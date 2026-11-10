"""Stand here in the 3D view: the way down to the ground of a body and back, in headless Chromium at a phone's size.

Tapping a spot on a body in view gives a card with the place, its height and a Stand here button; the button flies
down and the view is the ground (its own sky and terrain, the Sun and the other bodies where they are), a drag turns
the head, Back returns to orbit. Done on three bodies (the Moon, Mars, Titan: no air, thin dusty air, thick haze).
The ground heights are what the maps say (Olympus Mons high, Hellas low), and the frame time on the ground is
measured and printed (swiftshader here: a bound, not a phone).

Run: pytest tests/test_almanac_stand_browser.py -v
"""

import os
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
GROUND_MS = 180_000
SPOTS = {
    "moon": (20.19, 30.77),  # Taurus-Littrow
    "mars": (-5.4, 137.8),  # Gale
    "titan": (-10.6, 192.3),  # Huygens
}


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

    tmp = tmp_path_factory.mktemp("stand")
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

    with sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        ctx = browser.new_context(
            viewport=VIEW,
            device_scale_factor=2,
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
        # A shader that does not compile draws nothing and says so only here.
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
            timeout=120_000,
        )
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
            timeout=READY_MS,
            polling=200,
        )
        yield pg
        browser.close()


def _stand(pg, body):
    lat, lon = SPOTS[body]
    pg.evaluate("([b, la, lo]) => _aeStandAt(b, la, lo)", [body, lat, lon])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=200,
    )


def _leave(pg):
    pg.evaluate("() => _aeStandLeave()")
    pg.wait_for_function(
        "() => !_ae.stand && !document.getElementById('ae-view').classList.contains('ae-standing')",
        timeout=60_000,
        polling=200,
    )


@pytest.mark.parametrize("body", ["moon", "mars", "titan"])
def test_enter_and_leave(page, body):
    """Down to the ground and back on a body with no air, with dust, with haze."""
    _stand(page, body)
    state = page.evaluate(
        """() => { var st = _ae.stand; return { key: st.key, standing: document.getElementById('ae-view').classList.contains('ae-standing'),
          alt: st.altKm * 1000, hud: !!document.getElementById('ae-stand-text'), fr: !!st.fr, objs: st.fr.objs.length, sunAlt: st.fr.sunAlt }; }"""
    )
    assert state["key"] == body and state["standing"] and state["hud"] and state["fr"]
    assert (
        abs(state["alt"] - 1.7) < 0.01
    ), "on the ground the camera is an eye's height up"
    assert state["objs"] >= 10, "the other bodies are in the sky"
    page.evaluate("() => _aeStandLook(120, -40)")
    yaw = page.evaluate("() => _ae.stand.userYaw")
    assert yaw < 0, "dragging right turns the view left"
    _leave(page)
    assert (
        page.evaluate("() => _ae.target") == body
    ), "back returns to orbit over the body"
    assert not page.errors, page.errors


def test_terrain_heights(page):
    """The loaded maps: Olympus Mons is high, Hellas is low, the sea is at zero."""
    page.evaluate(
        "() => _aeStandReady()"
    )  # the terrain module comes with Stand here's, on first use
    page.evaluate(
        "() => Promise.all(['mars', 'earth', 'moon'].map(function (k) { return _aeTerrainLoad(k); }))"
    )
    olympus = page.evaluate("() => _aeGroundHeight('mars', 18.65, -133.8)")
    hellas = page.evaluate("() => _aeGroundHeight('mars', -42.4, 70.5)")
    ocean = page.evaluate("() => _aeGroundHeight('earth', 0, -150)")
    nothing = page.evaluate("() => _aeGroundHeight('jupiter', 0, 0)")
    assert olympus > 14000 and hellas < -5000 and olympus - hellas > 20000
    assert ocean == 0 and nothing == 0


def test_tap_card_and_button(page):
    """A tap on the body in view gives its spot a card with a Stand here button, which goes down."""
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function(
        "() => !_ae.fly && _ae.target === 'moon'", timeout=90_000, polling=200
    )
    page.evaluate("() => { _ae.dirty = true; _aeKick(); }")
    page.wait_for_timeout(500)
    page.evaluate("() => _aeTap(_ae.w / 2, _ae.h / 2)")
    page.wait_for_function("() => !!_ae.pick", timeout=30_000, polling=100)
    card = page.evaluate(
        "() => ({ hidden: document.getElementById('ae-card').hidden, button: !!document.querySelector('#ae-card [data-ae-stand]'), body: _ae.pick.body })"
    )
    assert card["body"] == "moon" and not card["hidden"] and card["button"]
    page.click("#ae-card [data-ae-stand]")
    page.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=200,
    )
    assert page.evaluate("() => _ae.stand.key") == "moon"
    _leave(page)
    assert not page.errors, page.errors


def test_frame_time_on_the_ground(page):
    """Median draw time of the ground scene at 390 x 844 (printed; swiftshader is far slower than a phone's GPU)."""
    _stand(page, "mars")
    ms = page.evaluate(
        """() => { var st = _ae.stand, t = []; for (var i = 0; i < 9; i++) { st.dirty = true; var a = performance.now();
          _aeStandDraw(performance.now()); (function (g) { g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(4)); })(_ae.gl.renderer.getContext()); t.push(performance.now() - a); } t.sort(function (x, y) { return x - y; }); return t[4]; }"""
    )
    print("\nstand here, Mars, 390x844 swiftshader: median draw %.1f ms" % ms)
    assert ms < 5000
    _leave(page)


def test_hd_terrain_tiles_sharpen_the_heights(page):
    """With the Almanac HD terrain tiles in, the heights near a place come from them; elsewhere the shipped map holds."""
    pytest.importorskip("numpy")
    import io

    import numpy as np
    from PIL import Image

    # A tile of one height everywhere (1234 m), as build_terrain.py writes them: metres + 32768 in red and green.
    u = np.full((256, 256), 1234 + 32768, dtype=np.uint16)
    rgb = np.zeros((256, 256, 3), dtype=np.uint8)
    rgb[..., 0], rgb[..., 1] = u >> 8, u & 255
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "WEBP", lossless=True)
    body = buf.getvalue()
    page.route(
        "**/hdtest/terrain/moon/3/*/*.webp",
        lambda route: route.fulfill(status=200, content_type="image/webp", body=body),
    )
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => _aeTerrainLoad('moon')")
    before = page.evaluate("() => _aeTerrainHeight('moon', 20.19, 30.77, 1e9).h")
    loaded = page.evaluate(
        "() => _aeTerrainHdLoad('moon', 20.19, 30.77, '/hdtest/', 3)"
    )
    after = page.evaluate("() => _aeTerrainHeight('moon', 20.19, 30.77, 1e9).h")
    far = page.evaluate("() => _aeTerrainHeight('moon', -60, -120, 1e9).h")
    page.evaluate("() => { _aeTerr.moon.hd = null; }")
    assert loaded and abs(after - 1234) < 1 and abs(before - 1234) > 5, (before, after)
    assert far != 1234, "a place whose tiles are not in keeps the shipped map"
    assert not page.errors, page.errors


# ── The sky and the ground, the later pieces ──
def _stand_anywhere(pg, body, lat, lon):
    pg.evaluate("([b, la, lo]) => _aeStandAt(b, la, lo)", [body, lat, lon])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground' && _ae.stand.fr",
        timeout=GROUND_MS,
        polling=200,
    )


def test_charon_hangs_over_pluto_and_saturn_shows_its_rings(page):
    _stand_anywhere(page, "pluto", 10, 10)
    charon = page.evaluate(
        "() => { var o = _ae.stand.fr.objs.filter(function (x) { return x.key === 'charon'; })[0]; return o && { rho: o.rho, z: o.dir[2], dist: o.dist }; }"
    )
    assert charon, "Charon is among the bodies in Pluto's sky"
    assert (
        0.029 < charon["rho"] < 0.033
    ), "its disc is about 1.8 degrees in radius (606 km at 19,591 km)"
    assert (
        charon["z"] > 0.9 and abs(charon["dist"] - (19591 - 1188)) < 700
    ), "from a place near the sub-Charon point it is almost overhead (centre distance less Pluto's radius)"
    _leave(page)
    _stand_anywhere(page, "titan", -10.6, 192.3)
    page.wait_for_function("() => !!_ae.stand.ringTex", timeout=60_000, polling=200)
    sat = page.evaluate(
        """() => { var st = _ae.stand, i = st.fr.objs.findIndex(function (x) { return x.key === 'saturn'; });
          st.dirty = true; _aeStandDraw(performance.now()); var sp = st.sprites[i + 1];
          return { rho: st.fr.objs[i].rho, rings: sp.uni.uRings.value, ringMap: !!sp.uni.uRingMap.value, half: sp.uni.uHalf.value, ring: sp.uni.uRing.value }; }"""
    )
    assert (
        sat["rings"] == 1 and sat["ringMap"] and sat["half"] > sat["rho"] * 1.8
    ), "Saturn's quad is wide enough for its rings, which are drawn"
    _leave(page)
    assert not page.errors, page.errors


def test_spacecraft_are_marked_where_they_are(page):
    _stand_anywhere(page, "moon", 20.19, 30.77)
    page.evaluate("() => { _aeTracksLoad(); }")
    page.wait_for_function(
        "() => !!_aeTracks && !!_aeTracks.probes && _aeTracks.probes.length > 0",
        timeout=60_000,
        polling=200,
    )
    page.evaluate(
        "() => { _ae.stand.fr = null; _ae.stand.dirty = true; _ae.dirty = true; _aeKick(); }"
    )
    page.wait_for_function(
        "() => _ae.stand.fr && _ae.stand.fr.crafts && _ae.stand.fr.crafts.length > 0",
        timeout=60_000,
        polling=200,
    )
    crafts = page.evaluate(
        "() => _ae.stand.fr.crafts.map(function (c) { return [c.key, c.dist > 1, Math.abs(Math.hypot(c.dir[0], c.dir[1], c.dir[2]) - 1) < 1e-6]; })"
    )
    assert any(c[0] == "voyager1" for c in crafts) and all(
        c[1] and c[2] for c in crafts
    )
    _leave(page)


def test_a_low_sun_throws_the_reliefs_shadows(page):
    _stand_anywhere(page, "moon", 20.19, 30.77)
    ms = page.evaluate(
        """() => { var st = _ae.stand, base = _aeDisplayMs(), prev = _aeStFrame(st, base).sunAlt;
          for (var t = base + 3600000; t < base + 800 * 3600000; t += 3600000) { var a = _aeStFrame(st, t).sunAlt; if (prev < 4 && a >= 4) return t; prev = a; } return null; }"""
    )
    assert ms, "the Sun rises there within a lunar month"
    page.evaluate("(ms) => _aeGoTo(ms)", ms)
    page.wait_for_function(
        "() => { var sh = _ae.stand.shade; return !!sh && !sh.job && _ae.stand.fr && _ae.stand.fr.sunAlt < 7 && Math.abs(_ae.stand.fr.sunAlt - 4) < 3; }",
        timeout=GROUND_MS,
        polling=500,
    )
    stats = page.evaluate(
        "() => { var a = _ae.stand.shade.arr, lo = 0, n = a.length, s = 0; for (var i = 0; i < n; i++) { s += a[i]; if (a[i] < 0.5) lo++; } return { shadowed: lo / n, mean: s / n }; }"
    )
    assert 0.002 < stats["shadowed"] < 0.6, (
        "some of the ground is in shadow at a Sun 4 degrees up, most is not (%s)"
        % stats
    )
    _leave(page)


def test_other_lanes_put_objects_in_the_sky_and_a_tap_names_them(page):
    """_aeStandSkySource: what a source returns is drawn in the sky and named on a tap, hidden by day, gone once taken out."""
    _stand_anywhere(page, "earth", 37.77, -122.42)
    seen = page.evaluate(
        """() => { window.__calls = []; window.__ats = 0; window.__off = _aeStandSkySource({
          ask: function (lat, lon, ms) { window.__calls.push(['earth', lat, lon, typeof ms]); return Promise.resolve({ t: ms }); },
          at: function (answer, ms) { window.__ats++; return [{ az: 180, el: 40, mag: -3, kind: 'sat', name: 'Test one', trail: [{ az: 190, el: 38 }, { az: 200, el: 36 }] }, { az: 90, el: 10, mag: 1, kind: 'plume', name: 'Glow' }]; } }); return 1; }"""
    )
    page.wait_for_function(
        "() => !!_ae.stand.skyPts && !!_ae.stand.skyLines", timeout=30_000, polling=250
    )
    calls = page.evaluate("() => window.__calls[0]")
    assert (
        calls[0] == "earth" and abs(calls[1] - 37.77) < 1e-6 and calls[3] == "number"
    ), calls
    # By night it is visible and a tap on it names it; by day the rule hides it.
    page.evaluate(
        "() => { _ae.stand.photo.lim = 6; _ae.stand.starUni.uLim.value = 6; _ae.stand.skyDirty = true; _ae.stand.dirty = true; }"
    )
    spot = page.evaluate(
        """() => { var st = _ae.stand, V = _ae.gl.THREE.Vector3, o = st.skyObjs[0], d = o.dir; st.userYaw = Math.atan2(d[0], d[1]) - st.yaw; st.userPitch = Math.asin(d[2]) - 0.05; st.dirty = true; _aeStandDraw(performance.now()); st.photo.lim = 6;
          var p = new V(d[0] * 10, d[1] * 10, d[2] * 10).project(st.camera); return [(p.x + 1) / 2 * _ae.w, (1 - p.y) / 2 * _ae.h]; }"""
    )
    assert page.evaluate("([x, y]) => _aeStandSkyTap(x, y)", spot) is True
    # (The tag of the tapped thing is the sky tag's own: the station's label, when it is up, is another element of the same class.)
    assert "Test one" in page.evaluate("() => _ae.stand.skyTag.firstChild.textContent")
    page.evaluate("() => { _ae.stand.photo.lim = -6; }")
    assert (
        page.evaluate("([x, y]) => _aeStandSkyTap(x, y)", spot) is False
    ), "by day it is not there to tap"
    page.evaluate("() => window.__off()")
    page.evaluate(
        "() => { _ae.stand.skyDirty = true; _ae.stand.dirty = true; _aeStandDraw(performance.now()); }"
    )
    assert page.evaluate("() => !_ae.stand.skyPts && !_ae.stand.skyObjs")
    _leave(page)
    assert not page.errors, page.errors


def test_a_provider_atmosphere_takes_over_the_sky_and_the_exposure(page):
    """_aeStandAir: while it wants the stand, its chunk is the sky and its exposureK the one exposure; taken away, the own march."""
    _stand_anywhere(page, "earth", 37.77, -122.42)
    own_k = page.evaluate(
        "() => { _ae.stand.dirty = true; _aeStandDraw(performance.now()); return _ae.stand.photo.k; }"
    )
    page.evaluate(
        """() => { window.__upd = 0; _aeStandAir = { wants: function (st) { return st.key === 'earth'; },
          glsl: 'uniform vec3 uTest; vec3 oaSky(vec3 d) { return uTest; }', uniforms: { uTest: [0.2, 0.1, 0.05] },
          update: function (st, fr, ph, u) { window.__upd++; u.uTest.value = [0.2, 0.1, 0.05]; }, exposureK: function () { return 1234; } };
          _ae.stand.fr = null; _ae.stand.dirty = true; _ae.dirty = true; _aeKick(); }"""
    )
    page.wait_for_function(
        "() => _ae.stand.airOn === true && _ae.stand.photo && _ae.stand.photo.k === 1234",
        timeout=30_000,
        polling=250,
    )
    assert page.evaluate("() => window.__upd") > 0
    page.evaluate(
        "() => { _aeStandAir = null; _ae.stand.fr = null; _ae.stand.dirty = true; _ae.dirty = true; _aeKick(); }"
    )
    page.wait_for_function(
        "() => _ae.stand.airOn === false && _ae.stand.photo && _ae.stand.photo.k !== 1234",
        timeout=30_000,
        polling=250,
    )
    assert abs(page.evaluate("() => _ae.stand.photo.k") / own_k - 1) < 0.5
    _leave(page)
    assert not page.errors, page.errors


def test_a_provider_eclipse_dims_the_sun_shows_stars_and_draws_the_moon_over_the_sun(
    page,
):
    """sunShare / limitMag / eclipse(): the Sun's light and the faintest star follow the provider; the Moon's disc covers the Sun's and wears a corona."""
    _stand_anywhere(
        page, "earth", 30.05, -99.14
    )  # Kerrville, 2024-04-08: the Moon on the Sun at 18:32 UTC
    page.evaluate(
        """() => { _aeStandAir = { wants: function (st) { return st.key === 'earth'; },
          glsl: 'uniform vec3 uTest; vec3 oaSky(vec3 d) { return uTest; }', uniforms: { uTest: [0.0005, 0.0007, 0.0012] },
          update: function () {}, sunShare: function () { return 0.003; }, limitMag: function () { return 4.5; },
          eclipse: function () { return { obsc: 1, sunShare: 0.003, sunSemiDeg: 0.2666, moonSemiDeg: 0.2745, corona: 1 }; } };
          _aeGoTo(Date.UTC(2024, 3, 8, 18, 32, 20)); _ae.stand.fr = null; _ae.stand.dirty = true; _ae.dirty = true; _aeKick(); }"""
    )
    page.wait_for_function(
        "() => _ae.stand.photo && _ae.stand.photo.lim === 4.5 && _ae.stand.photo.sunShare === 0.003",
        timeout=30_000,
        polling=250,
    )
    got = page.evaluate(
        """() => _ae.stand.sprites.filter(function (s) { return s.mesh.visible; }).map(function (s) {
          return { occ: s.uni.uOcc.value[2], cor: s.uni.uCorona.value, rho: s.uni.uRho.value }; })"""
    )
    assert any(
        abs(g["rho"] - 0.2666 * 3.14159265 / 180) < 1e-4 for g in got
    ), got  # the Sun at its true semi-diameter
    assert any(g["occ"] > 0 for g in got), got  # with the Moon's disc over it
    assert any(g["cor"] == 1 for g in got), got  # and the corona on the Moon
    # Without the provider's ambient the ground's sky light is this view's own, dimmed by the share; with it, the provider's, as given.
    dim = page.evaluate("() => _ae.stand.photo.amb.map(function (x) { return x; })")
    page.evaluate(
        """() => { _aeStandAir.ambient = function () { return { amb: [0.0123, 0.0123, 0.0123], horizon: [0.02, 0.02, 0.02], zenith: [0.03, 0.03, 0.03] }; };
          _ae.stand.fr = null; _ae.stand.dirty = true; _ae.dirty = true; _aeKick(); }"""
    )
    page.wait_for_function(
        "() => _ae.stand.photo && _ae.stand.photo.amb[0] === 0.0123 && _ae.stand.photo.zen[0] === 0.03 && _ae.stand.photo.hor[0] === 0.02",
        timeout=30_000,
        polling=250,
    )
    assert max(dim) < 0.01, dim  # the own march under a 0.003 share is dim, not a day's
    page.evaluate("() => { _aeStandAir = null; }")
    _leave(page)
    assert not page.errors, page.errors


def test_the_live_sky_cards_handoff_opens_stand_facing_its_way_and_close_goes_back(
    page,
):
    """window._osHandoff -> _aeStandOpen: the card's place, instant and facing; _aeStandClose: down again, then back()."""
    page.evaluate(
        "() => { window.__back = 0; window._osHandoff = { lat: 46.0, lon: 6.85, ms: Date.UTC(2026, 5, 21, 10, 0), heading: 123, pitch: 17, back: function () { window.__back++; } }; }"
    )
    assert page.evaluate("() => _aeStandOpen()") is True
    page.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )
    got = page.evaluate(
        "() => ({ head: ((_ae.stand.yaw + _ae.stand.userYaw) * 180 / Math.PI % 360 + 360) % 360, pitch: (_ae.stand.pitch + _ae.stand.userPitch) * 180 / Math.PI, ms: _aeDisplayMs(), handoff: window._osHandoff, lat: _ae.stand.lat })"
    )
    assert (
        abs(got["head"] - 123) < 1
        and got["handoff"] is None
        and abs(got["lat"] - 46.0) < 1e-6
    ), got
    assert abs(got["ms"] - 1_782_036_000_000) < 3_600_000, got
    page.evaluate("() => _aeStandClose()")
    page.wait_for_function(
        "() => !_ae.stand && window.__back === 1", timeout=60_000, polling=250
    )
    assert not page.errors, page.errors


def test_the_earths_coast_is_where_natural_earth_puts_it(page):
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => _aeTerrainLoad('earth')")
    sea = page.evaluate(
        "() => ({ sf: _aeTerrainHeight('earth', 37.77, -122.42, 0), off: _aeTerrainHeight('earth', 37.77, -123.3, 0) })"
    )
    assert (
        sea["sf"]["sea"] is False and sea["sf"]["h"] >= 3
    ), "San Francisco is on land (the shipped map alone says sea)"
    assert sea["off"]["sea"] is True, "the ocean off the Golden Gate is sea"


def test_the_phone_turns_the_view(page):
    _stand_anywhere(page, "moon", 20.19, 30.77)
    ok = page.evaluate("() => _aeMotionStart(_ae.stand)")
    assert ok
    page.evaluate(
        "() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 90, beta: 90, gamma: 0, absolute: true }))"
    )
    page.wait_for_function(
        "() => { var st = _ae.stand; st.dirty = true; _aeStandDraw(performance.now()); var h = ((st.yaw + st.userYaw) * 180 / Math.PI % 360 + 360) % 360; return Math.abs(h - 270) < 6; }",
        timeout=30_000,
        polling=400,
    )
    pitch = page.evaluate("() => (_ae.stand.pitch * 180 / Math.PI)")
    assert abs(pitch) < 6, "held upright it looks at the horizon"
    page.evaluate("() => _aeMotionStop(_ae.stand)")
    _leave(page)
    assert not page.errors, page.errors
