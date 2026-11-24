"""The flight's shoulder shot keeps the destination on screen whatever azimuth the camera starts from (Earth to Jupiter,
phone portrait and landscape), and the view reports when it has settled (window.__aeSettled).

Run: pytest tests/test_almanac_flight_shoulder_browser.py -v
"""

import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from browser_slots import WEBGL_ARGS

GL_ARGS = WEBGL_ARGS + ["--disable-accelerated-2d-canvas"]
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
# Per start azimuth: the destination's place in the frame (normalised device coordinates) when the camera stands at the shoulder.
SWEEP = """(a) => { var out = [];
  for (var az = -3.1; az <= 3.1; az += 0.2) {
    window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset(a.frm); window._almReduceMotion = undefined; _aeUpdate(_aeDisplayMs()); _ae.az = az;
    _aePreset(a.to); var f = _ae.fly; if (!f || !f.hold) { out.push({ az: az, hold: false }); _ae.fly = null; continue; }
    f.start = performance.now() - f.lead; _aeStepFly(performance.now()); _aePlaceCamera();
    var cam = _ae.gl.camera; cam.updateMatrixWorld();
    var p = _aeTargetPos(), v = new _ae.gl.THREE.Vector3(p[0], p[1], p[2]).project(cam);
    out.push({ az: az, hold: true, x: v.x, y: v.y, z: v.z });
    _ae.fly = null; }
  return out; }"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("sh")
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


@pytest.mark.parametrize("size", [(390, 844), (844, 390)])
def test_the_shoulder_shot_keeps_the_destination_on_screen_from_every_azimuth(served, size):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport={"width": size[0], "height": size[1]}, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            # the settled signal: nothing flying, spinning or loading
            pg.wait_for_function("() => typeof window.__aeSettled === 'function' && window.__aeSettled()", timeout=READY_MS, polling=200)
            rows = pg.evaluate(SWEEP, {"frm": "earth", "to": "jupiter"})
            held = [r for r in rows if r["hold"]]
            assert len(held) > 25, rows
            for r in held:
                assert abs(r["x"]) < 0.9 and abs(r["y"]) < 0.9 and r["z"] < 1, (size, r)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
