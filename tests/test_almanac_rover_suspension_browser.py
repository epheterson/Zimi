"""A driven rover's wheels stay with its body on steep, rough ground at top speed ("rover on weird terrain
was having wheels and suspension behave odd, like when going up hills and driving fast the thing don't stay together").

Each wheel stood on the ground under its hub however far that was from its mount on the body (which follows the slope no further
than AS_TILT_MAX and eases toward it), so over ground steeper than that, or after a long step, wheels drifted off the body or
sank through it. A wheel's travel is now bounded about its mount.

Headless Chromium at a phone's size; the rover is stepped on its own fixed step through the page's test hooks.

Run: pytest tests/test_almanac_rover_suspension_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_almanac_sites_browser as base  # noqa: E402

base.GL_ARGS.append("--disable-accelerated-2d-canvas")
served = base.served
page = base.page

# Steep (about 55 degrees at the worst), rough ground over the whole patch: two swells and a fine ripple.
ROUGH = """() => { var st = _ae.site; st.terrainHere = null;
  st.terrain = function (x, y) { return 1.6 * Math.sin(x * 0.55) * Math.cos(y * 0.5) + 0.35 * Math.sin(x * 2.3 + y * 1.7); }; }"""

# How far each wheel is from where its suspension holds it (its mount, tilted with the body, plus the hub's own height),
# worst over the whole run, at every step of a long-frame drive at top speed.
DRIVE = """([dt, steps]) => { var st = _ae.site, r = st.rover, V = _ae.gl.THREE.Vector3, worst = 0, apart = 0, travel = 0.6 * r.rm.radius;
  st.input.keys.f = true; st.input.fast = true; r.hdg = 1.2;
  for (var n = 0; n < steps; n++) {
    _asRoverStep(st, dt);
    var M = r.body.holder.matrix;
    for (var i = 0; i < r.wheels.length; i++) {
      var h = r.hubs[i], w = r.wheels[i], m = new V(h[0], h[1], 0).applyMatrix4(M);
      worst = Math.max(worst, Math.abs(w.z - (m.z + h[2])));
      apart = Math.max(apart, Math.hypot(w.x - m.x, w.y - m.y));
    }
  }
  st.input.keys.f = false; st.input.fast = false;
  return { worst: worst, apart: apart, travel: travel, finite: [r.x, r.y, r.z].every(isFinite) }; }"""


@pytest.mark.parametrize("body,site", [("moon", "Apollo 15"), ("mars", "Perseverance")])
def test_wheels_stay_with_the_body_on_steep_rough_ground_at_top_speed(page, body, site):
    base._visit(page, body, site, drive=True)
    page.evaluate(ROUGH)
    for dt in (1 / 60, 0.25):  # a smooth frame and a long one
        got = page.evaluate(DRIVE, [dt, 90])
        assert got["finite"], got
        assert got["worst"] <= got["travel"] + 1e-6, (dt, got)  # bounded travel: never off its mount
        assert got["apart"] < 0.6, (dt, got)  # and never far to the side of it
