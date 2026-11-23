"""Flying between bodies in the Almanac's 3D view does not roll the picture.

"It feels like there's a lot of weird rotating happening while flying between bodies now." Every frame of a
flight on an emulated iPhone: the camera's roll about its line of sight, measured from celestial north-up. Carrying up along the
swing round the old body (parallel transport) rolled the picture to 59 degrees by the middle of Earth to Mars and unwound it over
the rest of the flight; the picture now stays north-up, with the view's own roll (the Moon's, at an observer) eased from the old
body's to the new one's: its roll goes no further than the two ends ask for.

Run: pytest tests/test_almanac_flyroll_browser.py -v
"""

import math
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_slots import WEBGL_ARGS

GL_ARGS = WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 300_000
# Flights from one body to another, none through the Moon's own roll, then those with it.
STEADY = [("earth", "mars"), ("mars", "jupiter"), ("jupiter", "saturn"), ("earth", "sun"), ("sun", "venus"), ("jupiter", "io"), ("io", "europa")]
MOON = [("earth", "moon"), ("moon", "earth")]
LEVEL_DEG = 3.0   # the most the picture may be rolled off north-up on a flight that has no roll of its own to make
JUMP_DEG = 10.0   # the most the roll may change between two frames: a flight that passes the pole snaps the picture a half turn in one
EXTRA_DEG = 8.0   # the most roll a flight may make beyond the net change from its first frame to its last
RECORD = """(k) => {
  window.__rec = []; window.__origLabels = window.__origLabels || _aeUpdateLabels;
  _aeUpdateLabels = function () {
    window.__origLabels.apply(this, arguments);
    var e = _ae.gl.camera.matrixWorld.elements;
    window.__rec.push({ f: [-e[8], -e[9], -e[10]], u: [e[4], e[5], e[6]], fly: !!_ae.fly });
  };
  _aePreset(k);
}"""
DONE = "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("flyroll")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    try:
        srv.load_cache(force=True)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        yield "http://127.0.0.1:%d" % httpd.server_address[1]
        httpd.shutdown()
    finally:
        srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old
        srv.load_cache(force=True)
        env.undo()


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _roll(frame):
    """The camera's turn about its line of sight from north-up, in degrees (None looking along the pole)."""
    f, u = frame["f"], frame["u"]
    n = [-f[2] * f[0], -f[2] * f[1], 1 - f[2] * f[2]]
    ln = math.sqrt(_dot(n, n))
    if ln < 1e-3:
        return None
    n = [x / ln for x in n]
    return math.degrees(math.atan2(_dot(u, _cross(n, f)), _dot(u, n)))


def _delta(a, b):
    return (b - a + 180) % 360 - 180


def _flights(served, pairs):
    from playwright.sync_api import sync_playwright

    out = {}
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport=VIEW, device_scale_factor=1, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
                % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=READY_MS, polling=200)
            for a, b in pairs:
                pg.evaluate("(k) => _aePreset(k)", a)
                pg.wait_for_function(DONE, timeout=90_000, polling=200)
                pg.wait_for_timeout(400)
                pg.evaluate(RECORD, b)
                pg.wait_for_function(DONE, timeout=90_000, polling=100)
                pg.wait_for_timeout(200)
                out[(a, b)] = [fr for fr in pg.evaluate("window.__rec") if fr["fly"]]
        finally:
            br.close()
    return out


def _rolls(frames):
    return [r for r in (_roll(fr) for fr in frames) if r is not None]


def _travel(rolls):
    """How far the roll goes in all, and its first to last change."""
    return sum(abs(_delta(a, b)) for a, b in zip(rolls, rolls[1:])), abs(_delta(rolls[0], rolls[-1]))


def test_flight_does_not_roll_the_picture(served):
    flights = _flights(served, MOON + STEADY)
    for pair in STEADY:
        frames = flights[pair]
        assert len(frames) > 20, pair
        rolls = _rolls(frames)
        assert max(abs(_delta(a, b)) for a, b in zip(rolls, rolls[1:])) <= JUMP_DEG, (pair, "snapped between frames")
        assert max(abs(r) for r in rolls) <= LEVEL_DEG, (pair, "rolled off north-up", max(rolls, key=abs))
    for pair in MOON:
        # The Moon is up the way it is at the observer: the roll goes from that to north-up (or back) and no further.
        rolls = _rolls(flights[pair])
        assert max(abs(_delta(a, b)) for a, b in zip(rolls, rolls[1:])) <= JUMP_DEG, (pair, "snapped between frames")
        total, net = _travel(rolls)
        assert total - net <= EXTRA_DEG, (pair, "rolled beyond the ends' own", total, net)
