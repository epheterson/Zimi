"""The UFO at a world's floor holds still under a held forward lever pointed at the world, and its nose comes up to the horizon, on every world (gas giants too).

Run: pytest tests/test_almanac_ufo_floor_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401

# Fly at the world from 3 radii, nose at its centre, forward lever held, 60 frames a second; report each frame's height and nose.
APPROACH = """([key, secs]) => {
  const sh = _ae.ship, bodies = _afBodies(_ae.scene), b = _afBody(bodies, key);
  sh.hold = null; sh.auto = null; sh.dive = null; sh.landing = null; sh.rise = null; sh.ask = { f: 1, t: 0, u: 0 };
  sh.pos = [b.pos[0] + b.r * 3, b.pos[1], b.pos[2]]; sh.view = [-1, 0, 0]; sh.up = [0, 0, 1]; sh.vel = [0, 0, 0];
  const out = [];
  for (let i = 0; i < secs * 60; i++) {
    const was = sh.pos.slice();
    _afMove(sh, bodies, 1 / 60);
    const d = [0, 1, 2].map(k => sh.pos[k] - b.pos[k]), r = Math.hypot(...d);
    const pitch = -Math.asin(Math.max(-1, Math.min(1, (sh.view[0] * d[0] + sh.view[1] * d[1] + sh.view[2] * d[2]) / r))) * 180 / Math.PI;
    out.push({ alt: (r - b.r) / b.r, floor: _afFloor(b) / b.r, step: Math.hypot(...[0, 1, 2].map(k => sh.pos[k] - was[k])) / b.r, pitch });
  }
  return out;
}"""


@pytest.mark.parametrize("key", ["neptune", "mars", "sun"])
def test_floor_is_still_and_the_nose_comes_up(served, key):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS, polling=500)
            fr = pg.evaluate(APPROACH, [key, 120])
            floor = fr[0]["floor"]
            on = [i for i, f in enumerate(fr) if f["alt"] <= floor * 1.001]
            assert on, ("it never reached the floor", fr[-1])
            # at the floor with the nose still down at the world: held still, not shuffling in and out
            held = [f for f in fr[on[0] :] if f["pitch"] > 15]
            assert held, ("no frames held with the nose down", fr[on[0]])
            assert max(f["alt"] for f in held) < floor * 1.001, (
                "bobbing off the floor",
                held[:3],
            )
            print(
                key,
                "held",
                len(held),
                "max step",
                max(f["step"] for f in held),
                "floor",
                floor,
            )
            assert max(f["step"] for f in held) < floor * 0.05, (
                "moving, not still",
                held[:3],
            )
            assert abs(fr[-1]["pitch"]) < 11, ("the nose came up to level", fr[-1])
        finally:
            br.close()
