"""The Almanac's tide section in a real browser, and the sections that arrive
after the first paint.

On the shipped files, served by Zimi, in headless Chromium at a phone's width,
San Francisco (Golden Gate) chosen as the place:

  1. Nothing moves under the reader. The tide section and the inscriptions
     are drawn after the page; scrolled to what lies below either before it
     arrives, that content stays within a few pixels of where it was.
  2. The tide section holds its own height: on a second visit the space it
     keeps before it draws is the height it draws at.
  3. One clock. A time-machine frame moves the figure's Moon and the day's
     amber line without drawing the section again; a day in the month is a
     day to go to.
  4. Springs and neaps come from the harbour's own ranges: the days after a
     full Moon at San Francisco are springs, the days after a quarter neaps;
     at Pensacola, where the tide is once a day, the month follows the Moon's
     declination instead.

The predictions themselves are held to NOAA in tests/test_almanac_tides.cjs.

Run: pytest tests/test_almanac_tides_browser.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
VIEW = {"width": 390, "height": 844}
SF = {"lat": 37.8063, "lon": -122.4659, "name": "San Francisco"}
PENSACOLA = {"lat": 30.4044, "lon": -87.2112, "name": "Pensacola"}
POLL_MS = 100
STILL_PX = 3
DRAWN = "() => !!document.querySelector('#almanac-place .at-section')"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("tides")
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
def browser(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


def _context(browser, place=SF):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        locale="en-US",
    )
    ctx.add_init_script(
        "sessionStorage.setItem('zimi_almanac_location', %s);"
        % json.dumps(json.dumps(place))
    )
    return ctx


def _open(ctx, served):
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => document.getElementById('almanac-place') && document.querySelector('.alm-ref-entry')",
        polling=POLL_MS,
    )
    return pg, errors


def _top(pg, sel):
    # Within the Almanac's own scroller: the bar above it slides on its own.
    return pg.evaluate(
        "(s) => document.querySelector(s).getBoundingClientRect().top"
        " - document.getElementById('almanac-content').getBoundingClientRect().top",
        sel,
    )


@pytest.mark.parametrize(
    "below, arrived, held",
    [
        # The orrery, under the tide section, its module and stations.
        ("#almanac-orrery", DRAWN, "**/almanac-place?*"),
        # The long-haul sheets, under the inscriptions, at the page's end.
        (
            ".alm-ref-entry",
            "() => document.getElementById('almanac-rosetta').children.length > 0",
            "**/static/rosetta/manifest.json",
        ),
    ],
)
def test_a_late_section_does_not_move_what_is_below_it(
    browser, served, below, arrived, held
):
    ctx = _context(browser)
    waiting = []
    # The late part is held back until the reader is already looking below
    # it, the worst case (on a busy phone, or a slow disk).
    ctx.route(held, lambda route: waiting.append(route))
    try:
        pg, errors = _open(ctx, served)
        pg.wait_for_function(
            "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
            polling=POLL_MS,
        )
        pg.wait_for_timeout(500)
        assert not pg.evaluate(arrived)
        pg.evaluate(
            "(s) => document.querySelector(s).scrollIntoView({ block: 'center' })",
            below,
        )
        # The bar above the Almanac slides away on a scroll; let it settle.
        pg.wait_for_timeout(2000)
        before = _top(pg, below)
        assert 0 <= before < VIEW["height"], "%s is in view" % below
        for i in range(600):
            if waiting:
                break
            pg.wait_for_timeout(POLL_MS)
        assert waiting, "the late part was asked for"
        while waiting:
            waiting.pop().continue_()
        pg.wait_for_function(arrived, polling=POLL_MS, timeout=60000)
        pg.wait_for_timeout(600)
        after = _top(pg, below)
        assert abs(after - before) <= STILL_PX, (below, before, after)
        assert not errors, errors
    finally:
        ctx.close()


def test_the_tide_section_keeps_the_height_it_will_draw_at(browser, served):
    ctx = _context(browser)
    try:
        pg, _ = _open(ctx, served)
        pg.wait_for_function(DRAWN, polling=POLL_MS, timeout=60000)
        drawn = pg.evaluate("document.getElementById('almanac-place').offsetHeight")
        pg.close()
        # A second visit: the space kept before drawing is the drawn height.
        pg, errors = _open(ctx, served)
        kept = pg.evaluate(
            "parseFloat(document.getElementById('almanac-place').style.minHeight) || 0"
        )
        assert abs(kept - drawn) <= STILL_PX, (kept, drawn)
        pg.wait_for_function(DRAWN, polling=POLL_MS, timeout=60000)
        assert (
            pg.evaluate("document.getElementById('almanac-place').style.minHeight")
            == ""
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_the_tide_follows_the_one_clock(browser, served):
    ctx = _context(browser)
    try:
        pg, errors = _open(ctx, served)
        pg.wait_for_function(DRAWN, polling=POLL_MS, timeout=60000)
        pg.evaluate("_almScrubSettle(new Date('2026-10-01T19:00:00Z'))")
        pg.wait_for_function(DRAWN, polling=POLL_MS)
        pg.evaluate("document.querySelector('#almanac-place .at-section')._mark = 1")
        moon0 = pg.evaluate(
            "document.getElementById('at-fig-moon').getAttribute('transform')"
        )
        x0 = float(
            pg.evaluate("document.getElementById('at-now-line').getAttribute('x1')")
        )
        # A frame two hours on, as the time machine sends it while it travels.
        pg.evaluate("_almTravelLive(new Date('2026-10-01T21:00:00Z'))")
        x1 = float(
            pg.evaluate("document.getElementById('at-now-line').getAttribute('x1')")
        )
        assert x1 > x0 + 10, (x0, x1)
        # Five days on: the Moon has gone round.
        pg.evaluate("_almTravelLive(new Date('2026-10-06T21:00:00Z'))")
        assert (
            pg.evaluate(
                "document.getElementById('at-fig-moon').getAttribute('transform')"
            )
            != moon0
        )
        # The day's line hides once the frame leaves the day drawn.
        assert pg.evaluate("document.getElementById('at-now').style.display") == "none"
        # The frames drew nothing new: the same section element.
        assert pg.evaluate("document.querySelector('#almanac-place .at-section')._mark === 1")
        # A bar is a day to go to: three days on, the same time of day.
        pg.evaluate("_almScrubSettle(new Date('2026-10-01T19:00:00Z'))")
        pg.locator(".at-m-day").nth(14 + 3).click()
        assert (
            pg.evaluate("_almFocusInstant().toISOString()")
            == "2026-10-04T19:00:00.000Z"
        )
        assert pg.locator(".at-m-day.on").count() == 1
        assert not errors, errors
    finally:
        ctx.close()


@pytest.mark.parametrize(
    "place, iso, kind",
    [
        # Full Moon 26 Sep 2026: San Francisco's biggest ranges follow it,
        # three to four days late.
        (SF, "2026-09-30T19:00:00Z", "spring"),
        # Last quarter 3 Oct: the smallest follow it, as late.
        (SF, "2026-10-08T19:00:00Z", "neap"),
        (SF, "2026-10-04T19:00:00Z", "easing"),
        (SF, "2026-09-28T19:00:00Z", "growing"),
    ],
)
def test_springs_and_neaps_are_the_harbours_own(browser, served, place, iso, kind):
    ctx = _context(browser, place)
    try:
        pg, errors = _open(ctx, served)
        pg.wait_for_function(DRAWN, polling=POLL_MS, timeout=60000)
        got = pg.evaluate(
            "(iso) => _atWhyState(_atTideStation(), new Date(iso).getTime()).kind", iso
        )
        assert got == kind, (iso, got)
        assert not errors, errors
    finally:
        ctx.close()


def test_a_once_a_day_tide_follows_the_moons_declination(browser, served):
    ctx = _context(browser, PENSACOLA)
    try:
        pg, errors = _open(ctx, served)
        pg.wait_for_function(DRAWN, polling=POLL_MS, timeout=60000)
        assert pg.evaluate("_atDiurnal(_atTideStation())")
        st = pg.evaluate("_atWhyState(_atTideStation(), Date.now())")
        assert st["desc"] == "alm_tide_why_diurnal_desc"
        assert st["kind"] in ("tropic", "equatorial", "growing", "easing")
        assert not errors, errors
    finally:
        ctx.close()
