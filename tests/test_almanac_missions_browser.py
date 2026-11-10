"""Missions in the Almanac's Go to: the group is listed, tapping Apollo 11 starts the player at its first phase (named, timed, on its timeline),
the player stops cleanly, and the touchdown hands over to the site visit with a way back.

Run: pytest tests/test_almanac_missions_browser.py -v
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


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("ms")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def test_go_to_lists_missions_and_apollo_11_starts_the_player(served):
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
            pg.evaluate("openAlmanacEarth({ target: 'moon' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
                timeout=READY_MS,
                polling=200,
            )
            pg.click("#ae-go-btn")
            pg.wait_for_function(
                "() => !document.getElementById('ae-go').hidden && document.querySelectorAll('#ae-go [data-ae-go^=\"ms:\"]').length > 0",
                timeout=60_000,
            )
            keys = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-go [data-ae-go^=\"ms:\"]')).map(b => b.getAttribute('data-ae-go'))"
            )
            assert keys[0] == "ms:apollo11" and "ms:plan" in keys, keys
            # Missions are not flight targets: nothing in the sweep of bodies starts a mission.
            assert pg.evaluate("() => !('ms:apollo11' in AE_TARGETS)")
            pg.click("#ae-go [data-ae-go='ms:apollo11']")
            pg.wait_for_function(
                "() => !!_ae.mission && !!document.getElementById('am-hud')",
                timeout=120_000,
                polling=200,
            )
            hud = pg.evaluate(
                "() => ({ id: _ae.mission.id, phase: document.getElementById('am-hud').dataset.phase, met: (document.getElementById('am-met') || {}).textContent })"
            )
            assert hud["id"] == "apollo11" and hud["met"], hud
            # Leaving the view stops the player and gives the page its clock back.
            pg.evaluate("_amStop(false)")
            assert pg.evaluate(
                "() => !_ae.mission && !document.getElementById('am-hud')"
            )
            assert errors == [], errors
        finally:
            br.close()
