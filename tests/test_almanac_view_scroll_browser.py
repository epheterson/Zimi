"""The 3D view never scrolls: its foot stays on its bottom edge.

The sheet for a body (the i) waits below the view, out of sight, so the view's box has more inside it than it shows;
anything that scrolled it (a click that brings an element into view, a focus, a test) lifted the foot, with the clock
and the buttons, a third of the way up the picture, over the planets. On a slow Linux runner that was how the planets
test found the foot 377 px from the top of 788. The view clips instead of hiding, so nothing can scroll it.

Run: pytest tests/test_almanac_view_scroll_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000

FOOT = """() => { var v = _ae.el, r = v.getBoundingClientRect(), f = document.querySelector('.ae-bottom').getBoundingClientRect();
  return { scroll: [v.scrollTop, v.scrollLeft], fromBottom: Math.round(r.bottom - f.bottom) }; }"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("viewscroll")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield "http://127.0.0.1:%d" % httpd.server_address[1]
    finally:
        httpd.shutdown()
        srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old
        srv.load_cache(force=True)


def test_nothing_scrolls_the_view_and_the_foot_stays_on_its_bottom(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(
                viewport=VIEW,
                device_scale_factor=2,
                has_touch=True,
                is_mobile=True,
                service_workers="block",
            )
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
                % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
                timeout=READY_MS,
                polling=200,
            )
            pg.evaluate("_aePreset('saturn')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'saturn'; }",
                timeout=120_000,
                polling=200,
            )
            # The sheet is up and put away again: it waits below the view, which used to give the view room to scroll.
            pg.evaluate("_aeOpenInfo('saturn')")
            pg.wait_for_function(
                "() => document.getElementById('ae-info').classList.contains('in')",
                timeout=10_000,
            )
            pg.evaluate("_aeCloseInfo(true)")
            assert pg.evaluate(FOOT) == {"scroll": [0, 0], "fromBottom": 0}
            # Everything that scrolls: asked outright, brought into view, focused without the guard.
            pg.evaluate(
                "() => { _ae.el.scrollTop = 300; _ae.el.scrollTo(0, 300); document.getElementById('ae-info').scrollIntoView(); "
                "var x = document.getElementById('ae-info-x'); if (x) x.focus(); }"
            )
            assert pg.evaluate(FOOT) == {"scroll": [0, 0], "fromBottom": 0}
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
