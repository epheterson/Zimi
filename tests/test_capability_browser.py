"""Capability levels in a real browser, on software GL (SwiftShader), the "low" reference: the 3D view does not open
(a plain line, never a tab crash), the gear offers Auto / Light / Full and what the network adds, Full tries the view, and
the choice is kept.

Run: pytest tests/test_capability_browser.py -v
"""

import os
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("cap")
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
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            has_touch=True,
            is_mobile=True,
            service_workers="block",
        )
        ctx.add_init_script("try { if (!localStorage.getItem('zimi_cap')) localStorage.setItem('zimi_cap', 'auto'); } catch (e) {}")   # a test browser gets Full unless it says Auto
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function("() => typeof _almanacLoaded !== 'undefined' && _almanacLoaded && typeof ZimiCap !== 'undefined'", timeout=120_000)
        # On what Auto calls low the 3D files are held back until a tap needs them: this is the tap.
        pg.evaluate("() => _almLoadEarth()")
        pg.wait_for_function("() => typeof openAlmanacEarth === 'function'", timeout=120_000)
        yield pg
        br.close()


def test_software_gl_is_the_low_level_and_the_view_is_a_plain_line(page):
    sig = page.evaluate("() => ZimiCap.signals()")
    assert sig["soft"] is True and sig["level"] == "low", sig
    assert page.evaluate("() => ZimiCap.view3d()") == "static"
    page.evaluate("() => openAlmanacEarth({ target: 'earth' })")
    page.wait_for_function(
        "() => _aeIsOpen && document.getElementById('ae-msg').textContent.length > 8",
        timeout=30_000,
    )
    line = page.evaluate("() => document.getElementById('ae-msg').textContent")
    assert "3D view is off" in line, line
    # No GL was built for it: no three.js, no context held.
    assert page.evaluate("() => !_ae.gl && !window.THREE")


def test_the_gear_offers_the_three_choices_and_Full_tries_the_view(page):
    page.click("#ae-gear")
    page.wait_for_selector("input[name=cap-setting]")
    values = page.evaluate(
        "() => [...document.querySelectorAll('input[name=cap-setting]')].map(i => i.value)"
    )
    assert values == ["auto", "light", "full"]
    assert (
        page.evaluate(
            "() => document.querySelector('input[name=cap-setting]:checked').value"
        )
        == "auto"
    )
    page.evaluate(
        "() => document.querySelector('input[name=cap-setting][value=full]').click()"
    )
    page.wait_for_function("() => !_ae.capStatic && !_ae.failed", timeout=10_000)
    assert page.evaluate("() => localStorage.getItem('zimi_cap')") == "full"
    assert page.evaluate("() => ZimiCap.view3d()") == "open"
    # The view is making itself (software GL is slow); what matters is that it did not stay a plain line.
    page.wait_for_function(
        "() => document.getElementById('ae-msg').textContent !== 'The 3D view is off on this device. Choose Full in the gear to try it.'",
        timeout=10_000,
    )


def test_Auto_puts_the_plain_line_back(page):
    page.evaluate("() => ZimiCap.set('auto')")
    page.wait_for_function("() => _ae.capStatic && _ae.failed", timeout=20_000)
    assert page.evaluate("() => localStorage.getItem('zimi_cap')") == "auto"
    assert not page.errors, page.errors
def _almanac_with(page, served, init, idle_ms=6000):
    """Open the Almanac on a fresh context under `init` and wait out the quiet-time preload; whether almanac-earth.js came."""
    ctx = page.context.browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
    try:
        ctx.add_init_script(init)
        pg = ctx.new_page()
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function("() => typeof _almanacLoaded !== 'undefined' && _almanacLoaded && typeof ZimiCap !== 'undefined'", timeout=120_000)
        pg.wait_for_timeout(idle_ms)
        return pg.evaluate("() => typeof window.openAlmanacEarth === 'function'"), pg.evaluate("() => ZimiCap.lowPower()")
    finally:
        ctx.close()


def test_the_page_holds_the_3d_files_back_on_what_capability_calls_low(page, served):
    mem1 = "Object.defineProperty(navigator, 'deviceMemory', { get: () => 1 });"
    came, low = _almanac_with(
        page, served, mem1 + "try { localStorage.setItem('zimi_cap', 'auto'); } catch (e) {}"
    )
    assert low is True and came is False, (low, came)
    # Full is the person's word: the same machine fetches them ahead of the tap.
    came, low = _almanac_with(
        page, served, mem1 + "try { localStorage.setItem('zimi_cap', 'full'); } catch (e) {}"
    )
    assert low is False and came is True, (low, came)
