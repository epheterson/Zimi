"""The book reader, in a real browser on an emulated iPhone.

Eric, 2026-09-25: "For the book reader it needs to be awesome on mobile:
fixed footer and header that hide while scrolling or on tap, support
turning pages or scrolling ... a full proper experience."

A Gutenberg book opens as an e-reader: Zimi's header held away, the book's
own header and footer, pages turned by a tap at either side or a swipe, the
place kept as a character of the book through bigger type, a turn of the
phone and reopening, and a right-to-left book turning the other way. The
fixture is gutenberg2zim's shape: no doctype, the Dublin Core record in the
head, a title page spaced with empty paragraphs and a jump-up link.

Run: pytest tests/test_book_reader.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import books  # noqa: E402

G2Z = "gutenberg2zim-3.0.1"
CHAPTERS = 6
PARAS = 30  # a chapter runs to several pages on a phone


def _page(title, lang, words, rtl_word=None):
    chapters = "".join(
        '<div class="chapter"><a id="ch%d"></a><h2>%s %d</h2>%s</div>'
        % (
            i,
            rtl_word or "CHAPTER",
            i,
            "".join(
                "<p>%s %d.%d %s</p>" % (words, i, j, " ".join([words] * 12))
                for j in range(PARAS)
            ),
        )
        for i in range(1, CHAPTERS + 1)
    )
    contents = "".join(
        '<p><a class="pginternal" href="#ch%d">%s %d</a></p>'
        % (i, rtl_word or "CHAPTER", i)
        for i in range(1, CHAPTERS + 1)
    )
    return (
        '<html lang="%s"><head><meta content="text/html; charset=utf-8" http-equiv="Content-Type"/>\n'
        '<meta content="%s" name="dc.title"/>\n<meta content="Writer, A., 1800-1870" name="dc.creator"/>\n'
        '<link href="http://www.gutenberg.org/ebooks/1" rel="dcterms.isFormatOf"/>\n'
        "<title>%s</title></head><body><div>"
        '<span class="zim_up" style="position: fixed; bottom: 1em; left: 1em;"><a href="#">up</a></span></div>'
        "<h1>%s</h1><p><br/></p><p><br/> <br/></p><h2>By A. Writer</h2><hr/>"
        "<p><b>CONTENTS</b></p>%s%s</body></html>"
        % (lang, title, title, title, contents, chapters)
    ).encode()


def _js(var, rows):
    import json

    return ("var %s = %s;" % (var, json.dumps(rows))).encode()


FILES = {
    "full_by_popularity.js": _js(
        "json_data",
        [
            ["Liber", "A. Writer", "110", 1, "PA"],
            ["Sefer", "A. Writer", "110", 2, "PJ"],
        ],
    ),
    "languages.js": _js(
        "languages_json_data", [["English", "en", 1], ["עברית", "he", 1]]
    ),
    "lang_en_by_title.js": _js("json_data", [["Liber", "", "110", 1, "PA"]]),
    "lang_he_by_title.js": _js("json_data", [["Sefer", "", "110", 2, "PJ"]]),
    "Liber.1": _page("Liber", "en", "reading"),
    "Sefer.2": _page("Sefer", "he", "קריאה", rtl_word="פרק"),
}

# Where the character c of the book is on screen (the reader keeps c).
CHAR = r"""(c) => { var f = document.getElementById('reader-frame'), d = f.contentDocument, w = f.contentWindow;
  var secs = d.querySelectorAll('.zb-sec'), acc = 0;
  for (var i = 0; i < secs.length; i++) { var tw = d.createTreeWalker(secs[i], NodeFilter.SHOW_TEXT), t;
    while ((t = tw.nextNode())) { var n = t.nodeValue.length;
      if (acc + n > c) { var r = d.createRange(); r.setStart(t, c - acc); r.setEnd(t, Math.min(n, c - acc + 1));
        var rc = r.getClientRects()[0];
        return !!rc && rc.left >= 0 && rc.left < w.innerWidth && rc.top >= 0 && rc.top < w.innerHeight; }
      acc += n; } }
  return false; }"""
STATE = r"""() => { var f = document.getElementById('reader-frame'), d = f.contentDocument, w = f.contentWindow, h = d.documentElement;
  var art = d.querySelector('.zimi-reader-body');
  var secs = Array.prototype.slice.call(d.querySelectorAll('.zb-sec'));
  var places = JSON.parse(localStorage.getItem('zimi_book_places') || '{}'), key = Object.keys(places)[0];
  return { paged: h.classList.contains('zb-paged'), away: h.classList.contains('zb-away'),
    sec: secs.findIndex(function(s) { return s.classList.contains('zb-cur'); }),
    page: Math.round(Math.abs(parseFloat((art.style.transform || '').replace(/[^-0-9.]/g, '')) || 0) / w.innerWidth),
    held: document.body.classList.contains('chrome-held'), frameTop: f.getBoundingClientRect().top,
    jumpTop: !!d.getElementById('zimi-top') || !!d.querySelector('.zim_up'),
    blankFront: Array.prototype.filter.call(d.querySelectorAll('.zb-front p'), function(p) { return !p.textContent.trim(); }).length,
    foot: d.querySelector('.zb-left').textContent, c: key ? places[key].c : null }; }"""


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
    # Served as gutenberg2zim serves them: the pages as HTML, the listings as
    # scripts (the shared fixture's plain entries are bytes a browser downloads).
    path = str(zdir / "gutenberg_mul_all_2026-01.zim")
    with Creator(path).config_indexing(False, "eng") as cr:
        cr.set_mainpath("Liber.1")
        for fpath, blob in FILES.items():
            mime = "application/javascript" if fpath.endswith(".js") else "text/html"
            cr.add_item(_MediaItem(fpath, mime, blob))
        for key, value in {
            "Scraper": G2Z,
            "Name": "gutenberg_mul_all",
            "Title": "Library",
            "Language": "eng",
            "Description": "books",
            "Date": "2026-01-04",
        }.items():
            cr.add_metadata(key, value)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    monkeypatch.setattr(books, "request_details", lambda name: None)
    books._reset_for_tests()
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _open(pg, base, path):
    """Open a book as Bookshelf's Read does."""
    if not pg.url.startswith(base):
        pg.goto(base + "/")
        pg.wait_for_function(
            "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
            timeout=30000,
        )
    pg.evaluate("(p) => openArticle('gutenberg_mul', p)", path)
    pg.wait_for_function(
        "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.querySelector('.zb-foot'); }",
        timeout=30000,
    )
    pg.wait_for_timeout(500)


def _swipe(pg, x0, x1, y=420):
    cdp = pg.context.new_cdp_session(pg)
    cdp.send(
        "Input.dispatchTouchEvent",
        {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}]},
    )
    for i in range(1, 9):
        cdp.send(
            "Input.dispatchTouchEvent",
            {
                "type": "touchMove",
                "touchPoints": [{"x": x0 + (x1 - x0) * i / 8, "y": y}],
            },
        )
        pg.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    pg.wait_for_timeout(600)


def _tap(pg, x, y=420):
    pg.touchscreen.tap(x, y)
    pg.wait_for_timeout(500)


def test_a_book_reads_like_an_e_reader_on_a_phone(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        pg = ctx.new_page()
        frame = pg.frame_locator("#reader-frame")
        st = lambda: pg.evaluate(STATE)  # noqa: E731
        try:
            _open(pg, served, "Liber.1")
            s = st()
            # Pages where fingers are; Zimi's header away, the book's own chrome in its place.
            assert s["paged"] and s["held"] and s["frameTop"] == 0 and not s["away"]
            assert not s["jumpTop"], "no jump-to-top button in a book"
            assert s["blankFront"] == 0, "the title page keeps no empty paragraphs"
            # Contents: a chapter opens at its first page.
            frame.locator(".zb-toc").click()
            pg.wait_for_timeout(300)
            frame.locator('.zb-toc-list button[data-k="2"]').click()
            pg.wait_for_timeout(500)
            s = st()
            assert s["sec"] == 3 and s["page"] == 0 and s["away"]
            # A tap in the middle brings the bars, again sends them away.
            _tap(pg, 195)
            assert not st()["away"]
            _tap(pg, 195)
            assert st()["away"]
            # Turning: the right edge on, a swipe left on, a swipe right back, the left edge back.
            _tap(pg, 365)
            assert st()["page"] == 1
            _swipe(pg, 320, 80)
            assert st()["page"] == 2
            _swipe(pg, 80, 320)
            assert st()["page"] == 1
            _tap(pg, 25)
            assert st()["page"] == 0
            _tap(pg, 365)
            _tap(pg, 365)
            pg.wait_for_timeout(800)
            c = st()["c"]
            assert c and pg.evaluate(CHAR, c)
            assert "left in chapter" in st()["foot"]
            # Bigger type, then the phone turned and back: the same passage on screen.
            _tap(pg, 195)
            frame.locator(".zb-aa").click()
            pg.wait_for_timeout(300)
            frame.locator('[data-size="1"]').click()
            frame.locator('[data-size="1"]').click()
            frame.locator(".zb-set-sheet .zb-x").click()
            pg.wait_for_timeout(500)
            assert pg.evaluate(CHAR, c)
            pg.set_viewport_size({"width": 844, "height": 390})
            pg.wait_for_timeout(700)
            assert pg.evaluate(CHAR, c)
            pg.set_viewport_size({"width": 390, "height": 844})
            pg.wait_for_timeout(1000)
            assert pg.evaluate(CHAR, c) and st()["c"] == c
            # Reopened, it opens there.
            pg.evaluate("() => goHome(null)")
            pg.wait_for_timeout(400)
            assert not pg.evaluate(
                "() => document.body.classList.contains('chrome-held')"
            )
            _open(pg, served, "Liber.1")
            assert pg.evaluate(CHAR, c)
            # Scrolling instead: the passage near the top, the bars away on the way down.
            # Reopened, the bars are up: Aa is right there.
            frame.locator(".zb-aa").click()
            pg.wait_for_timeout(300)
            frame.locator('[data-mode="scroll"]').click()
            frame.locator(".zb-set-sheet .zb-x").click()
            pg.wait_for_timeout(400)
            assert not st()["paged"] and pg.evaluate(CHAR, c)
            pg.evaluate(
                "() => document.getElementById('reader-frame').contentWindow.scrollBy(0, 400)"
            )
            pg.wait_for_timeout(400)
            assert st()["away"]
            pg.evaluate(
                "() => document.getElementById('reader-frame').contentWindow.scrollBy(0, -150)"
            )
            pg.wait_for_timeout(400)
            assert not st()["away"]
            # A right-to-left book turns the other way.
            pg.evaluate(
                "() => localStorage.setItem('zimi_book_prefs', JSON.stringify({mode: 'pages'}))"
            )
            _open(pg, served, "Sefer.2")
            frame.locator(".zb-toc").click()
            pg.wait_for_timeout(300)
            frame.locator('.zb-toc-list button[data-k="0"]').click()
            pg.wait_for_timeout(500)
            _tap(pg, 25)
            assert st()["page"] == 1
            _swipe(pg, 80, 320)
            assert st()["page"] == 2
            _tap(pg, 365)
            assert st()["page"] == 1
        finally:
            br.close()
