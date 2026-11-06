"""near: in the search bar, in a real browser at a phone's width.

A search for near:Springfield 12km lists the towns around Springfield nearest
first, each with its distance, under a line saying what it measured from; the
query shows as a chip whose x takes the distance with it; and with the
Almanac's place beside the made-up town, of the two Springfields that one is
taken, and the line says so.

Run: pytest tests/test_near_live.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402

VIEW = {"width": 390, "height": 844}
ROWS = """() => Array.from(document.querySelectorAll('.result.map-place')).map(a =>
  [a.dataset.title, (a.querySelector('.snippet') || {}).textContent || ''])"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import test_mapplaces as fixture
    from conftest_zim import build_fixture_zim

    import zimi.server as srv
    from zimi import mapplaces
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("near")
    zdir = tmp / "zims"
    zdir.mkdir()
    build_fixture_zim(
        str(zdir / f"{fixture.NAME}.zim"),
        {"Scraper": "maps2zim v0.2.1"},
        files=fixture._map_files(),
    )
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(zdir), str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    mapplaces._reset_for_tests()
    srv.load_cache(force=True)
    mapplaces.build_all()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], fixture
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _page(served, place=None):
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    br = pw.chromium.launch()
    pg = br.new_page(viewport=VIEW, has_touch=True, is_mobile=True)
    if place:
        pg.add_init_script(
            "localStorage.setItem('zimi_almanac_place', %s)"
            % json.dumps(json.dumps(place))
        )
    return pw, br, pg


def test_near_lists_the_towns_around_with_their_distance(served):
    base, fx = served
    pw, br, pg = _page(served, {"lat": fx.SPRINGFIELD[0], "lon": fx.SPRINGFIELD[1]})
    try:
        pg.goto(base + "/?q=" + "near%3ASpringfield%2012km")
        pg.wait_for_selector(".result.map-place", timeout=15000)
        rows = pg.evaluate(ROWS)
        assert [r[0] for r in rows] == [
            "Springfield",
            "Fairview",
            "Oak Grove",
            "Greenville",
        ], rows
        assert all(" km" in r[1] and "town" in r[1] for r in rows), rows
        line = pg.locator(".near-from").inner_text()
        assert "12 km" in line and "Springfield" in line, line
        # Of two Springfields, the one nearest the Almanac's place, and said so.
        assert "nearest to you" in pg.locator(".near-which").inner_text()
        # The chip's x takes near: and its distance away together.
        x = pg.locator(".search-chip-x").first
        assert x.get_attribute("data-q").strip() == ""
        assert (
            pg.locator(".search-chip-label").first.inner_text()
            == "within 12 km of Springfield"
        )
    finally:
        br.close()
        pw.stop()


def test_without_a_place_of_your_own_the_largest_is_taken(served):
    base, fx = served
    pw, br, pg = _page(served)
    try:
        pg.goto(base + "/?q=" + "near%3ASpringfield%205mi")
        pg.wait_for_selector(".near-which", timeout=15000)
        assert "the largest" in pg.locator(".near-which").inner_text()
        rows = pg.evaluate(ROWS)
        assert rows and rows[0][0] == "Springfield" and " mi" in rows[0][1], rows
    finally:
        br.close()
        pw.stop()
