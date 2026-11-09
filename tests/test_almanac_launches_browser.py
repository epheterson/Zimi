"""The Launches list in the 3D Earth, driven in headless Chromium at a phone's size.

A public example: Starlink Group 4-31 (Falcon 9, Vandenberg, 2022-10-27 6:14 pm PDT, GCAT tag 2022-141) watched from
Los Angeles. The page loads nothing of the launches until the button is pressed, the list filters, a launch opens at
its pad at lift-off with its ascent drawn, the place says what it could see, and "From here" lands in the live sky.
LAUNCHES_SHOTS=<folder> saves a screenshot of each state there (the test does not read them: a person does).

Run: pytest tests/test_almanac_launches_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = os.environ.get(
    "LAUNCHES_GL_ARGS",
    "--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist",
).split()
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":34.05,"lon":-118.24,"name":"Los Angeles"}'
READY_MS = 400_000
SHOTS = os.environ.get("LAUNCHES_SHOTS", "")
TAG = "2022-141"
LIFTOFF_MS = 1_666_919_640_000  # 2022-10-28 01:14 UTC
CLOCK_SLACK_MS = 3_000


@pytest.fixture(scope="module")
def browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


@pytest.fixture
def served(tmp_path):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    (tmp_path / "zims").mkdir()
    (tmp_path / "data").mkdir()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp_path / "zims"), str(tmp_path / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _shot(pg, name):
    if SHOTS:
        pg.screenshot(path=os.path.join(SHOTS, name))


def test_a_launch_opens_at_its_pad_and_says_what_la_could_see(browser, served):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); } catch (e) {}" % PLACE
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    try:
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=READY_MS,
        )
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=READY_MS,
            polling=250,
        )
        # Nothing of the launches is loaded until the button is pressed.
        assert (
            pg.evaluate("typeof _alToggle + typeof _lfAscent") == "undefinedundefined"
        )
        pg.click("#ae-launch-btn")
        pg.wait_for_function(
            "() => typeof _al !== 'undefined' && (_al.state === 'ready' || _al.state === 'failed')",
            timeout=READY_MS,
            polling=250,
        )
        assert pg.evaluate("_al.state") == "ready"
        assert pg.evaluate("_al.rows.length") > 7000
        _shot(pg, "launches-list.png")
        # Filter by year, then by site: every row left matches both.
        pg.select_option("#al-year", "2022")
        pg.select_option("#al-site", "Vandenberg")
        rows = pg.eval_on_selector_all(".al-row", "els => els.length")
        assert 0 < rows < 100
        _shot(pg, "launches-filtered.png")
        # Open Starlink Group 4-31 (found by its designator).
        pg.evaluate(
            "(tag) => _alOpenLaunch(_al.rows.findIndex(function (r) { return r[15] === tag; }))",
            TAG,
        )
        pg.wait_for_function(
            "() => _al.view === 'launch' && _al.flight", timeout=READY_MS
        )
        # The clock is at lift-off, and the ascent is drawn.
        shown = pg.evaluate("_aeDisplayMs()")
        assert abs(shown - LIFTOFF_MS) < CLOCK_SLACK_MS * 10, shown
        assert (
            pg.evaluate("_al.flight.family") == "falcon"
            and pg.evaluate("_al.flight.points.length") == 526
        )
        pg.wait_for_timeout(1500)
        assert (
            pg.evaluate("_al.track.visible && _al.track.geometry.drawRange.count")
            == 526
        )
        text = pg.inner_text(".al-sheet")
        assert "Starlink Group 4-31" in text and "Vandenberg" in text
        assert (
            pg.evaluate("_al.sight.seen") is True
        )  # a twilight Falcon 9 from Vandenberg is up over Los Angeles
        assert "Visible from here" in text
        assert pg.evaluate("_al.dep && _al.dep.n") == 53
        _shot(pg, "launch-at-pad.png")
        # Ten seconds on the clock: the rocket is a point on the track, and the plume point is out.
        pg.evaluate("_aeGoTo(%d)" % (LIFTOFF_MS + 200_000))
        pg.wait_for_timeout(2500)
        assert pg.evaluate("_al.rocket.geometry.drawRange.count") >= 2
        _shot(pg, "launch-ascent.png")
        pg.evaluate("_al.sheetEl.hidden = true")
        pg.wait_for_timeout(600)
        _shot(pg, "launch-ascent-clear.png")
        pg.evaluate("_al.sheetEl.hidden = false")
        # The batch, once let go: 53 points.
        pg.evaluate("_aeGoTo(%d)" % (LIFTOFF_MS + 40 * 60_000))
        pg.wait_for_timeout(2500)
        assert pg.evaluate("_al.dots.geometry.drawRange.count") == 53
        _shot(pg, "launch-batch.png")
        pg.evaluate("_aeGoTo(%d)" % (LIFTOFF_MS - 2_000))
        pg.wait_for_timeout(1200)
        # "From here": the sky, at the place, at the rise.
        pg.click("#al-here")
        pg.wait_for_function(
            "() => typeof _aeIsOpen !== 'undefined' && !_aeIsOpen",
            timeout=READY_MS,
            polling=250,
        )
        pg.wait_for_timeout(1500)
        pg.evaluate("_almScrubSettle(new Date(%d))" % (LIFTOFF_MS + 75_000))
        pg.wait_for_timeout(2500)
        pg.evaluate("_skyState.canvas.scrollIntoView({ block: 'center' })")
        pg.wait_for_timeout(800)
        _shot(pg, "launch-sky.png")
        assert not [
            e for e in errors if "launch" in e.lower() or "_al" in e or "_lf" in e
        ], errors
    finally:
        ctx.close()
