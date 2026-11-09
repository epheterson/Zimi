"""A landing site and Stand here are one experience (almanac-standhost.js): the visit's models, rocks and rover stand on the
ground of Stand here (its terrain, its sky, the Sun and the other bodies in it), the site's camera orbits the lander or chases
the rover, and eye level is a second camera of the same visit, turned by a finger or the phone. Headless Chromium at a phone's
size, software GL.

Run: pytest tests/test_almanac_stand_sites_browser.py -v
"""

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
READY_MS = 300_000
STAND_MS = 300_000


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

    tmp = tmp_path_factory.mktemp("standsites")
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
    env.undo()


@pytest.fixture(scope="module")
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=1,
            has_touch=True,
            is_mobile=True,
            service_workers="block",
        )
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
            # Chromium now has iOS's permission ask, and a headless one answers no: answer yes, as a tap would.
            "DeviceOrientationEvent.requestPermission = function () { return Promise.resolve('granted'); };"
            % (PLACE, PLACE)
        )
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.on(
            "console",
            lambda m: (
                pg.errors.append(m.text[:400])
                if m.type == "error" and "THREE" in m.text
                else None
            ),
        )
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=240_000,
        )
        pg.evaluate("() => openAlmanacEarth({ target: 'moon' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=READY_MS,
            polling=200,
        )
        pg.evaluate("() => _aeLmLoad()")
        pg.wait_for_function("() => !!_aeLm", timeout=60_000)
        yield pg
        br.close()


def _visit(pg, body, name, drive=False):
    pg.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    pg.evaluate("() => _aeNow()")
    pg.evaluate("(b) => _aePreset(b)", body)
    pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=250)
    pg.evaluate(
        "([b, n]) => _aeLmOpen(b, _aeLm[b].filter(r => r[0] === n)[0])", [body, name]
    )
    pg.wait_for_function(
        "() => !!document.getElementById('as-visit')", timeout=120_000, polling=250
    )
    pg.evaluate(
        "(id) => document.getElementById(id).click()",
        "as-drive" if drive else "as-visit",
    )
    pg.wait_for_function(
        "() => { var s = _aeSiteState(); return s && s.phase === 'stand' && s.ready; }",
        timeout=STAND_MS,
        polling=500,
    )
    pg.wait_for_function(
        "() => _ae.site && _ae.site.host && _ae.site.host.live",
        timeout=STAND_MS,
        polling=500,
    )


def test_a_visit_is_drawn_on_the_ground_of_stand_here(page):
    _visit(page, "moon", "Apollo 17")
    s = page.evaluate(
        """() => { var st = _ae.site, g = st.host.st; return { inScene: g.scene.children.indexOf(st.group) >= 0, patchHidden: st.ground.visible === false,
          terrainHere: !!st.terrainHere, metre: st.shared.metre.value, sky: !!g.sky, ground: !!g.ground, sprites: g.sprites.length, objs: g.fr ? g.fr.objs.length : 0 }; }"""
    )
    assert s["inScene"] and s["patchHidden"] and s["terrainHere"], s
    assert (
        s["metre"] == 1
        and s["sky"]
        and s["ground"]
        and s["sprites"] > 10
        and s["objs"] >= 10
    ), s
    assert not page.errors, page.errors


def test_the_models_and_the_rover_stand_on_the_grounds_terrain(page):
    """The site's one height is the ground's: levelled at the lander, the terrain's own beyond, the body's curve in it."""
    h = page.evaluate(
        """() => { var st = _ae.site, h0 = _aeTerrainHeight(st.body, st.lat, st.lon, 0).h, flat = [st.flatFrom || AS_FLAT_FROM_M, st.flatTo || AS_FLAT_TO_M];
          return { at0: _asGroundAt(st, 0, 0, false), near: _asGroundAt(st, 5, 5, false), far: _asGroundAt(st, 600, 200, true),
            want: _aeTerrainLocal(st.body, st.lat, st.lon, h0, 600, 200, Math.hypot(600, 200) * AS_TERRAIN_LOD_PER_M, flat) }; }"""
    )
    assert (
        abs(h["at0"]) < 0.05 and abs(h["near"]) < 0.1
    ), "level where the lander stands"
    assert abs(h["far"] - h["want"]) < 1e-6, "beyond that the ground's own height"
    parts = page.evaluate(
        "() => _aeSiteState().parts.map(function (p) { return [p.model, p.z, p.ground]; })"
    )
    assert parts and all(abs(p[1] - p[2]) < 0.2 or p[0] == "saturn5" for p in parts)


def test_eye_level_is_a_camera_of_the_visit_and_the_phone_turns_it(page):
    page.wait_for_function(
        "() => !document.getElementById('as-eye').hidden", timeout=60_000, polling=250
    )
    page.evaluate("() => document.getElementById('as-eye').click()")
    page.wait_for_function("() => _ae.site.eye && _ae.site.eye.on", timeout=30_000)
    cam = page.evaluate(
        """() => { var st = _ae.site; _aeKick(); return { height: _asCameraLocal(st, 0.016).pos[2] - _asGroundAt(st, st.eye.x, st.eye.y, false), away: Math.hypot(st.eye.x - st.focusXY[0], st.eye.y - st.focusXY[1]) }; }"""
    )
    assert abs(cam["height"] - 1.7) < 0.05 and cam["away"] > 5, cam
    page.evaluate("() => _aeHostEyeLook(_ae.site, 100, 0)")
    assert page.evaluate("() => _ae.site.eye.yaw") != 0
    page.wait_for_function(
        "() => !document.getElementById('as-motion').hidden",
        timeout=30_000,
        polling=250,
    )
    assert page.evaluate("() => _aeHostMotionToggle(_ae.site)")
    page.evaluate(
        "() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 90, beta: 90, gamma: 0, absolute: true }))"
    )
    page.wait_for_function(
        "() => { _aeKick(); var y = (_ae.site.eye.yaw * 180 / Math.PI % 360 + 360) % 360; return Math.abs(y - 270) < 6; }",
        timeout=60_000,
        polling=500,
    )
    page.evaluate("() => document.getElementById('as-eye').click()")
    page.wait_for_function("() => !_ae.site.eye.on", timeout=30_000)
    assert not page.errors, page.errors


def test_a_rover_drives_on_the_ground_and_the_visit_ends_cleanly(page):
    _visit(page, "mars", "Curiosity", drive=True)
    w = page.evaluate(
        "() => _aeSiteState().rover.wheels.map(function (w) { return Math.abs(w.z - w.ground - 0.3) < 0.35; })"
    )
    assert w and all(w), "the wheels stand on the ground's heights"
    page.evaluate("() => _aeSiteLeave()")
    page.wait_for_function("() => !_ae.site", timeout=30_000)
    left = page.evaluate(
        "() => ({ ratio: _ae.gl.renderer.getPixelRatio() <= _ae.gl.dpr, clear: _ae.gl.renderer.getClearAlpha() })"
    )
    assert left["clear"] == 0, "the orbit view's see-through canvas is back"
    assert not page.errors, page.errors
