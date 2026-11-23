"""The surface button on a world with no ground (Jupiter) takes the UFO down to its cloud tops, and a hand on the controls stops the descent.

Run: pytest tests/test_almanac_ufo_down_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401


def test_surface_button_on_jupiter_takes_the_ufo_down(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("_aePreset('jupiter')")
            pg.wait_for_function("() => !_ae.fly && _ae.target === 'jupiter'", timeout=READY_MS, polling=500)
            # (the button reads the world at the centre once the flight is over: for a frame it still says the UFO's own word)
            pg.wait_for_function("() => { const r = document.getElementById('ae-rim'); return !r.hidden && r.getAttribute('data-kind') === 'enter' && r.getAttribute('aria-label') === _aeT('alm_fly_down'); }", timeout=READY_MS, polling=100)
            pg.evaluate("document.getElementById('ae-rim').click()")
            pg.wait_for_function("() => !!_ae.ship && !!_ae.ship.dive", timeout=READY_MS, polling=200)
            # a software renderer draws a frame a second: the flight is stepped on its own fixed 50 ms step
            res = pg.evaluate("""() => { const sh = _ae.ship; let n = 0;
              while ((sh.dive || sh.auto) && n++ < 20000) { const bodies = _afBodies(_ae.scene); _afInput(sh, 0.05); _afMove(sh, bodies, 0.05); }
              const near = _afOverShip(sh, _afBodies(_ae.scene)); return { n, dive: sh.dive, auto: !!sh.auto, key: near.body.key, alt: near.alt / near.body.r }; }""")
            assert res["dive"] is None and not res["auto"] and res["key"] == "jupiter" and res["alt"] < 0.05, res
            # a hand on the controls ends a way down
            pg.evaluate("() => { const sh = _ae.ship; sh.dive = 'jupiter'; sh.throttle = 0.5; _afInput(sh, 0.05); }")
            assert pg.evaluate("() => _ae.ship.dive") is None
        finally:
            br.close()


def test_a_way_down_to_jupiter_from_beside_io_goes_to_jupiter_not_io(served):
    """Jupiter's stop can leave a moon nearer than the planet: the lever's down is toward the dive's own world, so the craft is not held on Io's floor."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("_aePreset('jupiter')")
            pg.wait_for_function("() => !_ae.fly && _ae.target === 'jupiter'", timeout=READY_MS, polling=500)
            pg.wait_for_function("() => { const r = document.getElementById('ae-rim'); return !r.hidden && r.getAttribute('data-kind') === 'enter' && r.getAttribute('aria-label') === _aeT('alm_fly_down'); }", timeout=READY_MS, polling=100)
            pg.evaluate("document.getElementById('ae-rim').click()")
            pg.wait_for_function("() => !!_ae.ship && !!_ae.ship.dive", timeout=READY_MS, polling=200)
            res = pg.evaluate("""() => { const sh = _ae.ship; let bodies = _afBodies(_ae.scene);
              const io = _afBody(bodies, 'io'), jup = _afBody(bodies, 'jupiter');
              const out = _aeNorm(_aeSub(io.pos, jup.pos));
              sh.auto = sh.arrived = null; const side = _aeNorm(_aeCross(out, [0, 0, 1])); sh.pos = _aeAdd(io.pos, _aeScale(side, io.r * 3)); sh.vel = [0, 0, 0]; sh.dive = 'jupiter';
              let n = 0;
              while (sh.dive && n++ < 20000) { bodies = _afBodies(_ae.scene); _afInput(sh, 0.05); _afMove(sh, bodies, 0.05); }
              const near = _afOverShip(sh, _afBodies(_ae.scene)); return { n, dive: sh.dive, key: near.body.key, alt: near.alt / near.body.r, io: _aeLen(_aeSub(sh.pos, io.pos)) / io.r }; }""")
            assert res["dive"] is None and res["key"] == "jupiter" and res["alt"] < 0.05, res
        finally:
            br.close()
