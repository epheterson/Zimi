"""Turning and sliding the 3D view's camera by hand: no half turn of picture at the station's zenith, and two fingers slide.

In headless Chromium at a phone's size: dragging the station's view across the line straight down at the Earth turns the
picture a little at a time (it used to turn a half turn across two degrees), and two fingers (real touches) slide the view
across the body, bounded to its radius, while the pinch still zooms and one finger still turns; a shift-drag with the
mouse slides too; flying to another body lets the slide go.

Run: pytest tests/test_almanac_pan_browser.py -v
"""

import json
import os
import sys
import threading
from datetime import datetime

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
# Per half degree of drag; the old convention made 180 at the zenith.
MAX_ROLL_STEP_DEG = 30


def _station_over_the_equator_ms():
    """The instant the shipped elements' station next crosses the equator northward after their epoch, in ms.

    The view is pinned there (its clock stopped): the station's place was the wall clock's, and within a few degrees
    of its highest latitude (51.6) the zenith sweep below runs past the celestial pole, where roll is measured from a
    north that turns over (180) though the picture does not. The tests use the shipped snapshot (ZIMI_OFFLINE and an
    empty data directory: no cache, no fetch), so this instant and the station's place at it are the same every run.
    """
    with open(os.path.join(ROOT, "zimi", "assets", "satellites-snapshot.json")) as f:
        iss = json.load(f)["iss"]
    epoch = datetime.fromisoformat(iss["EPOCH"].replace("Z", "+00:00")).timestamp() * 1000
    # Argument of latitude ~ perigee + mean anomaly (eccentricity ~0.0007); the node is a revolution's fraction away.
    to_node = (-(iss["ARG_OF_PERICENTER"] + iss["MEAN_ANOMALY"])) % 360 / 360
    return round(epoch + to_node / iss["MEAN_MOTION"] * 86_400_000)


PIN_MS = _station_over_the_equator_ms()


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("pan")
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
def station(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(
                viewport=VIEW,
                device_scale_factor=2,
                has_touch=True,
                is_mobile=True,
                service_workers="block",
            )
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
                % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("openAlmanacEarth({ target: 'iss' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
                timeout=READY_MS,
                polling=200,
            )
            # One instant for the whole module, the clock stopped: the station is over the equator.
            pg.evaluate("(ms) => { _almFocus = new Date(ms); _almClockSetRate(0); }", PIN_MS)
            pg.wait_for_function(
                "(ms) => { _ae.dirty = true; _aeKick(); return !_ae.fly && _aeDisplayMs() === ms && !!_ae.issPos"
                " && Math.abs(_aeAzElOf(_aeNorm(_ae.issPos)).el) < 0.1; }",
                arg=PIN_MS,
                timeout=60_000,
                polling=200,
            )
            yield pg, ctx.new_cdp_session(pg), errors
        finally:
            br.close()


def touches(cdp, kind, points):
    cdp.send(
        "Input.dispatchTouchEvent",
        {
            "type": kind,
            "touchPoints": [
                {"x": x, "y": y, "id": i} for i, (x, y) in enumerate(points)
            ],
        },
    )


def screen_of_target(pg):
    """Where the target stands on the canvas, in CSS pixels, with the camera as last placed."""
    return pg.evaluate(
        """() => { _aePlaceCamera(); var c = _ae.gl.camera; c.updateMatrixWorld(); c.updateProjectionMatrix();
        var p = _aeBodyPos(_ae.target), v = new _ae.gl.THREE.Vector3(p[0], p[1], p[2]).project(c);
        var r = _aeById('ae-canvas').getBoundingClientRect();
        return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }"""
    )


def test_the_picture_does_not_flip_looking_straight_down_at_the_earth(station):
    pg, _, errors = station
    worst = pg.evaluate(
        """() => { _ae.target = 'iss'; var a = _aeAzElOf(_aeNorm(_ae.issPos)), worst = 0, worstAt = 0;
        [[1, 0], [0, 1]].forEach(function (dir) {
          _ae.issRoll = null; var prev = null;
          for (var d = -40; d <= 40; d += 0.5) {
            _ae.az = a.az + _aeRad(d * dir[0]); _ae.el_ = a.el + _aeRad(d * dir[1]);
            var r = _aeRollDeg('iss', _ae.scene.ms);
            if (prev !== null && Math.abs(_angleDelta(prev, r)) > worst) worst = Math.abs(_angleDelta(prev, r));
            prev = r;
          }
        });
        _ae.issRoll = null; _ae.az = a.az; _ae.el_ = a.el;
        return worst; }"""
    )
    assert worst < MAX_ROLL_STEP_DEG, worst
    assert not errors, errors


def test_two_fingers_slide_the_view_across_the_station_and_pinch_zooms(station):
    pg, cdp, errors = station
    pg.evaluate(
        "() => { _ae.pan = null; _ae.dist = AE_TARGETS.iss.min * 1.2; _ae.dirty = true; _aeKick(); }"
    )
    before = screen_of_target(pg)
    dist0 = pg.evaluate("() => _ae.dist")
    # Two fingers 120 px apart move together 40 px right and 30 px down, spreading to 160 px: slide and zoom at once.
    touches(cdp, "touchStart", [(135, 400), (255, 400)])
    touches(cdp, "touchMove", [(115, 415), (275, 415)])
    touches(cdp, "touchMove", [(155, 430), (315, 430)])
    # Moves reach the page aligned to its frames: the state is read once the last one has, not while it is on its way.
    pg.wait_for_function(
        "() => !!_ae.pinch && _ae.pinch.span === 160 && _ae.pinch.mx === 235 && _ae.pinch.my === 430",
        timeout=10_000,
    )
    state = pg.evaluate(
        "() => ({ pan: _ae.pan, dist: _ae.dist, az: _ae.az, el: _ae.el_ })"
    )
    touches(cdp, "touchEnd", [])
    after = screen_of_target(pg)
    assert state["pan"] and state["pan"]["t"] == "iss"
    assert state["dist"] < dist0  # fingers spread: closer
    # The station follows the fingers: right and down.
    assert after[0] - before[0] > 10 and after[1] - before[1] > 10, (before, after)
    reach = pg.evaluate("() => AE_TARGETS.iss.surface")
    assert sum(x * x for x in state["pan"]["v"]) ** 0.5 <= reach * 1.0001
    assert not errors, errors


# One pinch spreading from 120 px to 160 px, its pointer events in a given order: each finger's move is its own event,
# and the order a frame's touches arrive in is the browser's (it was a coin toss in CI).
PINCH_IN_ORDER = """(order) => {
    var cv = _aeById('ae-canvas'), ev = function (type, id, x, y) {
        cv.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', isPrimary: id === 901, bubbles: true }));
    };
    cv.setPointerCapture = function () {};   // synthetic pointers have nothing to capture
    _ae.fly = null; _ae.pan = null; _ae.dist = AE_TARGETS.iss.min * 1.2;
    var dist0 = _ae.dist;
    ev('pointerdown', 901, 135, 400); ev('pointerdown', 902, 255, 400);
    order.forEach(function (m) { ev('pointermove', m[0], m[1], m[2]); });
    var out = { dist0: dist0, dist: _ae.dist, min: AE_TARGETS.iss.min };
    ev('pointercancel', 901, 0, 0); ev('pointercancel', 902, 0, 0);
    delete cv.setPointerCapture;
    return out;
}"""


def test_a_pinch_ends_where_the_fingers_do_whatever_order_their_moves_arrive_in(station):
    """Spread from 120 to 160 px near the station's nearest: the view ends closer (at that nearest), in either order.

    Each move zoomed by its own ratio, clamped at the nearest; one finger's step past it was clamped, the other's step
    back out was not, and the same spread ended 4.5% farther than it began (CI's 1.928e-05 < 1.846e-05).
    """
    pg, _, errors = station
    first = [[901, 115, 415], [902, 275, 415]]
    for second in ([[901, 155, 430], [902, 315, 430]], [[902, 315, 430], [901, 155, 430]]):
        got = pg.evaluate(PINCH_IN_ORDER, first + second)
        assert got["dist"] < got["dist0"], (second, got)
        assert got["dist"] == pytest.approx(got["min"], rel=1e-9), (second, got)
    assert not errors, errors


def test_the_slide_is_bounded_and_one_finger_still_turns(station):
    pg, cdp, _ = station
    pg.evaluate(
        "() => { _ae.pan = null; _ae.dist = AE_TARGETS.iss.min * 1.2; _ae.dirty = true; _aeKick(); }"
    )
    for _ in range(4):  # one sweep across the screen is not as far as the station is wide, so sweep again
        touches(cdp, "touchStart", [(60, 400), (180, 400)])
        for i in range(1, 12):
            touches(cdp, "touchMove", [(60 + i * 25, 400), (180 + i * 25, 400)])
        touches(cdp, "touchEnd", [])
    got = pg.evaluate(
        "() => ({ len: Math.hypot.apply(null, _ae.pan.v), reach: AE_TARGETS.iss.surface })"
    )
    assert got["len"] == pytest.approx(
        got["reach"], rel=1e-3
    )  # far past the edge: held at the radius
    az0 = pg.evaluate(
        "() => { var p = _ae.pan.v.slice(); window.__pan0 = p; return _ae.az; }"
    )
    touches(cdp, "touchStart", [(195, 400)])
    touches(cdp, "touchMove", [(235, 400)])
    touches(cdp, "touchMove", [(275, 400)])
    touches(cdp, "touchEnd", [])
    turned = pg.evaluate(
        "() => ({ az: _ae.az, same: _ae.pan.v.every(function (x, i) { return x === window.__pan0[i]; }) })"
    )
    assert turned["az"] != az0 and turned["same"]


def test_shift_drag_slides_and_a_flight_lets_it_go(station):
    pg, _, errors = station
    pg.evaluate(
        "() => { _ae.pan = null; _ae.dist = AE_TARGETS.iss.min * 1.2; _ae.dirty = true; _aeKick(); }"
    )
    pg.keyboard.down("Shift")
    pg.mouse.move(200, 400)
    pg.mouse.down()
    pg.mouse.move(230, 420, steps=3)
    pg.mouse.up()
    pg.keyboard.up("Shift")
    assert pg.evaluate("() => !!_ae.pan && Math.hypot.apply(null, _ae.pan.v) > 0")
    pg.evaluate("() => _aePreset('earth')")
    assert pg.evaluate("() => _ae.pan === null")
    assert not errors, errors
