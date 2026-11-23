"""A body the view settles on is always in frame: a sliver of a measured screen, or a spiked nearest stop, cannot leave the camera
beyond its fit (on a phone, the Moon at 173 Earth radii), and the debug log says what the fit was made of.

Run: pytest tests/test_almanac_fit_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401


def test_a_lost_context_comes_back_to_the_view_it_was_in(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("() => _aePreset('moon')")
            pg.wait_for_function(
                "() => _ae.target === 'moon' && !_ae.fly", timeout=READY_MS
            )
            pg.evaluate(
                "() => _ae.gl.renderer.getContext().getExtension('WEBGL_lose_context').loseContext()"
            )
            pg.wait_for_function(
                "() => _aeReady() && _aeIsOpen && !!_ae.gl && !_ae.gl.renderer.getContext().isContextLost()",
                timeout=READY_MS,
                polling=200,
            )
            pg.wait_for_function("() => !_ae.fly", timeout=READY_MS)
            assert pg.evaluate("() => _ae.target") == "moon"
        finally:
            br.close()


def test_the_tile_queue_holds_only_what_is_wanted(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("() => { var hd = _ae.gl.hd; if (!hd) return; hd.queue = []; }")
            n = pg.evaluate(
                """() => { var hd = _ae.gl.hd; if (!hd) return -1; var b = hd.bodies[0]; hd.frame++;
                var nd = _aeHdNode(b, 5, 3, 2); _aeHdWant(_ae.gl, b, nd, 1); var had = hd.queue.length;
                hd.frame++; _aeHdDropStale(hd); return [had, hd.queue.length, _aeHdLayerNode(b, nd, b.maps[0]).tex[b.maps[0].layer] === undefined]; }"""
            )
            if n != -1:
                assert n[0] >= 1 and n[1] == 0 and n[2] is True, n
        finally:
            br.close()


def test_settled_body_is_within_its_fit(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "?debug3d=1")
        try:
            pg.evaluate("() => { _ae.target = 'moon'; }")
            sane = pg.evaluate("() => _aeBodyFitDist('moon')")
            # a screen measured as a sliver: the fit stays within what the narrowest real phone would need
            pg.evaluate("() => { _ae.w = 3; _ae.h = 1300; }")
            sliver = pg.evaluate("() => _aeClampDist(_aeFitDist(AE_FIT_MOON))")
            assert sliver < 12, sliver
            # a nearest stop spiked far out (whatever raised it): the clamp never lands beyond the body's fit
            pg.evaluate(
                "() => { _ae.w = 402; _ae.h = 714; AE_TARGETS.moon.min = 500; AE_TARGETS.moon.stop = 400; }"
            )
            spiked = pg.evaluate("() => _aeClampDist(_aeFitDist(AE_FIT_MOON))")
            assert spiked <= sane + 1e-6, (spiked, sane)
            pg.evaluate("(d) => { _ae.dist = d; _aeDbgFit('test'); }", spiked)
            text = pg.evaluate("() => _aeDbgText()")
            assert (
                "fit test moon w=402 h=714 aspect=0.563" in text
                and "min=500" in text
                and "stop=400" in text
            ), text
        finally:
            br.close()
