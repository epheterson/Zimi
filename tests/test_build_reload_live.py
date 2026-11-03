"""A window left open picks up a new build without a relaunch.

Eric, on his installed app: "I still had to relaunch the PWA to see the new
tiles." Back from the background on the Almanac, the build was heard (the
stream's first tick) but the Almanac counted as in use, so the reload waited
for a hide that an iPhone app may never run. An Almanac not yet touched since
it was shown, and at its top, comes back the same from #almanac: it reloads.
Reading aloud, a field with text, and an Almanac that was used still wait.

Run: pytest tests/test_build_reload_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

NEW_BUILD = "zimi-a-newer-build"
SETTLE_MS = 1500  # a reload that is coming has begun by then


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "water.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _reloads(page, setup=None):
    """Hear a new build on the page as it stands; whether it reloaded."""
    page.evaluate("() => { window.__same = 1; }")
    if setup:
        page.evaluate(setup)
    page.evaluate("(b) => _buildHeard(b)", NEW_BUILD)
    page.wait_for_timeout(SETTLE_MS)
    try:
        return page.evaluate("() => window.__same !== 1")
    except Exception:  # the page navigated under the call
        return True


def _almanac(browser, p, base):
    ctx = browser.new_context(service_workers="block", **p.devices["iPhone 13"])  # no worker to wait for
    pg = ctx.new_page()
    pg.goto(base + "/#almanac")
    pg.wait_for_function("() => typeof _almanacOpen !== 'undefined' && _almanacOpen", timeout=20000)
    pg.wait_for_function("() => typeof _BUILD === 'string' && _BUILD", timeout=5000)
    pg.wait_for_timeout(800)
    return pg


def test_almanac_reloads_only_when_nothing_would_be_lost(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()

        pg = _almanac(br, p, served)
        assert _reloads(pg), "an Almanac just shown, untouched, at its top: it reloads for the new build"
        pg.wait_for_function("() => _almanacOpen", timeout=20000)  # and comes back at #almanac
        assert pg.evaluate("() => location.hash") == "#almanac"

        pg = _almanac(br, p, served)
        assert not _reloads(pg, "() => { _ttsSpeaking = true; }"), "reading aloud: it waits"

        pg = _almanac(br, p, served)
        assert not _reloads(pg, "() => { _buildTouched = true; }"), "an Almanac that was used: it waits"

        pg = _almanac(br, p, served)
        field = "() => { var i = document.createElement('input'); i.value = 'Tokyo'; document.body.appendChild(i); i.focus(); }"
        assert not _reloads(pg, field), "a field with text being typed in: it waits"
        br.close()
