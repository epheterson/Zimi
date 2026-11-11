"""A PDF over the 50 MB cap opens in Zimi's PDF.js reader, by Range.

Stored uncompressed it is sent in pieces and its pages draw; stored
compressed it is refused, and the reader says why in words.

Run: pytest tests/test_big_pdf_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

VIEWER = "/static/pdfjs/web/viewer.html?zr=1&file=/w/{zim}/files/manual.pdf"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from test_big_entries import build_library
    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("bigpdf")
    zdir = tmp / "zims"
    zdir.mkdir()
    build_library(str(zdir))
    saved = srv.ZIM_DIR, srv.ZIMI_DATA_DIR
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(zdir), str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = saved


@pytest.fixture
def page():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844}, service_workers="block"
        )
        yield ctx.new_page()
        br.close()


def test_an_uncompressed_pdf_over_the_cap_opens_and_its_pages_draw(served, page):
    ranged = []
    page.on(
        "response",
        lambda r: "manual.pdf" in r.url
        and r.status == 206
        and ranged.append(r.headers.get("content-range")),
    )
    page.goto(served + VIEWER.format(zim="plain"))
    page.wait_for_function(
        "() => window.PDFViewerApplication && PDFViewerApplication.pagesCount === 3",
        timeout=30000,
    )
    page.wait_for_selector(".page[data-page-number='1'] canvas", timeout=30000)
    page.wait_for_function(
        "() => { var t = document.querySelector('.page[data-page-number=\"1\"] .textLayer'); return t && /Page 1/.test(t.textContent); }",
        timeout=30000,
    )
    assert ranged, "PDF.js read it by Range"


def test_a_compressed_one_says_why_it_will_not_open(served, page):
    page.goto(served + VIEWER.format(zim="packed"))
    page.wait_for_selector(".zp-msg", timeout=30000)
    msg = page.inner_text(".zp-msg")
    assert "compressed" in msg, msg
