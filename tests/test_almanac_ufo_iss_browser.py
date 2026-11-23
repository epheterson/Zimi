"""the UFO turned on at the ISS leaves the picture as it was, and the craft is in it (in front of the camera, past its near plane, drawn).

Run: pytest tests/test_almanac_ufo_iss_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401

SEEN = """() => {
  const sh = _ae.ship, cam = _ae.gl.camera, c = sh.craft, e = cam.matrixWorld.elements;
  const look = [-e[8], -e[9], -e[10]], p = c.root.getWorldPosition(new _ae.gl.THREE.Vector3());
  const rel = [p.x - cam.position.x, p.y - cam.position.y, p.z - cam.position.z];
  const ahead = rel[0] * look[0] + rel[1] * look[1] + rel[2] * look[2];
  return { visible: c.root.visible, inScene: c.root.parent === _ae.gl.scene, ahead, near: cam.near, far: cam.far, cam: [cam.position.x, cam.position.y, cam.position.z] };
}"""


def test_the_ufo_at_the_iss_changes_nothing_and_is_in_front(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("_aePreset('iss')")
            pg.wait_for_function(
                "() => !_ae.fly && _ae.target === 'iss'", timeout=READY_MS, polling=500
            )
            before = pg.evaluate(
                "() => { const p = _ae.gl.camera.position; return [p.x, p.y, p.z]; }"
            )
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            pg.wait_for_function(
                "() => !!_ae.ship && !!_ae.ship.craft", timeout=READY_MS, polling=500
            )
            pg.wait_for_timeout(1500)
            seen = pg.evaluate(SEEN)
            assert seen["visible"] and seen["inScene"], seen
            assert seen["near"] < seen["ahead"] < seen["far"], (
                "the craft is past the near plane and inside the far one",
                seen,
            )
            moved = max(abs(a - b) for a, b in zip(before, seen["cam"]))
            assert moved < 0.01, (
                "getting in moves nothing (the ISS itself moves 11 km in the wait)",
                before,
                seen,
            )
            # a hand on the view lets the held picture go: with no lever the craft stays where it is, in front of the eye (it used to circle the Earth by itself at 336 km/s)
            pg.evaluate("() => { _ae.ship.hold = null; _ae.ship.hand = true; }")
            pg.evaluate("() => _afAdvance(3)")
            later = pg.evaluate("() => [Math.hypot(..._ae.ship.vel), _ae.ship.hold]")
            assert later == [0, None], ("no lever, no motion", later)
        finally:
            br.close()