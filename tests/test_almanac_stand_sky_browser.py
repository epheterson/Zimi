"""Stand here in the 3D view (part 2 of 5: see tests/stand_support.py for what they share).

Run: pytest tests/test_almanac_stand_sky_browser.py -v
"""

import os
import sys

import pytest  # noqa: F401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 58 ground scenes drawn in software GL run past a CI runner's hour; the full local run on every bake keeps them.
pytestmark = pytest.mark.local_gate

from stand_support import (  # noqa: E402,F401
    GL_ARGS,
    GROUND_MS,
    NEWLY_REACHED,
    NIGHT_OF_NOON,
    PLACE,
    READY_MS,
    SPOTS,
    VIEW,
    WALK_STEPS,
    WEBGL_ARGS,
    _clock_back_to_now,
    _face,
    _ground_luma,
    _leave,
    _noon,
    _stand,
    _stand_anywhere,
    _tag,
    _walk_state,
    os,
    page,
    pytest,
    served,
    sys,
    threading,
    undersized,
)


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
    assert page.evaluate("() => { _ae.stand.handoff.backLabel = 'Look'; return _aeBackLabel(); }") == "Look"  # a caller's own name for it
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
