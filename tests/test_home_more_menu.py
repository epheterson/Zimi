"""One ⋯ on everything Home draws, and on every app's top bar; the same About sheet behind each.

Eric: "All the apps are supposed to have a ... menu with what's relevant including about that lists what's in it" and
"I want ... menu on every tile on homepage, every app".

On a phone, in a real browser, over a small library: every tile and row on Home (each source, each app, in the list and
in the tiles) has a ⋯ with a hit area of at least 44x44, which opens the card's menu with an About; every app page has a
⋯ in the top bar whose About says what the app is and which sources it reads; the sheet closes on Escape and on Back and
hands focus back to the ⋯; the Discover cards carry the same ⋯.

Run: pytest tests/test_home_more_menu.py -v
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from test_home_apps_live import HOME, LIBRARY  # noqa: E402

pytestmark = pytest.mark.fieldguide_on
PHONE = {
    "width": 390,
    "height": 3000,
}  # as wide as a phone, tall enough to hit-test the whole of Home at once
DAY = 86400


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("morehome")
    zdir = tmp / "zims"
    zdir.mkdir()
    for filename, meta, _ in LIBRARY:
        build_fixture_zim(str(zdir / filename), meta)
    mp = pytest.MonkeyPatch()
    mp.setenv("ZIMI_APPS", ",".join(srv.APP_NAMES))
    mp.setenv("ZIMI_OFFLINE", "1")
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    srv.load_cache(force=True)
    now = time.time()
    by_file = {srv._zim_short_name(f): when for f, _, when in LIBRARY}
    for z in srv._zim_list_cache:
        if z["name"] in by_file:
            days, hours, entries = by_file[z["name"]]
            z["first_seen"] = now - days * DAY
            z["updated_at"] = now - hours * 3600 if hours else None
            z["entries"] = entries
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


def _page(pw, served, view="list", lang="en", theme="light"):
    br = pw.chromium.launch()
    ctx = br.new_context(
        viewport=PHONE,
        is_mobile=True,
        has_touch=True,
        color_scheme="dark" if theme == "dark" else "light",
        locale="he-IL" if lang == "he" else "en-US",
    )
    init = "localStorage.setItem('zimi_library_view','%s');" % view
    if theme == "red":
        init += "localStorage.setItem('zimi_app_theme','red');"
    ctx.add_init_script(init)
    pg = ctx.new_page()
    pg.goto(served + "/")
    pg.wait_for_function(HOME, timeout=30000)
    pg.wait_for_timeout(500)
    return br, pg


# Every tile and row on Home, with the ⋯ it wears and how big a tap on it is.
TILES = r"""() => Array.from(document.querySelectorAll('#output .stat-card')).map(c => {
  const m = c.querySelector('.card-more');
  let w = 0, h = 0;
  if (m) {
    const r = m.getBoundingClientRect(), L = r.left - 30, T = r.top - 30; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let y = T; y < r.bottom + 30; y += 2) for (let x = L; x < r.right + 30; x += 2) {
      const e = document.elementFromPoint(x, y);
      if (e && (e === m || m.contains(e))) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    w = x1 - x0 + 2; h = y1 - y0 + 2;
  }
  return { zim: c.dataset.zim, app: c.dataset.app || '', more: !!m, w: w, h: h };
})"""


@pytest.mark.parametrize("view", ["list", "tiles"])
def test_every_tile_and_row_has_a_more_that_opens_an_about(served, view):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw, served, view)
        try:
            cards = pg.evaluate(TILES)
            assert len(cards) >= 10, cards
            assert any(c["app"] for c in cards) and any(c["zim"] for c in cards)
            bare = [c for c in cards if not c["more"]]
            assert not bare, "tiles with no ⋯: %s" % bare
            small = [c for c in cards if c["w"] < 43 or c["h"] < 43]
            assert not small, "a ⋯ with a tap area under 44x44: %s" % small
            # Each opens a menu with an About, and About opens a sheet that says what it is.
            for i in range(len(cards)):
                pg.evaluate(
                    "(i) => document.querySelectorAll('#output .stat-card .card-more')[i].scrollIntoView({block: 'center'})",
                    i,
                )
                pg.evaluate(
                    "(i) => document.querySelectorAll('#output .stat-card .card-more')[i].click()",
                    i,
                )
                pg.wait_for_selector(
                    "#zim-ctx-menu.visible [data-action^=about]", timeout=5000
                )
                kind = pg.evaluate(
                    "document.querySelector('#zim-ctx-menu [data-action^=about]').dataset.action"
                )
                assert kind == ("about-app" if cards[i]["app"] else "about"), (i, kind)
                pg.click("#zim-ctx-menu [data-action^=about]")
                pg.wait_for_selector(
                    "#zim-about .zi-body .zi-title, #zim-about .zi-body .zi-none",
                    timeout=8000,
                )
                body = pg.inner_text("#zim-about")
                assert "zi_load_failed" not in body and len(body) > 20, body
                if cards[i]["app"]:
                    assert pg.evaluate(
                        "(a) => document.querySelector('#zim-about').innerText.includes(t('app_about_' + a))",
                        cards[i]["app"],
                    ), body
                pg.keyboard.press("Escape")
                pg.wait_for_selector("#zim-about", state="detached", timeout=3000)
                assert pg.evaluate(
                    "(i) => document.activeElement === document.querySelectorAll('#output .stat-card .card-more')[i]",
                    i,
                ), "focus goes back to the ⋯ that opened it"
        finally:
            br.close()


def test_the_discover_cards_carry_the_same_more(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw, served)
        try:
            pg.wait_for_selector(
                "#output .discover-card:not(.dc-loading)", timeout=15000
            )
            cards = pg.evaluate(
                "() => Array.from(document.querySelectorAll('.discover-card:not(.dc-loading)')).map(c => !!c.querySelector('.dc-more'))"
            )
            assert cards and all(cards), cards
            pg.evaluate("document.querySelector('.discover-card .dc-more').click()")
            pg.wait_for_selector(
                "#zim-ctx-menu.visible [data-action^=about]", timeout=5000
            )
        finally:
            br.close()


# Left out: Zimipedia (it needs a wiki ZIM) and the Games (Zimi's own ZIM, which the test suite turns off): same code path.
APPS = {
    "tube": "openTube()",
    "exchange": "openExchange()",
    "books": "openBooks()",
    "dictionary": "openDictionary()",
    "fieldguide": "openFieldguide()",
    "almanac": "openAlmanac()",
}


@pytest.mark.parametrize("app", sorted(APPS))
def test_every_app_has_a_more_in_its_top_bar_with_an_about(served, app):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw, served)
        try:
            pg.evaluate("() => " + APPS[app])
            pg.wait_for_function("(a) => _openAppId() === a", arg=app, timeout=15000)
            pg.wait_for_function(
                "() => { const b = document.querySelector('.topbar-more'); return b && b.getBoundingClientRect().width > 0; }"
            )
            pg.click(".topbar-more")
            pg.wait_for_selector("#topbar-menu.visible .topbar-menu-item", timeout=3000)
            pg.click("#topbar-menu .topbar-menu-item >> nth=0")
            pg.wait_for_selector("#zim-about .zi-desc", timeout=5000)
            said = pg.evaluate(
                "(a) => document.querySelector('#zim-about').innerText.includes(t('app_about_' + a))",
                app,
            )
            assert said, pg.inner_text("#zim-about")
            if app in ("tube", "exchange", "books"):
                assert pg.query_selector(
                    "#zim-about .zi-src"
                ), "the sources it reads are listed"
            # Escape closes it and focus returns to the ⋯.
            pg.keyboard.press("Escape")
            pg.wait_for_selector("#zim-about", state="detached", timeout=3000)
            assert pg.evaluate(
                "document.activeElement && document.activeElement.classList.contains('topbar-more')"
            )
            # Back closes it too, and stays on the app.
            pg.wait_for_timeout(400)  # the step Escape took back has landed
            pg.click(".topbar-more")
            pg.click("#topbar-menu .topbar-menu-item >> nth=0")
            pg.wait_for_selector("#zim-about", timeout=3000)
            pg.go_back()
            pg.wait_for_selector("#zim-about", state="detached", timeout=3000)
            assert pg.evaluate("(a) => _openAppId() === a", app)
        finally:
            br.close()


def test_the_sheet_mirrors_in_hebrew_and_names_the_app_in_it(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw, served, lang="he")
        try:
            pg.evaluate(
                "document.querySelector('.app-tile[data-app=books] .card-more').click()"
            )
            pg.wait_for_selector("#zim-ctx-menu.visible [data-action=about-app]")
            pg.click("#zim-ctx-menu [data-action=about-app]")
            pg.wait_for_selector("#zim-about .zi-src", timeout=5000)
            assert pg.evaluate("document.documentElement.dir") == "rtl"
            text = pg.inner_text("#zim-about")
            assert pg.evaluate("t('app_about_books')") in text
            assert "app_about_books" not in text
        finally:
            br.close()
