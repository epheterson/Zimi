"""A spacecraft whose model does not come, or comes late: the view says so and never goes blank.

A model that 404s ends the flight at the craft's dot with one short line; a model slower than a moment shows a line
while it loads. In headless Chromium at a phone's size.

Run: pytest tests/test_almanac_craft_fallback_browser.py -v
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
MODEL = "**/craft-voyager-v1.bin"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("craft")
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


@pytest.fixture(scope="module")
def browser():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


def _open(browser, url, handler):
    ctx = browser.new_context(
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
    pg.route(MODEL, handler)
    pg.goto(url + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function'", timeout=120_000
    )
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=READY_MS,
        polling=200,
    )
    return ctx, pg


HINT = "() => { var h = document.getElementById('ae-hint'); return h && h.classList.contains('ae-show') ? h.textContent : ''; }"


def test_a_model_that_404s_ends_at_the_dot_with_one_line(browser, served):
    ctx, pg = _open(browser, served, lambda route: route.fulfill(status=404, body="no"))
    try:
        pg.evaluate("_aePreset('voyager1')")
        pg.wait_for_function(
            "() => { var h = document.getElementById('ae-hint'); return h && h.classList.contains('ae-show') && h.textContent.length > 0; }",
            timeout=60_000,
            polling=200,
        )
        assert pg.evaluate(HINT) == pg.evaluate("_aeT('alm_craft_failed')")
        pg.wait_for_function(
            "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
            timeout=120_000,
            polling=200,
        )
        assert pg.evaluate("isFinite(_ae.dist) && _ae.target === 'voyager1'")
    finally:
        ctx.close()


def test_a_slow_model_shows_a_line_while_it_loads_and_the_line_goes_when_it_is_in(
    browser, served
):
    def slow(route):
        import time

        time.sleep(1.5)
        route.continue_()

    ctx, pg = _open(browser, served, slow)
    try:
        pg.evaluate("_aePreset('voyager1')")
        pg.wait_for_function(
            "() => { var h = document.getElementById('ae-hint'); return h && h.classList.contains('ae-show') && h.textContent.length > 0; }",
            timeout=60_000,
            polling=100,
        )
        assert pg.evaluate(HINT) == pg.evaluate("_aeT('alm_craft_loading')")
        pg.wait_for_function(
            "() => !!(_aeCraft.voyager && _aeCraft.voyager.data)",
            timeout=60_000,
            polling=200,
        )
        pg.wait_for_function(
            "() => { var h = document.getElementById('ae-hint'); return !h || !h.classList.contains('ae-show'); }",
            timeout=20_000,
            polling=200,
        )
    finally:
        ctx.close()
