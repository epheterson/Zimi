"""the UFO that comes down to a world's surface with its nose to the ground pitches up to the horizon by itself, then stays near the surface (round it, hands off).

Run: pytest tests/test_almanac_ufo_surface_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401

# acos of a dot product a rounding short of 1 reads about 1e-6 degrees for a craft that did not move at all (a slow runner's ground lands on that side of it)
NOISE_DEG = 1e-4

RUN = """([f, steps]) => {
  const sh = _ae.ship, bodies = _afBodies(_ae.scene), near = () => _afOverShip(sh, bodies), b = near().body;
  sh.hold = null; sh.auto = null; sh.dive = null; sh.landing = null; sh.lookDown = 0; sh.ask = { f: f, t: 0, u: 0 };
  const away = () => { const d = [0, 1, 2].map(i => sh.pos[i] - b.pos[i]), l = Math.hypot(...d); return d.map(v => v / l); };
  const down0 = -_aeDot(sh.view, away()), a0 = away();
  for (let i = 0; i < steps; i++) _afMove(sh, bodies, 0.05);
  const a1 = away();
  return { down0: down0, down1: -_aeDot(sh.view, away()), alt: near().alt / b.r, moved: Math.acos(Math.min(1, a0[0] * a1[0] + a0[1] * a1[1] + a0[2] * a1[2])) * 180 / Math.PI };
}"""

PUT = """() => { const sh = _ae.ship, b = _afBody(_afBodies(_ae.scene), 'mars'), d = [0, 1, 2].map(i => sh.pos[i] - b.pos[i]), l = Math.hypot(...d), up = d.map(v => v / l);
  sh.hold = null; sh.pos = [0, 1, 2].map(i => b.pos[i] + up[i] * b.r * 1.0001);
  const side = _aeNorm(_aeCross(up, [0, 0, 1])); sh.view = _aeNorm(_aeAdd(_aeScale(up, -0.9), _aeScale(side, 0.3))); sh.up = up; sh.free = true; }"""


def test_the_ufo_at_the_surface_pitches_up_and_stays_near_it(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("_aePreset('mars')")
            pg.wait_for_function(
                "() => !_ae.fly && _ae.target === 'mars'", timeout=READY_MS, polling=500
            )
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS, polling=500)
            for f in (0, 1):  # hands off, and the forward thumb
                pg.evaluate(PUT)
                out = pg.evaluate(RUN, [f, 100])
                assert out["down0"] > 0.5, out  # (it started nose down)
                assert abs(out["down1"]) < 0.1, out  # level: the nose is at the horizon
                assert out["alt"] < 0.05, out  # still near the surface
                assert (out["moved"] < NOISE_DEG) if f == 0 else out["moved"] > 0.1, out  # hands off it never moves by itself; on the thumb it goes round the world at the pace of its height
        finally:
            br.close()
