"""A page opened from somewhere has a way back to it, named (Eric,
2026-10-01: "Popping into a wiki from almanac or anywhere except simply
opening it maybe should have a proper back button").

An article or an app page opened from the Almanac, a search or the home
page carries where it came from on its history entry. The header's arrow
names it ("Almanac", "Search") and takes the same step the browser's Back
does: to the Almanac at its scroll and its date, to the search with its
results. Desktop and a 390px phone, English and Hebrew (right to left).
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PHONE = {"width": 390, "height": 844}
DESKTOP = {"width": 1280, "height": 900}
QUESTION = "questions/567/how-can-i-chop-onions-without-crying"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from books_sources_fixture import build_zim
    from conftest_zim import build_wiki_fixture_zim
    from sotoki_fixture import LISTING, QUESTION as QUESTION_PAGE, TAGS

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("origin")
    zdir = tmp / "zims"
    zdir.mkdir()
    build_wiki_fixture_zim(str(zdir / "wikipedia_en_test.zim"))
    html = lambda s, title="": ("text/html", s, title)  # noqa: E731
    build_zim(
        str(zdir / "cooking.stackexchange.com_en_all_2026-07.zim"),
        {
            "Scraper": "sotoki v3.1.1",
            "Name": "cooking.stackexchange.com_en_all",
            "Title": "Cooking",
            "Language": "eng",
        },
        {
            "questions": html(LISTING, "Questions"),
            "tags": html(TAGS),
            QUESTION: html(QUESTION_PAGE, "How can I chop onions without crying?"),
        },
        main_path="questions",
    )
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR, os.environ.get("ZIMI_OFFLINE"))
    os.environ["ZIMI_OFFLINE"] = "1"
    srv.ZIM_DIR = str(zdir)
    srv.ZIMI_DATA_DIR = str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    srv.load_cache(force=True)
    srv._search_cache_clear()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old[0], old[1]
    if old[2] is None:
        os.environ.pop("ZIMI_OFFLINE", None)
    else:
        os.environ["ZIMI_OFFLINE"] = old[2]


def _page(pw, base, lang, phone):
    br = pw.chromium.launch()
    ctx = br.new_context(
        viewport=PHONE if phone else DESKTOP,
        locale="he-IL" if lang == "he" else "en-US",
        is_mobile=phone,
        has_touch=phone,
        service_workers="block",
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base + "/")
    pg.wait_for_function("() => zimsCache && zimsCache.length === 2", timeout=30000)
    return br, pg, errors


def _arrow(pg):
    """(shown, visible text, aria-label) of the header's back arrow: the
    arrow carries no words; where it goes is in its name."""
    return pg.evaluate(
        """() => { const b = document.getElementById('back-btn');
          return [getComputedStyle(b).display !== 'none', b.innerText.replace('\u2190', '').trim(), b.getAttribute('aria-label')]; }"""
    )


def _arrow_fits(pg):
    """The arrow inside the screen, mirrored in RTL."""
    return pg.evaluate(
        """() => { const b = document.getElementById('back-btn'), r = b.getBoundingClientRect();
          const vw = document.documentElement.clientWidth;
          const arrow = getComputedStyle(b.querySelector('.back-arrow')).transform;
          return { inside: r.left >= 0 && r.right <= vw, arrow,
                   sideways: document.documentElement.scrollWidth > vw }; }"""
    )


@pytest.mark.parametrize("lang,phone", [("en", False), ("he", True)])
def test_almanac_to_an_article_and_back_to_its_place_and_date(served, lang, phone):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _page(pw, served, lang, phone)
        pg.evaluate("() => openAlmanac()")
        pg.wait_for_function(
            "() => _almanacOpen && document.querySelector('#almanac-view .alm-link')",
            timeout=30000,
        )
        # A day away from today, and the Almanac scrolled to a link.
        pg.evaluate("() => _almSelectDay(_almTodayJDN - 40)")
        focus = pg.evaluate("() => _almFocus && _almFocus.getTime()")
        assert focus
        link = pg.locator("#almanac-view .alm-link:visible").last
        link.scroll_into_view_if_needed()
        # The place is where the page was when the link was tapped. Read
        # before the tap it can be stale: the new day's deep-links and the
        # late sections redraw the page under the reader (kept still on
        # screen, so its offset moves), and the tap scrolls the link back in.
        pg.evaluate("""() => { const c = document.getElementById('almanac-content');
              document.addEventListener('pointerdown', () => { window._tapScroll = c.scrollTop; },
                                        { capture: true, once: true }); }""")
        link.click()
        scroll = pg.evaluate("() => window._tapScroll")
        assert scroll and scroll > 0
        pg.wait_for_function(
            "() => readerOpen && currentArticle && currentArticle.zim === 'wikipedia_en_test'",
            timeout=15000,
        )
        shown, label, aria = _arrow(pg)
        assert shown and label == "", (shown, label)
        assert aria == pg.evaluate("t('back_to', {place: t('almanac')})")
        fits = _arrow_fits(pg)
        assert fits["inside"] and not fits["sideways"], fits
        if lang == "he":
            assert fits["arrow"] != "none", fits

        # The header's arrow: the Almanac, where it was, on the day it was on.
        pg.locator("#back-btn").click()
        pg.wait_for_function("() => _almanacOpen && !readerOpen", timeout=15000)
        pg.wait_for_timeout(1200)
        assert (
            abs(
                pg.evaluate(
                    "() => document.getElementById('almanac-content').scrollTop"
                )
                - scroll
            )
            <= 2
        )
        assert pg.evaluate("() => _almFocus && _almFocus.getTime()") == focus

        # Forward to the article, and the browser's Back: the same place.
        pg.go_forward()
        pg.wait_for_function("() => readerOpen", timeout=15000)
        assert _arrow(pg)[2] == pg.evaluate("t('back_to', {place: t('almanac')})")
        pg.go_back()
        pg.wait_for_function("() => _almanacOpen && !readerOpen", timeout=15000)
        pg.wait_for_timeout(1200)
        assert (
            abs(
                pg.evaluate(
                    "() => document.getElementById('almanac-content').scrollTop"
                )
                - scroll
            )
            <= 2
        )
        assert pg.evaluate("() => _almFocus && _almFocus.getTime()") == focus
        assert errors == []
        br.close()


@pytest.mark.parametrize("lang,phone", [("en", False), ("he", True)])
def test_search_to_an_app_and_back_to_the_results(served, lang, phone):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _page(pw, served, lang, phone)
        pg.evaluate(
            "() => { if (typeof _setOpenInApps === 'function') _setOpenInApps(true); }"
        )
        box = pg.locator("#q")
        box.click()
        box.fill("onions")
        box.press("Enter")
        pg.wait_for_function(
            "() => allResults && allResults._query === 'onions' && !allResults.partial",
            timeout=30000,
        )
        card = pg.locator('a.result[data-path="%s"]' % QUESTION)
        assert (
            pg.evaluate("p => _resultApp('cooking.stackexchange', p)", QUESTION)
            == "exchange"
        )
        card.click()
        pg.wait_for_function("() => _isExchangePage()", timeout=15000)
        shown, label, aria = _arrow(pg)
        assert shown and label == "", (shown, label)
        assert aria == pg.evaluate("t('back_to', {place: t('search')})")
        assert _arrow_fits(pg)["inside"]

        # The arrow: the results, as they were, nothing asked again.
        asked = []
        pg.on("request", lambda r: asked.append(r.url) if "/search?" in r.url else None)
        pg.locator("#back-btn").click()
        pg.wait_for_function(
            "() => !readerOpen && mode === 'search' && document.querySelector('a.result')",
            timeout=15000,
        )
        assert pg.evaluate("() => document.getElementById('q').value") == "onions"
        assert pg.evaluate("location.search") == "?q=onions"
        assert asked == []

        # Forward into the question, the browser's Back: the same.
        pg.go_forward()
        pg.wait_for_function("() => _isExchangePage()", timeout=15000)
        assert _arrow(pg)[2] == pg.evaluate("t('back_to', {place: t('search')})")
        pg.go_back()
        pg.wait_for_function(
            "() => !readerOpen && mode === 'search' && document.querySelector('a.result')",
            timeout=15000,
        )
        assert errors == []
        br.close()


def test_a_page_opened_by_the_readers_own_links_has_no_name(served):
    """Opening a source and reading on is the reader's own way: the arrow,
    when it is there, is unnamed."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _page(pw, served, "en", False)
        pg.evaluate("async () => { await enterSource('wikipedia_en_test', true); }")
        pg.wait_for_function("() => readerOpen", timeout=15000)
        assert _arrow(pg)[1] == ""
        pg.evaluate("() => openArticle('wikipedia_en_test', 'A/Sol', 'Sun')")
        pg.wait_for_function(
            "() => currentArticle && currentArticle.path === 'A/Sol'", timeout=15000
        )
        assert _arrow(pg)[1] == ""
        assert errors == []
        br.close()
