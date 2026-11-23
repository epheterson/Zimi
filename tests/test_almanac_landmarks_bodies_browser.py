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

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
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
# puts the same latitude and longitude: they are one point, for every body (the Earth's picture row is the geodetic latitude).
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
                // The Earth's picture is read by the geodetic latitude of the vertex's point (AE_EARTH_VERT), not by its uv.
                var vv = key === 'earth' ? 0.5 + Math.atan2(pos.getZ(i), (1 - AE_EARTH_FLATTENING) * Math.hypot(pos.getX(i), pos.getY(i))) / Math.PI : uv.getY(i);
                var d = Math.hypot(uv.getX(i) - u, vv - v);
                if (d < bd) { bd = d; best = i; }
            }
            var w = new S.THREE.Vector3(pos.getX(best), pos.getY(best), pos.getZ(best)).applyMatrix4(mesh.matrixWorld);
            // The Earth's grid is not on its vertices (they lie on the flattened sphere's own latitudes): the landmark
            // system is asked about the vertex's own geodetic point instead.
            var lat = g[0], lon = g[1];
            if (key === 'earth') { lat = (0.5 + Math.atan2(pos.getZ(best), (1 - AE_EARTH_FLATTENING) * Math.hypot(pos.getX(best), pos.getY(best))) / Math.PI - 0.5) * 180; lon = uv.getX(best) * 360 - 180; bd = 0; }
            var dd = _aeLmDir(b, lat, lon);
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
            # Pluto's place comes from the probes' table, fetched once the view is among the planets (not on the Earth
            # it opened on): the frame after the table is in places it.
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_ae.gl.planets.mars.pos && !!_ae.gl.planets.ceres.pos; }",
                timeout=60_000,
                polling=200,
            )  # Ceres is placed once its table has come, so the grid check stands on it like on the others
            got = pg.evaluate(VERTEX_VS_LANDMARK, {"bodies": BODIES, "grid": GRID})
            for key in BODIES:
                g = got[key]
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
            pg.evaluate("() => document.getElementById('ae-lm-btn').click()")   # (its button stays in the page, unseen: the name pill's sheet presses it)
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
            pg.click("#ae-find")
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
            headings = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-go h4')).map(h => h.textContent)"
            )
            assert "Landing sites" in headings, headings
            pg.evaluate("() => { const rows = Array.from(document.querySelectorAll('#ae-go .ae-go-row')).filter(r => /Curiosity/.test(r.textContent) && /^lm:/.test(r.getAttribute('data-ae-go'))); const lm = _aeGoLmRow(rows[0].getAttribute('data-ae-go')); _aeShowGo(false); _aeLmOpen(lm.body, lm.row); _aeLmFly(lm.body, lm.row); }")   # the flight over a site (a tap in Go to now stands on the ground at a site that has one)
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
            assert "Curiosity" in card, card
            spot = pg.evaluate("""() => {
                var row = _aeLm.mars.filter(r => r[0] === 'Curiosity')[0], b = _aeLmBodies().filter(x => x.key === 'mars')[0];
                var d = _aeLmDir(b, row[1], row[2]), p = [b.center[0] + d[0] * b.r, b.center[1] + d[1] * b.r, b.center[2] + d[2] * b.r];
                _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld();
                var s = _aeProject(p);
                return { x: s.x / _ae.w, y: (s.y + (_ae.infoShift || 0)) / _ae.h, dist: _ae.dist, min: AE_TARGETS.mars.min, target: _ae.target };
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
                "Olympus Mons" in card and "Mountains" in card and "km across" in card
            ), card
            assert not pg.query_selector(
                "#ae-lm-fly"
            )  # a site's card has no way there of its own
            pg.evaluate("_aeLmFly(_ae.lm.body, _ae.lm.row)")
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
                if "18.6, -133.8" in view:
                    # Olympus Mons faces us at the middle of the disc: the best known name there is never the one to give way.
                    assert "Olympus Mons" in [b["n"] for b in boxes], boxes
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


# Over Europe at three distances from the Earth's centre (Earth radii): the whole continent and more, the continent, a few countries.
EUROPE_ZOOMS = [30.0, 14.0, 6.7]   # (without an installed map or HD the base map is only sharp down to about 6.65 Earth radii: the stop _aeCloseStop sets)
EUROPE = (48.0, 10.0)
EARTH_NAMES_MIN, EARTH_NAMES_MAX = 3, 12


def test_earth_names_a_handful_at_each_zoom_and_none_overlap(served):
    """Landmarks on, over Europe at three zooms: between 3 and 12 names, none on another, each more local as the view closes in."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
                % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=READY_MS, polling=200)
            pg.evaluate("window._almReduceMotion = function () { return true; }; _aeLmLoad()")
            pg.wait_for_function("() => !!_aeLm", timeout=60_000, polling=200)
            pg.evaluate("_aeLmSetLayer(true)")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return _aeLm.earth.length > 100; }", timeout=60_000, polling=250)
            seen = []
            for dist in EUROPE_ZOOMS:
                pg.evaluate(
                    """([dist, lat, lon]) => { var sc = _ae.scene || _aeSceneAt(_aeDisplayMs());
                        _aeFlyTo('earth', dist, _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(lat, lon), sc.gast))); _ae.dirty = true; _aeKick(); }""",
                    [dist, EUROPE[0], EUROPE[1]],
                )
                pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && (" + LABELS + ")().length > 0; }", timeout=60_000, polling=250)
                for _ in range(4):
                    pg.evaluate("_ae.dirty = true; _aeKick()")
                    pg.wait_for_timeout(300)
                boxes = pg.evaluate(BOXES)
                assert EARTH_NAMES_MIN <= len(boxes) <= EARTH_NAMES_MAX, (dist, [b["n"] for b in boxes])
                for i, a in enumerate(boxes):
                    for b in boxes[i + 1 :]:
                        assert not (a["x0"] < b["x1"] and b["x0"] < a["x1"] and a["y0"] < b["y1"] and b["y0"] < a["y1"]), (dist, a, b)
                # Each name is hit 44 px tall where it has the room (its text keeps its own height in the middle); where a neighbour is nearer the
                # gap is shared (the nearer label wins). A name is never partly off the screen.
                hits = pg.evaluate(
                    """() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(e => !e.hidden).map(e => {
                      var r = e.getBoundingClientRect(), cs = getComputedStyle(e);
                      return { n: e.textContent, h: r.height, pt: parseFloat(cs.paddingTop), pb: parseFloat(cs.paddingBottom), hit: parseFloat(cs.getPropertyValue("--hit")) || 0, mid: _aeSceneTapAt(r.left + r.width / 2, r.top + r.height / 2) === e,
                        inside: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 }; })"""
                )
                for h in hits:
                    # (The text's own height is the font's line: 14 px on a Mac, 13 on Linux. What is exact is the 6 px of padding and the hit beyond it.)
                    line = h["h"] - h["pt"] - h["pb"]
                    assert h["mid"] and h["inside"] and abs(h["pt"] - (6 + h["hit"])) < 0.5 and abs(h["pb"] - (6 + h["hit"])) < 0.5 and 10 <= line <= 18, "%s %r" % (dist, sorted(h.items()))
                seen.append([b["n"] for b in boxes])
                pg.screenshot(path=os.path.join(os.environ.get("EARTHDETAIL_SHOTS", "/tmp"), "names-%s.png" % dist)) if os.environ.get("EARTHDETAIL_SHOTS") else None
            assert seen[0] != seen[-1], seen   # closing in names other things
            ctx.close()
        finally:
            br.close()


# The Earth's sea near land is lit as shallow water (the shore tint, almanac-earth.js _aeEarthCoast), at a cost the frame does not notice.
# The shader as it was without the tint, for the comparison: the shore lines out, the sea test as it was.
SHADER_WITHOUT_SHORE = """() => { var S = _ae.gl, m = S.earth.material; if (!m.__with) m.__with = m.fragmentShader;
  m.fragmentShader = m.__with.split('\\n').filter(l => !/float shore =|day = mix\\(day, vec3|ocean = max\\(ocean/.test(l)).join('\\n');
  m.needsUpdate = true; return S.renderer.compileAsync ? S.renderer.compileAsync(S.scene, S.camera) : S.renderer.compile(S.scene, S.camera); }"""
SHADER_WITH_SHORE = """() => { var S = _ae.gl, m = S.earth.material; m.fragmentShader = m.__with || m.fragmentShader; m.needsUpdate = true;
  return S.renderer.compileAsync ? S.renderer.compileAsync(S.scene, S.camera) : S.renderer.compile(S.scene, S.camera); }"""
DRAW_MS = """(n) => { var gl = _ae.gl.renderer.getContext(), b = new Uint8Array(4); _aeDraw(performance.now(), true); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
  var t0 = performance.now(); for (var i = 0; i < n; i++) { _ae.dirty = true; _aeDraw(performance.now(), true); } gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return (performance.now() - t0) / n; }"""
SEA_PX = """([lat, lon]) => { var sc = _aeSceneAt(_aeDisplayMs()), b = _aeLmBodies().filter(x => x.key === 'earth')[0], d = _aeLmDir(b, lat, lon);
  _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); var s = _aeProject([d[0] * b.r, d[1] * b.r, d[2] * b.r]); return [s.x, s.y]; }"""
REAL_GPU = bool(os.environ.get("ZIMI_GPU"))
REAL_GPU_ARGS = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
SHORE_MIN_LIFT = 6.0        # luminance (0-255) the tint adds to the sea off a coast, and the margin over the open sea
FRAME_COST_MAX = 1.05       # the frame costs at most this much more with the tint than without
COAST_LINE = [(33.6, -119.75 - 0.25 * i) for i in range(17)]   # a line of sea off the coast, from the shore out 400 km
OPEN_PT = (30.0, -131.0)                                            # the Pacific far out


def _lum(png, x, y, half=4):
    import io

    from PIL import Image

    im = Image.open(io.BytesIO(png)).convert("RGB")
    box = im.crop((int(x) - half, int(y) - half, int(x) + half + 1, int(y) + half + 1))
    px = list(box.getdata())
    return sum(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px) / len(px)


def test_the_sea_near_a_coast_is_lighter_than_the_open_sea_and_costs_the_frame_nothing(served):
    """Over the Pacific off Los Angeles at noon: the sea a short way off the coast is lighter than the open sea far out, and was not before.
    With ZIMI_GPU=1 (a real GPU, the Metal one here) drawing the frame with the tint also costs within 5 percent of drawing it without; the
    software renderer's time is the CPU's, which has no texture unit, so it is printed and not held to that."""
    import statistics

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=REAL_GPU_ARGS if REAL_GPU else GL_ARGS)
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
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=READY_MS * 3, polling=200)
            pg.evaluate("window._almReduceMotion = function () { return true; }")
            pg.wait_for_function("() => !!_ae.gl.earthUni.coastMap.value", timeout=60_000, polling=200)
            pg.evaluate("_aeLmLoad()")
            pg.wait_for_function("() => !!_aeLm", timeout=60_000, polling=200)   # the earth's place on the screen is read off the landmarks' own placement
            pg.evaluate(
                """() => { _aeGoTo(Date.UTC(2026, 10, 11, 20, 0, 0)); var sc = _aeSceneAt(Date.UTC(2026, 10, 11, 20, 0, 0));
                  _aeFlyTo('earth', 1.7, _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(31.0, -125.0), sc.gast))); _ae.dirty = true; _aeKick(); }"""
            )

            def settle():
                for _ in range(4):
                    pg.evaluate("_ae.dirty = true; _aeKick()")
                    pg.wait_for_timeout(200)

            def sample():
                settle()
                xy = [pg.evaluate(SEA_PX, list(p)) for p in COAST_LINE + [OPEN_PT]]
                assert all(200 < y < VIEW["height"] - 150 and 20 < x < VIEW["width"] - 45 for x, y in xy), xy   # in the picture, clear of the bars and the buttons
                png = pg.screenshot()
                return [_lum(png, *p) for p in xy]

            pg.evaluate(SHADER_WITHOUT_SHORE)
            before = sample()
            pg.evaluate(SHADER_WITH_SHORE)
            after = sample()
            lift = max(a - b for a, b in zip(after[:-1], before[:-1]))
            assert lift > SHORE_MIN_LIFT, ("the sea off the coast is lighter with the tint", lift, before, after)
            assert max(after[:-1]) > after[-1] + SHORE_MIN_LIFT, "the sea off the coast is lighter than the open sea"
            assert abs(after[-1] - before[-1]) < 2, "the open sea is as it was"
            # The cost: the same draw, with and without, alternating, the medians.
            times = {"with": [], "without": []}
            for rnd in range(5):
                for mode, js in (("without", SHADER_WITHOUT_SHORE), ("with", SHADER_WITH_SHORE)) if rnd % 2 == 0 else (("with", SHADER_WITH_SHORE), ("without", SHADER_WITHOUT_SHORE)):
                    pg.evaluate(js)
                    settle()
                    pg.evaluate(DRAW_MS, 5)
                    times[mode].append(pg.evaluate(DRAW_MS, 20))
            w, wo = statistics.median(times["with"]), statistics.median(times["without"])
            print("frame ms with the shore %.2f without %.2f" % (w, wo))
            if REAL_GPU:
                assert w <= wo * FRAME_COST_MAX, (w, wo, times)
            ctx.close()
        finally:
            br.close()
