"""No planned flight puts the camera inside or grazing a body.

Every flight between the nine bodies is stepped through as it will be drawn, 4 ms at a time (the dip past a body is brief: coarse
steps missed it), and the camera stays at least AE_CLEAR radii from every body's centre. A flight that left the Sun flew into it:
the leg in swung round the destination across the Sun's side, 0.74 Sun radii from its centre going to Mars.

Run: pytest tests/test_almanac_flight_clearance_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401

BODIES = [
    "earth",
    "moon",
    "sun",
    "mars",
    "jupiter",
    "saturn",
    "venus",
    "mercury",
    "neptune",
]
AE_CLEAR = 1.35

# Plans the flight from `a` (the view stands there) to `b`, steps it, puts the view back and says how near the camera came to a body.
STEP_FLIGHTS = """([a, ms]) => {
  const keep = { target: _ae.target, dist: _ae.dist, az: _ae.az, el: _ae.el_, roll: _ae.roll, preset: _ae.preset };
  const out = {};
  for (const b of %s) {
    if (b === a) continue;
    _aePreset(b);
    const f = _ae.fly;
    if (!f) { out[b] = null; } else {
      const total = _aeFlyLead(f) + f.ms + (f.hold ? AE_FLY_TAIL_MS : 0), bodies = [{ key: "earth", pos: [0, 0, 0], r: 1 }, { key: "moon", pos: _ae.scene.moon, r: AE_MOON_RADIUS_RE }, { key: "sun", pos: _aeSunShown(_ae.scene), r: AE_SUN_SHOW_R }].concat(Object.keys(_ae.gl.planets).filter(k => _ae.gl.planets[k].b && _ae.gl.planets[k].pos).map(k => ({ key: k, pos: _ae.gl.planets[k].pos, r: _ae.gl.planets[k].b.r })));
      let worst = { d: Infinity };
      for (let t = 0; t <= total; t += ms) {
        const at = f.start + Math.min(t, total - 1e-6);
        _aeStepFly(at);
        const pos = _aePoseOf(_aeViewCam()).pos;
        for (const bd of bodies) { const d = _aeLen(_aeSub(pos, bd.pos)) / bd.r; if (d < worst.d) worst = { d, body: bd.key, t }; }
      }
      out[b] = worst;
    }
    _ae.fly = null; _ae.target = keep.target; _ae.dist = keep.dist; _ae.az = keep.az; _ae.el_ = keep.el; _ae.roll = keep.roll; _ae.preset = keep.preset;
  }
  return out;
}""" % str(BODIES)


def test_no_flight_between_the_bodies_goes_through_one(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            bad = {}
            for a in BODIES:
                pg.evaluate("a => _aePreset(a)", a)
                pg.wait_for_function(
                    "(a) => !_ae.fly && _ae.target === a",
                    arg=a,
                    timeout=READY_MS,
                    polling=300,
                )
                for b, worst in pg.evaluate(STEP_FLIGHTS, [a, 4]).items():
                    if worst and worst["d"] < AE_CLEAR:
                        bad["%s -> %s" % (a, b)] = worst
            assert not bad, bad
        finally:
            br.close()
