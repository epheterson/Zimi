"""Stand here in the 3D view: the way down to the ground of a body and back, in headless Chromium at a phone's size.

Tapping a spot on a body in view gives a card with the place, its height and a Stand here button; the button flies
down and the view is the ground (its own sky and terrain, the Sun and the other bodies where they are), a drag turns
the head, Back returns to orbit. Done on three bodies (the Moon, Mars, Titan: no air, thin dusty air, thick haze).
The ground heights are what the maps say (Olympus Mons high, Hellas low), and the frame time on the ground is
measured and printed (swiftshader here: a bound, not a phone). On the ground every control gives a finger 44 x 44.

Run: pytest tests/test_almanac_stand_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hit_area import undersized  # noqa: E402

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS
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


@pytest.fixture(autouse=True)
def _clock_back_to_now(page):
    """Every test starts on the live clock: several set a moment (_aeGoTo), and a clock left off now opens the time bar's speed slider
    under the ground view, which the finger-size test then measures."""
    yield
    page.evaluate("() => { if (typeof _aeNow === 'function') _aeNow(); }")


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
        "() => { _aeHudInfoPaint(true); return { hidden: document.getElementById('ae-card').hidden, pinned: document.getElementById('ah-info').classList.contains('ah-pinned'), body: _ae.pick.body }; }"
    )
    assert card["body"] == "moon" and card["hidden"] and card["pinned"], card   # a tapped spot brings no card: the info corner is fixed on it
    page.evaluate("() => _aeRimSync(true)")
    page.click("#ae-rim")   # the corner's button is the one way down, at the spot
    page.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=200,
    )
    assert page.evaluate("() => _ae.stand.key") == "moon"
    _leave(page)
    assert not page.errors, page.errors


def test_a_far_dwarf_planet_behind_the_moon_does_not_take_the_moon_s_tap(page):
    """On 14 Nov 2026 Pluto lines up behind the Moon from the Earth: the Moon's disc under the finger is the Moon's."""
    page.evaluate("() => _aeGoTo(Date.UTC(2026, 10, 14, 12))")
    page.wait_for_function("() => Math.abs(_aeDisplayMs() - Date.UTC(2026, 10, 14, 12)) < 1000", timeout=60_000, polling=100)
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly && _ae.target === 'moon'", timeout=90_000, polling=200)
    page.evaluate("() => { _ae.dirty = true; _aeKick(); }")
    page.wait_for_timeout(500)
    assert page.evaluate("() => _aeBodyAt(_ae.w / 2, _ae.h / 2)") == "moon"


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
          var p = new V(d[0] * 50000, d[1] * 50000, d[2] * 50000).project(st.camera); return [(p.x + 1) / 2 * _ae.w, (1 - p.y) / 2 * _ae.h]; }"""
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
    # The card's own air (almanac-oneair.js) is a provider too; the view's own march is measured without it.
    own_k = page.evaluate(
        "() => { _aeStandAir = null; _ae.stand.fr = null; _ae.stand.dirty = true; _aeStandDraw(performance.now()); return _ae.stand.photo.k; }"
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


def _ground_luma(page):
    """The mean linear luminance of the ground band of the picture (the lower quarter, above the clock)."""
    import io

    from PIL import Image

    im = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
    w, h = im.size
    band = im.crop((0, int(h * 0.62), w, int(h * 0.86))).resize((60, 24))
    px = list(band.getdata())
    return sum(0.2126 * (r / 255) ** 2.2 + 0.7152 * (g / 255) ** 2.2 + 0.0722 * (b / 255) ** 2.2 for r, g, b in px) / len(px)


NIGHT_OF_NOON = 0.15   # the readable night ground (starlight at this view's own widest exposure) comes to about 0.12 of the noon ground's luminance


def test_the_ground_is_dark_at_night_under_a_providers_huge_exposure(page):
    """A provider's night exposure is millions: a floor of this view's own light on the ground, opened up that far, would glow (a green night at Boulder;
    0.7 of noon). The starlight floor is opened no further than this view's own widest exposure: dark, and readable, whatever the provider's.
    A stub with the real provider's measured values: ambient ~2e-10 and exposureK 2.5e6 at Sun -25, ambient ~1e-2 and K 32 at noon."""
    _stand_anywhere(page, "earth", 40.0, -105.0)
    page.evaluate(
        """() => { _aeStandAir = { wants: function (st) { return st.key === 'earth'; },
          glsl: 'uniform vec3 uTest; vec3 oaSky(vec3 d) { return uTest; }', uniforms: { uTest: [1e-9, 1e-9, 2e-9] }, update: function () {},
          exposureK: function (st, fr) { return fr.sunAlt > -6 ? 32 : 2.5e6; },
          ambient: function (st, fr) { return fr.sunAlt > -6
            ? { amb: [0.0096, 0.0202, 0.0454], horizon: [0.0517, 0.0818, 0.107], zenith: [0.0094, 0.0178, 0.0385] }
            : { amb: [2e-10, 3.2e-10, 5.7e-10], horizon: [2.3e-9, 2.2e-9, 1.4e-9], zenith: [4.2e-10, 6.9e-10, 7.1e-10] }; } };
          window.__go = function (ms) { var st = _ae.stand; _aeGoTo(ms); st.userYaw = Math.PI * 1.5 - st.yaw; st.fr = null; st.dirty = true; _ae.dirty = true; _aeKick(); }; }"""
    )
    page.evaluate("() => window.__go(Date.UTC(2026, 5, 20, 18, 0, 0))")
    page.wait_for_function("() => _ae.stand.fr && _ae.stand.fr.sunAlt > 50 && _ae.stand.photo.provAmb === true", timeout=60_000, polling=250)
    page.wait_for_timeout(2500)
    noon = _ground_luma(page)
    night_ms = page.evaluate(
        """() => { var st = _ae.stand, t0 = Date.UTC(2026, 5, 21, 3, 0, 0), best = t0, bd = 999;
          for (var t = t0; t < t0 + 8 * 3600000; t += 300000) { var d = Math.abs(_aeStFrame(st, t).sunAlt + 25); if (d < bd) { bd = d; best = t; } } return best; }"""
    )
    page.evaluate("(ms) => window.__go(ms)", night_ms)
    page.wait_for_function("() => _ae.stand.fr && _ae.stand.fr.sunAlt < -20 && _ae.stand.photo.provAmb === true", timeout=60_000, polling=250)
    page.wait_for_timeout(2500)
    night = _ground_luma(page)
    page.evaluate("() => { _aeStandAir = null; }")
    _leave(page)
    assert noon > 0.02, noon
    assert night < NIGHT_OF_NOON * noon, (night, noon)
    assert not page.errors, page.errors


def test_a_direct_handoff_is_on_the_ground_at_once_and_says_when_its_first_frame_is_drawn(page):
    """h.direct: no flight down; h.firstFrame: a promise of the first live ground picture (the card holds its still until then)."""
    page.evaluate(
        "() => { window.__back = 0; window.__h = { lat: 46.0, lon: 6.85, ms: Date.UTC(2026, 5, 21, 10, 0), heading: 123, direct: true, back: function () { window.__back++; } }; }"
    )
    assert page.evaluate("async () => { await _aeStandOpen(window.__h); return await window.__h.firstFrame; }") is True
    assert page.evaluate("() => _ae.stand.mode") == "ground"
    hud = page.evaluate("() => document.getElementById('ae-stand-text').innerText")
    import re

    assert re.search(r"☀ \d+° [↑↓] · [NESW]+\s+⌖ \d+° [NESW]+", hud), hud  # the Sun's height is degrees and an arrow, its bearing the letter after a dot
    page.evaluate("() => _aeStandClose()")
    page.wait_for_function("() => !_ae.stand && window.__back === 1", timeout=60_000, polling=250)
    assert not page.errors, page.errors


def test_a_night_on_the_moon_offers_the_way_to_the_next_sunrise(page):
    _stand_anywhere(page, "moon", 20.19, 30.77)
    night = page.evaluate(
        """() => { var st = _ae.stand, t0 = Date.UTC(2026, 10, 10, 0, 0, 0);
          for (var t = t0; t < t0 + 30 * 86400000; t += 3600000) if (_aeStFrame(st, t).sunAlt < -10) return t; return null; }"""
    )
    assert night
    page.evaluate("(ms) => { _aeGoTo(ms); _ae.stand.fr = null; _ae.stand.dirty = true; _ae.dirty = true; _aeKick(); }", night)
    page.wait_for_function("() => document.querySelector('[data-ae-sunrise]')", timeout=60_000, polling=250)
    page.evaluate("() => document.querySelector('[data-ae-sunrise]').click()")
    page.wait_for_function("() => _ae.stand.fr && _ae.stand.fr.sunAlt >= -0.5", timeout=60_000, polling=250)
    _leave(page)
    assert not page.errors, page.errors


@pytest.mark.parametrize("dsf", [2, 3])
def test_a_real_touch_on_the_sun_names_it_then_leaves_for_it_at_any_pixel_ratio(page, dsf):
    """A finger, not a call: Playwright's touchscreen on the Sun (CSS pixels) at device scale 2 and 3 names it; a second tap on it leaves the ground for the Sun."""
    browser = page.context.browser
    ctx = browser.new_context(viewport=VIEW, device_scale_factor=dsf, has_touch=True, is_mobile=True, service_workers="block")
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE)
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(page.url.split("#")[0] + "#almanac", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=READY_MS, polling=200)
    _stand_anywhere(pg, "earth", 40.0, -105.0)
    where = pg.evaluate(
        """() => { var st = _ae.stand; _aeGoTo(Date.UTC(2026, 5, 20, 18, 0, 0)); st.fr = null; st.dirty = true; _ae.dirty = true; _aeKick(); return true; }"""
    )
    pg.wait_for_function("() => _ae.stand.fr && _ae.stand.fr.sunAlt > 50", timeout=60_000, polling=250)
    xy = pg.evaluate(
        """() => { var st = _ae.stand; st.userYaw = st.fr.sunAz - st.yaw; st.userPitch = st.fr.sunAlt * Math.PI / 180 - AE_STAND_PITCH_DEG * Math.PI / 180; st.zoom = 1; st.zf = null; st.dirty = true; _ae.dirty = true; _aeKick();
          return new Promise(function (r) { setTimeout(function () { var V = _ae.gl.THREE.Vector3, d = st.fr.sun, p = new V(d[0] * 50000, d[1] * 50000, d[2] * 50000).project(st.camera);
            var rect = document.getElementById('ae-canvas').getBoundingClientRect(); r([rect.left + (p.x + 1) / 2 * _ae.w, rect.top + (1 - p.y) / 2 * _ae.h]); }, 800); }); }"""
    )
    pg.touchscreen.tap(xy[0], xy[1])
    pg.wait_for_function("() => _ae.stand.skyNamed === 'body:sun'", timeout=GROUND_MS, polling=200)
    assert pg.evaluate("() => _ae.stand.zoom") == 1
    pg.touchscreen.tap(xy[0], xy[1])
    pg.wait_for_function("() => !_ae.stand && _ae.target === 'sun'", timeout=GROUND_MS, polling=200)
    assert not pg.errors, pg.errors
    ctx.close()


def test_a_sky_object_with_an_angular_size_is_a_billboard_in_twilight_and_a_point_without_one(page):
    """{kind:'plume', sizeDeg, axisAz, axisEl, rgb, lum}: a soft billboard long along its track, only in twilight; with no sizeDeg the point sprite as before."""
    _stand_anywhere(page, "earth", 34.05, -118.24)
    twilight = page.evaluate(
        """() => { var st = _ae.stand, t0 = Date.UTC(2026, 5, 21, 0, 0, 0);
          for (var t = t0; t < t0 + 6 * 3600000; t += 120000) { var a = _aeStFrame(st, t).sunAlt; if (a < -5 && a > -8) return t; } return null; }"""
    )
    assert twilight
    page.evaluate(
        """(ms) => { window.__off = _aeStandSkySource(function () { return [
            { kind: 'plume', az: 250, el: 14, sizeDeg: [25, 6], axisAz: 240, axisEl: 40, rgb: [1, 0.8, 0.6], lum: 1, name: 'plume' },
            { kind: 'rocket', az: 200, el: 30, mag: 2, name: 'point' }]; });
          _aeGoTo(ms); _ae.stand.fr = null; _ae.stand.skyDirty = true; _ae.stand.dirty = true; _ae.dirty = true; _aeKick(); }""",
        twilight,
    )
    page.wait_for_function("() => _ae.stand.boards && _ae.stand.boards[0] && _ae.stand.boards[0].mesh.visible", timeout=60_000, polling=250)
    got = page.evaluate(
        "() => { var b = _ae.stand.boards[0].uni; return { size: b.uSize.value, lum: b.uLum.value, mag0: _ae.stand.skyPts.mesh.geometry.attributes.aMag.array[0], mag1: _ae.stand.skyPts.mesh.geometry.attributes.aMag.array[1] }; }"
    )
    assert abs(got["size"][0] - 12.5 * 3.14159265 / 180) < 1e-3 and abs(got["size"][1] - 3 * 3.14159265 / 180) < 1e-3, got
    assert got["lum"] > 0.05 and got["mag0"] == 99 and got["mag1"] == 2, got  # the plume is no point; the rocket still is
    page.evaluate("() => window.__off()")
    _leave(page)
    assert not page.errors, page.errors


def test_the_back_arrow_names_where_it_really_goes(page):
    """_aeBackLabel: on the ground the view of the body (or the card that handed the sky over); off it, where the view was opened from."""
    _stand_anywhere(page, "earth", 37.77, -122.42)
    assert page.evaluate("() => _aeBackLabel()") == "Earth"  # the arrow leaves the ground for the view of the body
    assert page.evaluate("() => { _ae.stand.handoff = { back: function () {} }; return _aeBackLabel(); }") == "Almanac"  # a card's hand-off: back to the card, on the Almanac page
    assert page.evaluate("() => { _ae.stand.handoff.backLabel = 'Look'; return _aeBackLabel(); }") == "Look"  # a lane's own name for it
    assert page.evaluate("() => { _ae.stand.handoff = null; _ae.backLabel = 'Mission'; var l = _aeBackLabel(); _ae.backLabel = null; return l; }") == "Mission"
    _leave(page)
    got = page.evaluate(
        "() => ['orrery', 'sky', 'hero'].map(function (f) { _aeFrom = f; return _aeBackLabel(); })"
    )
    assert got == ["Solar System", "Almanac", "Almanac"], got
    page.evaluate("() => { _aeFrom = 'orrery'; }")
    assert not page.errors, page.errors


def test_stand_does_not_wait_for_hd_terrain_tiles_that_never_arrive(page):
    """A part whose tile server hangs must not hold the first frame: the ground is built on the core's heights after a moment."""
    page.route("**/hdhang/**", lambda route: None)  # never answered
    page.evaluate(
        "() => { window.__hd = _ae.gl.hd; _ae.gl.hd = { man: { layers: { 'terrain/earth': { max: 6, from: 4, base: '/hdhang/' } } }, bodies: [], queue: [], loading: 0, gpu: 0, frame: 0, fresh: [], budget: _aeHdBudget() }; }"
    )
    try:
        _stand_anywhere(page, "earth", 40.0, -105.0)  # waits up to GROUND_MS for the ground to be live
        assert page.evaluate("() => _ae.stand.live") is True
    finally:
        page.evaluate("() => { _ae.gl.hd = window.__hd; }")
        page.unroute("**/hdhang/**")
    _leave(page)
    assert not page.errors, page.errors


def _face(page, expr):
    """Turn the head to the local direction `expr` (a unit vector in the ground's frame), draw, and give the pixel it is at."""
    return page.evaluate(
        """(expr) => { var st = _ae.stand, d = eval(expr); st.userYaw = Math.atan2(d[0], d[1]) - st.yaw; st.userPitch = Math.asin(d[2]) - AE_STAND_PITCH_DEG * Math.PI / 180; st.zoom = 1;
          st.dirty = true; _ae.dirty = true; _aeStandDraw(performance.now());
          var p = new (_ae.gl.THREE.Vector3)(d[0] * AE_STAND_SKY_AT_M, d[1] * AE_STAND_SKY_AT_M, d[2] * AE_STAND_SKY_AT_M).project(st.camera); return [(p.x + 1) / 2 * _ae.w, (1 - p.y) / 2 * _ae.h]; }""",
        expr,
    )


def _tag(page):
    return page.evaluate(
        "() => { var t = _ae.stand.skyTag && _ae.stand.skyTag.firstChild; return t && !t.hidden ? t.textContent : null; }"
    )


def _noon(page):
    page.evaluate(
        """() => { var st = _ae.stand; _aeGoTo(Date.UTC(2026, 5, 20, 18, 0, 0)); st.fr = null; st.dirty = true; _ae.dirty = true; _aeKick(); }"""
    )
    page.wait_for_function("() => _ae.stand.fr && _ae.stand.fr.sunAlt > 50", timeout=60_000, polling=250)


def test_a_touch_23_px_above_the_sun_with_the_view_offset_under_the_top_bar_still_hits_it(page):
    """onesky's case: 390x844 at device scale 2, the Sun at the view's centre, the view 56 px under the top bar: the tap lands in PAGE coordinates
    ~23 px above the Sun (touchscreen.tap(195, 427.2)); the handler converts with the canvas's own rect, so it is inside the 44 px target.
    It names the Sun and leaves the view as it was (the telescope is the pinch's)."""
    _stand_anywhere(page, "earth", 40.0, -105.0)
    _noon(page)
    xy = page.evaluate(
        """() => { var st = _ae.stand; st.userYaw = st.fr.sunAz - st.yaw; st.userPitch = st.fr.sunAlt * Math.PI / 180 - AE_STAND_PITCH_DEG * Math.PI / 180; st.zoom = 1; st.dirty = true; _ae.dirty = true; _aeKick();
          return new Promise(function (r) { setTimeout(function () { var rect = document.getElementById('ae-canvas').getBoundingClientRect(); r([rect.left + _ae.w / 2, rect.top + _ae.h / 2, rect.top]); }, 800); }); }"""
    )
    # The Sun is at the view's centre (the camera looks at it); the finger comes down 23 px above it, in page coordinates.
    page.touchscreen.tap(xy[0], xy[1] - 23)
    page.wait_for_function("() => !!_ae.stand.skyNamed", timeout=15_000, polling=200)
    assert _tag(page) == page.evaluate("() => _aeInfoName('sun')")
    assert page.evaluate("() => _ae.stand.zoom") == 1, "the name does not zoom"
    _leave(page)
    assert not page.errors, page.errors


def test_a_tap_names_the_moon_a_second_tap_flies_to_it_and_empty_sky_clears_the_name(page):
    """From the ground: a tap on the Moon says Moon (no telescope), a tap on the empty sky takes the name away, two taps on the Moon leave
    the ground and fly to it in the 3D view."""
    _stand_anywhere(page, "earth", 40.0, -105.0)
    page.evaluate(
        """() => { var st = _ae.stand, ms = Date.UTC(2026, 5, 20, 12, 0, 0);
          for (var h = 0; h < 72; h++) { var fr = _aeStFrame(st, ms + h * 3600000), m = fr.objs.filter(function (o) { return o.key === 'moon'; })[0]; if (m.dir[2] > 0.4) { ms += h * 3600000; break; } }
          _aeGoTo(ms); st.fr = null; st.dirty = true; _ae.dirty = true; _aeKick(); }"""
    )
    page.wait_for_function(
        "() => _ae.stand.fr && _ae.stand.fr.objs.some(o => o.key === 'moon' && o.dir[2] > 0.3)", timeout=60_000, polling=250
    )
    moon = "_ae.stand.fr.objs.filter(function (o) { return o.key === 'moon'; })[0].dir"
    xy = _face(page, moon)
    assert page.evaluate("([x, y]) => _aeStandSkyTap(x, y)", xy) is True
    assert _tag(page) == page.evaluate("() => _aeInfoName('moon')")
    assert page.evaluate("() => _ae.stand.zoom") == 1, "no telescope on a tap"
    # Empty sky: a spot well away from the Moon, the Sun and everything named. The name goes.
    empty = page.evaluate(
        """() => { var st = _ae.stand; st.userYaw += 1.2; st.userPitch = 0.5; st.zoom = 1; st.dirty = true; _aeStandDraw(performance.now()); return [_ae.w / 2, _ae.h * 0.15]; }"""
    )
    assert page.evaluate("([x, y]) => _aeStandSkyTap(x, y)", empty) is False
    assert _tag(page) is None and page.evaluate("() => _ae.stand.skyNamed") is None
    # Two taps on the Moon, the second on the same name: the ground is left and the view flies to the Moon.
    xy = _face(page, moon)
    assert page.evaluate("([x, y]) => _aeStandSkyTap(x, y)", xy) is True
    assert page.evaluate("() => _ae.stand.skyNamed") == "body:moon"
    assert page.evaluate("([x, y]) => _aeStandSkyTap(x, y)", xy) is True
    page.wait_for_function("() => !_ae.stand && _ae.preset === 'moon'", timeout=GROUND_MS, polling=200)
    page.wait_for_function("() => _ae.target === 'moon'", timeout=GROUND_MS, polling=200)
    assert not page.errors, page.errors


def test_a_tap_names_a_star_and_stays_on_the_ground(page):
    """At night Polaris is named by a tap and a second tap does not leave: a star has no place in the 3D view."""
    _stand_anywhere(page, "earth", 37.77, -122.42)
    page.evaluate(
        """() => { var st = _ae.stand; _aeGoTo(Date.UTC(2026, 5, 21, 8, 0, 0)); st.fr = null; st.dirty = true; _ae.dirty = true; _aeKick(); }"""
    )
    page.wait_for_function("() => _ae.stand.fr && _ae.stand.fr.sunAlt < -20", timeout=60_000, polling=250)
    polaris = "(function () { var s = _aeStandNamedStars().filter(function (x) { return x.name === 'Polaris'; })[0], f = _ae.stand.fr; return [_aeDot(s.eq, f.east), _aeDot(s.eq, f.north), _aeDot(s.eq, f.up)]; })()"
    d = page.evaluate("() => " + polaris)
    assert abs(d[2] - 0.6112) < 0.03, d   # Polaris stands at the latitude: 37.77 degrees up, due north
    assert d[1] > 0.7 and abs(d[0]) < 0.1, d
    xy = _face(page, polaris)
    page.evaluate("() => { _ae.stand.photo.lim = 6; }")
    assert page.evaluate("([x, y]) => _aeStandSkyTap(x, y)", xy) is True
    assert _tag(page) == "Polaris"
    assert page.evaluate("([x, y]) => _aeStandSkyTap(x, y)", xy) is True
    assert page.evaluate("() => !!_ae.stand && _ae.stand.mode === 'ground'"), "a star is named, not flown to"
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


# Not measured here: the shell's top bar (the shell's tests do), and the clock's parts (13px wide, 4px apart: they wait
# for a layout change, named with the Almanac page's).
@pytest.mark.parametrize("body", ["moon"])
def test_the_ground_views_controls_give_a_finger_44px(page, body):
    _stand(page, body)
    try:
        short = undersized(page, skip=".topbar, .ep", noscroll=True)
    finally:
        _leave(page)
    assert not short, "\n".join(short)


def test_the_way_down_takes_the_same_time_everywhere(page):
    """Stand here's flight down is one move of AE_MOVE_MS, long enough that the ground is built by the time it ends."""
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=120_000, polling=250)
    page.evaluate("() => { _aeStandAt('moon', 12.0, 21.0); }")
    page.wait_for_function("() => !!_ae.fly && !!_ae.standPending", timeout=60_000, polling=50)
    assert page.evaluate("() => _ae.fly.ms === AE_MOVE_MS && AE_MOVE_MS >= 2000 && AE_MOVE_MS <= 2500")
    _stand(page, "moon")
    _leave(page)


WALK_STEPS = """([n]) => { const st = _ae.stand, t0 = performance.now(); st.walk = _aeStandWalkOf(st); st.walk.at = t0; let peak = 0;
  for (let i = 1; i <= n; i++) { _aeStandWalkStep(st, t0 + i * 50); peak = Math.max(peak, st.walk.jump); }
  return { x: st.walk.x, y: st.walk.y, h: st.walk.h, jump: st.walk.jump, peak, yaw: st.yaw + st.userYaw }; }"""


def _walk_state(page):
    return page.evaluate("() => { const w = _ae.stand.walk || {}; return { x: w.x || 0, y: w.y || 0, h: w.h || 0, jump: w.jump || 0 }; }")


@pytest.mark.parametrize("where", [("moon", 20.19, 30.77), ("earth", 48.5, 11.0)])
def test_walking_keys_on_the_moon_and_on_earths_ground(page, where):
    """On foot: W S forward and back, A D turn, Q E step aside, the arrows the same (Left and Right turn), Space jumps an average person's jump in the body's
    own gravity, Shift runs; the eye stays on the ground there."""
    body, lat, lon = where
    page.evaluate("() => _aeTerrainLoad('earth')") if body == "earth" else None
    _stand_anywhere(page, body, lat, lon)
    page.evaluate("() => { document.activeElement && document.activeElement.blur(); }")
    yaw0 = page.evaluate("() => _ae.stand.yaw + _ae.stand.userYaw")

    def walk(key, steps=20):
        page.keyboard.down(key)
        page.wait_for_function("(k) => Object.values(_ae.stand.walk.keys).some(Boolean) || _ae.stand.walk.hop", arg=key, timeout=60_000, polling=50)
        r = page.evaluate(WALK_STEPS, [steps])
        page.keyboard.up(key)
        return r

    import math

    r = walk("w")
    ahead = r["x"] * math.sin(yaw0) + r["y"] * math.cos(yaw0)
    assert ahead > 0.9 * 1.4 * 20 * 0.05 * 0.5, (body, r)  # about a second at walking pace (1.4 m/s)
    start = _walk_state(page)
    r = walk("s")
    back = (r["x"] - start["x"]) * math.sin(yaw0) + (r["y"] - start["y"]) * math.cos(yaw0)
    assert back < -0.3, r
    r0 = _walk_state(page)
    r = walk("e")
    side = (r["x"] - r0["x"]) * math.cos(yaw0) - (r["y"] - r0["y"]) * math.sin(yaw0)
    assert side > 0.3, ("E steps aside to the right", r)
    turn0 = page.evaluate("() => _ae.stand.yaw + _ae.stand.userYaw")
    walk("a")
    assert page.evaluate("() => _ae.stand.yaw + _ae.stand.userYaw") < turn0 - 0.2, "A turns left"
    walk("d")
    # The arrows mirror WASD: Up walks forward, Left and Right turn.
    r0 = _walk_state(page)
    r = walk("ArrowUp")
    assert math.hypot(r["x"] - r0["x"], r["y"] - r0["y"]) > 0.3, "Up walks like W"
    turn0 = page.evaluate("() => _ae.stand.yaw + _ae.stand.userYaw")
    walk("ArrowLeft")
    assert page.evaluate("() => _ae.stand.yaw + _ae.stand.userYaw") < turn0 - 0.2, "Left turns left"
    walk("ArrowRight")
    # Shift runs.
    r0 = _walk_state(page)
    page.keyboard.down("Shift")
    r = walk("w")
    page.keyboard.up("Shift")
    assert math.hypot(r["x"] - r0["x"], r["y"] - r0["y"]) > 1.8 * 1.4 * 0.9, ("Shift runs", r)
    # The eye is on the ground wherever it has walked to.
    h = page.evaluate("() => { const s = _ae.stand, w = s.walk; return [w.h, _aeStandWalkGround(s, w.x, w.y)]; }")
    assert abs(h[0] - h[1]) < 1e-6, h
    # Space jumps: a 2.6 m/s launch, v0^2 / 2g: about 2.1 m on the Moon, 0.34 m on the Earth.
    page.keyboard.down(" ")
    page.wait_for_function("() => _ae.stand.walk.hop", timeout=60_000, polling=50)
    r = page.evaluate(WALK_STEPS, [160])
    page.keyboard.up(" ")
    if body == "moon":
        assert 1.8 < r["peak"] < 2.4, r
    else:
        assert 0.28 < r["peak"] < 0.42, r
    assert r["jump"] == 0, "and it lands"
    assert not page.errors, page.errors
    _leave(page)


def test_a_thumb_walks_on_touch_and_a_drag_elsewhere_looks(page):
    _stand_anywhere(page, "moon", 20.19, 30.77)
    cdp = page.context.new_cdp_session(page)

    def touch(kind, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})

    page.evaluate("() => { _ae.stand.walk = null; }")
    touch("touchStart", [(70, 640)])
    for y in (600, 560, 540):
        touch("touchMove", [(70, y)])
        page.wait_for_timeout(60)
    page.wait_for_function("() => _ae.stand.walk && _ae.stand.walk.stick.y > 0.5", timeout=60_000, polling=50)
    stick = page.evaluate("() => [!document.getElementById('ae-walk-stick').hidden, _ae.stand.walk.stick.y]")
    r = page.evaluate(WALK_STEPS, [20])
    touch("touchEnd", [])
    assert stick[0] and r["x"] ** 2 + r["y"] ** 2 > 0.04, (stick, r)   # the stick shows and it walks
    page.wait_for_function("() => _ae.stand.walk.stick.y === 0 && document.getElementById('ae-walk-stick').hidden", timeout=60_000, polling=50)
    # Past the dotted ring it runs.
    touch("touchStart", [(70, 640)])
    for y in (580, 520, 480, 440):
        touch("touchMove", [(70, y)])
        page.wait_for_timeout(60)
    page.wait_for_function("() => _ae.stand.walk.stick.y > 1.12", timeout=60_000, polling=50)
    touch("touchEnd", [])
    # A drag on the right half looks (and does not walk).
    before = page.evaluate("() => [_ae.stand.userYaw, _ae.stand.walk.x, _ae.stand.walk.y]")
    touch("touchStart", [(300, 400)])
    for x in (280, 250, 220):
        touch("touchMove", [(x, 400)])
        page.wait_for_timeout(60)
    touch("touchEnd", [])
    after = page.evaluate("() => [_ae.stand.userYaw, _ae.stand.walk.x, _ae.stand.walk.y]")
    assert abs(after[0] - before[0]) > 0.05 and after[1:] == before[1:], (before, after)
    _leave(page)


def test_the_ground_takes_over_the_orbit_cameras_pose_and_falls_from_there(page):
    """The way down is one fall: the ground view's first picture has the orbit flight's last camera (its height over the place, where its screen-up points, its
    lens), not a jump from the sharp distance to three kilometres. Heights only fall, from the orbit's end to the eye."""
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => _aeTerrainLoad('moon')")
    page.evaluate(
        """() => { window.__orb = null; window.__first = null; (function tick() {
          const st = _ae.stand;
          if (!st || !st.live) { const e = _ae.gl.camera.matrixWorld.elements; window.__orb = { fwd: [-e[8], -e[9], -e[10]], up: [e[4], e[5], e[6]], fov: _ae.gl.camera.fov, dist: _ae.dist }; }
          else if (!window.__first && st.camera && st.altKm > 0) { const e = st.camera.matrixWorld.elements, fr = _aeStFrame(st, _aeDisplayMs());
            const sc = (v) => [0, 1, 2].map(i => fr.east[i] * v[0] + fr.north[i] * v[1] + fr.up[i] * v[2]);
            window.__first = { fwd: sc([-e[8], -e[9], -e[10]]), up: sc([e[4], e[5], e[6]]), fov: st.camera.fov, alt: st.altKm, alt0: st.alt0 }; }
          requestAnimationFrame(tick); })(); }"""
    )
    page.evaluate("() => _aeStandAt('moon', 20.19, 30.77)")
    page.wait_for_function("() => !!window.__first", timeout=GROUND_MS, polling=100)
    r = page.evaluate("() => ({ o: window.__orb, f: window.__first })")
    import math

    def angle(a, b):
        d = sum(x * y for x, y in zip(a, b)) / (math.hypot(*a) * math.hypot(*b))
        return math.degrees(math.acos(max(-1, min(1, d))))

    assert abs(r["f"]["fov"] - r["o"]["fov"]) < 1.0, r
    assert angle(r["f"]["fwd"], r["o"]["fwd"]) < 3, r
    assert angle(r["f"]["up"], r["o"]["up"]) < 3, r
    assert 0 < r["f"]["alt"] <= r["f"]["alt0"], r["f"]   # (how far down the first sampled frame is depends on the machine: from the orbit's end height down)
    _leave(page)


def test_the_handover_frame_is_the_orbit_frame_again(page):
    """No dissolve: the ground's first picture (the orbit view drawn under it, the ground at no opacity) is the orbit view's last, to the pixel."""
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => _aeTerrainLoad('moon')")
    page.evaluate("() => _aePreset('moon')")   # (a settled orbit view, and the last test's way back finished)
    page.wait_for_function("() => !_ae.stand && !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=90_000, polling=200)
    page.wait_for_function("() => Math.abs(_aeDisplayMs() - Date.now()) < 5000", timeout=60_000, polling=200)   # the clock back on now (a test before set a moment)
    page.wait_for_timeout(800)
    page.evaluate(
        """() => { window.__t = []; const N = 48, c = document.createElement('canvas'); c.width = N; c.height = N; const x = c.getContext('2d');
          const od = window._aeDraw; window.__od = od; window._aeDraw = function (a, b) { const r = od(a, b);
            if (_ae.standPending || (_ae.stand && _ae.stand.live)) { x.clearRect(0, 0, N, N); x.drawImage(document.getElementById('ae-canvas'), 0, 0, N, N);
              window.__t.push({ live: !!(_ae.stand && _ae.stand.live), still: !!document.querySelector('.ae-stand-still'), d: Array.from(x.getImageData(0, 0, N, N).data) }); }
            return r; }; }"""
    )
    page.evaluate("() => _aeStandAt('moon', 20.19, 30.77)")
    page.wait_for_function("() => window.__t.filter(f => f.live).length > 3", timeout=GROUND_MS, polling=100)
    t = page.evaluate("() => window.__t")
    page.evaluate("() => { window._aeDraw = window.__od; }")
    first = next(i for i, f in enumerate(t) if f["live"])
    diff = sum(abs(a - b) for a, b in zip(t[first]["d"], t[first - 1]["d"])) / len(t[first]["d"])
    assert diff < 1.5, ("the first ground frame differs from the last orbit frame", diff, page.evaluate("() => ({ ms: _aeDisplayMs() - Date.now(), rate: typeof _almRate === 'undefined' ? null : _almRate, red: _aeRedOn(), reduce: _aeReduceMotion(), caps: typeof ZimiCap !== 'undefined' && ZimiCap.get('skyQuality') })"))
    assert not any(f["still"] for f in t), "no frozen copy is faded"
    _leave(page)


def test_the_planet_sits_in_the_same_place_going_down_and_coming_back(page):
    """into the ground and out again, the Moon is where it was in the picture, the size it was."""
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => _aeTerrainLoad('moon')")
    page.evaluate("() => { _aeNow(); _aePreset('moon'); }")
    page.wait_for_function("() => !_ae.stand && !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=90_000, polling=200)
    page.wait_for_timeout(800)
    page.evaluate("() => { _ae.dist = Math.max(_aeClampDist(0), _aeStandSharpDist('moon') * 0.8); _ae.dirty = true; _aeKick(); }")   # closer than where the colour map stays sharp: the way back must not stand off to it
    page.wait_for_timeout(500)
    place = "() => { var p = _aeProject(_aeBodyPos('moon')); return { x: p.x, y: p.y, d: _ae.dist, az: _ae.az, el: _ae.el_ }; }"
    before = page.evaluate(place)
    _stand(page, "moon")
    page.evaluate("() => _aeStandLeave()")
    page.wait_for_function("() => !_ae.stand && !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=GROUND_MS, polling=200)
    page.wait_for_timeout(500)
    after = page.evaluate(place)
    assert abs(after["x"] - before["x"]) < 30 and abs(after["y"] - before["y"]) < 30, ("the Moon moved in the picture", before, after)
    assert after["d"] == pytest.approx(before["d"], rel=0.02), (before, after)


def test_a_ground_still_being_built_shows_the_wait(page):
    """on a slow phone the flight ended and nothing happened for many seconds (the card gone, no sign of life): the where line's spinner says it is coming."""
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => { _aePreset('moon'); }")
    page.wait_for_function("() => !_ae.stand && !_ae.fly", timeout=90_000, polling=200)
    page.evaluate("() => { _ae.standPending = { key: 'moon', t0: performance.now(), ready: false, dead: false }; _ae.dirty = true; _aeKick(); }")
    page.wait_for_function("() => document.getElementById('ah-info').classList.contains('ae-loading')", timeout=30_000, polling=100)
    page.evaluate("() => { _ae.standPending = null; _ae.dirty = true; _aeKick(); }")
    page.wait_for_function("() => !document.getElementById('ah-info').classList.contains('ae-loading')", timeout=30_000, polling=100)


def test_the_rims_dot_arrives_as_the_eye_touches_the_ground(page):
    """the rim glyph's lit dot travels with the move (the flight, the wait, the fall), so it reaches the end as the camera is on the ground, not before: its last
    tenth of an inch (above 9.5 of its 10 px) is made inside the last 1.2 s of the fall, in a first descent and in a second one after it."""
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => _aeTerrainLoad('moon')")

    def descent():
        page.evaluate("() => { _aeNow(); _aePreset('moon'); }")
        page.wait_for_function("() => !_ae.stand && !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=90_000, polling=200)
        page.wait_for_timeout(500)
        page.evaluate(
            """() => { window.__d = []; window.__ds = false;
              (function s() { var lit = document.querySelector('#ae-rim .ae-rim-lit'), m = /translate\\(([\\d.]+)px/.exec(lit.style.transform || ''), st = _ae.stand;
                window.__d.push([m ? +m[1] : null, st ? st.mode : (_ae.standPending ? 'pend' : '-'), performance.now(), st && typeof st.prog === 'number' ? st.prog : null, st ? st.altKm : null]);
                if (!window.__ds) requestAnimationFrame(s); })(); }"""
        )
        page.evaluate("() => _aeStandAt('moon', 20.19, 30.77)")
        page.wait_for_function("() => _ae.stand && _ae.stand.mode === 'ground'", timeout=GROUND_MS, polling=100)
        page.wait_for_timeout(300)
        page.evaluate("() => { window.__ds = true; }")
        return page.evaluate("() => window.__d")

    for n in (1, 2):
        d = descent()
        moving = [x for x in d if x[1] in ("pend", "descend") and x[0] is not None]   # (a frame of the sampler between two of the view's own has no new value: skipped)
        assert len(moving) > 10, ("the dot is driven while the move is on", n)
        ground_at = next(x[2] for x in d if x[1] == "ground")
        w1 = page.evaluate("() => AE_MOVE_MS / (AE_MOVE_MS + AE_STAND_DESCENT_MS)")
        for x in moving:   # the dot is the fall's own progress (its clock), at every frame the view drew: nothing of a first descent is kept for a second
            if x[1] == "descend" and x[3] is not None:
                assert abs(x[0] - 10 * (w1 + (1 - w1) * x[3])) < 0.35, ("the dot is not the fall's progress", n, x)
        near_end = [x for x in moving if x[0] > 9.5 and x[4] is not None]
        assert not near_end or near_end[0][4] < 0.1, ("the dot was at its end while the eye was still high", n, near_end[0])   # (under 100 m)
        vals = [x[0] for x in moving]
        assert all(b >= a - 1e-6 for a, b in zip(vals, vals[1:])), ("and it only travels one way", n)
        _leave(page)
        page.wait_for_function("() => !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=GROUND_MS, polling=200)
    assert page.evaluate("() => document.querySelector('#ae-rim .ae-rim-glyph') !== null")


@pytest.mark.parametrize("body", ["earth", "moon", "mars"])
def test_down_and_up_is_one_smooth_move_the_height_only_ever_falls_then_only_rises(page, body):
    """one eased descent and one eased ascent, no holds, no pops to other heights: the camera's height over the body (the orbit view's before the ground takes over, the ground's
    after) only falls on the way down and only rises on the way up, never faster than a steady fall, no stretch of standing still, and the rim's dot goes with it."""
    lat, lon = {"earth": (37.77, -122.42), "moon": (20.19, 30.77), "mars": (-5.4, 137.8)}[body]
    page.evaluate("() => _aeStandReady()")
    page.evaluate("(b) => _aeTerrainLoad(b)", body)
    page.evaluate("(b) => { _aeNow(); _aePreset(b); }", body)
    page.wait_for_function("() => !_ae.stand && !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=90_000, polling=200)
    page.wait_for_timeout(600)
    before = page.evaluate("() => ({ dist: _ae.dist, az: _ae.az, el: _ae.el_ })")
    page.evaluate(
        """(key) => { window.__tr = []; window.__stop = false; var R = AE_TARGETS[key].surface;
          (function s() { var st = _ae.stand, c = _ae.gl.camera, b = _aeBodyPos(key), h;
            if (st && st.live) h = st.altKm; else h = (Math.hypot(c.position.x - b[0], c.position.y - b[1], c.position.z - b[2]) - R) * AE_EARTH_RADIUS_KM;
            var lit = document.querySelector('#ae-rim .ae-rim-lit'), m = /translate\\(([\\d.]+)px/.exec(lit && lit.style.transform || '');
            window.__tr.push([performance.now(), h, m ? +m[1] : null, st ? st.mode : '']);
            if (!window.__stop) requestAnimationFrame(s); })(); }""",
        body,
    )
    page.evaluate("([b, la, lo]) => _aeStandAt(b, la, lo)", [body, lat, lon])
    page.wait_for_function("() => _ae.stand && _ae.stand.mode === 'ground'", timeout=GROUND_MS, polling=100)
    down = page.evaluate("() => window.__tr.length")
    page.evaluate("() => _aeStandLeave()")
    page.wait_for_function("() => !_ae.stand && !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=GROUND_MS, polling=100)
    page.wait_for_timeout(400)
    page.evaluate("() => { window.__stop = true; }")
    tr = page.evaluate("() => window.__tr")
    after = page.evaluate("() => ({ dist: _ae.dist, az: _ae.az, el: _ae.el_ })")
    import math

    def check(rows, sign, name):
        rows = [r for r in rows if r[1] > 0]
        rows = [b for a, b in zip([None] + rows, rows) if a is None or b[1] != a[1]]   # (only where the view drew a new height: the sampler runs between its frames too)
        steps = [(math.log(b[1] / a[1]), (b[0] - a[0]) / 1000, a[1], b[1], a[3], b[3]) for a, b in zip(rows, rows[1:]) if b[0] - a[0] >= 5]   # (frames the sampler took twice in one of the view's own are not steps)
        assert all(sign * st[0] >= -2e-3 for st in steps), (name, "the height went the wrong way", [st for st in steps if sign * st[0] < -2e-3][:3])
        fastest = 0.0   # (over any stretch of at least 200 ms: the sampler's own timing between the view's frames is not the camera's)
        for i, a in enumerate(rows):
            for b in rows[i + 1:]:
                if b[0] - a[0] >= 200:
                    fastest = max(fastest, abs(math.log(b[1] / a[1])) / ((b[0] - a[0]) / 1000))
                    break
        assert fastest < 14, (name, "faster than a steady fall", fastest)

    check(tr[:down], -1, "down")
    check(tr[down:], 1, "up")
    dd = [r[2] for r in tr[:down] if r[2] is not None]
    assert all(b >= a - 1e-6 for a, b in zip(dd, dd[1:])) and dd[-1] > 9.9, ("the dot goes down with the move and ends at the ground", [(i, x, y) for i, (x, y) in enumerate(zip(dd, dd[1:])) if y < x - 1e-6][:4], dd[-3:])
    du = [r[2] for r in tr[down:] if r[2] is not None]
    assert all(b <= a + 1e-6 for a, b in zip(du, du[1:])), "and back up the same way"
    # and the planet is back where it was
    assert after["dist"] == pytest.approx(before["dist"], rel=0.02) and abs(after["az"] - before["az"]) < 0.05 and abs(after["el"] - before["el"]) < 0.05, (before, after)


def test_a_stalled_frame_does_not_throw_the_fall_ahead(page):
    """a shader compiled or a map uploaded in the middle of the fall (the page stands still for a second) must not make the camera jump to where the clock says: the
    move goes on from where it stood."""
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => _aeTerrainLoad('moon')")
    page.evaluate("() => { _aeNow(); _aePreset('moon'); }")
    page.wait_for_function("() => !_ae.stand && !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=90_000, polling=200)
    page.wait_for_timeout(500)
    page.evaluate("() => _aeStandAt('moon', 20.19, 30.77)")
    page.wait_for_function("() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'descend' && _ae.stand.altKm < _ae.stand.alt0 * 0.2", timeout=GROUND_MS, polling=50)
    h0 = page.evaluate("() => _ae.stand.altKm")
    page.evaluate("() => { const t = performance.now(); while (performance.now() - t < 1200); }")   # the page stands still for 1.2 s
    page.wait_for_timeout(250)
    h1 = page.evaluate("() => _ae.stand ? _ae.stand.altKm : 0")
    import math

    assert h1 > 0, "still falling"
    assert math.log(h0 / h1) < 1.8, ("the fall jumped across the stall", h0, h1)   # (a second at about 9 a second would be 9; a slow frame's own share and the 0.25 s that follows are not)
    _leave(page)


def test_a_stalled_frame_does_not_throw_a_go_to_flight_ahead_and_back(page):
    """a go-to flight met by a stalled frame (a long gap) used to step with the whole stall, then be given the time back the frame after: the camera jumped ahead and snapped
    back. The guard now runs before the flight steps, so the view only ever goes forward and no frame turns it far."""
    page.evaluate("() => { _aeNow(); _aePreset('earth'); }")
    page.wait_for_function("() => !_ae.fly", timeout=90_000, polling=200)
    page.evaluate("""() => {
      window.__tr = []; window.__stop = false;
      (function s() { const c = _ae.gl.camera; window.__tr.push([performance.now(), c.quaternion.toArray(), c.position.toArray(), _ae.fly ? _ae.fly.prog : 1]); if (!window.__stop) requestAnimationFrame(s); })();
      _aePreset('mars');
      setTimeout(() => requestAnimationFrame(() => { const t = performance.now(); while (performance.now() - t < 400); }), 1200);
    }""")
    page.wait_for_function("() => window.__tr.length > 5 && performance.now() - window.__tr[window.__tr.length - 1][0] < 100 && !_ae.fly", timeout=120_000, polling=250)
    page.wait_for_timeout(400)
    tr = page.evaluate("() => { window.__stop = true; return window.__tr; }")
    import math

    worst = 0
    stall_at = next(a[0] for a, b in zip(tr, tr[1:]) if b[0] - a[0] > 300)
    for a, b in zip(tr, tr[1:]):
        if a[0] < stall_at - 100:
            continue   # (the flight's own start has hitches of its own: this is about the frames from the stall on)
        dot = abs(sum(x * y for x, y in zip(a[1], b[1])))
        worst = max(worst, 2 * math.degrees(math.acos(min(1, dot))))
    assert max(b[0] - a[0] for a, b in zip(tr, tr[1:])) > 300, "the stall happened"
    assert worst < 8, ("a frame turned the view far", worst)
    after = [b[3] for a, b in zip(tr, tr[1:]) if a[0] >= stall_at - 100]
    steps = [y - x for x, y in zip(after, after[1:])]
    assert min(steps) >= -1e-6, ("the flight went back", min(steps))   # (given the time back twice, it ran backwards)
    assert max(steps) < 0.03, ("the flight jumped ahead", max(steps))


NEWLY_REACHED = ["vesta", "charon", "phobos", "enceladus", "mimas", "tethys", "dione", "rhea", "iapetus", "triton"]


@pytest.mark.parametrize("body", NEWLY_REACHED)
def test_every_solid_body_has_a_walk_and_a_rover(page, body):
    """Stand here and Drive on every body with a surface (these ten had neither a ground nor a frame for a vehicle)."""
    page.evaluate("() => { if (typeof _aeTracksLoad === 'function') _aeTracksLoad(); }")   # (the dwarf planets' and Charon's places come with their tables, which a flight there loads)
    page.wait_for_function("() => !!window._aeTracks", timeout=120_000, polling=200)
    page.evaluate("(b) => _aePreset(b)", body)
    page.wait_for_function("() => !_ae.fly", timeout=180_000, polling=250)
    _stand_anywhere(page, body, 10, 20)
    assert page.evaluate("() => _aeStandable(%r) && AE_DRIVE_BODIES.indexOf(%r) >= 0" % (body, body))
    page.evaluate("([b, la, lo]) => _aeDriveHere(b, la, lo)", [body, 10, 20])
    page.wait_for_function("() => _ae.site && _ae.site.rover && _ae.site.phase === 'stand'", timeout=GROUND_MS, polling=250)
    assert page.evaluate("() => _ae.site.rover.x !== undefined && !!_ae.site.host"), "the rover is on the ground there"
    page.evaluate("() => _aeSiteLeave(true)")
    page.wait_for_function("() => !_ae.site", timeout=60_000, polling=100)
    assert not page.errors, page.errors


def test_a_rover_called_up_where_one_stands_keeps_the_ground_and_the_eye(page):
    """"walking and standing should be the same viewport and adding rover shouldn't cost anything"; "the view doesn't change at all
    and it drops from off the top of the screen". The visit takes the very ground stood on (no second build), every frame has a ground drawn, the
    rover falls in from over the top edge, and one is driving it with the picture exactly as it was: the camera never moves until the rover does."""
    page.evaluate("() => { _aeNow(); }")
    _stand_anywhere(page, "moon", 20.19, 30.77)
    page.evaluate("""() => { window.__g = _ae.stand; window.__fr = []; window.__top = null; var t0 = performance.now(); (function tick(t) { var s = _ae.site, h = s && s.host;
      if (s && s.rover && window.__top === null && s.fr) { var p = _aeProject(_asToWorld(s.fr, [s.rover.x, s.rover.y, s.rover.z])); window.__top = p ? p.y : null; }
      window.__fr.push([!!(_ae.stand && _ae.stand.live), !!(h && h.live), s && s.fr && s.pose ? _aeRigLocal(s.fr, s.pose.pos) : null, s && s.pose ? s.pose.look : null, s && s.drive, s && s.pose ? s.pose.fov : null, _ae.gl.camera.view && _ae.gl.camera.view.enabled ? _ae.gl.camera.view.offsetY : 0]);
      if (t - t0 < 170000 && !(s && s.drive && s.atEye && t - t0 > 1500 && window.__fr.filter(r => r[4]).length > 30)) requestAnimationFrame(tick); })(t0); }""")
    page.evaluate("() => _aeDriveHere('moon', 20.19, 30.77)")
    page.wait_for_function("() => _ae.site && _ae.site.atEye && _ae.site.drive && window.__fr.filter(r => r[4]).length > 30", timeout=GROUND_MS, polling=100)
    got = page.evaluate("() => ({ same: _ae.site.host.st === window.__g, live: _ae.site.host.live, frames: window.__fr, top: window.__top, fr: _ae.site.fr && [_ae.site.fr.e, _ae.site.fr.n, _ae.site.fr.u] })")
    assert got["same"] and got["live"], "the visit drew the ground that was stood on, not a second one"
    fr = got["frames"]
    assert all(r[0] or r[1] for r in fr), "a frame with neither ground drawn"
    assert got["top"] is not None and got["top"] < 0, ("it starts out of the picture, over its top edge", got["top"])
    eye = [r[2] for r in fr if r[2] is not None]
    assert abs(eye[0][0]) < 0.5 and abs(eye[0][1]) < 0.5 and 1.0 < eye[0][2] < 2.5, ("the eye where one stood", eye[0])
    still = max(((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2) ** 0.5 for a, b in zip(eye, eye[1:]))
    assert still < 0.02, ("the picture's place does not move: not while it falls in, not as one starts driving it", still)
    looks = [r[3] for r in fr if r[3] is not None]
    turn = max(sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5 for a, b in zip(looks, looks[1:]))
    assert turn < 1e-3, ("nor where it looks", turn)
    assert any(r[4] for r in fr), "and one is driving it"
    assert len(set(r[5] for r in fr if r[2] is not None)) == 1, ("the same field of view throughout", set(r[5] for r in fr))
    page.evaluate("() => _aeSiteLeave(true)")
    page.wait_for_function("() => !_ae.site", timeout=60_000, polling=100)
    assert not page.errors, page.errors


def test_a_gas_giant_has_no_ground_and_the_ufo_is_what_goes_there(page):
    """Jupiter, Saturn, Uranus and Neptune have no ground: no line about it, no dead button, the UFO can be entered there, and no ground is offered."""
    page.evaluate("() => { _aeNow(); _aePreset('earth'); }")
    page.wait_for_function("() => !_ae.fly", timeout=90_000, polling=200)
    assert page.evaluate("() => ['jupiter', 'saturn', 'uranus', 'neptune'].every(k => !_aeStandable(k) && AE_DRIVE_BODIES.indexOf(k) < 0)")
    page.evaluate("() => _aePreset('jupiter')")
    page.wait_for_function("() => !_ae.fly && _ae.arrived === 'jupiter'", timeout=90_000, polling=200)
    assert page.evaluate("() => _aeFlyAble()"), "the UFO is there for it"
    page.evaluate("() => enterFly()")
    page.wait_for_function("() => !!_ae.ship", timeout=120_000, polling=200)
    page.evaluate("() => _afStop()")


def test_standing_on_the_earth_at_night_the_ground_is_readable(page):
    """a night on the ground (here: Los Angeles at 1 a.m. under no Moon) was a black slab (the provider's sky light is nothing there and the floor applied only to bodies without a provider): the
    ground is dark but can be made out, with its horizon."""
    import io

    import numpy as np
    from PIL import Image

    page.evaluate("() => { _aeNow(); _aeGoTo(Date.UTC(2026, 10, 15, 9, 0)); }")   # 01:00 in Los Angeles; the Sun far under the horizon
    _stand_anywhere(page, "earth", 34.05, -118.24)
    page.wait_for_timeout(1500)
    assert page.evaluate("() => _ae.stand.fr.sunAlt") < -30
    im = Image.open(io.BytesIO(page.screenshot())).convert("L")
    w, h = im.size
    ground = np.asarray(im.crop((0, int(h * 0.6), w, int(h * 0.8)))).astype(float)
    assert 20 < ground.mean() < 90, ("the night ground is black or lit like day", ground.mean())
    _leave(page)


def test_the_way_up_hands_over_a_real_picture_not_a_black_one(page):
    """leaving the ground, the copy of its last picture that fades over the orbit view's first is the ground's picture (it was black: the Moon seemed to appear out of nothing)."""
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => _aeTerrainLoad('moon')")
    page.evaluate("() => { _aeNow(); _aePreset('moon'); }")
    page.wait_for_function("() => !_ae.stand && !_ae.fly && !document.querySelector('.ae-stand-still')", timeout=90_000, polling=200)
    page.wait_for_timeout(800)
    _stand(page, "moon")
    page.evaluate(
        """() => { window.__pair = null; const of = window._aeStandStillFade; window.__of = of; window._aeStandStillFade = function (el) {
          const mk = (src) => { const c = document.createElement('canvas'); c.width = 48; c.height = 48; const x = c.getContext('2d'); x.drawImage(src, 0, 0, 48, 48); return Array.from(x.getImageData(0, 0, 48, 48).data); };
          window.__pair = { still: el ? mk(el) : null, orbit: mk(document.getElementById('ae-canvas')) };
          return of(el); }; }"""
    )
    page.evaluate("() => _aeStandLeave()")
    page.wait_for_function("() => !_ae.stand && !document.querySelector('.ae-stand-still')", timeout=GROUND_MS, polling=200)
    pair = page.evaluate("() => { window._aeStandStillFade = window.__of; return window.__pair; }")
    assert pair and pair["still"], "no picture was handed over"
    still, orbit = pair["still"], pair["orbit"]
    assert max(still) > 40, "the ground's last picture is black"
    diff = sum(abs(a - b) for a, b in zip(still, orbit)) / len(still)
    assert diff < 6, ("the handed-over picture is not the orbit view's first", diff)


def test_tapping_the_sun_in_the_solar_system_view_goes_in_to_it(page):
    """"Can I not click on the sun in the solar system view to zoom into it?": Mercury's finger-wide reach covered the Sun's, and the view's own target was the Sun."""
    page.evaluate("() => { _aeNow(); _aePreset('planets'); }")
    page.wait_for_function("() => _ae.preset === 'planets' && !_ae.fly", timeout=GROUND_MS, polling=250)
    at = page.evaluate("() => { var p = _aeProject(_aeBodyPos('sun', _ae.scene)); return [p.x, p.y, _aeBodyAt(p.x, p.y)]; }")
    assert at[2] == "sun", at
    page.evaluate("([x, y]) => _aeTap(x, y)", at[:2])
    page.wait_for_function("() => _ae.preset === 'sun'", timeout=GROUND_MS, polling=250)
    page.evaluate("() => _aePreset('earth')")
