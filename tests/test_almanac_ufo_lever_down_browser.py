"""The UFO's down lever, held at a world's lowest height under the forward throttle, keeps it circling there on every world, the Sun too:
it does not turn the circling into a straight flight off the world ("with UFO when I pulled lever to go down into sun it took
me out of the low surface stick and flew me to space going forward"). The Sun's floor is 0.3 radii up and the pace is the height, so a down
lever of a third (less than the throttle) let a straight tangent grow its own speed; on a planet the floor is a few km and nothing grew.

Run: pytest tests/test_almanac_ufo_lever_down_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401

# From the floor with the nose level (or `pitch` degrees off it), the throttle f and the down lever `lev` held through the frame's own step (the ride, the
# flare, the hug) for 4 s at `dt` a frame: the highest it stood over the surface, in the world's radii (1e9 if it ended up over another world).
SCAN = """([key, f, lev, pitch, dt]) => {
  const sh = _ae.ship, bodies = _afBodies(_ae.scene), b = _afBody(bodies, key);
  const up = [0.3, 0.2, 0.93].map((v, i, a) => v / Math.hypot(...a)), side = [-up[1], up[0], 0], sl = Math.hypot(...side), t = side.map(v => v / sl);
  sh.hold = null; sh.auto = null; sh.dive = null; sh.landing = null; sh.rise = null; sh.landT = 0; sh.throttle = f; sh.lever = lev; sh.tilt = false; sh.lookDown = 0;
  sh.pos = [0, 1, 2].map(i => b.pos[i] + up[i] * (b.r + _afFloor(b)));
  const p = pitch * Math.PI / 180; sh.view = t.map((v, i) => v * Math.cos(p) + up[i] * Math.sin(p)); sh.up = up; sh.vel = [0, 0, 0];
  let top = 0;
  for (let i = 0; i < 4 / dt; i++) { _aeShipStep(_ae.scene, dt); const nb = _afOverShip(sh, bodies); top = Math.max(top, nb.body === b ? nb.alt / b.r : 1e9); }
  sh.lever = 0; sh.throttle = 0;
  return { top: top, floor: _afFloor(b) / b.r };
}"""


@pytest.mark.parametrize("key", ["sun", "mars", "neptune"])
def test_the_down_lever_under_throttle_keeps_a_hugging_craft_at_the_floor(served, key):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("_aePreset('%s')" % key)
            pg.wait_for_function("(k) => !_ae.fly && _ae.target === k", arg=key, timeout=READY_MS, polling=500)
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS, polling=500)
            left = []
            for dt in (1 / 60, 0.05):
                for f in (0.5, 1):
                    for lev in (-0.3, -1):
                        for pitch in (-10, 0, 5):
                            got = pg.evaluate(SCAN, [key, f, lev, pitch, dt])
                            if got["top"] > got["floor"] * 1.3 + 0.01:
                                left.append((round(dt, 3), f, lev, pitch, got))
            assert not left, ("the down lever took the craft off the floor", key, left[:4])
        finally:
            br.close()
