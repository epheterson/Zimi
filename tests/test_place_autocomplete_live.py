"""Places autocomplete in a real browser at a phone's width (390x844).

Typing near:Spri in the search box offers the towns that start so, each as
"Springfield, Illinois, United States", the biggest first; the arrow keys and
Enter, or a tap, put near:"Springfield, Illinois" in the box, ready for a
distance; where after the name ("Paris, Tex") narrows the list; the same
suggestions come in the map's own box; and the line over the results says
which Springfield was taken.

Run, one file at a time:
    ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_place_autocomplete_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402

VIEW = {"width": 390, "height": 844}
SHOTS = os.environ.get("ZIMI_SHOTS")  # a folder to keep the screenshots in
ROWS = """() => Array.from(document.querySelectorAll('#suggest-dropdown .suggest-item, .suggest-dropdown .suggest-item'))
  .map(r => r.innerText.replace(/\\s+/g, ' ').trim())"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import test_place_autocomplete as fixture
    from conftest_zim import build_fixture_zim

    import zimi.server as srv
    from zimi import mapplaces
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("placeslive")
    zdir = tmp / "zims"
    zdir.mkdir()
    files = dict(fixture._map_files())
    files["index.html"] = (
        b"<html><head><title>Map</title></head><body>map</body></html>"
    )
    build_fixture_zim(
        str(zdir / f"{fixture.NAME}.zim"), {"Scraper": "maps2zim v0.2.1"}, files=files
    )
    # A second source, or Zimi opens the only one it has and the box searches inside it.
    build_fixture_zim(str(zdir / "guide_en_2026-01.zim"), {"Title": "Guide"})
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


@pytest.fixture()
def page(served):
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    br = pw.chromium.launch()
    pg = br.new_page(viewport=VIEW, has_touch=True, is_mobile=True)
    yield pg
    br.close()
    pw.stop()


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name))


def _type(pg, text):
    # Keys typed before the page has its sources are lost to it: a cold, slow runner types too early.
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=30000,
    )
    pg.locator("#q").click()
    pg.keyboard.type(text, delay=15)


def _rows(pg):
    pg.wait_for_selector(".suggest-item.sg-place", timeout=10000)
    return pg.evaluate(ROWS)


def _fits(pg):
    """Nothing sticks out past the phone's width: not the page, not the list."""
    return pg.evaluate("""() => {
          const d = document.querySelector('#suggest-dropdown, .suggest-dropdown');
          const r = d.getBoundingClientRect();
          return { page: document.documentElement.scrollWidth, left: r.left, right: r.right,
                   rows: Array.from(d.querySelectorAll('.suggest-item')).every(e => e.scrollWidth <= e.clientWidth + 1) };
        }""")


def test_a_prefix_after_near_offers_the_places_with_where(served, page):
    base, _fx = served
    page.goto(base + "/")
    _type(page, "near:Spri")
    rows = _rows(page)
    assert rows[:2] == [
        "Springfield, Illinois, United States",
        "Springfield, Missouri, United States",
    ], rows
    assert len(rows) == 5
    fit = _fits(page)
    assert (
        fit["page"] <= VIEW["width"]
        and fit["left"] >= 0
        and fit["right"] <= VIEW["width"]
    ), fit
    assert fit["rows"], "a row is wider than its list"
    _shot(page, "near-spri-390.png")


def test_the_keyboard_picks_a_place_and_the_search_says_which(served, page):
    base, _fx = served
    page.goto(base + "/")
    _type(page, "near:Spri")
    _rows(page)
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    assert page.input_value("#q") == 'near:"Springfield, Missouri" '
    # The dropdown closed, nothing searched yet: the distance comes next.
    assert (
        page.locator(".suggest-item.sg-place").count() == 0
        or not page.locator("#suggest-dropdown, .suggest-dropdown").first.is_visible()
    )
    page.keyboard.type("5km")
    page.keyboard.press("Enter")
    page.wait_for_selector(".near-from", timeout=15000)
    line = page.locator(".near-from").first.inner_text()
    assert "5 km" in line and "Springfield, Missouri, United States" in line, line
    chip = page.locator(".search-chip-label").first.inner_text()
    assert chip == "within 5 km of Springfield, Missouri", chip
    _shot(page, "near-picked-390.png")


def test_a_tap_picks_a_place(served, page):
    base, _fx = served
    page.goto(base + "/")
    _type(page, "near:Paris")
    rows = _rows(page)
    assert rows == ["Paris, France", "Paris, Texas, United States"], rows
    page.locator(".suggest-item.sg-place").nth(1).tap()
    assert page.input_value("#q") == 'near:"Paris, Texas" '


def test_where_typed_after_the_name_narrows_the_list(served, page):
    base, _fx = served
    page.goto(base + "/")
    _type(page, "near:Paris, Tex")
    rows = _rows(page)
    assert rows == ["Paris, Texas, United States"], rows
    page.fill("#q", "")
    _type(page, 'near:"Springfield, Ill')
    assert _rows(page) == ["Springfield, Illinois, United States"]


def test_a_distance_or_a_position_is_not_completed(served, page):
    base, _fx = served
    page.goto(base + "/")
    _type(page, "near:39.8,-89.6")
    page.wait_for_timeout(600)
    assert page.locator(".suggest-item.sg-place").count() == 0


def test_the_map_box_offers_them_too(served, page):
    base, fx = served
    page.goto(base + "/?a=" + fx.MAP + "%2Findex.html")
    page.wait_for_selector("#q", timeout=15000)
    page.wait_for_function(
        "() => typeof _isMapPage === 'function' && _isMapPage()", timeout=15000
    )
    _type(page, "near:Spri")
    rows = _rows(page)
    assert rows[0] == "Springfield, Illinois, United States", rows
    page.fill("#q", "")
    _type(page, "Paris, Texas")
    page.wait_for_selector(".suggest-item.sg-place", timeout=10000)
    first = page.evaluate(ROWS)[0]
    assert first.startswith("Paris") and "Texas, United States" in first, first
    fit = _fits(page)
    assert fit["page"] <= VIEW["width"] and fit["right"] <= VIEW["width"], fit
    _shot(page, "map-box-390.png")
