"""Stand here in the 3D view (part 1 of 5: see tests/stand_support.py for what they share).

Run: pytest tests/test_almanac_stand_browser.py -v
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
