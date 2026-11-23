"""the UFO's travel card says light's time as one short rounded line ("~13 light minutes") and stands clear of the throttle's slot.

Run: pytest tests/test_almanac_ufo_card_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401


def test_light_span_is_short_and_rounded(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            got = pg.evaluate(
                "() => [1, 787, 3580, 7300, 90000, 1e9].map(_ahLightSpan)"
            )
            assert got == [
                "~1 light second",
                "~13 light minutes",
                "~1 light hour",
                "~2 light hours",
                "~1 light day",
                "~32 light years",
            ], got
        finally:
            br.close()


def test_card_clears_the_throttle(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS, polling=500)
            pg.evaluate(
                "() => { const el = document.createElement('div'); el.className = 'ah-info'; el.id = 'probe-info'; el.innerHTML = '<b>Sun → Jupiter</b><span>193 million mi · ×1,454 c</span><span>~13 light minutes</span>'; _ae.el.appendChild(el); }"
            )
            box = pg.evaluate(
                "() => { const a = document.getElementById('probe-info').getBoundingClientRect(), t = document.getElementById('af-throttle').getBoundingClientRect(); return { a: [a.left, a.top, a.right, a.bottom], t: [t.left, t.top, t.right, t.bottom] }; }"
            )
            a, t = box["a"], box["t"]
            apart = a[0] >= t[2] or a[2] <= t[0] or a[3] <= t[1] or a[1] >= t[3]
            assert apart, ("the card covers the throttle", box)
        finally:
            br.close()
