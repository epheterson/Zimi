"""Discover's language badge says what the card's text is written in, on every card.

A Word or Quote of the Day from an English wiki under a German, Russian or Arabic page carried no badge,
because only the standard card asked _cardLangBadge; the Game of the Day (its text translated by Zimi
itself, its ZIM's metadata saying English) carried one it should not. The quote card in Russian also
lost its last line at a phone's width.

Run: pytest tests/test_home_badge_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

READY = "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0"
RU_QUOTE = (
    "Воображение важнее знания. Знание ограничено, тогда как воображение охватывает целый мир,"
    " стимулирует прогресс и рождает эволюцию."
)


@pytest.fixture
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from app_saved_fixture import build_library

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("badge")
    mp = pytest.MonkeyPatch()
    build_library(tmp / "zims")
    mp.setattr(srv, "ZIM_DIR", str(tmp / "zims"))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    mp.setenv("ZIMI_OFFLINE", "1")
    mp.setenv("ZIMI_TORRENT", "0")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


@pytest.fixture
def pw():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        yield p


def _page(pw, served, lang, quote="Imagination is more important than knowledge."):
    br = pw.chromium.launch()
    pg = br.new_context(**pw.devices["iPhone 13"], service_workers="block").new_page()
    pg.goto(served + "/")
    pg.wait_for_function(READY, timeout=30000)
    pg.wait_for_selector("#discover-row", state="attached")
    pg.wait_for_function(
        "() => document.querySelector('#discover-row .discover-card') && !document.querySelector('#discover-row .dc-loading')",
        timeout=20000,
    )
    pg.evaluate("l => setLanguage(l)", lang)
    pg.wait_for_function("l => _currentLang === l", arg=lang)
    pg.evaluate(
        """() => {
          [['wiktionary_en-simple_all_nopic', 'Wiktionary', 'eng'],
           ['wikiquote_en_all_nopic', 'Wikiquote', 'eng'],
           ['wikiquote_ru_all_nopic', 'Wikiquote', 'rus'],
           ['zimi_games', 'Games', 'eng']].forEach(function(z) {
            zimsCache.push({ name: z[0], title: z[1], language: z[2], main_path: 'index' });
          });
          _rebuildZimsMap();
        }"""
    )
    pg.evaluate(
        """q => _renderDiscover(document.getElementById('discover-row'), [
          { zim: 'wikiquote_en_all_nopic', path: 'Q', title: 'Albert Einstein', blurb: '\\u201c' + q + '\\u201d', attribution: 'Albert Einstein' },
          { zim: 'wiktionary_en-simple_all_nopic', path: 'institution', title: 'institution', blurb: 'a society or organization', part_of_speech: 'noun' },
          { zim: 'zimi_games', path: 'ineq', title: 'Inequality', type: 'random', blurb: 'A puzzle' }])""",
        quote,
    )
    return br, pg


@pytest.mark.parametrize("lang", ["de", "ru", "ar"])
def test_every_card_badges_text_in_another_language_and_only_that(served, pw, lang):
    br, pg = _page(pw, served, lang)
    try:
        got = pg.evaluate(
            """() => ({
              quote: !!document.querySelector('.dc-quote-card:not(.dc-word-card) .dc-header .lang-badge'),
              word: !!document.querySelector('.dc-word-card .dc-header .lang-badge'),
              game: !!document.querySelector('.discover-card[data-zim="zimi_games"] .lang-badge'),
            })"""
        )
        assert got == {"quote": True, "word": True, "game": False}, got
    finally:
        br.close()


def test_a_card_in_the_pages_own_language_has_no_badge(served, pw):
    br, pg = _page(pw, served, "en")
    try:
        assert pg.locator(".discover-card .lang-badge").count() == 0
    finally:
        br.close()


def test_the_russian_quote_shows_its_last_line_at_phone_width(served, pw):
    br, pg = _page(pw, served, "ru", RU_QUOTE)
    try:
        r = pg.evaluate(
            """() => { const b = document.querySelector('.dc-quote-card:not(.dc-word-card) .dc-quote');
              const c = b.closest('.discover-card').getBoundingClientRect(); const q = b.getBoundingClientRect();
              return { scroll: b.scrollHeight, client: b.clientHeight, qb: q.bottom, cb: c.bottom,
                       lines: Math.round(b.scrollHeight / parseFloat(getComputedStyle(b).lineHeight)) }; }"""
        )
        print(r)
        assert r["scroll"] <= r["client"] + 1, r
    finally:
        br.close()


@pytest.mark.parametrize("scheme,dark", [("dark", True), ("light", False)])
def test_first_paint_follows_the_os_when_no_theme_is_stored(served, pw, scheme, dark):
    """No stored theme, no account: the page is stamped before its stylesheet, so the first frame is already the
    OS's scheme and nothing flips later."""
    br = pw.chromium.launch()
    try:
        pg = br.new_context(**pw.devices["iPhone 13"], service_workers="block", color_scheme=scheme).new_page()
        pg.add_init_script(
            """window.__bg = []; document.addEventListener('readystatechange', function () {
              if (document.body) __bg.push([document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]); });
            new MutationObserver(function () { if (document.body) __bg.push([document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]); })
              .observe(document.documentElement, { attributes: true });"""
        )
        pg.goto(served + "/")
        pg.wait_for_function(READY, timeout=30000)
        seen = pg.evaluate("() => __bg")
        want = "dark" if dark else "light"
        assert seen and all(t == want for t, _ in seen), seen
        assert len({c for _, c in seen}) == 1, seen
    finally:
        br.close()
