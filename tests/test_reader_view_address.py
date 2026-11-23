"""Reader View survives a reload and a copied link.

The article's address carries it (&rv=1) while it is on and drops it when it is off, so reloading the page, or opening
the same address elsewhere, reads the article the way it was left.

Run: pytest tests/test_reader_view_address.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

PROSE = (
    "A paragraph long enough for Reader View to take the page, which wants a few "
    "hundred characters of real text before it calls something an article. "
) * 3
PAGE = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plain</title></head>'
    "<body><main><h1>Plain</h1><p>%s</p><p>%s</p></main></body></html>" % (PROSE, PROSE)
)
ON = "() => { var d = document.getElementById('reader-frame').contentDocument; return !!(d && d.querySelector('.zimi-reader')); }"
LOADED = "() => { var d = document.getElementById('reader-frame').contentDocument; return !!(d && d.body && d.body.children.length) && document.getElementById('reader-loading').classList.contains('hidden'); }"


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import _MediaItem
    from libzim.writer import Creator

    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    with Creator(str(zdir / "plainread_en_2026-01.zim")).config_indexing(False, "eng") as cr:
        cr.set_mainpath("A/index")
        cr.add_item(_MediaItem("A/index", "text/html", PAGE.encode()))
        for key, value in {
            "Name": "plainread_en",
            "Title": "Plain",
            "Language": "eng",
            "Description": "plain",
            "Date": "2026-01-01",
        }.items():
            cr.add_metadata(key, value)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def test_reader_view_comes_back_on_reload_and_on_the_same_link(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(**pw.devices["iPhone 13"])
            pg = ctx.new_page()
            pg.goto(served + "/?a=plainread%2FA%2Findex")
            pg.wait_for_function(LOADED, timeout=30000)
            assert not pg.evaluate(ON), "off until asked"
            assert "rv=1" not in pg.url
            pg.evaluate("() => _readerViewToggle()")
            pg.wait_for_function(ON, timeout=10000)
            assert pg.url.endswith("&rv=1"), pg.url
            pg.reload()
            pg.wait_for_function(ON, timeout=30000)
            assert pg.url.endswith("&rv=1"), pg.url
            # The same address in a fresh page, with nothing remembered.
            other = br.new_context(**pw.devices["iPhone 13"]).new_page()
            other.goto(pg.url)
            other.wait_for_function(ON, timeout=30000)
            # Off again: the address says so, and a reload reads the page as written.
            pg.evaluate("() => _readerViewToggle()")
            pg.wait_for_function("() => location.search.indexOf('rv=1') < 0")
            pg.reload()
            pg.wait_for_function(LOADED, timeout=30000)
            assert not pg.evaluate(ON)
        finally:
            br.close()
