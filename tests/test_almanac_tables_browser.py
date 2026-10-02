"""The Almanac's Tables and Calculations in a real browser.

On the shipped files, served by Zimi, in headless Chromium at a phone's width
(390px), San Francisco chosen as the place:

  1. The tiles: two rows, every table and calculation, scrolling inside
     themselves; the page never scrolls sideways.
  2. Every table opens with rows, its time window changes them (a day, a
     month, a year), and the print rules are there for it.
  3. Every calculation shows an answer from its defaults, with no button.
  4. Inputs: a place searched and picked (San Francisco to New York, about
     4,130 km); a unit picked (100 °F is 37.78 °C); a number dragged
     sideways and typed; a date's drum changed.
  5. Back (the view's, Escape, the browser's) returns to the Almanac where
     it was, still open.

The sums themselves are held in tests/test_almanac_tables.cjs.

Run: pytest tests/test_almanac_tables_browser.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
VIEW = {"width": 390, "height": 844}
SF = {
    "lat": 37.7749,
    "lon": -122.4194,
    "name": "San Francisco, California, United States",
}
TABLES = [
    "sunmoon",
    "tides",
    "twilight",
    "phases",
    "seasons",
    "calendars",
    "nav",
    "stars",
    "eclipses",
    "suntime",
]
CALCS = [
    "distance",
    "sundial",
    "sunmoonday",
    "units",
    "sight",
    "days",
    "convert",
    "zones",
]
DRAWN = (
    "() => { var o = document.getElementById('tb-out'); var a = document.getElementById('tk-answer');"
    " return (o && !o.classList.contains('tb-busy') && o.firstChild && !o.querySelector('.tb-wait'))"
    " || (a && a.textContent.length > 0); }"
)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("tables")
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
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(
            viewport=VIEW,
            device_scale_factor=2,
            has_touch=True,
            service_workers="block",
            locale="en-US",
            timezone_id="America/Los_Angeles",
            reduced_motion="reduce",
        )
        ctx.add_init_script(
            "localStorage.setItem('zimi_almanac_place', %s);"
            % json.dumps(json.dumps(SF))
        )
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function("() => document.getElementById('alm-group-tables')")
        pg.evaluate("typeof _cancelAllRAF === 'function' && _cancelAllRAF()")
        yield pg
        br.close()


def _open(pg, id_):
    pg.evaluate("(id) => _almRefOpen(id)", id_)
    pg.wait_for_function(
        "(id) => window.AlmanacRef && document.getElementById('alm-ref') && document.getElementById('alm-ref-title')",
        arg=id_,
        timeout=30000,
    )
    pg.wait_for_function(DRAWN, timeout=60000)


def _rows(pg):
    return pg.evaluate(
        "document.querySelectorAll('#tb-out tbody tr:not(.tb-grp)').length"
    )


def _no_side_scroll(pg):
    return pg.evaluate(
        "() => { var r = document.getElementById('alm-ref'), c = document.getElementById('almanac-content');"
        " return document.documentElement.scrollWidth <= innerWidth && c.scrollWidth <= c.clientWidth"
        " && (!r || r.scrollWidth <= r.clientWidth); }"
    )


def _seg(pg, v):
    pg.click("[data-tk-seg='win'][data-v='%s']" % v)
    pg.wait_for_timeout(50)
    pg.wait_for_function(DRAWN, timeout=60000)


def test_the_tiles(page):
    tiles = page.evaluate(
        "[...document.querySelectorAll('.alm-tile')].map(b => b.dataset.tb)"
    )
    assert tiles == TABLES + CALCS
    assert page.evaluate("document.querySelectorAll('.alm-tiles').length") == 2
    # Each row scrolls inside itself; the print chips are gone.
    assert page.evaluate(
        "[...document.querySelectorAll('.alm-tiles')].every(r => r.scrollWidth > r.clientWidth)"
    )
    assert page.evaluate("document.querySelectorAll('.alm-sheet').length") == 0
    assert _no_side_scroll(page)


@pytest.mark.parametrize("id_", TABLES)
def test_every_table_opens_and_its_window_changes_its_rows(page, id_):
    _open(page, id_)
    assert page.evaluate("document.getElementById('alm-ref-title').textContent")
    if id_ == "tides":
        # The station is the Almanac's own (its data arrives with the tide section).
        page.wait_for_function(
            "() => typeof _at !== 'undefined' && _at.data", timeout=30000
        )
        page.evaluate("AlmanacRef.open('tides')")
        page.wait_for_function(DRAWN)
    _seg(page, "day")
    day = _rows(page)
    _seg(page, "month")
    month = _rows(page)
    if id_ in ("sunmoon", "twilight", "tides", "calendars", "suntime"):
        assert day == 1 and month >= 28, (id_, day, month)
    elif id_ == "nav":
        assert day > month or day >= 24, (id_, day, month)
    _seg(page, "year")
    year = _rows(page)
    if id_ in ("phases", "seasons", "eclipses", "stars"):
        assert year > 0 and year >= month, (id_, month, year)
    if id_ == "seasons":
        assert year == 4
    assert _no_side_scroll(page)
    # Print: the rules that make the view the page, and its heading for paper.
    assert page.evaluate(
        "document.querySelector('#tb-print-head .tb-printhead h1') !== null"
    )
    page.emulate_media(media="print")
    page.evaluate("document.documentElement.classList.add('alm-ref-print')")
    shown = page.evaluate(
        "() => [getComputedStyle(document.querySelector('.tb-printhead')).display,"
        " getComputedStyle(document.querySelector('.tb-head')).display,"
        " getComputedStyle(document.querySelector('.tb-controls')).display]"
    )
    page.evaluate("document.documentElement.classList.remove('alm-ref-print')")
    page.emulate_media(media="screen")
    assert shown == ["block", "none", "none"], shown
    assert not page.errors, page.errors


@pytest.mark.parametrize("id_", CALCS)
def test_every_calculation_answers_from_its_defaults(page, id_):
    _open(page, id_)
    big = page.evaluate("document.querySelector('.tk-big').textContent")
    assert big and big != "–", (id_, big)
    assert page.evaluate("document.querySelectorAll('#tk-working tr').length") > 0
    assert page.evaluate(
        "document.querySelector('.tk-calc, button[data-calculate]') === null"
    )
    assert _no_side_scroll(page)
    assert not page.errors, page.errors


def _pick_place(page, key, query):
    page.click("[data-tk-place='%s']" % key)
    page.fill(".tk-pop .tk-search", query)
    page.click(".tk-pop .tk-opt")


def test_distance_after_picking_places(page):
    _open(page, "distance")
    _pick_place(page, "a", "San Francisco")
    _pick_place(page, "b", "New York")
    page.click("[data-tk-seg='unit'][data-v='km']")
    big = page.evaluate("document.querySelector('.tk-big').textContent")
    km = float(big.split(" ")[0].replace(",", ""))
    assert abs(km - 4130) < 15, big


def test_units_after_picking_and_typing(page):
    _open(page, "units")
    page.click("[data-tk-pick='kind']")
    page.click(".tk-pop .tk-opt[data-v='temperature']")
    page.click("[data-tk-pick='from']")
    page.click(".tk-pop .tk-opt[data-v='f']")
    page.click("[data-tk-pick='to']")
    page.click(".tk-pop .tk-opt[data-v='c']")
    # Tap the number to type it.
    page.click("[data-tk='v']")
    page.fill("[data-tk='v'] .tk-in", "100")
    page.keyboard.press("Enter")
    assert page.evaluate("document.querySelector('.tk-big').textContent") == "37.78 °C"
    # Drag it sideways: it moves, and the answer follows.
    box = page.locator("[data-tk='v']").bounding_box()
    y = box["y"] + box["height"] / 2
    page.mouse.move(box["x"] + 5, y)
    page.mouse.down()
    page.mouse.move(box["x"] + 5 + 70, y, steps=8)
    page.mouse.up()
    v = page.evaluate("_tb.calc.units.v")
    assert v > 100, v
    assert page.evaluate("document.querySelector('.tk-big').textContent") != "37.78 °C"
    # And the keys.
    page.focus("[data-tk='v']")
    before = page.evaluate("_tb.calc.units.v")
    page.keyboard.press("ArrowUp")
    assert page.evaluate("_tb.calc.units.v") == before + 1


def test_a_date_drum_and_an_angle(page):
    _open(page, "sight")
    before = page.evaluate("_tb.calc.sight.ms")
    page.click("[data-tk-date='ms']")
    page.focus("[data-tk='ms.day']")
    page.keyboard.press("ArrowUp")
    assert page.evaluate("_tb.calc.sight.ms") - before == 86400000
    page.click("[data-tk-done]")
    # An angle typed the navigator's way.
    page.click("[data-tk='lat']")
    page.fill("[data-tk='lat'] .tk-in", "41 27.3 N")
    page.keyboard.press("Enter")
    assert abs(page.evaluate("_tb.calc.sight.lat") - 41.455) < 1e-9
    assert (
        page.evaluate("document.querySelector(\"[data-tk='lat'] .tk-v\").textContent")
        == "41° 27.3′"
    )


def test_back_returns_to_the_almanac_where_it_was(page):
    page.evaluate(
        "window.AlmanacRef && document.getElementById('alm-ref') && AlmanacRef.close()"
    )
    page.wait_for_timeout(300)
    page.evaluate("document.getElementById('alm-group-tables').scrollIntoView()")
    # The late sections (the tide) and the phone's header settle first.
    page.wait_for_timeout(2000)
    page.evaluate("document.getElementById('alm-group-tables').scrollIntoView()")
    page.wait_for_timeout(500)
    top = page.evaluate("document.getElementById('almanac-content').scrollTop")
    page.evaluate("document.querySelector(\".alm-tile[data-tb='seasons']\").click()")
    page.wait_for_function(DRAWN, timeout=60000)
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.getElementById('alm-ref')")
    assert page.evaluate("_almanacOpen")
    assert (
        abs(page.evaluate("document.getElementById('almanac-content').scrollTop") - top)
        < 2
    )
    # The browser's Back: the view goes, the Almanac stays.
    page.evaluate("document.querySelector(\".alm-tile[data-tb='units']\").click()")
    page.wait_for_function(DRAWN, timeout=60000)
    page.go_back()
    page.wait_for_function("() => !document.getElementById('alm-ref')")
    page.wait_for_timeout(300)
    assert page.evaluate("_almanacOpen")
    # The view's own Back.
    page.evaluate("document.querySelector(\".alm-tile[data-tb='days']\").click()")
    page.wait_for_function(DRAWN, timeout=60000)
    page.click("[data-tb-close]")
    page.wait_for_function("() => !document.getElementById('alm-ref')")
    page.wait_for_timeout(300)
    assert page.evaluate("_almanacOpen")
    assert not page.errors, page.errors
