"""Stand here in the 3D view (part 5 of 5: see tests/stand_support.py for what they share).

Run: pytest tests/test_almanac_stand_rover_browser.py -v
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
