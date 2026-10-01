"""A MediaWiki desktop-skin page uses the whole width of a phone.

Older wikis scraped by mwoffliner (explainxkcd, the OpenStreetMap wiki,
RationalWiki) keep their desktop skin, Vector legacy or MonoBook: the sidebar
itself is gone from the ZIM but the content column keeps the margin it made
room for (site CSS: div#content{margin-left:12em}). On a 390px phone the left
half of the page was empty, the "Go to this explanation" link (absolutely
placed at the right) sat on the "Latest comic" heading, and the comic's box
ran off the right edge (Eric's iPhone, 2026-10-01).

The page here is explainxkcd's main page cut down: its markup, its skin
classes and the stylesheet rules that make the layout. Served through the
real handler at a phone's width, and at a desktop's, where nothing changes.

Run: pytest tests/test_reader_mw_desktop_skin.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

ZIM = "explainwiki_en_all_2026-01"

# The rules of skins.vector.styles.legacy.css, site.styles.css and mwoffliner's
# vector.css that place the content column (the real files, in that order).
SKIN_CSS = """
body{margin:0;background-color:#f6f6f6;overflow-y:scroll;font-family:sans-serif}
.mw-body{margin-left:10em}
.mw-body{background-color:#fff;color:#202122;padding:1em}
.mw-body{margin-top:-1px;border:1px solid #a7d7f9;border-right-width:0}
.mw-body{padding:1.25em 1.5em 1.5em 1.5em}
.vector-body{font-size:0.875rem;line-height:1.6;position:relative;z-index:0}
@media screen and (min-width:982px){.mw-body,.mw-footer{margin-left:11em}}
div#footer,div#content{margin-left:12em}
"""
VECTOR_CSS = ".mw-body{margin-left:auto}"

LI = (
    'style="background-color:#6E7B91;border:1.5px solid #333;border-radius:3px;'
    'display:inline;font-size:16px;font-variant:small-caps;font-weight:600;margin:0 4px;padding:1.5px 0"'
)
NAV = "".join(
    '<li %s><a href="c%d">%s</a></li>' % (LI, i, label)
    for i, label in enumerate(
        ["|&lt;", "&lt; Prev", "Comic #3278 (October 1, 2026)", "Next &gt;", "&gt;|"]
    )
)

PAGE = f"""<!DOCTYPE html>
<html class="client-nojs" lang="en" dir="ltr"><head><meta charset="UTF-8"><title>Main Page</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="skin.css" rel="stylesheet"><link href="vector.css" rel="stylesheet"></head>
<body class="skin-vector-legacy mediawiki ltr sitedir-ltr ns-0 page-Main_Page skin-vector action-view">
<div id="content" class="mw-body" role="main"><a id="top"></a>
<h1 id="firstHeading" class="firstHeading">Main Page</h1>
<div id="bodyContent" class="vector-body"><div id="mw-content-text" class="mw-body-content">
<div class="mw-parser-output">
<center><p><font size="5px"><i>Welcome to the <b>explain xkcd</b> wiki!</i></font><br>
<span>We have an explanation for all 3287 xkcd comics. Help us finish them!</span></p></center>
<p><span id="goto" style="position: absolute; right:0; padding-top:1.4em; font-size: 100%;"><a href="c3">&nbsp;</a><a href="c3"><b>Go to this explanation</b></a></span></p>
<h1><span class="mw-headline" id="Latest_comic">Latest comic</span></h1>
<div style="border:1px solid grey; background:#f6f6f6; padding:1.5em;">
<table class="comic-content" cellspacing="5" style="background-color:#fff;border:1px solid #a2a9b1;font-size:88%;line-height:1.5em;margin:0.5em 0 0.5em 1em;padding:0.2em;text-align:center;width:98%;"><tbody>
<tr><td style="font-size:21px;font-variant:small-caps;font-weight:800">Vera Rubin Observatory</td></tr>
<tr><td><ul style="text-align:center;margin-bottom:10px">{NAV}</ul></td></tr>
<tr><td><img id="comic" src="comic.svg" width="740" height="240" alt="The comic"></td></tr>
<tr><td><ul style="text-align:center;margin-top:-7px;margin-bottom:15px">{NAV}</ul></td></tr>
</tbody></table></div>
<h2><span class="mw-headline" id="Explanation">Explanation</span></h2>
<p>This shows a bingo card of various items discovered or potentially discoverable using the Vera Rubin Observatory.</p>
<hr><span style="position: absolute; left:0; padding-top:1.35em; font-size: 105%;"><a href="c3#Discussion">add a comment!</a></span>
<h2><span class="mw-headline" id="New_here">New here?</span></h2>
<p>You can read a brief introduction about this wiki at explain xkcd.</p>
</div></div></div></div>
<div class="zim-footer">This article is issued from Explain xkcd.</div>
</body></html>"""

COMIC = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="740" height="240">'
    '<rect width="740" height="240" fill="#ddd"/></svg>'
)


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
        cr.set_mainpath("Main_Page")
        cr.add_item(_MediaItem("Main_Page", "text/html", PAGE.encode()))
        cr.add_item(_MediaItem("skin.css", "text/css", SKIN_CSS.encode()))
        cr.add_item(_MediaItem("vector.css", "text/css", VECTOR_CSS.encode()))
        cr.add_item(_MediaItem("comic.svg", "image/svg+xml", COMIC.encode()))
        for key, value in {
            "Name": "explainwiki_en_all",
            "Title": "Explain wiki",
            "Language": "eng",
            "Description": "a desktop-skin wiki",
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


# Where things are in the frame: the content column's left edge, every element
# cut off at the right edge (past the frame and not inside a box of its own
# that scrolls), and the heading against the link placed beside it.
MEASURE = """() => {
  var d = document.getElementById('reader-frame').contentDocument, w = d.defaultView;
  var W = w.innerWidth, clipped = [];
  var scrolls = function (el) {
    for (var p = el.parentElement; p && p !== d.body; p = p.parentElement) {
      var ox = w.getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.getBoundingClientRect().right <= W + 1) return true;
    }
    return false;
  };
  d.body.querySelectorAll('*').forEach(function (el) {
    if (el.id === 'zimi-top') return;
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > W + 1 && !scrolls(el)) clipped.push((el.id || el.tagName) + ':' + Math.round(r.right));
  });
  var h = d.getElementById('Latest_comic').parentElement.getBoundingClientRect();
  var g = d.getElementById('goto').getBoundingClientRect();
  var overlap = !(g.bottom <= h.top || g.top >= h.bottom || g.right <= h.left || g.left >= h.right);
  return { width: W, contentLeft: d.getElementById('content').getBoundingClientRect().left,
    marginLeft: w.getComputedStyle(d.getElementById('content')).marginLeft,
    scrollWidth: d.documentElement.scrollWidth, clipped: clipped.slice(0, 12), overlap: overlap,
    comic: d.getElementById('comic').getBoundingClientRect().width };
}"""


def _measure(served, device=None, viewport=None):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = (
            br.new_context(**pw.devices[device])
            if device
            else br.new_context(viewport=viewport)
        )
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(served + "/")
        pg.wait_for_function(
            "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
            timeout=30000,
        )
        pg.evaluate("([z, p]) => openArticle(z, p)", ["explainwiki", "Main_Page"])
        pg.wait_for_function(
            "() => { var f = document.getElementById('reader-frame'); var d = f && f.contentDocument;"
            " var i = d && d.getElementById('comic'); return !!(i && i.complete && d.getElementById('zimi-top')); }",
            timeout=20000,
        )
        pg.wait_for_timeout(200)
        out = pg.evaluate(MEASURE)
        br.close()
    assert not errors, errors
    return out


def test_a_desktop_skin_page_uses_the_whole_phone_width(served):
    m = _measure(served, device="iPhone 13")
    assert m["width"] <= 400, m
    # The column starts at the left edge, not past an empty sidebar.
    assert m["contentLeft"] <= 4, m
    # Nothing is cut off at the right edge, and the page does not scroll sideways.
    assert not m["clipped"], m
    assert m["scrollWidth"] <= m["width"], m
    # The link that sat beside the heading on a desktop is not on top of it.
    assert not m["overlap"], m
    # The comic fits inside the frame.
    assert 0 < m["comic"] <= m["width"], m


def test_a_desktop_skin_page_is_unchanged_on_a_desktop(served):
    m = _measure(served, viewport={"width": 1280, "height": 900})
    # 12em of the 16px body font: the skin's own sidebar room, kept.
    assert m["marginLeft"] == "192px", m
