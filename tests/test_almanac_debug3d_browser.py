"""The 3D debug log: off by default (nothing fetched, nothing kept); `?debug3d=1` turns it on for the device, and it records the UFO's changes with the call
that made them and shows them on a pill that copies them.

Run: pytest tests/test_almanac_debug3d_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_fly_browser import GL_ARGS, PLACE, READY_MS, VIEW, served  # noqa: E402,F401


def _open(pw, served, query):
    br = pw.chromium.launch(args=GL_ARGS)
    ctx = br.new_context(viewport=VIEW, device_scale_factor=1, has_touch=True, is_mobile=True, service_workers="block")
    ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE))
    pg = ctx.new_page()
    requested = []
    pg.on("request", lambda r: requested.append(r.url))
    pg.goto(served + "/" + query + "#almanac", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=READY_MS)
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
    return br, pg, requested


def test_debug_log(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, requested = _open(pw, served, "")
        try:
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS)
            assert pg.evaluate("() => _aeDbgLog.length") == 0, "off: nothing is kept"
            assert not any("almanac-debug3d.js" in u for u in requested)
            assert pg.evaluate("() => document.getElementById('ae-dbg-pill')") is None
        finally:
            br.close()
        br, pg, requested = _open(pw, served, "?debug3d=1")
        try:
            pg.wait_for_function("() => !!document.getElementById('ae-dbg-pill')", timeout=READY_MS)
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS)
            pg.evaluate("_afStop()")
            pg.wait_for_function("() => !_ae.ship", timeout=READY_MS)
            text = pg.evaluate("() => _aeDbgText()")
            assert "fly start asked" in text and "fly stop" in text, text
            assert "ship=1" in text and "ufoBtn=" in text, text
            assert pg.evaluate("() => localStorage.getItem('zimi.debug3d')") == "1"
            pg.evaluate("document.getElementById('ae-dbg-pill').click()")
            assert "fly start asked" in pg.evaluate("() => document.querySelector('pre').textContent")
        finally:
            br.close()
        # ?debug3d=0 turns it off for the device
        br, pg, requested = _open(pw, served, "?debug3d=0")
        try:
            assert pg.evaluate("() => localStorage.getItem('zimi.debug3d')") is None
        finally:
            br.close()
