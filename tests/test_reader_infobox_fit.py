"""An infobox in the reader: beside the text when there is room, above it otherwise.

Wikipedia's Roman Empire infobox holds a row that will not wrap (a no-wrap
run, a long list of languages). In the reader it widened the infobox into
its own scroll box, cut mid-word at the frame's right edge with nothing to
show it could be scrolled (#136). 1.15.2 fixed that by giving the infobox the
column's whole width, and on a 565px window it then spread across the page,
labels far left and values mid-page (#136 again). Now: its text wraps; it
floats right at its own width while the column holds it and a readable line
beside it; narrower, it sits above the text at its own width, centred.

Served through the real handler from a ZIM written here, with Wikipedia's own
infobox rules (site.styles.css: 100% below 640px, a 22em right float above).

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
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>@media (max-width:640px){.infobox{width:100%}}
@media (min-width:640px){.infobox{margin-left:1em;float:right;clear:right;width:22em}}</style></head>
<body class="skin-vector-2022 skin--responsive"><div class="mw-parser-output">
<table class="infobox"><tbody>
<tr><td colspan="2"><span style="white-space:nowrap">Official: Latin and Greek, and regional languages spoken across the provinces of the empire</span></td></tr>
<tr><th>Capital</th><td>Rome (27 BC to AD 476)</td></tr>
</tbody></table><p>The Roman Empire. """ + "It ruled the Mediterranean. " * 60 + """</p></div></body></html>"""

MEASURE = """() => {
  var d = document.getElementById('reader-frame').contentDocument, w = d.defaultView;
  var t = d.querySelector('.infobox'), r = t.getBoundingClientRect();
  var col = d.querySelector('.mw-parser-output').getBoundingClientRect();
  var em = parseFloat(w.getComputedStyle(t).fontSize);
  return { left: r.left, right: r.right, width: r.width, scroll: t.scrollWidth, client: t.clientWidth,
    frame: w.innerWidth, colLeft: col.left, colRight: col.right, float: w.getComputedStyle(t).float, em: em };
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


def _measure(served, engine, width):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        try:
            br = getattr(pw, engine).launch()
        except Exception:
            pytest.skip(engine + " is not installed")
        ctx = br.new_context(viewport={"width": width, "height": 800}, has_touch=True)
        pg = ctx.new_page()
        pg.goto(served + "/")
        pg.wait_for_function(
            "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
            timeout=30000,
        )
        pg.evaluate("([z, p]) => openArticle(z, p)", ["wiki", "A/Empire"])
        # the reader's own style is in (its scroll-to-top button rides with it)
        pg.wait_for_function(
            "() => { var d = document.getElementById('reader-frame').contentDocument; return !!(d && d.querySelector('.infobox') && d.getElementById('zimi-top')); }",
            timeout=20000,
        )
        pg.wait_for_timeout(300)
        m = pg.evaluate(MEASURE)
        br.close()
    return m


ENGINES = ["chromium", "firefox", "webkit"]


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("width", [390, 565])
def test_without_room_beside_it_the_infobox_sits_above_at_its_own_width(served, engine, width):
    m = _measure(served, engine, width)
    assert m["float"] == "none", m
    assert m["right"] <= m["frame"] and m["left"] >= 0, m  # never past an edge
    assert m["scroll"] <= m["client"] + 1, m  # nothing left to scroll to, nothing clipped
    assert m["width"] <= 22 * m["em"] + 2, m  # its own width, never the column's
    # centred in the column
    assert abs((m["left"] - m["colLeft"]) - (m["colRight"] - m["right"])) <= 2, m


@pytest.mark.parametrize("engine", ENGINES)
def test_with_room_beside_it_the_infobox_floats_right(served, engine):
    m = _measure(served, engine, 1024)
    assert m["float"] == "right", m
    assert m["colRight"] - m["right"] <= 2, m  # at the column's right edge
    assert m["width"] <= 22 * m["em"] + 2, m
    assert m["scroll"] <= m["client"] + 1, m
