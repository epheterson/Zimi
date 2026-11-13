"""An app page that is open hears a setting changed in another window (the account's value taken by the shell, or
another tab) and shows it, instead of keeping the old one until it reloads.

Two pages of one browser: the first holds the app open, the second writes the key the way the shell does (the storage
event reaches the first, never the writer).

Run: pytest tests/test_apps_live_prefs_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Waits for a state, so a long one costs nothing when the state comes: a loaded CI shard took more than 15 s to
# load manage.js and draw Manage (CI 2026-11-10).
WAIT_MS = 45_000


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("liveprefs")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


@pytest.fixture(scope="module")
def browser_ctx():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(service_workers="block")
        yield ctx
        br.close()


def _change(ctx, base, key, value):
    """Another window of the same browser writes ``key`` (None: back to its default)."""
    other = ctx.new_page()
    other.goto(base + "/health")
    other.evaluate(
        "([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }",
        [key, value],
    )
    other.close()


def _open(ctx, base, path):
    pg = ctx.new_page()
    pg.goto(base + path, wait_until="load")
    return pg


def test_tube_follows_sort_autoplay_and_theater(served, browser_ctx):
    pg = _open(browser_ctx, served, "/static/tube.html")
    assert pg.evaluate("[_sort, _autoplay, _theater]") == ["top", True, False]
    _change(browser_ctx, served, "zimitube_sort", "newest")
    _change(browser_ctx, served, "zimitube_autoplay", "0")
    _change(browser_ctx, served, "zimitube_theater", "1")
    pg.wait_for_function(
        "() => _sort === 'newest' && _autoplay === false && _theater === true",
        timeout=WAIT_MS,
    )
    _change(browser_ctx, served, "zimitube_sort", None)
    pg.wait_for_function("() => _sort === 'top'", timeout=WAIT_MS)
    pg.close()


def test_reddot_follows_who_is_followed(served, browser_ctx):
    pg = _open(browser_ctx, served, "/static/reddot.html")
    assert pg.evaluate("_follow") == []
    _change(browser_ctx, served, "reddot_follow", '["r_kiwix|kiwix"]')
    pg.wait_for_function(
        "() => _follow.length === 1 && isFollowed('r_kiwix', 'kiwix')", timeout=WAIT_MS
    )
    _change(browser_ctx, served, "reddot_follow", None)
    pg.wait_for_function("() => _follow.length === 0", timeout=WAIT_MS)
    pg.close()


def test_wiki_follows_its_view(served, browser_ctx):
    pg = _open(browser_ctx, served, "/static/wiki.html")
    assert pg.evaluate("_view") == "cards"
    _change(browser_ctx, served, "zimi_wiki_view", "list")
    pg.wait_for_function("() => _view === 'list'", timeout=WAIT_MS)
    _change(browser_ctx, served, "zimi_wiki_view", None)
    pg.wait_for_function("() => _view === 'cards'", timeout=WAIT_MS)
    pg.close()


def test_pdf_reader_follows_dark_pages(served, browser_ctx):
    pg = browser_ctx.new_page()
    pg.goto(served + "/static/pdfjs/web/viewer.html", wait_until="load")
    pg.wait_for_function(
        "() => document.documentElement.classList.length >= 0", timeout=WAIT_MS
    )
    before = pg.evaluate("document.documentElement.classList.contains('zp-dark')")
    # Dark pages need a dark Zimi; the chosen value is what the page reads, so it is asked for both ways.
    pg.emulate_media(color_scheme="dark")
    _change(browser_ctx, served, "zimi_pdf_dark", "0")
    pg.wait_for_function(
        "() => !document.documentElement.classList.contains('zp-dark')", timeout=WAIT_MS
    )
    _change(browser_ctx, served, "zimi_pdf_dark", "1")
    pg.wait_for_function(
        "() => document.documentElement.classList.contains('zp-dark')", timeout=WAIT_MS
    )
    assert before in (True, False)
    pg.close()


def test_manage_maps_pane_redraws_when_the_source_changes(served, browser_ctx):
    pg = browser_ctx.new_page()
    pg.goto(served + "/", wait_until="load")
    # The boot paints "Loading library" over #output before it asks for the list (init); Manage opened before that
    # point is wiped with it, and drillCategory finds no #catalog-results. Open it once the list is in.
    pg.wait_for_function("() => zimsCache !== null", timeout=WAIT_MS)
    pg.evaluate("enterManage()")
    pg.wait_for_function(
        "() => typeof drillCategory === 'function' && !!document.getElementById('catalog-results')",
        timeout=WAIT_MS,
    )
    pg.evaluate("drillCategory('maps')")
    # Until manage.js is in, drillCategory is app.js's stub that queues the call: wait for the Maps view it draws.
    pg.wait_for_function(
        "() => typeof _browseView !== 'undefined' && _browseView === 'drilldown' && manageCategoryFilter === 'maps'",
        timeout=WAIT_MS,
    )
    # The account's value comes in: the shell writes it and announces it. The calls are counted in the one turn of the page
    # that announces it: the catalog, the library list and the downloads redraw this same view when their own answers land
    # (a runner's speed decides whether one lands between two of the test's turns), and those are not this announcement's.
    drills = pg.evaluate(
        """() => {
            var calls = [], real = drillCategory;
            drillCategory = function (k) { calls.push(k); };
            try { localStorage.setItem(SK.MAPS_SOURCE, 'streetzim'); _prefApplied([SK.MAPS_SOURCE]); }
            finally { drillCategory = real; localStorage.removeItem(SK.MAPS_SOURCE); }
            return calls;
        }"""
    )
    assert drills == ["maps"]
    pg.close()
