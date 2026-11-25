"""Stand here in the 3D view (part 4 of 5: see tests/stand_support.py for what they share).

Run: pytest tests/test_almanac_stand_bodies_browser.py -v
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
