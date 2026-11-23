"""A page nobody is touching costs nothing: Home and the Almanac idle on a slow machine (a 6x CPU throttle).

A dual-core laptop sat at 60% CPU on Home doing nothing, falling when the Almanac card scrolled away: the card's
eighteen twinkling stars repainted it every frame. Checked here: at Light, Home runs no animation and asks for no frame
while idle, and its main thread stays under a budget; where the machine carries it the stars twinkle on the compositor
(no frames asked for) and pause off screen; at the Light level the Almanac's sky is a still picture (no breeze, no
passers-by) and its paints are timed for ZimiCap; a sky scrolled out of view asks for no frames at any level.

Run: pytest tests/test_idle_lean_browser.py -v
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

THROTTLE = 6  # an Intel N3050's single thread against a current laptop's, roughly
IDLE_S = 5
# Home's main thread over the idle window, in percent of wall time under the throttle. Idle Home measured ~1% with
# the stars still (3% when they twinkled); a frame loop at the display's rate is past 20 under this throttle.
HOME_IDLE_BUSY_PCT = 6

COUNT_FRAMES = """
window.__raf = {};
const _raf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = function (fn) { const k = (fn && fn.name) || 'anon'; window.__raf[k] = (window.__raf[k] || 0) + 1; return _raf(fn); };
"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import wiki_fixture
    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("idle")
    (tmp / "data").mkdir()
    wiki_fixture.build_library(str(tmp / "zims"))
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


@pytest.fixture(scope="module")
def browser(served):   # after served: its probe starts a Playwright of its own, which cannot run inside this one
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        yield br
        br.close()


def _page(browser, cap=None):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=3,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        COUNT_FRAMES
        + (
            "try { localStorage.setItem('zimi_cap', %r); } catch (e) {}" % cap
            if cap
            else ""
        )
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    cdp = ctx.new_cdp_session(pg)
    cdp.send("Performance.enable")
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": THROTTLE})
    return pg, cdp


def _task_s(cdp):
    return next(
        m["value"]
        for m in cdp.send("Performance.getMetrics")["metrics"]
        if m["name"] == "TaskDuration"
    )


def _idle(pg, cdp, secs=IDLE_S):
    """Frames asked for (by function name), running animations and main-thread busy % over a window of nothing."""
    pg.evaluate("() => { window.__raf = {}; }")
    t0, w0 = _task_s(cdp), time.time()
    time.sleep(secs)
    busy = (_task_s(cdp) - t0) / (time.time() - w0) * 100
    frames = pg.evaluate("() => window.__raf")
    anims = pg.evaluate(
        "() => document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName || String(a.effect && a.effect.target && a.effect.target.className))"
    )
    return frames, anims, busy


def test_home_idle_runs_nothing(browser, served):
    pg, cdp = _page(browser, "light")
    try:
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_function(
            "() => document.querySelector('.dc-today')", timeout=60_000
        )
        pg.evaluate(
            "() => document.querySelector('.dc-today').scrollIntoView({ block: 'center' })"
        )
        pg.wait_for_timeout(
            4000
        )  # the load's own work (the catalog, the moon's map) is done
        frames, anims, busy = _idle(pg, cdp)
        assert anims == [], anims
        assert sum(frames.values()) == 0, frames
        assert busy < HOME_IDLE_BUSY_PCT, busy
        # The stars are there, still, each at its own brightness.
        stars = pg.evaluate(
            "() => [...document.querySelectorAll('.dc-today .dc-star')].map(e => getComputedStyle(e).opacity)"
        )
        assert len(stars) >= 10 and len(set(stars)) > 3, stars
        assert pg.errors == [], pg.errors
    finally:
        pg.context.close()


def test_stars_twinkle_where_the_machine_carries_it_and_pause_off_screen(browser, served):
    pg, cdp = _page(browser, "full")
    try:
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_function("() => document.querySelector('.dc-today')", timeout=60_000)
        pg.evaluate("() => document.querySelector('.dc-today').scrollIntoView({ block: 'center' })")
        pg.wait_for_function("() => document.querySelector('.dc-today.twinkle:not(.dc-away)')", timeout=30_000)
        pg.wait_for_timeout(3000)   # the strain probe's frames are over
        frames, anims, busy = _idle(pg, cdp)
        assert len(anims) >= 10 and set(anims) == {"dc-twinkle"}, anims
        assert sum(frames.values()) == 0, frames
        assert busy < HOME_IDLE_BUSY_PCT, busy
        assert pg.evaluate("() => getComputedStyle(document.querySelector('.dc-star')).willChange") == "opacity"
        pg.evaluate("() => { const r = document.querySelector('.dc-today').getBoundingClientRect(); window.scrollBy(0, r.bottom + 50); }")
        pg.wait_for_function("() => document.querySelector('.dc-today.dc-away')", timeout=5000)
        assert pg.evaluate("() => document.getAnimations().filter(a => a.playState === 'running').length") == 0
        assert pg.errors == [], pg.errors
    finally:
        pg.context.close()


def _almanac(pg, served):
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _almanacLoaded !== 'undefined' && _almanacLoaded && typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
        timeout=120_000,
    )
    pg.evaluate("() => _skyState.canvas.scrollIntoView({ block: 'center' })")
    pg.wait_for_timeout(3000)


def test_light_almanac_sky_is_a_still_picture(browser, served):
    pg, cdp = _page(browser, "light")
    try:
        _almanac(pg, served)
        assert pg.evaluate("() => ZimiCap.still() && _almStill()")
        assert pg.evaluate("() => _skyState.inView && !document.hidden")
        frames, _, _ = _idle(pg, cdp)
        # No breeze (twelve frames a second) and no plane or meteor: at most a frame for a late satellite answer.
        assert frames.get("_skyLoop", 0) <= 2, frames
        assert pg.evaluate(
            "() => !_skyTimers.sway && !_skyTimers.plane && !_skyTimers.meteor"
        ), pg.evaluate("() => _skyTimers")
        assert pg.errors == [], pg.errors
    finally:
        pg.context.close()


def test_slow_ambient_paints_make_the_sky_still_at_any_level(browser, served):
    pg, cdp = _page(browser, "full")
    try:
        _almanac(pg, served)
        assert pg.evaluate("() => !ZimiCap.still()")
        # Twelve paints past a frame's time: the machine pays for the sky's motion with the page.
        assert pg.evaluate(
            "() => { for (let i = 0; i < 12; i++) ZimiCap.painted(40); return ZimiCap.still() && _almStill(); }"
        )
        pg.evaluate("() => _skyArm()")
        assert pg.evaluate(
            "() => !_skyTimers.sway && !_skyTimers.plane && !_skyTimers.birds"
        ), pg.evaluate("() => _skyTimers")
    finally:
        pg.context.close()


def test_a_sky_scrolled_away_asks_for_no_frames(browser, served):
    pg, cdp = _page(browser, "full")
    try:
        _almanac(pg, served)
        pg.evaluate("() => { const r = document.getElementById('almanac-content'); r.scrollTop = r.scrollHeight; }")
        pg.wait_for_timeout(2000)
        assert pg.evaluate("() => !_skyState.inView"), "the sky did not leave the screen"
        frames, _, _ = _idle(pg, cdp, 3)
        assert frames.get("_skyLoop", 0) == 0, frames
    finally:
        pg.context.close()


# The Almanac at Light, idle: the sky is still and the clocks below are out of sight. Measured at ~1% under this
# throttle; a one-a-second clock tick or satellite poll shows as frames and timers here before it shows in the figure.
ALMANAC_LIGHT_IDLE_BUSY_PCT = 8


def test_light_almanac_idle_asks_for_nothing(browser, served):
    pg, cdp = _page(browser, "light")
    try:
        _almanac(pg, served)
        assert pg.evaluate("() => _tzClockInView === false"), "the world clocks are on screen: this test wants them below"
        frames, anims, busy = _idle(pg, cdp)
        # Nothing on the page asks for a frame: not the clocks out of sight, not their hand. The sky asks only when its
        # stars have drifted a pixel (the live tick), a frame or two at most.
        assert frames.get("_skyLoop", 0) <= 2 and sum(v for k, v in frames.items() if k != "_skyLoop") == 0, frames
        assert anims == [], anims
        assert pg.evaluate("() => !_tzClockRAF && !_tzClockFrame"), "the world clocks tick out of sight"
        # The ISS's elements come with the 3D view's files, which a low-power machine fetches only at a touch: no wait for them.
        assert pg.evaluate("() => typeof _aeLoadSats !== 'function' && !_skyTimers.sats"), pg.evaluate("() => _skyTimers")
        assert busy < ALMANAC_LIGHT_IDLE_BUSY_PCT, busy
        assert pg.errors == [], pg.errors
    finally:
        pg.context.close()


# A frame whose cost is outside the sky's own drawing (here a 30 ms ResizeObserver callback after the frame callbacks,
# standing in for the style, layout, paint and canvas hand-off a slow machine pays): the sky times the whole frame,
# so its motion stops. Timing _skyPaint alone, the governor never saw it.
SLOW_FRAME = """() => {
  const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:1px';
  document.body.appendChild(d);
  new ResizeObserver(() => { const t = performance.now(); while (performance.now() - t < 30) {} }).observe(d);
  let w = 1; (function grow() { d.style.width = (w = 3 - w) + 'px'; requestAnimationFrame(grow); })();
}"""


def test_slow_frames_stop_the_sky_motion_at_full(browser, served):
    pg, cdp = _page(browser, "full")
    try:
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})   # the sky's own paints fast: only the frame around them is slow
        _almanac(pg, served)
        pg.wait_for_function("() => !!_skyTimers.sway", timeout=30_000)
        pg.wait_for_timeout(2500)   # thirty breeze frames at the machine's own pace
        assert pg.evaluate("() => !ZimiCap.still()"), "fast frames made the sky still"
        pg.evaluate(SLOW_FRAME)
        pg.wait_for_function("() => ZimiCap.still()", timeout=15_000)
        pg.wait_for_function("() => !_skyTimers.sway", timeout=5_000)
        # The orrery's scenery spin is the same kind of motion: on screen it holds where it is, and its loop ends.
        pg.evaluate("() => _orreryCanvas.scrollIntoView({ block: 'center' })")
        pg.wait_for_function("() => !_orreryScenery && !_orreryPlaying", timeout=10_000)
        assert pg.errors == [], pg.errors
    finally:
        pg.context.close()


# While the page is still loading (the person keeps touching it, so app.js whenQuiet never runs), the sky shows its still
# picture: no breeze, nobody crossing. Once the page settles, the motion starts.
BUSY_PAGE = "window.__busy = setInterval(() => { if (typeof _quietNote === 'function') _quietNote(); }, 40);"   # what each touch, scroll or key does


def test_sky_motion_waits_for_the_page_to_settle(browser, served):
    pg, cdp = _page(browser, "full")
    try:
        pg.add_init_script(BUSY_PAGE)
        _almanac(pg, served)
        assert pg.evaluate("() => _skyState.paints > 0 && _skyState.inView"), "the still picture is drawn"
        assert pg.evaluate("() => !_skyTimers.sway && !_skyTimers.plane && !_skyTimers.meteor"), pg.evaluate("() => _skyTimers")
        pg.evaluate("() => clearInterval(window.__busy)")
        pg.wait_for_function("() => !!_skyTimers.sway && !!_skyTimers.meteor", timeout=30_000)
        assert pg.errors == [], pg.errors
    finally:
        pg.context.close()
