"""A wide infobox keeps the reader's column instead of clipping on a phone.

Wikipedia's Roman Empire infobox holds a row that will not wrap (a no-wrap
run, a long list of languages). In the reader it widened the infobox into
its own scroll box, cut mid-word at the frame's right edge with nothing to
show it could be scrolled (#136). The infobox now takes the column's width
and its text wraps.

Served through the real handler from a ZIM written here, at a phone's 390px.

Run: pytest tests/test_reader_infobox_fit.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

ZIM = "wiki_en_2026-01"
PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Empire</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body class="skin-vector-2022 skin--responsive"><div class="mw-parser-output">
<table class="infobox"><tbody>
<tr><td colspan="2"><span style="white-space:nowrap">Official: Latin and Greek, and regional languages spoken across the provinces of the empire</span></td></tr>
<tr><th>Capital</th><td>Rome (27 BC to AD 476)</td></tr>
</tbody></table><p>The Roman Empire.</p></div></body></html>"""

MEASURE = """() => {
  var d = document.getElementById('reader-frame').contentDocument;
  var t = d.querySelector('.infobox'), r = t.getBoundingClientRect();
  return { width: r.width, scroll: t.scrollWidth, client: t.clientWidth, frame: d.defaultView.innerWidth };
}"""


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
    with Creator(str(zdir / (ZIM + ".zim"))).config_indexing(False, "eng") as cr:
        cr.set_mainpath("A/Empire")
        cr.add_item(_MediaItem("A/Empire", "text/html", PAGE.encode()))
        for key, value in {
            "Name": "wiki_en",
            "Title": "Wiki",
            "Language": "eng",
            "Description": "wiki",
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


@pytest.mark.parametrize("engine", ["chromium", "webkit"])
def test_a_wide_infobox_fits_the_column(served, engine):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        try:
            br = getattr(pw, engine).launch()
        except Exception:
            pytest.skip(engine + " is not installed")
        ctx = br.new_context(viewport={"width": 390, "height": 800}, has_touch=True)
        pg = ctx.new_page()
        pg.goto(served + "/")
        pg.wait_for_function(
            "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
            timeout=30000,
        )
        pg.evaluate("([z, p]) => openArticle(z, p)", ["wiki", "A/Empire"])
        pg.wait_for_function(
            "() => { var d = document.getElementById('reader-frame').contentDocument; return !!(d && d.querySelector('.infobox')); }",
            timeout=20000,
        )
        pg.wait_for_timeout(500)
        m = pg.evaluate(MEASURE)
        br.close()
    assert m["width"] <= m["frame"], m
    assert m["scroll"] <= m["client"] + 1, m  # nothing left to scroll to, nothing clipped
