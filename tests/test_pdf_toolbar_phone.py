"""The PDF viewer's toolbar on a phone (1.12.1).

At 390px pdf.js's stock toolbar packed ten 28px buttons edge to edge (the
four annotation tools among them), too small and too close for a finger.
On a phone its buttons are pdf.js's touch size and the annotation tools,
which have no place in the overflow menu, step aside; print and download
are in the menu already. Desktop is unchanged.

Run: pytest tests/test_pdf_toolbar_phone.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from test_books_sources import _library, _water  # noqa: E402

TOOLBAR = """() => { var r = [];
  document.querySelectorAll('#toolbarContainer button, #toolbarContainer input').forEach(function(b) {
    var s = b.getBoundingClientRect(); if (!s.width || !s.height) return;
    r.push({ id: b.id, left: s.left, right: s.right, w: s.width, h: s.height }); });
  return { vw: innerWidth, sw: document.documentElement.scrollWidth, items: r }; }"""


@pytest.fixture
def served_pdf(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    _library(tmp_path, monkeypatch, [_water()])
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    name = srv.list_zims()[0]["name"]
    yield "http://127.0.0.1:%d/static/pdfjs/web/viewer.html?file=/w/%s/files/Water%%20(1).pdf" % (
        httpd.server_address[1],
        name,
    )
    httpd.shutdown()
    srv.release_zim_handles(list(srv.get_zim_files()))


def _toolbar(url, device):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            args = pw.devices[device] if isinstance(device, str) else device
            pg = br.new_context(**args).new_page()
            pg.goto(url)
            pg.wait_for_function(
                "() => (document.getElementById('numPages') || {}).textContent.indexOf('1') >= 0",
                timeout=30000,
            )
            return pg.evaluate(TOOLBAR)
        finally:
            br.close()


def _skip_without_browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")


def test_the_pdf_toolbar_fits_a_finger_on_a_phone(served_pdf):
    _skip_without_browser()
    got = _toolbar(served_pdf, "iPhone 13")
    items = sorted(got["items"], key=lambda i: i["left"])
    ids = [i["id"] for i in items]
    assert got["sw"] <= got["vw"], got
    # The annotation tools are not on a phone's bar; the menu is.
    assert not [i for i in ids if i.startswith("editor")], ids
    assert "secondaryToolbarToggleButton" in ids
    for i in items:
        if i["id"] != "pageNumber":
            assert i["h"] >= 40 and i["w"] >= 40, i
        assert i["right"] <= got["vw"], i
    # Nothing overlaps its neighbour.
    for a, b in zip(items, items[1:]):
        assert a["right"] <= b["left"] + 0.5, (a, b)


def test_the_desktop_toolbar_is_unchanged(served_pdf):
    _skip_without_browser()
    got = _toolbar(served_pdf, {"viewport": {"width": 1280, "height": 800}})
    by = {i["id"]: i for i in got["items"]}
    assert (
        "editorHighlightButton" in by and "printButton" in by and "downloadButton" in by
    )
    assert round(by["zoomInButton"]["h"]) == 28
