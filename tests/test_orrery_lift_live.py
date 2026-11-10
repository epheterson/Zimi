"""The orrery and the 3D Planets view are one experience: a tap lifts the flat drawing into 3D, and the 3D view settles back.

The page's orrery (almanac-orrery.js) and the view's Planets overview (almanac-earth.js) draw the same picture: every body in
its true direction from the Sun at the one squeeze of its distance, from above the ecliptic's north. Checked here on the shipped
files, served by Zimi, in headless Chromium (SwiftShader):

  1. One source of positions: at six dates from 1900 to 2300 each planet's place in the orrery (its offset from the Sun as a
     share of the canvas) is the 3D view's to under 0.4 px of a 358 px canvas (the Earth, which the view keeps at the middle
     and a Sun a fixed distance off, is within a third of a pixel).
  2. The lift starts where the drawing stands: the first 3D frame puts the Sun and every planet within 2 px of where the
     last flat frame had it, in portrait (390x844) and landscape (844x390).
  3. The lift ends in the view on the tapped body with the page covered; the way back (the header's arrow, the Planets view
     pulled out) flies out and lands on the page's orrery, in place, the view closed and the page uncovered.
  4. Reduced motion: a cross-fade, no flight (no clip, no camera blend), same end states. No WebGL: a plain line where the
     hint stands, the view not opened, the orrery still working.
  5. No page errors anywhere.

Run: pytest tests/test_orrery_lift_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
PORTRAIT = {"width": 390, "height": 844}
LANDSCAPE = {"width": 844, "height": 390}
MAX_OFF_PX = 2.0
MAX_POS_PX = 0.4
POLL_MS = 100
DATES = [
    "2026-11-09",
    "1990-03-01",
    "2060-07-01",
    "2100-01-01",
    "1900-06-15",
    "2300-01-01",
]
PLANETS = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]

READY = """async () => {
  _orreryClockTouched(); _orreryPlaying = false;
  document.getElementById('almanac-orrery').scrollIntoView({ block: 'center' });
  await _aePrepare(true); await _aeOrreryLoad();
  await new Promise(r => setTimeout(r, 600));
  _drawOrrery(_orreryCanvas, _orreryDpr);
  return _aeReady() && typeof _aeOrreryIn === 'function';
}"""

# The Sun's and planets' places on the screen in the last flat frame, then the tap: the first 3D frame is drawn inside the call.
FIRST_FRAME = """(key) => {
  var r = _orreryCanvas.getBoundingClientRect();
  var two = { Sun: [r.left + _orrerySunPos.x, r.top + _orrerySunPos.y] };
  _orreryPlanetPositions.forEach(p => { two[p.name] = [r.left + p.x, r.top + p.y]; });
  _orreryOpenEarthView(key);
  var S = _ae.gl, v = _ae.el.getBoundingClientRect(), three = {};
  var proj = function (p) { var q = new S.THREE.Vector3(p[0], p[1], p[2]).project(S.camera); return [v.left + (q.x + 1) / 2 * _ae.w, v.top + (1 - q.y) / 2 * _ae.h]; };
  three.Sun = proj(_aeSunShown(_ae.scene));
  ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'].forEach(k => { three[k.charAt(0).toUpperCase() + k.slice(1)] = proj(S.planets[k].pos); });
  return { two: two, three: three, hand: !!_ae.hand, target: _ae.target, preset: _ae.preset, clip: _ae.el.style.clipPath };
}"""

# One body's place in the orrery and in the 3D scene as a share of the canvas width, at a date.
POSITIONS = """(ms) => {
  _aeGoTo(ms);
  var sc = _aeSceneAt(ms); _ae.scene = sc; _aeUpdatePlanets(sc);
  var S = _ae.gl, e = S.ecl, K = AE_SUN_SHOW_DIST / _solarSqueeze(1), W = 358, y = _aeCross(e.z, e.x), out = {};
  var T = _jdToJulianCentury(ms / 86400000 + 2440587.5);
  ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'].forEach(function (nm) {
    var d = _aeSub(S.planets[nm.toLowerCase()].pos, e.sun), o = _orreryDrawnOffset(_orreryHelioAU(nm, T));
    out[nm] = Math.hypot(_aeDot(d, e.x) / K - o.x, _aeDot(d, y) / K - o.y) * W;
  });
  return out;
}"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("orrerylift")
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


def _almanac(browser, served, view=PORTRAIT, reduced=False):
    ctx = browser.new_context(
        viewport=view,
        device_scale_factor=2,
        color_scheme="dark",
        reduced_motion="reduce" if reduced else "no-preference",
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && document.getElementById('almanac-orrery')",
        timeout=120000,
        polling=POLL_MS,
    )
    assert pg.evaluate(READY)
    return pg, errors


def _worst_off(res):
    worst = 0.0
    for name, a in res["two"].items():
        b = res["three"].get(name)
        if b:
            worst = max(worst, ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5)
    return worst


def _wait_hand_done(pg):
    pg.wait_for_function("() => !_ae.hand", timeout=20000, polling=POLL_MS)


@pytest.mark.parametrize("view", [PORTRAIT, LANDSCAPE], ids=["portrait", "landscape"])
def test_first_3d_frame_is_the_last_flat_frame(browser, served, view):
    pg, errors = _almanac(browser, served, view)
    res = pg.evaluate(FIRST_FRAME, "mars")
    assert res["hand"] and res["target"] == "mars" and res["preset"] == "mars"
    assert "inset" in res["clip"]  # the view is the canvas's rectangle at first
    assert len(res["two"]) == 9 and len(res["three"]) == 8
    assert _worst_off(res) < MAX_OFF_PX, res
    _wait_hand_done(pg)
    assert pg.evaluate(
        "_aeIsOpen && document.getElementById('almanac-view').classList.contains('ae-covered')"
    )
    assert pg.evaluate("_ae.el.style.clipPath") == ""
    assert not errors, errors


def test_the_way_back_settles_onto_the_orrery(browser, served):
    pg, errors = _almanac(browser, served)
    pg.evaluate(FIRST_FRAME, "neptune")
    _wait_hand_done(pg)
    pg.evaluate("_aeClose()")
    pg.wait_for_function("() => !_aeIsOpen", timeout=20000, polling=POLL_MS)
    assert not pg.evaluate(
        "document.getElementById('almanac-view').classList.contains('ae-covered')"
    )
    r = pg.evaluate(
        "(() => { var r = _orreryCanvas.getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; })()"
    )
    assert r[0] < r[2] and r[1] > 0, r  # the orrery is on the screen it settled onto
    assert not errors, errors


def test_the_planets_view_pulled_out_settles_onto_the_orrery(browser, served):
    pg, errors = _almanac(browser, served)
    pg.evaluate(FIRST_FRAME, "earth")
    _wait_hand_done(pg)
    pg.evaluate("_aePreset('planets')")
    pg.wait_for_function("() => !_ae.fly", timeout=20000, polling=POLL_MS)
    pg.evaluate(
        "() => { for (var i = 0; i < 12 && _aeIsOpen && !_ae.hand; i++) _aeZoomBy(1.15); }"
    )
    pg.wait_for_function("() => !_aeIsOpen", timeout=20000, polling=POLL_MS)
    assert not errors, errors


def test_reduced_motion_is_a_cross_fade(browser, served):
    pg, errors = _almanac(browser, served, reduced=True)
    res = pg.evaluate(FIRST_FRAME, "jupiter")
    assert res["hand"] and res["clip"] == ""  # no frame opening, no flight
    assert pg.evaluate("_ae.hand.xfade === true && _ae.hand.e === 1")
    _wait_hand_done(pg)
    pg.evaluate("_aeClose()")
    pg.wait_for_function("() => !_aeIsOpen", timeout=20000, polling=POLL_MS)
    assert not errors, errors


def test_one_source_of_positions_at_every_date(browser, served):
    import datetime

    pg, errors = _almanac(browser, served)
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function("() => _aeIsOpen && !_ae.hand", timeout=30000, polling=POLL_MS)
    for d in DATES:
        ms = int(
            datetime.datetime.fromisoformat(d + "T12:00:00+00:00").timestamp() * 1000
        )
        off = pg.evaluate(POSITIONS, ms)
        assert max(off.values()) < MAX_POS_PX, (d, off)
    assert not errors, errors


NO_WEBGL = """(() => { var g = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (k) { return /webgl/i.test(k) ? null : g.apply(this, arguments); }; })()"""


def test_no_webgl_the_orrery_says_so_and_stays(browser, served):
    ctx = browser.new_context(viewport=PORTRAIT, device_scale_factor=2)
    ctx.add_init_script(NO_WEBGL)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && document.getElementById('almanac-orrery')", timeout=120000)
    pg.evaluate("document.getElementById('almanac-orrery').scrollIntoView({ block: 'center' })")
    pg.evaluate("_orreryOpenEarthView('mars')")
    pg.wait_for_function("() => openAlmanacEarth.unsupported === true", timeout=60000, polling=POLL_MS)
    assert not pg.evaluate("_aeIsOpen")
    pg.wait_for_function("() => document.getElementById('orrery-hint').textContent.trim() !== ''", timeout=10000, polling=POLL_MS)
    assert pg.evaluate("document.getElementById('almanac-orrery').getBoundingClientRect().width") > 0
    assert not errors, errors
