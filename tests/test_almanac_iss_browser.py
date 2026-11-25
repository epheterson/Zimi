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

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
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
    pend.forEach(function (cb) { cb(PERF); });   // (the frame runs only as the one the view asked for: its id is still _ae.raf)
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
            # Paused, the clock at the foot opens (its slider shows) and the picture glides up by half of it, once:
            # let that settle, then count.
            pg.evaluate("() => { _almFocus = new Date(); _almClockSetRate(0); }")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return _ae.infoShift === _aeInfoShiftTarget(); }",
                timeout=60_000,
                polling=200,
            )
            # and for the loop to go idle on its own (tiles and the model arriving late each draw a frame).
            pg.wait_for_function(
                "() => !_ae.raf && !_ae.dirty", timeout=60_000, polling=500
            )
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


# The station's distance from its own ring (km): every drawn instant, the ring is the orbit it is on now.
ON_RING = """(offMs) => {
  _almFocus = new Date(Date.now() + offMs); _almClockSetRate(0);
  _ae.gl.renderer.render = function () {};
  _aeUpdate(_aeDisplayMs());
  var g = _ae.gl.issRing.geometry, a = g.attributes.position.array, n = g.drawRange.count, p = _ae.issPos;
  var L = _ae.gl.issRing.position, pts = [], rs = [], rel = [];   // (the vertices are held relative to the station, which the line stands at: 32-bit steps are most of a metre at the Earth's radius)
  for (var i = 0; i < n; i++) { pts.push([a[i * 3] + L.x, a[i * 3 + 1] + L.y, a[i * 3 + 2] + L.z]); rs.push(_aeLen(pts[i])); rel.push(_aeLen([a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]) * AE_EARTH_RADIUS_KM); }
  var best = Infinity;
  for (var i = 0; i < n; i++) {
    var u = pts[i], v = pts[(i + 1) % n], ab = _aeSub(v, u), ap = _aeSub(p, u);
    var t = _aeClamp(_aeDot(ab, ap) / _aeDot(ab, ab), 0, 1);
    best = Math.min(best, _aeLen(_aeSub(_aeAdd(u, _aeScale(ab, t)), p)));
  }
  // the ellipse's own extremes from the station's state (what the ring is the ellipse of): p / (1 +- e), osculating, so its roundness moves with the orbit's phase
  var is = _ae.sats.list.filter(function (q) { return q.iss; })[0], eq = _aeEqEq(_ae.scene), st = _aeSatAt(is, _aeDisplayMs(), eq);
  var sr = _aeRotZ(_aeXyz(st.posKm), eq), sv = _aeRotZ(_aeXyz(st.velKmS), eq), sh = _aeCross(sr, sv), sl = _aeLen(sh), sp = sl * sl / AE_GM_EARTH_KM3_S2;
  var se = _aeLen(_aeSub(_aeScale(_aeCross(sv, sh), 1 / AE_GM_EARTH_KM3_S2), _aeScale(sr, 1 / _aeLen(sr))));
  return { n: n, ecc: se, pMin: sp / (1 + se), pMax: sp / (1 - se), km: best * AE_EARTH_RADIUS_KM, rMin: Math.min.apply(null, rs) * AE_EARTH_RADIUS_KM, rMax: Math.max.apply(null, rs) * AE_EARTH_RADIUS_KM,
    rStation: _aeLen(p) * AE_EARTH_RADIUS_KM, standsAt: _aeLen(_aeSub([L.x, L.y, L.z], p)) * AE_EARTH_RADIUS_KM, middle: rel[n / 2], neighbour: Math.min(rel[n / 2 - 1], rel[n / 2 + 1]), far: Math.max.apply(null, rel) };
}"""
ISS_ECC_MAX = 0.003  # osculating (the station's mean one is 0.0007): about 40 km between the ring's nearest and farthest points
RING_TOLERANCE_KM = (
    0.05  # 50 m: a pixel is 100 m only with the station filling the screen
)


def test_the_station_is_on_its_own_orbit_ring(served):
    """The ring is the ellipse through the station's position and velocity, redrawn each frame with the station as one
    vertex: at any instant, a minute on, hours on or days on, the station lies on it (it stood 3 km off a ring drawn up
    to a minute earlier, and the ring's own ends 15 km apart), and the ring is round at the station's height.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "iss")
            for off in (
                0,
                20_000,
                45_000,
                600_000,
                3_600_000,
                3 * 3_600_000,
                2 * 86_400_000,
            ):
                got = pg.evaluate(ON_RING, off)
                assert got["n"] >= 90, (off, got)
                assert got["km"] < RING_TOLERANCE_KM, (off, got)
                # held relative to the station, finest at it: no kink of two long chords there, no 32-bit jitter beside it
                assert got["standsAt"] < 0.001 and got["middle"] < 0.001, (off, got)
                assert 0 < got["neighbour"] < 20, (off, got)
                # The ring is the osculating ellipse of the station's state, so how round it is moves with the orbit's phase (J2: 13 to 28 km
                # between its nearest and farthest points over one orbit, by the wall clock the test runs at): what is held is that it spans the
                # ellipse's own extremes, and that the osculating eccentricity stays the small one of the station's orbit.
                assert (
                    abs(got["rMin"] - got["pMin"]) < 1
                    and abs(got["rMax"] - got["pMax"]) < 1
                ), (off, got)
                assert got["ecc"] < ISS_ECC_MAX, (off, got)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


# Drive the page's own loop on a virtual 60 fps clock at a clock rate; the view's pull-out, where the camera is, where the
# station is on the screen and whether its ring shows, at every frame.
RIDE = """([rate, frames]) => {
  var NOW = Date.now(), PERF = performance.now() + 1e6, RealDate = Date;
  window.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
  performance.now = function () { return PERF; };
  var cbs = [];
  window.requestAnimationFrame = function (cb) { cbs.push(cb); return cbs.length; };
  window.cancelAnimationFrame = function () {};
  _ae.gl.renderer.render = function () {};
  _almFocus = new RealDate(_aeDisplayMs()); _almClockLast = 0; _almClockRAF = 0; _almClockRunning = false;
  _almClockSetRate(rate);
  _ae.dirty = true; _ae.raf = 0; if (_ae.idleTimer) clearTimeout(_ae.idleTimer); _ae.idleTimer = 0;
  var out = [];
  for (var i = 0; i < frames; i++) {
    NOW += 1000 / 60; PERF += 1000 / 60;
    if (!_ae.raf) _aeKick();   // the view's own loop (the page's clock, below a fast rate, ticks only four times a second)
    var pend = cbs; cbs = [];
    pend.forEach(function (cb) { cb(PERF); });   // (the frame runs only as the one the view asked for: its id is still _ae.raf)
    var c = _ae.gl.camera.position, p = _ae.issPos, s = _aeProject(p), tp = _aeViewCam().tp;
    out.push({ far: _ae.issFar, dist: _aeLen(_aeSub([c.x, c.y, c.z], tp)), fromEarth: _aeLen([c.x, c.y, c.z]), sx: s && s.x, sy: s && s.y, w: _ae.w, h: _ae.h,
      ring: _ae.gl.issRing.visible && _ae.gl.issRing.material.opacity > 0 });
  }
  window.Date = RealDate;
  return out;
}"""
RIDE_SMOOTH = 0.35  # the most a frame may change the log of the camera's distance (a pull-out takes about a second)


def test_following_the_station_faster_than_it_can_be_followed_pulls_out_to_its_orbit(
    served,
):
    """At an hour a second the camera still rides the station close; at a day a second (a frame moves the Earth under it too far to
    follow) the view eases out to the whole orbit with the station moving along its ring, and eases back when slow
    again: every frame inside the view, no frame a snap."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "iss")
            close = pg.evaluate("_ae.dist")
            slow = pg.evaluate(RIDE, [60, 60])
            assert max(r["far"] for r in slow) == 0, slow[-1]
            assert abs(slow[-1]["dist"] - close) < close * 0.01, (slow[-1], close)
            fast = pg.evaluate(RIDE, [86400, 150])
            assert fast[-1]["far"] > 0.99, fast[-1]
            assert fast[-1]["ring"], "the orbit is drawn while the view is out at it"
            assert 2 < fast[-1]["fromEarth"] < 12, fast[
                -1
            ]  # the whole orbit (1.07 Earth radii) across a phone's width
            for r in fast:
                assert (
                    r["sx"] is not None
                    and 0 <= r["sx"] <= r["w"]
                    and 0 <= r["sy"] <= r["h"]
                ), r  # never lost
                assert (
                    r["fromEarth"] > 1.0
                ), r  # and the camera never goes through the Earth on the way
            for a, b in zip(fast, fast[1:]):
                assert abs(math.log(b["dist"] / a["dist"])) < RIDE_SMOOTH, (a, b)
            back = pg.evaluate(RIDE, [1, 180])
            assert back[-1]["far"] < 0.01, back[-1]
            assert abs(back[-1]["dist"] - close) < close * 0.02, (back[-1], close)
            for a, b in zip(back, back[1:]):
                assert abs(math.log(b["dist"] / a["dist"])) < RIDE_SMOOTH, (a, b)
            for r in back:
                assert r["sx"] is not None and r["fromEarth"] > 1.0, r
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_go_to_the_station_on_a_clock_too_fast_to_follow_flies_to_its_orbit_not_in_and_out(
    served,
):
    """With time running at a day a second the station goes round many times in the seconds a flight takes. The flight ends at
    the whole orbit (where the view pulls out to anyway), never in close and then back out.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.evaluate(
                "() => { _almFocus = new Date(); _almClockSetRate(86400); _ae.dirty = true; _aeKick(); }"
            )
            pg.wait_for_function("() => !!_ae.issPos", timeout=120_000, polling=300)
            out = pg.evaluate("() => _aeFitDist(_aeLen(_ae.issPos) * AE_ISS_FAR_FIT)")
            pg.evaluate("() => _aePreset('iss')")
            low = pg.evaluate(
                """() => new Promise(res => { var lo = Infinity, quiet = 0, n = 0, t = setInterval(() => {
                    _ae.dirty = true; _aeKick(); lo = Math.min(lo, _ae.dist);
                    quiet = _ae.fly ? 0 : quiet + 1; n++;
                    if (quiet > 40 || n > 2400) { clearInterval(t); res(lo); } }, 50); })"""
            )
            assert low >= out * 0.9, (low, out)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


GO_TO_STATION = """([rate, at]) => {
  var NOW = at || Date.now(), PERF = performance.now(), RealDate = Date;
  window.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
  performance.now = function () { return PERF; };
  var cbs = [];
  window.requestAnimationFrame = function (cb) { cbs.push(cb); return cbs.length; };
  window.cancelAnimationFrame = function () {};
  _ae.gl.renderer.render = function () {};
  _almFocus = new RealDate(NOW); _almClockSetRate(rate);
  _ae.dirty = true; _ae.raf = 0; if (_ae.idleTimer) clearTimeout(_ae.idleTimer); _ae.idleTimer = 0;
  var out = [], landed = -1;
  function frame(i) {
    NOW += 1000 / 60; PERF += 1000 / 60;
    var pend = cbs; cbs = [];
    if (!_ae.raf && !pend.length) { if (i % 6 === 0) _aeKick(); pend = cbs; cbs = []; }
    pend.forEach(function (cb) { cb(PERF); });
    out.push({ dist: _ae.dist, az: _ae.az, el: _ae.el_, fly: !!_ae.fly });
  }
  for (var i = 0; i < 5; i++) frame(i);
  _aePreset('iss');
  for (var j = 0; j < 900; j++) frame(j);
  window.Date = RealDate;
  return out;
}"""


@pytest.mark.parametrize("rate", [86400])
def test_go_to_the_station_on_a_fast_clock_is_one_move_with_nothing_after_it(
    served, rate
):
    """The flight to a station the clock takes round too fast to follow goes straight out to its orbit (never out past it and
    back in, as the over-the-shoulder pull did), and once it lands the camera does not move again.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.issPos", timeout=120_000, polling=300)
            out = pg.evaluate("() => _aeFitDist(_aeLen(_ae.issPos) * AE_ISS_FAR_FIT)")
            rows = pg.evaluate(GO_TO_STATION, [rate])
            assert max(r["dist"] for r in rows) <= out * 1.05, (
                max(r["dist"] for r in rows),
                out,
            )
            last = max(i for i, r in enumerate(rows) if r["fly"])
            assert last < len(rows) - 60, "the flight ends"
            after = rows[last + 1 :]
            assert max(abs(r["az"] - after[0]["az"]) for r in after) < 0.01, after[-1]
            assert max(abs(r["el"] - after[0]["el"]) for r in after) < 0.01, after[-1]
            assert max(abs(r["dist"] - after[0]["dist"]) for r in after) < 0.05, after[
                -1
            ]
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


GO_IN = GO_TO_STATION.replace(
    "out.push({ dist: _ae.dist, az: _ae.az, el: _ae.el_, fly: !!_ae.fly });",
    "var s = _ae.issPos && _aeProject(_ae.issPos); out.push({ dist: _ae.dist, fly: !!_ae.fly, sx: s && s.x, sy: s && s.y, w: _ae.w, h: _ae.h });",
).replace("j < 900", "j < 1200")


# Where the station is, and which side of the Earth the camera looks at, follow the instant: sixteen of them 62 minutes apart (the
# station is a different way round each time), never the wall clock the suite happens to run at.
ISS_SWEEP_FROM_MS, ISS_SWEEP_STEP_MS = 1_795_219_200_000, 62 * 60_000   # 2026-11-21 00:00 UTC


@pytest.mark.parametrize("step", range(16))
@pytest.mark.parametrize("rate", [1, 3600])
def test_go_to_the_station_flies_straight_in_with_the_station_in_the_picture(
    served, rate, step
):
    """Go to the station, at real time or an hour a second: one move in (the camera never goes out past where it started), the
    station in the frame at every step of it, landing close with the station held still on the screen after.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.issPos", timeout=120_000, polling=300)
            start = pg.evaluate("() => _ae.dist")
            rows = pg.evaluate(GO_IN, [rate, ISS_SWEEP_FROM_MS + step * ISS_SWEEP_STEP_MS])
            assert max(r["dist"] for r in rows) <= start * 1.02, (
                max(r["dist"] for r in rows),
                start,
            )
            flying = [r for r in rows if r["fly"]]
            assert flying, "it flew"
            for r in flying:
                assert (
                    r["sx"] is not None
                    and 0 <= r["sx"] <= r["w"]
                    and 0 <= r["sy"] <= r["h"]
                ), r
            last = max(i for i, r in enumerate(rows) if r["fly"])
            after = rows[last + 1 :]
            assert after[0]["dist"] < 0.001, after[0]
            # Held still to a pixel or two at either rate: at an hour a second the camera follows the station round by 460 km a
            # frame from half a kilometre away, and the station must not wander on the screen (1.3 m a pixel there).
            worst = max(
                abs(r["sx"] - after[0]["sx"]) + abs(r["sy"] - after[0]["sy"])
                for r in after
            )
            assert worst < 2, (worst, after[-1])
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
