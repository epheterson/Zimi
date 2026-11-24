"""The probes added to the stock models (Kepler, Spitzer, New Horizons, Europa Clipper, OSIRIS-APEX, Psyche, Lucy):
each one's model is fetched from the app (not the HD pack), and a flight to it ends on the model drawn, on screen, its
dot gone, in headless Chromium at a phone's size.

Run: pytest tests/test_almanac_stock_models_browser.py -v
"""

import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from browser_slots import WEBGL_ARGS

GL_ARGS = WEBGL_ARGS + ["--disable-accelerated-2d-canvas"]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
# track key -> the stock model it draws
NEW = {
    "kepler": "kepler",
    "newhorizons": "newhorizons",
    "europaclipper": "clipper",
    "osirisapex": "osirisrex",
    "psyche": "psyche",
    "lucy": "lucy",
    "gaia": "gaia",
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("sm")
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


def test_every_new_model_is_a_stock_file_the_view_asks_the_app_for():
    from pathlib import Path

    js = (Path(ROOT) / "zimi/static/almanac-earth.js").read_text(encoding="utf-8")
    for key, model in NEW.items():
        assert "%s: '%s'" % (key, model) in js, key
        assert (Path(ROOT) / ("zimi/static/earth/craft-%s-v1.bin" % model)).is_file(), model
    hd_only = js.split("var AE_CRAFT_HD_MODEL = {")[1].split("}")[0]
    for model in NEW.values():
        assert "'%s'" % model not in hd_only, model


@pytest.mark.parametrize("key", list(NEW))
def test_a_flight_to_it_ends_on_its_model(served, key):
    from playwright.sync_api import sync_playwright

    model = NEW[key]
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
            errors, asked = [], []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("request", lambda r: asked.append(r.url))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
                timeout=READY_MS,
                polling=200,
            )
            pg.evaluate("_aeTracksLoad()")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            pg.evaluate(
                "(k) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aeUpdate(_aeDisplayMs()); _aePreset(k); }",
                key,
            )
            pg.wait_for_function(
                "(k) => { _ae.dirty = true; _aeKick(); var I = _ae.gl.crafts && _ae.gl.crafts[k]; return !_ae.fly && _ae.target === k && !!I && I.root.visible && I.show > 0.99; }",
                arg=key,
                timeout=60_000,
                polling=200,
            )
            got = pg.evaluate(
                """(k) => { _aeUpdate(_aeDisplayMs()); var I = _ae.gl.crafts[k], m = AE_CRAFT_MODEL[k], d = _aeCraftData(m), S = _ae.gl, V = S.THREE.Vector3;
                var p = _aeBodyPos(k), c = S.camera, v = new V(p[0], p[1], p[2]).project(c);
                var tris = 0; I.root.traverse(function (o) { if (o.geometry && o.visible) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
                return { model: m, tris: tris, nrm: !!d.nrm, ndc: [v.x, v.y, v.z], dot: _aeProbeCraftDot(k),
                         spans: Math.hypot(c.position.x - p[0], c.position.y - p[1], c.position.z - p[2]) / _aeCraftSpanRe(m) }; }""",
                key,
            )
            assert got["model"] == model, got
            assert got["tris"] > 500 and got["nrm"], got  # drawn, non-empty, smooth-shaded
            assert abs(got["ndc"][0]) < 0.6 and abs(got["ndc"][1]) < 0.6 and got["ndc"][2] < 1, got  # on screen
            assert got["dot"] < 0.01 and 1.5 < got["spans"] < 6, got
            assert any("craft-%s-v1.bin" % model in u for u in asked), asked[-10:]
            assert not any("/craft/" in u and model in u for u in asked)  # not the HD pack's
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
