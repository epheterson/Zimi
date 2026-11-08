"""A near: search with exactly one source installed answers, whatever the source.

With one source Zimi opens it on its own, and the search box then belongs to
what was opened: a map's box finds places (Enter flies to the first), an
article source's box searches its articles. A near: search has to end in
something said in both, never in a page that waits for ever:

  one map            the box lists the places near; Enter flies the map there
                     (the reader loaded, its spinner gone)
  one article source the line "No installed map names a place called Boston",
                     not "No results found"
  one map, by link   /?q=near:... lists the towns around

Found while tracing a reported hang: the "Loading..." text is the reader's
hidden spinner, which is in the page's text whenever a reader is open. A map
whose own page is served as application/octet-stream (a fixture's plain
entries are) never renders, so the fixture's map page is a real article.

Run, one file at a time:
    ZIMI_TORRENT=0 ZIMI_BUILTIN_ZIMS=0 ZIMI_OFFLINE=1 pytest tests/test_near_single_source_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402

VIEW = {"width": 390, "height": 844}


def _serve(tmp, with_map):
    """A library of exactly one source: the map, or an article source."""
    from http.server import ThreadingHTTPServer

    import test_place_autocomplete as fixture
    from conftest_zim import build_fixture_zim

    import zimi.server as srv
    from zimi import mapplaces
    from zimi.http import ZimHandler

    zdir = tmp / "zims"
    zdir.mkdir()
    if with_map:
        build_fixture_zim(
            str(zdir / f"{fixture.NAME}.zim"),
            {"Scraper": "maps2zim v0.2.1"},
            files=fixture._map_files(),
        )
    else:
        build_fixture_zim(str(zdir / "guide_en_2026-01.zim"), {"Title": "Guide"})
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(zdir), str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    mapplaces._reset_for_tests()
    srv.load_cache(force=True)
    mapplaces.build_all()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, old, srv


@pytest.fixture(params=[True, False], ids=["map", "articles"], scope="module")
def served(request, tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    httpd, old, srv = _serve(tmp_path_factory.mktemp("single"), request.param)
    assert len(srv._zim_list_cache) == 1, "exactly one source is installed"
    yield "http://127.0.0.1:%d" % httpd.server_address[1], request.param
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


@pytest.fixture()
def page(served):
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    br = pw.chromium.launch()
    pg = br.new_page(viewport=VIEW, has_touch=True, is_mobile=True)
    yield pg
    br.close()
    pw.stop()


def _ready(pg):
    """The page is up and has met its library, and Zimi has had its say about
    where to put the person (it opens a lone source)."""
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && !!zimsCache && zimsCache.length === 1",
        timeout=15000,
    )
    pg.wait_for_timeout(1500)


def _type_near(pg, text):
    pg.locator("#q").click()
    pg.keyboard.type(text, delay=10)


def test_near_typed_in_the_box_ends_in_an_answer(served, page):
    base, is_map = served
    page.goto(base + "/")
    _ready(page)
    _type_near(page, "near:Boston 5km")
    if is_map:
        # The map's box: the places near, nearest first; Enter flies to the first.
        page.wait_for_selector(".suggest-item.sg-place", timeout=10000)
        rows = page.evaluate(
            "() => [...document.querySelectorAll('.suggest-item')].map(r => r.innerText)"
        )
        assert rows[0].startswith("Boston"), rows
        page.keyboard.press("Enter")
        page.wait_for_function("() => location.hash.startsWith('#map=')", timeout=10000)
        assert "42.3" in page.url and "-71.0" in page.url, page.url
        # The reader loaded: its page is in the frame and its spinner is hidden.
        page.wait_for_function(
            """() => {
              const f = document.getElementById('reader-frame');
              const d = f && f.contentDocument;
              return document.getElementById('reader-loading').classList.contains('hidden')
                && !!d && !!d.body && (d.body.textContent || '').length > 0;
            }""",
            timeout=10000,
        )
    else:
        page.keyboard.press("Enter")
        page.wait_for_selector(".near-from", timeout=15000)
        text = page.locator("#output").inner_text()
        assert (
            "No installed map names a place called" in text and "Boston" in text
        ), text
        assert "No results found" not in text, text


def test_near_opened_from_a_link_ends_in_an_answer(served, page):
    base, is_map = served
    page.goto(base + "/?q=near%3ASpringfield%205km")
    page.wait_for_selector(".near-from", timeout=15000)
    text = page.locator("#output").inner_text()
    if is_map:
        assert (
            "Springfield" in text and page.locator(".result.map-place").count() >= 1
        ), text
    else:
        assert "No installed map names a place called" in text, text
