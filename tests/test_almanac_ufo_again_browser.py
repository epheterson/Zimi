"""the UFO on, off and on again is drawn the second time (the craft is built once and was left out of the scene by the first stop).

Run: pytest tests/test_almanac_ufo_again_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401


def test_the_ufo_is_drawn_again_after_off_and_on(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("_aePreset('mars')")
            pg.wait_for_function(
                "() => !_ae.fly && _ae.target === 'mars'", timeout=READY_MS, polling=500
            )
            for _ in range(2):
                pg.evaluate("document.getElementById('ae-fly-btn').click()")
                pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS, polling=500)
                pg.wait_for_function(
                    "() => { const c = _ae.ship.craft; return !!c && c.root.visible && c.root.parent === _ae.gl.scene; }",
                    timeout=READY_MS,
                    polling=300,
                )
                pg.evaluate("document.getElementById('ae-fly-btn').click()")
                pg.wait_for_function("() => !_ae.ship", timeout=READY_MS, polling=300)
        finally:
            br.close()
