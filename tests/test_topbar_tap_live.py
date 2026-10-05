"""A tap on the top bar's empty space takes the view on screen to its top.

Eric, 2026-10-03: "In PWA tapping header doesn't scroll to top." An
installed app on iOS has no browser status bar to tap, and the reader's page
scrolls inside its frame, where iOS would not reach anyway.

Run: pytest tests/test_topbar_tap_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

LONG = (
    b"<html><body><h1>Long</h1>"
    + b"<p>Water runs downhill. " * 40
    + b"</p>" * 1
    + b"<p>more</p>" * 400
    + b"</body></html>"
)

# A point on the bar that no control, link or field covers.
EMPTY_SPOT = """() => { const bar = document.querySelector('.topbar').getBoundingClientRect();
  const skip = _TOPBAR_TAP_SKIP, y = bar.top + bar.height / 2;
  for (let x = bar.left + 2; x < bar.right - 2; x += 2) {
    const el = document.elementFromPoint(x, y);
    if (el && el.closest('.topbar') && !el.closest(skip)) return { x, y };
  }
  return null; }"""


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from libzim.writer import Creator

    from conftest_zim import _Article
    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    with Creator(str(zdir / "long.zim")).config_indexing(True, "eng") as c:
        c.set_mainpath("A/Long")
        c.add_item(_Article("A/Long", "Long", LONG))
        c.add_metadata("Title", "Long")
        c.add_metadata("Language", "eng")
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], srv.list_zims()[0]["name"]
    httpd.shutdown()
    srv.release_zim_handles(list(srv.get_zim_files()))


@pytest.mark.parametrize("motion", ["no-preference", "reduce"])
def test_a_tap_on_the_bar_takes_the_article_to_its_top(served, motion):
    from playwright.sync_api import sync_playwright

    base, name = served
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"], reduced_motion=motion)
        pg = ctx.new_page()
        try:
            pg.goto(base + "/?a=" + name + "%2FA%2FLong")
            pg.wait_for_function(
                "() => { const f = document.getElementById('reader-frame');"
                " return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.scrollHeight > 3000; }",
                timeout=20000,
            )
            frame_y = (
                "() => document.getElementById('reader-frame').contentWindow.scrollY"
            )
            pg.evaluate(
                "() => document.getElementById('reader-frame').contentWindow.scrollTo(0, 2500)"
            )
            pg.wait_for_function(frame_y + " > 2000")
            # The bar steps aside while reading down; scrolling up a little brings it back.
            pg.evaluate("() => document.body.classList.remove('chrome-away')")
            pg.wait_for_timeout(400)
            spot = pg.evaluate(EMPTY_SPOT)
            assert spot, "the bar has empty space to tap"
            pg.mouse.click(spot["x"], spot["y"])
            pg.wait_for_function(frame_y + " === 0", timeout=5000)
            # A control on the bar still does its own thing and no more.
            pg.evaluate(
                "() => document.getElementById('reader-frame').contentWindow.scrollTo(0, 1500)"
            )
            pg.wait_for_function(frame_y + " > 1000")
            pg.evaluate("() => document.body.classList.remove('chrome-away')")
            pg.click(".topbar-more")
            pg.wait_for_timeout(500)
            assert pg.evaluate(frame_y) > 1000
        finally:
            br.close()


def test_an_iphone_home_screen_app_offers_copy_link_not_a_browser(served):
    """Eric, 2026-10-03: "PWA open in browser doesn't seem to work." An iOS
    home-screen app cannot open Safari (window.open to Zimi stays in the app;
    the x-safari scheme is undocumented), so the control says Copy link and
    copies; elsewhere it is still Open in browser."""
    from playwright.sync_api import sync_playwright

    base, name = served
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        ctx.add_init_script(
            "Object.defineProperty(navigator, 'standalone', { get: () => true });"
        )
        pg = ctx.new_page()
        try:
            pg.goto(base + "/?a=" + name + "%2FA%2FLong")
            pg.wait_for_function("() => readerOpen && !!currentArticle", timeout=20000)
            pg.click(".topbar-more")
            menu = pg.locator("#topbar-menu")
            menu.wait_for(state="visible", timeout=5000)
            text = menu.inner_text()
            assert "Copy link" in text and "Open in browser" not in text, text
            pg.evaluate(
                "() => { window.__copied = null; window._copyText = (u) => { window.__copied = u; }; }"
            )
            pg.locator("#topbar-menu .topbar-menu-item", has_text="Copy link").click()
            copied = pg.evaluate("() => window.__copied")
            assert copied and "a=" in copied and "Long" in copied, copied
        finally:
            br.close()


def test_a_tap_on_the_bar_takes_the_almanac_to_its_top(served):
    """Eric, 2026-10-05: "why can't I tap top area on iOS to scroll to top of
    almanac? Works on library page". The Almanac scrolls in a box of its own."""
    from playwright.sync_api import sync_playwright

    base, _name = served
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"], reduced_motion="reduce")
        pg = ctx.new_page()
        try:
            pg.goto(base + "/#almanac")
            pg.wait_for_function(
                "() => { const c = document.getElementById('almanac-content'); return c && c.scrollHeight > 3000; }",
                timeout=30000,
            )
            pg.evaluate("() => document.getElementById('almanac-content').scrollTo(0, 2500)")
            pg.wait_for_function("() => document.getElementById('almanac-content').scrollTop > 2000")
            pg.evaluate("() => _scrollViewToTop()")
            pg.wait_for_function("() => document.getElementById('almanac-content').scrollTop === 0", timeout=5000)
        finally:
            br.close()
