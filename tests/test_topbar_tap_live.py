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
            pg.evaluate(
                "() => document.getElementById('almanac-content').scrollTo(0, 2500)"
            )
            pg.wait_for_function(
                "() => document.getElementById('almanac-content').scrollTop > 2000"
            )
            pg.evaluate("() => _scrollViewToTop()")
            pg.wait_for_function(
                "() => document.getElementById('almanac-content').scrollTop === 0",
                timeout=5000,
            )
        finally:
            br.close()


# ── every view: a tap on the bar takes the one on screen to its top ─────────
# Eric, 2026-10-05: "are there any other views where tapping the top wasn't
# connected right?" and "I don't need or want zimi header to hide ... in main
# library views or settings." Each view is scrolled by a wheel over its
# middle (grown first, so a small fixture still scrolls), the empty part of
# the bar is tapped, and whatever the wheel moved must be back at its top.
# Saved over a scrolled page and a table over the scrolled Almanac: the one
# in front goes up, what is behind it stays.

# Everything scrolled, in the shell and in its frames.
SCROLLED = """() => { const out = {}; const walk = (doc, pre) => {
  if (doc.defaultView.scrollY > 0) out[pre + 'window'] = doc.defaultView.scrollY;
  doc.querySelectorAll('*').forEach((e, i) => { if (e.scrollTop > 0 && e !== doc.documentElement) out[pre + (e.id || e.tagName) + '#' + i] = e.scrollTop; });
  doc.querySelectorAll('iframe').forEach((f, j) => { try { if (f.contentDocument) walk(f.contentDocument, pre + 'frame' + j + ':'); } catch (e) {} }); };
  walk(document, ''); return out; }"""
# Room to scroll where the middle of the view is: the reader's page, or the
# box under the middle (past a sideways row or a picture).
GROW = """() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  const sideways = (n) => { const cs = getComputedStyle(n); return (/auto|scroll/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1) || cs.maxHeight !== 'none'; };
  let host = el;
  if (el && el.tagName === 'IFRAME') host = el.contentDocument.body;
  else while (host && host !== document.body && (host.tagName === 'CANVAS' || sideways(host) || host.offsetHeight < 60)) host = host.parentElement;
  const s = host.ownerDocument.createElement('div'); s.style.height = '6000px'; host.appendChild(s); }"""
FRAME_READY = (
    "() => { const w = document.getElementById('reader-frame').contentWindow;"
    " return readerOpen && w && w.document.readyState === 'complete' && w.document.body && %s; }"
)
APP = FRAME_READY % (
    "w.document.body.children.length > 2 && /^\\/static\\/[a-z]+\\.html/.test(w.location.pathname)"
)
ARTICLE = FRAME_READY % "/Physics/.test(w.location.pathname)"
SCROLL_FRAME = (
    "const w = document.getElementById('reader-frame').contentWindow, s = w.document.createElement('div');"
    " s.style.height = '6000px'; w.document.body.appendChild(s); w.scrollTo(0, 2000);"
)
# name: (open it, ready when, then (a panel in front, an article), whether
# the header steps aside while it is scrolled)
VIEWS = {
    "home": (
        "() => { goHome(); const s = document.createElement('div'); s.style.height = '6000px';"
        " document.getElementById('main-view').appendChild(s); }",
        "() => !readerOpen",
        None,
        False,
    ),
    "search": (
        "() => { const q = document.getElementById('q'); q.value = 'Einstein'; q.dispatchEvent(new Event('input')); }",
        "() => document.querySelectorAll('.result, .search-result, [data-zim]').length > 0",
        None,
        False,
    ),
    "catalog": (
        "() => { manageTab = 'browse'; enterManage(); }",
        "() => mode === 'manage'",
        None,
        False,
    ),
    "settings": (
        "() => enterManage(null, 'preferences')",
        "() => mode === 'manage'",
        None,
        False,
    ),
    "create": ("() => openCreate()", "() => _createOpen", None, False),
    "saved": ("() => toggleLibraryPanel('bookmarks')", "() => true", None, False),
    "saved-over-a-scrolled-page": (
        "() => { const s = document.createElement('div'); s.style.height = '6000px';"
        " document.getElementById('main-view').appendChild(s); scrollTo(0, 2000); }",
        "() => scrollY > 1000",
        "() => toggleLibraryPanel('bookmarks')",
        False,
    ),
    "tube": ("() => openTube()", APP, None, False),
    "exchange": ("() => openExchange()", APP, None, False),
    "reddot": ("() => openReddot()", APP, None, False),
    "bookshelf": ("() => openBooks()", APP, None, False),
    "zimipedia": ("() => openWiki()", APP, None, False),
    "dictionary": ("() => openDictionary()", APP, None, False),
    "almanac": (
        "() => openAlmanac()",
        "() => { const c = document.getElementById('almanac-content'); return c && c.scrollHeight > 3000; }",
        None,
        False,
    ),
    "a-table-over-the-scrolled-almanac": (
        "() => openAlmanac()",
        "() => document.getElementById('alm-group-tables')",
        "() => { document.getElementById('almanac-content').scrollTop = 1500; _almRefOpen('sunmoon'); }",
        False,
    ),
    "article": ("() => openArticle('wikipedia', 'Physics')", ARTICLE, None, False),
    "saved-over-an-article": (
        "() => openArticle('wikipedia', 'Physics')",
        ARTICLE,
        "() => { " + SCROLL_FRAME + " toggleLibraryPanel('bookmarks'); }",
        False,
    ),
    "zimipedia-article": (
        "() => openWiki()",
        APP,
        "() => document.getElementById('reader-frame').contentWindow.tell({ zimi: 'open', zim: 'wikipedia', path: 'Physics' })",
        True,
    ),
}


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import wiki_fixture

    import zimi.server as srv
    from zimi import wiki
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("views")
    zdir = str(tmp / "zims")
    wiki_fixture.build_library(zdir)
    was = srv.ZIM_DIR, srv.ZIMI_DATA_DIR
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = zdir, str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    wiki._reset_for_tests()
    srv.load_cache(force=True)
    wiki_fixture.index_wikipedias()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.release_zim_handles(list(srv.get_zim_files()))
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = was


@pytest.mark.parametrize("view", list(VIEWS))
def test_a_tap_on_the_bar_takes_every_view_to_its_top(library, view):
    from playwright.sync_api import sync_playwright

    open_js, ready, then, reading = VIEWS[view]
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"], reduced_motion="reduce")
        pg = ctx.new_page()
        try:
            pg.goto(library + "/")
            pg.wait_for_function(
                "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
                timeout=30000,
            )
            pg.evaluate("() => document.activeElement && document.activeElement.blur()")
            pg.evaluate(open_js)
            pg.wait_for_function(ready, timeout=30000)
            if then:
                pg.evaluate(then)
            if reading:
                pg.wait_for_function(
                    "() => { const d = document.getElementById('reader-frame').contentDocument;"
                    " return d && d.querySelector('.zw-bar'); }",
                    timeout=30000,
                )
            pg.wait_for_timeout(2500 if view.startswith("a-table") else 800)
            behind = pg.evaluate(SCROLLED)
            pg.evaluate(GROW)
            # A spot in the middle that is not a sideways row of cards (the
            # wheel stays in one; a finger dragging up would not).
            mid = pg.evaluate(
                """() => { const x = innerWidth / 2; for (let y = innerHeight / 2; y < innerHeight - 20; y += 20) {
                  let e = document.elementFromPoint(x, y), side = false;
                  for (; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e);
                    if (/auto|scroll/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1) side = true; }
                  if (!side) return [x, y]; } return [x, innerHeight / 2]; }"""
            )
            pg.mouse.move(mid[0], mid[1])
            for _ in range(6):
                pg.mouse.wheel(0, 500)
                pg.wait_for_timeout(100)
            pg.wait_for_timeout(400)
            moved = {
                k: v for k, v in pg.evaluate(SCROLLED).items() if behind.get(k) != v
            }
            assert moved, "the view scrolled"
            # The header steps aside only while an article is read.
            away = pg.evaluate("() => document.body.classList.contains('chrome-away')")
            assert away == reading, (view, away)
            pg.evaluate("() => document.body.classList.remove('chrome-away')")
            pg.wait_for_timeout(400)
            spot = pg.evaluate(EMPTY_SPOT)
            assert spot, "the bar has empty space to tap"
            pg.mouse.click(spot["x"], spot["y"])
            pg.wait_for_timeout(600)
            now = pg.evaluate(SCROLLED)
            assert not [k for k in moved if k in now], (view, moved, now)
            # What is behind the one in front stays where it was scrolled.
            for k in behind:
                if k not in moved:
                    assert now.get(k), ("what is behind stays", view, k, behind, now)
        finally:
            br.close()
