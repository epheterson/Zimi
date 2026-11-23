"""The Almanac while its clock runs fast, in a real browser.

  1. Nothing is cut off: the sections held for the throw may grow (a six-week month), never clip their foot, and
     never shrink until the clock stops.
  2. How much follows the clock goes by the machine's level: at Full the star chart and the analemma are drawn every
     frame while their motion reads, at Light neither is drawn until the clock stops.

Run: pytest tests/test_almanac_travel_browser.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

VIEW = {"width": 390, "height": 844}
PLACE = {"lat": 40.71, "lon": -74.01, "name": "New York"}
POLL_MS = 100

COUNT = """() => {
  window.__drawn = { star: 0, ana: 0, frames: 0 };
  const wrap = (n, k) => { const o = window[n]; window[n] = function () { window.__drawn[k]++; return o.apply(this, arguments); }; };
  wrap('_starChartTravelDraw', 'star'); wrap('_renderAnalemma', 'ana');
  (function f() { window.__drawn.frames++; if (!window.__stop) requestAnimationFrame(f); })();
}"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("travel")
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
        br = pw.chromium.launch()
        yield br
        br.close()


def _open(browser, served, cap):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        locale="en-US",
        timezone_id="America/New_York",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %s); localStorage.setItem('zimi_cap', %r); } catch (e) {}"
        % (json.dumps(json.dumps(PLACE)), cap)
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _almPanelsReady !== 'undefined' && _almPanelsReady",
        timeout=60_000,
        polling=POLL_MS,
    )
    return ctx, pg


def test_a_fast_throw_never_clips_the_calendar_or_shrinks_it(browser, served):
    """Through a five-week November, a six-week January and a five-week February: the calendar is never cut off, and
    once it has grown it keeps that height until the clock stops ("if it ever grows, don't let it shrink so that
    the page doesn't bounce"); stopped, it settles to the month's own height."""
    ctx, pg = _open(browser, served, "full")
    try:
        pg.evaluate("() => { _almClockSetRate(0); _almScrubSettle(new Date(2026, 10, 20, 12)); document.getElementById('almanac-calendar').scrollIntoView({ block: 'start' }); }")
        pg.evaluate("() => _almClockSetRate(86400 * 5)")
        seen = pg.evaluate("""async () => {
          let clip = 0, tallest = 0, shrank = 0, frozen = true;
          for (let i = 0; i < 200 && _almFocusInstant() < new Date(2027, 1, 12); i++) {
            await new Promise(r => setTimeout(r, 40));
            const c = document.getElementById('almanac-calendar'), h = c.offsetHeight;
            frozen = frozen && _almTravelFrozen;
            clip = Math.max(clip, c.scrollHeight - c.clientHeight);
            if (h < tallest - 1) shrank = Math.max(shrank, tallest - h);
            tallest = Math.max(tallest, h);
          }
          return { clip, tallest, shrank, frozen, at: _almFocusInstant().toDateString() };
        }""")
        pg.evaluate("() => _almClockSetRate(0)")
        pg.wait_for_function("() => !_almTravelFrozen", timeout=10_000)
        settled = pg.evaluate("() => document.getElementById('almanac-calendar').offsetHeight")
        pg.evaluate("() => _almClockSetRate(1)")
        assert seen["frozen"], seen
        assert seen["clip"] <= 1, seen
        assert seen["shrank"] == 0, seen
        assert settled < seen["tallest"], (settled, seen)   # February is shorter than January: it settles once stopped
        assert pg.errors == [], pg.errors
    finally:
        ctx.close()


def _charts_during_throw(pg, rate):
    pg.evaluate(
        "() => { _almClockSetRate(0); _almScrubSettle(new Date(2026, 10, 20, 21)); }"
    )
    pg.evaluate(
        "() => document.getElementById('almanac-starchart').scrollIntoView({ block: 'center' })"
    )
    pg.wait_for_timeout(600)  # the observers have said what is on screen
    pg.evaluate(COUNT)
    pg.evaluate("(r) => _almClockSetRate(r)", rate)
    pg.wait_for_timeout(2000)
    drawn = pg.evaluate("() => { window.__stop = 1; return window.__drawn; }")
    pg.evaluate("() => _almClockSetRate(1)")
    return drawn


def test_at_full_the_star_chart_turns_every_frame(browser, served):
    ctx, pg = _open(browser, served, "full")
    try:
        drawn = _charts_during_throw(
            pg, 3600
        )  # an hour a second: the sky turns 15 degrees a second
        assert drawn["star"] >= drawn["frames"] * 0.8, drawn
        assert pg.errors == [], pg.errors
    finally:
        ctx.close()


def test_at_light_the_charts_wait_for_the_clock_to_stop(browser, served):
    ctx, pg = _open(browser, served, "light")
    try:
        drawn = _charts_during_throw(pg, 3600)
        assert drawn["star"] == 0 and drawn["ana"] == 0, drawn
        assert drawn["frames"] > 20, drawn
        assert pg.errors == [], pg.errors
    finally:
        ctx.close()
