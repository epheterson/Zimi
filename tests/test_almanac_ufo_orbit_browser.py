"""The UFO never moves by itself. Throttling forward at the lowest height over a world takes it round the world at that height (not off in a straight line); a nose pulled up leaves.

Run: pytest tests/test_almanac_ufo_orbit_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401

MOVE = """([ask, secs, pitch]) => {
  const sh = _ae.ship, bodies = _afBodies(_ae.scene), near = _afOverShip(sh, bodies), b = near.body;
  sh.hold = null; sh.auto = null; sh.dive = null; sh.ask = ask;
  const away = [0, 1, 2].map(i => sh.pos[i] - b.pos[i]), l = Math.hypot(...away), up = away.map(v => v / l);
  // the nose level with the ground (or pitched up by `pitch` degrees), along the wing's cross with up
  const side = [up[1] * 0 - up[2] * 1, up[2] * 0 - up[0] * 0, up[0] * 1 - up[1] * 0], sl = Math.hypot(...side) || 1;
  const t = side.map(v => v / sl), p = pitch * Math.PI / 180;
  sh.view = t.map((v, i) => v * Math.cos(p) + up[i] * Math.sin(p));
  const rel = () => { const d = [0, 1, 2].map(i => sh.pos[i] - b.pos[i]); return { r: Math.hypot(...d), d }; };
  const a = rel(); _afMove(sh, bodies, secs); const c = rel();
  const cos = a.d.reduce((s, v, i) => s + v * c.d[i], 0) / (a.r * c.r);
  return { r0: a.r, r1: c.r, ang: Math.acos(Math.min(1, cos)) * 180 / Math.PI, alt: near.alt / b.r };
}"""


def _at_floor(pg, key):
    if not pg.evaluate("() => !!_ae.ship"):
        pg.evaluate(f"_aePreset('{key}')")
        pg.wait_for_function(
            f"() => !_ae.fly && _ae.target === '{key}'", timeout=READY_MS, polling=500
        )
        pg.evaluate("document.getElementById('ae-fly-btn').click()")
        pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS, polling=500)
    pg.evaluate(
        f"""() => {{ const sh = _ae.ship, b = _afBody(_afBodies(_ae.scene), '{key}'), d = [0, 1, 2].map(i => sh.pos[i] - b.pos[i]), l = Math.hypot(...d);
      sh.hold = null; sh.pos = [0, 1, 2].map(i => b.pos[i] + d[i] / l * (b.r + _afFloor(b))); }}"""
    )


def test_the_ufo_circles_at_the_floor_only_under_throttle(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            _at_floor(pg, "mars")
            idle = pg.evaluate(MOVE, [{"f": 0, "t": 0, "u": 0}, 1.0, 0])
            assert idle["ang"] < 1e-3 and abs(idle["r1"] - idle["r0"]) < 1e-9, (
                "no lever, no motion",
                idle,
            )
            _at_floor(pg, "mars")
            fwd = pg.evaluate(MOVE, [{"f": 1, "t": 0, "u": 0}, 0.2, 0])
            assert (
                abs(fwd["r1"] - fwd["r0"]) / fwd["r0"] < 1e-9 and fwd["ang"] > 0.01
            ), ("throttling forward circles at the same height", fwd)
            up = pg.evaluate(MOVE, [{"f": 1, "t": 0, "u": 0}, 0.2, 45])
            assert up["r1"] > up["r0"] * 1.0000001, ("a nose pulled up leaves", up)
        finally:
            br.close()
