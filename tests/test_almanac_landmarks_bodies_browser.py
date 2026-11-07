"""Landmarks on every body: the same system as the Moon's, drawn on Mars and the rest, and flown to.

Eric, 2026-11-06: "landmarks on each body would be necessary... I want to fly right to the moon landing spot". In
headless Chromium at a phone's size: every body's landmark lands where the body's map is sampled for that latitude and
longitude (the sphere's own vertex for it, the Earth and the Moon included), Mars names only its own places and only
with Landmarks on, a card names the kind and offers Fly there, and Go to lists the landing sites of Mars beside the
Moon's and flies down to one, the site in the middle of the screen.

Run: pytest tests/test_almanac_landmarks_bodies_browser.py -v
"""

import os
import re
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
LABELS = "() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden).map(b => b.textContent)"
# Whole-sphere grid points (multiples of 11.25 degrees: a vertex of every body's sphere), lat, lon east.
GRID = [(22.5, 45.0), (-33.75, 135.0), (11.25, -112.5), (-56.25, -22.5)]
BODIES = [
    "moon",
    "earth",
    "mars",
    "venus",
    "mercury",
    "io",
    "europa",
    "ganymede",
    "callisto",
    "titan",
    "pluto",
    "ceres",
]


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("lmb")
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


# The sphere's own vertex for (lat, lon), by the uv the shader reads the map at, against where the landmark system
# puts the same latitude and longitude: they are one point, for every body.
VERTEX_VS_LANDMARK = """(a) => {
    var S = _ae.gl, out = {};
    a.bodies.forEach(function (key) {
        var b = _aeLmBodies().filter(function (x) { return x.key === key; })[0];
        if (!b) { out[key] = 'no body'; return; }
        var mesh = key === 'moon' ? S.moon : key === 'earth' ? S.earth : S.planets[key].mesh;
        mesh.updateMatrixWorld(true);
        var pos = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv, worst = 0, off = 0;
        a.grid.forEach(function (g) {
            var u = (g[1] + 180) / 360, v = (g[0] + 90) / 180, best = -1, bd = 1e9;
            for (var i = 0; i < uv.count; i++) {
                var d = Math.hypot(uv.getX(i) - u, uv.getY(i) - v);
                if (d < bd) { bd = d; best = i; }
            }
            var w = new S.THREE.Vector3(pos.getX(best), pos.getY(best), pos.getZ(best)).applyMatrix4(mesh.matrixWorld);
            var dd = _aeLmDir(b, g[0], g[1]);
            var p = [b.center[0] + dd[0] * b.r, b.center[1] + dd[1] * b.r, b.center[2] + dd[2] * b.r];
            worst = Math.max(worst, Math.hypot(w.x - p[0], w.y - p[1], w.z - p[2]) / b.r);
            off = Math.max(off, bd);
        });
        out[key] = { worst: worst, off: off };
    });
    return out;
}"""


def test_landmarks_on_every_body_and_a_flight_to_a_rover(served):
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
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
                timeout=READY_MS,
                polling=200,
            )
            pg.evaluate("_aeLmLoad()")
            pg.wait_for_function("() => !!_aeLm", timeout=60_000, polling=200)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }"
            )  # flights end where they go, at once

            # One file, every body: the list the view reads has each of them, and a landmark is the sphere's own point.
            assert pg.evaluate("_aeLmBodyKeys().join()") == ",".join(
                [
                    "moon",
                    "mars",
                    "venus",
                    "titan",
                    "mercury",
                    "earth",
                    "io",
                    "europa",
                    "ganymede",
                    "callisto",
                    "pluto",
                    "ceres",
                ]
            )
            pg.evaluate("_aePreset('mars')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_ae.gl.planets.mars.pos; }",
                timeout=60_000,
                polling=200,
            )
            got = pg.evaluate(VERTEX_VS_LANDMARK, {"bodies": BODIES, "grid": GRID})
            for key in BODIES:
                g = got[key]
                if key == "ceres" and not isinstance(g, dict):
                    continue  # Ceres has no table to stand on before its date's data is in
                assert isinstance(g, dict), (key, g)
                assert g["off"] < 1e-6, (key, g)  # the grid is on the sphere's vertices
                assert g["worst"] < 1e-5, (key, g)

            # Landmarks are off until turned on: Mars names nothing, whatever the view.
            pg.evaluate(
                "_aeLmSetLayer(false); _ae.lm = null; _aeRenderCard(); _aePreset('mars')"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=60_000,
                polling=200,
            )
            pg.wait_for_timeout(600)
            assert pg.evaluate(LABELS) == []
            # On, they are Mars's own places (at most 18), the biggest first: the sites of Olympus Mons's size read at
            # the whole disc, the face turned to us.
            pg.click("#ae-gear")
            pg.check("#ae-set-body input[name='ae-lm-layer']")
            pg.click("#ae-gear")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return ("
                + LABELS
                + ")().length > 0; }",
                timeout=60_000,
                polling=250,
            )
            names = pg.evaluate(LABELS)
            mars = pg.evaluate("_aeLm.mars.map(r => r[0])")
            assert 0 < len(names) <= 18 and set(names) <= set(mars), names
            # Too far to read: from the whole system none of them.
            pg.evaluate("_aePreset('planets')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=60_000,
                polling=200,
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return ("
                + LABELS
                + ")().length === 0; }",
                timeout=60_000,
                polling=250,
            )

            # Go to lists Mars's landing sites with the Moon's; a tap on Curiosity flies there.
            pg.evaluate("_aeLmSetLayer(false); _ae.lm = null; _aeRenderCard()")
            pg.click("#ae-go-btn")
            pg.wait_for_function(
                "() => document.querySelectorAll('#ae-go [data-ae-go^=\"lm:mars:\"]').length === 10",
                timeout=60_000,
            )
            assert (
                pg.evaluate(
                    "document.querySelectorAll('#ae-go [data-ae-go^=\"lm:moon:\"]').length"
                )
                == 25
            )
            heading = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-go h4')).map(h => h.textContent).pop()"
            )
            assert heading == "Landing sites", heading
            pg.click("#ae-go .ae-go-row:has-text('Curiosity')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'mars' && ("
                + LABELS
                + ")().length > 0; }",
                timeout=60_000,
                polling=200,
            )
            assert pg.evaluate(LABELS) == [
                "Curiosity"
            ]  # Landmarks off: the place chosen, alone
            card = pg.inner_text("#ae-card")
            assert "Curiosity" in card and "Landing site" in card, card
            spot = pg.evaluate("""() => {
                var row = _aeLm.mars.filter(r => r[0] === 'Curiosity')[0], b = _aeLmBodies().filter(x => x.key === 'mars')[0];
                var d = _aeLmDir(b, row[1], row[2]), p = [b.center[0] + d[0] * b.r, b.center[1] + d[1] * b.r, b.center[2] + d[2] * b.r];
                _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld();
                var s = _aeProject(p);
                return { x: s.x / _ae.w, y: s.y / _ae.h, dist: _ae.dist, min: AE_TARGETS.mars.min, target: _ae.target };
            }""")
            assert spot["dist"] == pytest.approx(spot["min"], rel=1e-6)
            assert abs(spot["x"] - 0.5) < 0.03 and abs(spot["y"] - 0.5) < 0.03, spot

            # A feature's card: its kind, its size, a way down, and (with the library) its article.
            pg.evaluate("_aeLmSetLayer(true); _ae.lm = null; _aeRenderCard()")
            row = pg.evaluate("_aeLm.mars.filter(r => r[0] === 'Olympus Mons')[0]")
            assert (
                row[3] == "mons" and re.fullmatch(r"Q\d+", row[4]) and row[5] > 500
            ), row
            pg.evaluate(
                "_aeLmOpen('mars', _aeLm.mars.filter(r => r[0] === 'Olympus Mons')[0])"
            )
            card = pg.inner_text("#ae-card")
            assert (
                "Olympus Mons" in card
                and "Mountains" in card
                and "km across" in card
                and "Fly there" in card
            ), card
            pg.click("#ae-lm-fly")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=30_000,
                polling=100,
            )
            assert not pg.query_selector("#ae-lm-fly")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return ("
                + LABELS
                + ")().indexOf('Olympus Mons') >= 0; }",
                timeout=60_000,
                polling=250,
            )
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
# Every drawn landmark's whole box on screen (the dot, the name, wherever the name runs), as the page lays it out.
BOXES = """() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden).map(b => {
    var r = b.getBoundingClientRect(); return { n: b.textContent, x0: r.left, x1: r.right, y0: r.top, y1: r.bottom }; })"""
# Views to try: each body whole, Mars turned to the Tharsis volcanoes (where Tempe Terra met Olympus Mons), the Moon
# from its near side and low over Apollo 11.
OVERLAP_VIEWS = [
    "_aePreset('mars')",
    "_aePreset('mars'); var b = _aeLmBodies().filter(x => x.key === 'mars')[0], a = _aeAzElOf(_aeLmDir(b, 18.6, -133.8)); _ae.az = a.az; _ae.el_ = a.el",
    "_aePreset('moon')",
    "_aePreset('earth')",
    "_aePreset('venus')",
    "_aeLmFly('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 11')[0])",
]


def test_no_two_landmark_labels_overlap(served):
    """Mars, the Moon and the Earth at a phone's size: with Landmarks on, no drawn label's box meets another's."""
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
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _aeLmLoad()"
            )
            pg.wait_for_function("() => !!_aeLm", timeout=60_000, polling=200)
            pg.evaluate("_aeLmSetLayer(true)")
            for view in OVERLAP_VIEWS:
                pg.evaluate("() => { " + view + "; _ae.dirty = true; _aeKick(); }")
                pg.wait_for_function(
                    "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && ("
                    + LABELS
                    + ")().length > 1; }",
                    timeout=60_000,
                    polling=250,
                )
                for _ in range(4):
                    pg.evaluate("_ae.dirty = true; _aeKick()")
                    pg.wait_for_timeout(300)
                boxes = pg.evaluate(BOXES)
                for i, a in enumerate(boxes):
                    for b in boxes[i + 1 :]:
                        meets = (
                            a["x0"] < b["x1"]
                            and b["x0"] < a["x1"]
                            and a["y0"] < b["y1"]
                            and b["y0"] < a["y1"]
                        )
                        assert not meets, (view, a, b)
            ctx.close()
        finally:
            br.close()
