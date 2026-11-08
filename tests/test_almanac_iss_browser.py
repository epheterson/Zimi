"""The 3D view at the station: the Earth moves under it smoothly, a flight home is not a crawl, a probe keeps its tail.

In headless Chromium at a phone's size. Nothing here times a frame (software GL is far too slow for that): the page's own
loop is driven on a virtual 60 fps clock with the renderer stubbed to a counter, and the rest is state.

Run: pytest tests/test_almanac_iss_browser.py -v
"""

import math
import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
FRAMES = 120  # two virtual seconds at 60 fps
# The old loop drew the station's view four times a second (7 of 120 frames); smooth is a draw nearly every frame.
MIN_DRAWN_SHARE = 0.9
# A flight home from the station was stretched to 13 s by the turn limit; a flight is a couple of seconds.
MAX_FLIGHT_MS = 4000

# Drive the page's own loop (_aeFrame) with a virtual clock; returns the camera and the draw count at every frame.
DRIVE = """([mode]) => {
  var NOW = Date.now(), PERF = performance.now(), RealDate = Date;
  window.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
  performance.now = function () { return PERF; };
  var cbs = [];
  window.requestAnimationFrame = function (cb) { cbs.push(cb); return cbs.length; };
  window.cancelAnimationFrame = function () {};
  var draws = 0;
  _ae.gl.renderer.render = function () { draws++; };
  if (mode === 'paused') { _almFocus = new RealDate(NOW); _almClockSetRate(0); }
  _ae.dirty = true; _ae.raf = 0; if (_ae.idleTimer) clearTimeout(_ae.idleTimer); _ae.idleTimer = 0;
  var out = [];
  for (var i = 0; i < %d; i++) {
    NOW += 1000 / 60; PERF += 1000 / 60;
    var pend = cbs; cbs = [];
    if (!_ae.raf && !pend.length) { if (i %% 6 === 0) _aeKick(); pend = cbs; cbs = []; }   // idle: the loop's own timer, every 100 ms
    pend.forEach(function (cb) { _ae.raf = 0; cb(PERF); });
    var c = _ae.gl.camera.position;
    out.push([c.x, c.y, c.z, draws]);
  }
  window.Date = RealDate;
  return out;
}""" % FRAMES


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("issview")
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


def _open(br, served, target, orbits=None):
    ctx = br.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=1,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r);"
        " %s } catch (e) {}"
        % (
            PLACE,
            PLACE,
            "localStorage.setItem('zimi_ae_orbits', %r);" % orbits if orbits else "",
        )
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    pg.evaluate("(t) => openAlmanacEarth({ target: t })", target)
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=READY_MS,
        polling=200,
    )
    pg.wait_for_function(
        "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
        timeout=60_000,
        polling=200,
    )
    return ctx, pg, errors


def _browser(pw):
    return pw.chromium.launch(args=GL_ARGS)


def _steps(rows):
    return [math.dist(rows[i][:3], rows[i + 1][:3]) for i in range(len(rows) - 1)]


def test_the_earth_moves_under_the_station_every_frame(served):
    """At the station at real time the loop draws on every frame and the camera, riding the station, moves on every one
    (it drew and moved four times a second: the Earth below jerked); with the clock paused it draws nothing new.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "iss")
            assert pg.evaluate("() => _aeStationMoves()")
            rows = pg.evaluate(DRIVE, ["real"])
            steps = _steps(rows)
            moved = sum(1 for s in steps if s > 0)
            assert rows[-1][3] >= MIN_DRAWN_SHARE * FRAMES, rows[-1]
            assert moved >= MIN_DRAWN_SHARE * len(steps), (moved, len(steps))
            mean = sum(steps) / len(steps)
            assert max(steps) < 3 * mean, (
                max(steps),
                mean,
            )  # no frame leaps while the rest stand
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_paused_clock_leaves_the_station_view_still(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "iss")
            rows = pg.evaluate(DRIVE, ["paused"])
            assert not pg.evaluate("() => _aeStationMoves()")
            assert rows[-1][3] <= FRAMES // 6, rows[-1]  # only the idle interval draws
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_shown_instant_carries_on_between_the_clock_s_ticks(served):
    """The page's slow clock steps its instant four times a second; the 3D view reads it carried on at the clock's rate."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "iss")
            got = pg.evaluate("""() => {
                _almFocus = new Date(); _almRate = 2; _almClockSync();
                var base = _almFocus.getTime(), out = {};
                _almClockLast = performance.now() - 100; out.part = _aeDisplayMs() - base;
                _almClockLast = performance.now() - 5000; out.capped = _aeDisplayMs() - base;
                _almClockLast = performance.now(); out.atTick = _aeDisplayMs() - base;
                _almClockSetRate(0); _almClockLast = performance.now() - 100; out.paused = _aeDisplayMs() - base;
                _almFocus = null; _almRate = 1; _almClockSync();
                return out; }""")
            assert 190 <= got["part"] <= 260, got  # 100 ms at two a second
            assert got["capped"] == 2 * pg.evaluate("() => ALM_CLOCK_SLOW_MS"), got
            assert 0 <= got["atTick"] < 20, got
            assert got["paused"] == 0, got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_flight_from_the_station_to_my_place_is_proportionate(served):
    """The locate button from the station flew a shoulder swing between two bodies 1e-4 Earth radii and 1 apart: half a
    turn crammed into 200 ms, stretched by the turn limit to 13 s. The station's pull back to its Earth is one zoom out.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "iss")
            got = pg.evaluate(
                """() => {
                navigator.geolocation.getCurrentPosition = function (ok) { ok({ coords: { latitude: 37.77, longitude: -122.42 } }); };
                _aeLocateMe();
                var f = _ae.fly;
                return { hold: f.hold, total: _aeFlyLead(f) + f.ms + (f.hold ? AE_FLY_TAIL_MS : 0), target: _ae.target }; }"""
            )
            assert got["target"] == "earth" and not got["hold"], got
            assert got["total"] <= MAX_FLIGHT_MS, got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_probe_keeps_its_tail_beside_its_model(served):
    """At a probe, its model drawn, its path still shows (while the Orbits setting says so) rather than going out the
    moment the model shows."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth", orbits="always")
            pg.evaluate("_aeTracksLoad()")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            pg.evaluate(
                "() => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aeUpdate(_aeDisplayMs()); _aePreset('voyager1'); }"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); var I = _ae.gl.crafts && _ae.gl.crafts.voyager1; return !_ae.fly && _ae.target === 'voyager1' && !!I && I.root.visible && I.show > 0.99; }",
                timeout=60_000,
                polling=200,
            )
            got = pg.evaluate(
                """() => { _aeUpdate(_aeDisplayMs()); var t = _ae.gl.probes.trails.voyager1;
                return { dot: _aeProbeCraftDot('voyager1'), shown: t.visible, alpha: t.material.opacity }; }"""
            )
            assert got["dot"] < 0.01 and got["shown"] and got["alpha"] > 0, got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
