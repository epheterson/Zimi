"""while the UFO flies, a world in the picture is ringed (the goal's ring bright), never named across its face; a world off the picture keeps its arrow and name.

Run: pytest tests/test_almanac_ufo_rings_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401

REFS = """() => [...document.querySelectorAll('#af-refs .af-ref')].filter(e => !e.hidden).map(e => ({ ring: e.classList.contains('af-ring'), goal: e.classList.contains('af-goal'), text: e.textContent, key: e.dataset.key, w: e.style.width }))"""


def test_a_world_in_the_picture_is_ringed_not_named(served):
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
            # face Jupiter and fly there: it is in the picture and the goal
            pg.evaluate(
                """() => { const sh = _ae.ship, j = _afBody(_afBodies(_ae.scene), 'jupiter');
                  sh.hold = null; sh.free = true; sh.view = _aeNorm(_aeSub(j.pos, sh.pos)); sh.up = _aeNorm(_aeCross(_aeCross(sh.view, sh.up), sh.view)); sh.auto = 'jupiter'; _ae.dirty = true; }"""
            )
            pg.wait_for_function(
                "() => [...document.querySelectorAll('#af-refs .af-ref')].some(e => !e.hidden && e.dataset.key === 'jupiter')",
                timeout=30_000,
                polling=300,
            )
            if os.environ.get(
                "UFO_SHOTS"
            ):  # (a viewer looks at these; not part of the assertions)
                pg.wait_for_timeout(1500)
                pg.screenshot(path=os.path.join(os.environ["UFO_SHOTS"], "transit.png"))
            refs = pg.evaluate(REFS)
            goal = [r for r in refs if r["key"] == "jupiter"][0]
            assert (
                goal["ring"] and goal["goal"] and goal["text"] == "" and goal["w"]
            ), goal
            assert all(r["text"] == "" for r in refs if r["ring"]), refs
            assert all(
                r["text"] for r in refs if not r["ring"]
            ), refs  # off the picture: the arrow and the name stay
        finally:
            br.close()
