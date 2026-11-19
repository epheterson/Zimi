"""The Downloads row says "Testing mirrors…" while the mirror probe runs.

A real server, a real download against fake download mirrors whose probes
are held open, and Chromium at phone width on Manage → Downloads.

Run: pytest tests/test_mirror_probe_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.library as lib  # noqa: E402
import zimi.mirrorrank as mirrorrank  # noqa: E402
from download_mirrors_fixture import download_mirrors, wait_for  # noqa: E402,F401

PHONE = {"width": 390, "height": 844}


@pytest.fixture
def served(download_mirrors, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    monkeypatch.setattr(srv, "ZIMI_MANAGE", True, raising=False)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], download_mirrors
    httpd.shutdown()
    httpd.server_close()


def test_the_row_says_testing_mirrors_while_the_probe_runs(served, monkeypatch):
    from playwright.sync_api import sync_playwright

    base, download_mirrors = served
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_FILE_BYTES", 0)
    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 30.0)
    mirrors = download_mirrors(countries=("us", "nl"))
    for m in mirrors.mirrors:
        m.chunk_delay = 5.0  # the probe stays open while the page looks
    dl_id, err = lib._start_download(mirrors.meta4_url, size_bytes=len(mirrors.body))
    assert err is None, err
    assert wait_for(lambda: lib._active_downloads[dl_id].get("probing"), timeout=10)

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = br.new_context(viewport=PHONE, service_workers="block").new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(base + "/?manage&lang=en")
            pg.locator('.manage-tab[data-tab="downloads"]').click()
            row = pg.locator("#manage-downloads .dl-row").first
            row.wait_for(timeout=20000)
            assert "Testing mirrors…" in row.inner_text()
            wide = pg.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            assert wide <= 0, f"the page scrolls sideways by {wide}px at 390px"
            assert not errors, errors
        finally:
            br.close()
            for m in mirrors.mirrors:
                m.chunk_delay = 0
