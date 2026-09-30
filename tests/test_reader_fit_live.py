"""A page with no viewport meta, shown early, fits its picture once it loads.

Reader View on (sticky or Auto) shows a page at DOMContentLoaded, before its
pictures load. A page laid out for a desktop (no viewport meta, xkcd's comic
in a 780px table) is scaled to the frame by its widest picture; measured that
early, a picture with no width attributes has no size yet, so the comic was
left clipped. The fit runs again at the frame's load; the early reveal stays.

Served through the real handler from a ZIM written here, at a phone's 390px,
the comic's bytes held back so it loads well after the page is shown.

Run: pytest tests/test_reader_fit_live.py -v
"""

import os
import struct
import sys
import threading
import time
import zlib

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

ZIM = "comics_en_2026-01"
COMIC_W, COMIC_H = 740, 240
TABLE_W = 780
HOLD_S = 1.5  # the comic's bytes arrive this long after they are asked for

# xkcd's shape: no viewport meta, the comic in a fixed-width centred table,
# the <img> with no width or height. Too little text for Reader View to take.
PAGE = f"""<!doctype html><html><head><meta charset="utf-8"><title>Comic</title></head>
<body><table width="{TABLE_W}" align="center"><tr><td>
<h1>A comic</h1><img id="comic" src="comic.png" alt="A comic">
<p>Next, previous, random.</p></td></tr></table></body></html>"""


def _png(w, h):
    """A plain grey PNG, w by h."""

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    rows = b"".join(b"\x00" + b"\x80" * w for _ in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
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
        cr.set_mainpath("A/comic")
        cr.add_item(_MediaItem("A/comic", "text/html", PAGE.encode()))
        cr.add_item(_MediaItem("A/comic.png", "image/png", _png(COMIC_W, COMIC_H)))
        for key, value in {
            "Name": "comics_en",
            "Title": "Comics",
            "Language": "eng",
            "Description": "comics",
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


# Watches, in the shell, for the page shown while the comic is still on its
# way: the early reveal, which the fix must keep.
WATCH = """() => {
  window.__shownEarly = false;
  var tick = function () {
    var f = document.getElementById('reader-frame'), d = null;
    try { d = f && f.contentDocument; } catch (e) {}
    var img = d && d.getElementById('comic');
    if (img && f.style.visibility === 'visible' && !img.complete) { window.__shownEarly = true; return; }
    setTimeout(tick, 5);
  };
  tick();
}"""

FIT = """() => {
  var d = document.getElementById('reader-frame').contentDocument, w = d.defaultView;
  var img = d.getElementById('comic');
  return { complete: img.complete, natural: img.naturalWidth, zoom: parseFloat(d.documentElement.style.zoom || '1'),
    frame: w.innerWidth };
}"""


@pytest.mark.parametrize("mode", ["auto", "sticky"])
def test_a_page_shown_early_fits_its_picture_once_it_loads(served, mode):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        if mode == "auto":
            ctx.add_init_script("try{localStorage.setItem('zimi_reader_auto', '1')}catch(e){}")
        errors = []

        def hold(route):
            time.sleep(HOLD_S)
            route.continue_()

        ctx.route("**/comic.png*", hold)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(served + "/")
        pg.wait_for_function(
            "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
            timeout=30000,
        )
        if mode == "sticky":
            # Reader View kept on from the page before: the flag the reader reads.
            pg.evaluate("() => { _readerViewOn = true; }")
        pg.evaluate(WATCH)
        pg.evaluate("([z, p]) => openArticle(z, p)", ["comics", "A/comic"])
        pg.wait_for_function(
            "() => { var d = document.getElementById('reader-frame').contentDocument; var i = d && d.getElementById('comic'); return !!(i && i.complete && i.naturalWidth); }",
            timeout=20000,
        )
        pg.wait_for_timeout(300)
        fit = pg.evaluate(FIT)
        shown_early = pg.evaluate("() => window.__shownEarly")
        br.close()
    assert shown_early, "the page is shown before its picture loads"
    assert fit["natural"] == COMIC_W, fit
    # Scaled so the comic (in its 780px table, past the frame's right edge)
    # fits the frame whole.
    assert 0.25 <= fit["zoom"] and fit["zoom"] * COMIC_W <= fit["frame"], fit
    assert not errors, errors
