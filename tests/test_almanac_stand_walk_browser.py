"""Stand here in the 3D view (part 3 of 5: see tests/stand_support.py for what they share).

Run: pytest tests/test_almanac_stand_walk_browser.py -v
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
