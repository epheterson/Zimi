"""The 3D view's worlds in tiles (Pluto, Io) and the Sun close up, at a phone's size.

A small Almanac HD for two planets' layers is built here and served; the view is driven in headless Chromium at 390x844.
Tiles load and sharpen as the camera nears, the GPU memory stays under its cap while the camera goes from world to
world, and the Sun renders at three distances with its prominences and flares (almanac-sun.js, loaded on first need).
Screenshots land in $ZIMI_SHOTS (when set) to be looked at.

Run: scripts/heavy.sh pytest tests/test_almanac_bodies_browser.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import test_almanac_hd_browser as hdb  # noqa: E402
from test_almanac_hd_browser import _open_earth, _settle  # noqa: E402,F401

LAYERS = {"planets/pluto": 2, "planets/io": 2}
SHOTS = os.environ.get("ZIMI_SHOTS")


def _fixture_hd(folder, out):
    from PIL import Image, ImageDraw

    from zimi import creator

    for layer, top in LAYERS.items():
        for z in range(top + 1):
            for x in range(2 ** (z + 1)):
                for y in range(2**z):
                    p = os.path.join(folder, layer, str(z), str(x))
                    os.makedirs(p, exist_ok=True)
                    # A checker that gets finer with the level, so a sharper level can be told by eye.
                    im = Image.new("RGB", (64, 64), (90, 80 + 40 * z, 70))
                    d = ImageDraw.Draw(im)
                    step = max(4, 32 >> z)
                    for i in range(0, 64, step * 2):
                        d.rectangle(
                            [i, 0, i + step - 1, 63], fill=(200, 160 + 30 * z, 120)
                        )
                    im.save(os.path.join(p, "%d.webp" % y), "WEBP")
    with open(os.path.join(folder, "hd.json"), "w") as f:
        json.dump(
            {
                "version": 1,
                "tile": 512,
                "ext": "webp",
                "layers": {k: {"max": v} for k, v in LAYERS.items()},
            },
            f,
        )
    with open(os.path.join(folder, "index.html"), "w") as f:
        f.write("<!doctype html><title>Almanac HD</title><p>tiles</p>")
    with open(os.path.join(folder, "zimi.txt"), "w") as f:
        f.write(
            "Title: Almanac HD\nDescription: test tiles\nLanguage: eng\nCreator: test\nPublisher: test\n"
        )
    creator.create_folder_zim(folder, out_path=out, register=False)


@pytest.fixture(scope="module")
def browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=hdb.GL_ARGS)
        yield br
        br.close()


@pytest.fixture
def served(tmp_path):
    import zimi.server as srv

    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    # The tiles-only flavour: the ZIM sits in the library, the view finds it by name.
    (tmp_path / "zims").mkdir()
    (tmp_path / "data").mkdir()
    _fixture_hd(
        str(tmp_path / "stage"), str(tmp_path / "zims" / "zimi_almanac_hd_2026-11.zim")
    )
    from http.server import ThreadingHTTPServer
    import threading

    from zimi.http import ZimHandler

    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp_path / "zims"), str(tmp_path / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"), timeout=240_000)


def _body(key):
    return "_ae.gl.hd.bodies.filter(b => b.key === '%s')[0]" % key


def test_a_world_sharpens_as_the_camera_nears_and_the_memory_holds(browser, served):
    ctx, pg, tiles = _open_earth(browser, served, base="/w/zimi_almanac_hd/")
    try:
        pg.wait_for_function("() => _ae.gl.hd", timeout=60_000, polling=200)
        bodies = pg.evaluate("_ae.gl.hd.bodies.map(b => b.key)")
        assert "pluto" in bodies and "io" in bodies, bodies
        # The memory cap, small enough here that going between worlds must give tiles back.
        cap = 12 * 1024 * 1024
        pg.evaluate("_ae.gl.hd.budget = %d" % cap)
        most = {"pluto": 0, "io": 0}
        for key in ("pluto", "io", "pluto"):
            pg.evaluate("_aePreset('%s')" % key)
            _settle(
                pg, "() => !_ae.fly && %s.drawn.length > 0" % _body(key), ms=120_000
            )
            # Far: the first levels only.
            far = pg.evaluate("%s.drawn.map(n => n.z)" % _body(key))
            _shot(pg, "tiles-%s-far" % key)
            pg.evaluate(
                "_ae.dist = AE_TARGETS['%s'].min; _ae.dirty = true; _aeKick()" % key
            )
            _settle(
                pg,
                "() => %s.drawn.length > 0 && %s.drawn.every(n => n.z === 2)"
                % (_body(key), _body(key)),
                ms=120_000,
            )
            near = pg.evaluate("%s.drawn.map(n => n.z)" % _body(key))
            _shot(pg, "tiles-%s-near" % key)
            assert max(near) > max(far), (key, far, near)
            most[key] = max(near)
            # The memory cap holds: over it only by what is drawn this frame.
            held = pg.evaluate("""() => { var hd = _ae.gl.hd; var inUse = 0;
                hd.bodies.forEach(b => { for (var k in b.nodes) { var n = b.nodes[k];
                  if (n.used === hd.frame) for (var l in n.tex) if (n.tex[l] && n.tex[l].isTexture) inUse += n.tex[l].userData.bytes; } });
                return { gpu: hd.gpu, inUse: inUse, budget: hd.budget }; }""")
            assert held["gpu"] <= max(held["budget"], held["inUse"]), held
        assert most["pluto"] == 2 and most["io"] == 2
        # Pluto's base map steps aside once its tiles cover it; Mercury (no tiles here) keeps its one map.
        assert pg.evaluate("_ae.gl.planets.mercury.mesh.material.visible") is True
    finally:
        ctx.close()


def test_decoded_tiles_reach_the_gpu_a_couple_a_frame(browser, served):
    ctx, pg, _ = _open_earth(browser, served, base="/w/zimi_almanac_hd/")
    try:
        pg.wait_for_function("() => _ae.gl.hd", timeout=60_000, polling=200)
        peak = pg.evaluate(
            """() => { var hd = _ae.gl.hd, calls = 0, max = 0, S = _ae.gl, orig = S.renderer.initTexture.bind(S.renderer);
            S.renderer.initTexture = function (t) { calls++; return orig(t); };
            var frame = hd.frame;
            return new Promise(res => { var t0 = performance.now(); (function tick() {
              _ae.dirty = true; _aeKick(); var perFrame = calls; calls = 0; max = Math.max(max, perFrame);
              if (performance.now() - t0 > 4000) return res(max); requestAnimationFrame(tick); })(); }); }"""
        )
        assert peak <= pg.evaluate("AE_HD_UPLOADS * 2"), peak
    finally:
        ctx.close()


SUN_DISTANCES = {"far": 10.0, "mid": 5.0, "close": 2.6}  # in the Sun's drawn radii


def test_the_sun_renders_at_three_distances_with_its_close_up(browser, served):
    ctx, pg, _ = _open_earth(browser, served, base="/w/zimi_almanac_hd/")
    errors = []
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    try:
        # A date at the cycle's peak, so there are spots, loops and flares to draw.
        pg.evaluate("_aePreset('sun')")
        pg.wait_for_function(
            "() => _ae.target === 'sun' && !_ae.fly", timeout=60_000, polling=200
        )
        pg.evaluate("() => { window._sync = S => { var gl = S.renderer.getContext(), px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }; }")
        times = {}
        for name, radii in SUN_DISTANCES.items():
            pg.evaluate(
                "_ae.fly = null; _ae.dist = AE_SUN_SHOW_R * %f; _ae.dirty = true; _aeKick()"
                % radii
            )
            pg.wait_for_function(
                "() => typeof _aeSunFxTick === 'function' && _ae.gl.sunFx && _ae.gl.sunFx.on === true",
                timeout=60_000,
                polling=200,
            )
            pg.wait_for_timeout(600)
            _shot(pg, "sun-%s" % name)
            # Frame time: the render itself, 12 frames, in this (software) browser.
            times[name] = pg.evaluate(
                """() => { var S = _ae.gl, t0 = performance.now(); for (var i = 0; i < 12; i++) S.renderer.render(S.scene, S.camera);
                window._sync(S); return (performance.now() - t0) / 12; }"""
            )
        # Plain against full at the close distance: what the close-up adds to a frame.
        plain = pg.evaluate(
            """() => { var S = _ae.gl, fx = S.sunFx, full = [S.sunMat.fragmentShader, S.sunGlowMat.fragmentShader];
            S.sunMat.fragmentShader = AE_SUN_FRAG; S.sunGlowMat.fragmentShader = AE_SUN_GLOW_FRAG; S.sunMat.needsUpdate = S.sunGlowMat.needsUpdate = true;
            S.renderer.render(S.scene, S.camera); var t0 = performance.now(); for (var i = 0; i < 12; i++) S.renderer.render(S.scene, S.camera);
            window._sync(S); var ms = (performance.now() - t0) / 12;
            S.sunMat.fragmentShader = full[0]; S.sunGlowMat.fragmentShader = full[1]; S.sunMat.needsUpdate = S.sunGlowMat.needsUpdate = true; return ms; }"""
        )
        print(
            "sun frame ms (software GL, 390x844 at 2x):",
            times,
            "plain at close:",
            plain,
        )
        # No shader failed to compile.
        bad = [
            e
            for e in errors
            if "shader" in e.lower() or "program" in e.lower() or "glsl" in e.lower()
        ]
        assert not bad, bad
        loaded = pg.evaluate("typeof _aeSunFxTick === 'function' && _ae.gl.sunFx.on")
        assert loaded is True
        # What stands on the Sun was fed to the shaders.
        fed = pg.evaluate("Array.from(_ae.gl.sunFx.promA).some(v => v !== 0)")
        assert fed is True
    finally:
        ctx.close()
