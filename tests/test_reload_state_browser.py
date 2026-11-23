"""A reload returns you where you were: Manage's tab, category, language pill and search live in the address
(/?manage&tab=browse&cat=..&lang=..&q=..), and so does the Bookshelf's place (/?books=<view>).

Run: pytest tests/test_reload_state_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

WAIT_MS = 45_000


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("reloadstate")
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


def _address(pg):
    return pg.evaluate("location.pathname + location.search + location.hash")


def test_manage_catalog_category_and_language_survive_a_reload(served, browser_ctx):
    pg = browser_ctx.new_page()
    pg.goto(served + "/?manage&tab=browse&cat=wikipedia&lang=es", wait_until="load")
    pg.wait_for_function(
        "() => typeof manageTab !== 'undefined' && manageTab === 'browse' && manageCategoryFilter === 'wikipedia' && manageLangFilter === 'es'",
        timeout=WAIT_MS,
    )
    assert _address(pg) == "/?manage&tab=browse&cat=wikipedia&lang=es"
    # A pill switched off is lang= with nothing after it, and is kept so.
    pg.evaluate("filterCatalogLang('es')")
    pg.wait_for_function("() => manageLangFilter === null", timeout=WAIT_MS)
    assert _address(pg) == "/?manage&tab=browse&cat=wikipedia&lang="
    pg.reload(wait_until="load")
    pg.wait_for_function(
        "() => typeof manageTab !== 'undefined' && manageTab === 'browse' && manageCategoryFilter === 'wikipedia' && manageLangFilter === null",
        timeout=WAIT_MS,
    )
    pg.close()


def test_manage_search_and_other_tabs_survive_a_reload(served, browser_ctx):
    pg = browser_ctx.new_page()
    pg.goto(served + "/?manage&tab=browse&lang=&q=wiki", wait_until="load")
    pg.wait_for_function(
        "() => typeof manageTab !== 'undefined' && manageTab === 'browse' && q.value === 'wiki' && _browseView === 'search'",
        timeout=WAIT_MS,
    )
    assert _address(pg) == "/?manage&tab=browse&lang=&q=wiki"
    pg.goto(served + "/?manage=server&tab=downloads", wait_until="load")
    pg.wait_for_function("() => typeof manageTab !== 'undefined' && manageTab === 'downloads'", timeout=WAIT_MS)
    pg.goto(served + "/?manage=server", wait_until="load")
    pg.wait_for_function("() => typeof manageTab !== 'undefined' && manageTab === 'settings' && _msSection === 'server'", timeout=WAIT_MS)
    pg.close()


def test_the_bookshelf_keeps_its_place_in_the_address(served, browser_ctx):
    pg = browser_ctx.new_page()
    pg.goto(served + "/#books", wait_until="load")
    pg.wait_for_function("() => typeof _booksOpen !== 'undefined' && _booksOpen", timeout=WAIT_MS)
    pg.wait_for_function("() => document.getElementById('reader-frame').contentWindow.go", timeout=WAIT_MS)
    pg.evaluate("document.getElementById('reader-frame').contentWindow.go({v: 'list', sort: 'title'})")
    pg.wait_for_function("() => location.search.indexOf('books=') > 0", timeout=WAIT_MS)
    want = _address(pg)
    pg.reload(wait_until="load")
    pg.wait_for_function(
        "() => { var w = document.getElementById('reader-frame').contentWindow; return w && w._stack && w._stack.length === 2 && w.cur().sort === 'title'; }",
        timeout=WAIT_MS,
    )
    assert _address(pg) == want
    pg.evaluate("document.getElementById('reader-frame').contentWindow.tab('home')")
    pg.wait_for_function("() => location.hash === '#books' && !location.search", timeout=WAIT_MS)
    pg.close()


def test_a_search_inside_a_category_comes_back_whole_and_an_unknown_category_does_not(served, browser_ctx):
    pg = browser_ctx.new_page()
    pg.goto(served + "/?manage&tab=browse&cat=wikipedia&lang=&q=wiki", wait_until="load")
    pg.wait_for_function(
        "() => typeof manageTab !== 'undefined' && manageCategoryFilter === 'wikipedia' && q.value === 'wiki' && _browseView === 'search'",
        timeout=WAIT_MS,
    )
    assert _address(pg) == "/?manage&tab=browse&cat=wikipedia&lang=&q=wiki"
    pg.close()
    pg = browser_ctx.new_page()
    pg.goto(served + "/?manage&tab=browse&cat=x%27);alert(1);//&lang=&q=wiki", wait_until="load")
    pg.wait_for_function(
        "() => typeof manageTab !== 'undefined' && manageTab === 'browse' && q.value === 'wiki' && _browseView === 'search'",
        timeout=WAIT_MS,
    )
    assert pg.evaluate("() => manageCategoryFilter") is None
    pg.close()
