"""Highlights (1.12) in a real browser: one engine for every reader.

- An article on a phone (390px, touch): text selected, the bar's Highlight
  tapped, the page reloaded, the same words painted again (the second of
  three repeats, not the first); a note; the Saved panel shows it under its
  page and under Highlights, and opens it at its place.
- A book turning pages: highlighted on a page, still painted after bigger
  type and a page turned, found again when the book is reopened, and opened
  from the panel the book turns to it.
- An EPUB's chapters (when this build reads EPUBs): highlighted, reopened.
- Desktop: a mouse selection, Reader View toggled (the text swapped under
  it), its color changed and the highlight removed.
- A newer build of the ZIM: a passage moved, re-spaced and re-cased is found;
  one whose words are gone is kept and listed as not found in this version.
- Right to left: a highlight in an Arabic page.
- Nothing on the primary path: an article without highlights never fetches
  the engine; a selection does.
- The anchor survives the DOM changing under it (text nodes split, words
  wrapped, whitespace changed) and the <mark> fallback paints the same.

Run: pytest tests/test_highlights_live.py -v
"""

import io
import re
import json
import os
import sys
import threading
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

ENGINE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "highlights.js",
)


def _saved_store():
    """app.js's Saved, on its own: what the engine reads its colours and its
    longest quote from when it runs outside the shell."""
    with open(os.path.join(os.path.dirname(ENGINE), "app.js"), encoding="utf-8") as f:
        return re.search(
            r"var Saved = \(function \(\) \{[\s\S]*?\n\}\)\(\);", f.read()
        ).group(0)


PHRASE = "the old lighthouse"
FILLER = [
    "Keepers trimmed the wick at dusk and wound the clockwork that turned the lens %d.",
    "Ships counted the flashes, %d of them, to know which headland lay ahead.",
    "The tower was whitewashed each spring, and the gallery rail was painted %d times.",
]


def _article(newer=False):
    """A mwoffliner-shaped article. The newer build adds text before the
    passages, re-spaces and re-cases one and drops another."""
    fill = "".join(
        "<p>%s</p>" % (FILLER[i % 3] % i) for i in range(40 if not newer else 46)
    )
    storm = (
        "When the storm came in 1881 the old lighthouse lost its lamp, and the keeper wrote it down."
        if not newer
        else "When the Storm came in\n   1881 THE OLD\n LIGHTHOUSE lost its lamp, and the keeper wrote it down."
    )
    oil = (
        "<p>Lamp oil was carried up two hundred steps every evening.</p>"
        if not newer
        else ""
    )
    extra = (
        "<p>Etymology: from the Greek pharos, the island of the first great light.</p>"
        "<p>The old lighthouse was painted white in 1920.</p>"
        if newer
        else ""
    )
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>Lighthouse</title></head><body>"
        '<h1 id="firstHeading">Lighthouse</h1>'
        '<div id="mw-content-text"><div class="mw-parser-output">'
        + extra
        + "<p>A lighthouse is a tower that guides ships. The old lighthouse stood on the northern cape for two centuries.</p>"
        "<p>Sailors in the fog trusted the old lighthouse to take them past the reef.</p>"
        "<p>"
        + storm
        + "</p>"
        + oil
        + '<h2 id="History">History</h2>'
        + fill
        + "</div></div></body></html>"
    ).encode()


ARABIC = (
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>منارة</title></head><body>'
    '<h1 id="firstHeading">منارة</h1><div id="mw-content-text"><div class="mw-parser-output">'
    "<p>كانت المنارة القديمة على الرأس الشمالي مدة قرنين.</p>"
    "<p>ثم هدمت العاصفة المنارة القديمة في الشتاء، وكتب الحارس ذلك في دفتره.</p>"
    "<p>وبنى الناس المنارة القديمة من جديد بالحجر الأبيض.</p>"
    + "".join("<p>كان الحارس يشعل المصباح كل مساء رقم %d.</p>" % i for i in range(30))
    + "</div></div></body></html>"
).encode()


def _epub():
    """The smallest EPUB with two chapters."""
    buf = io.BytesIO()
    para = "".join(
        "<p>The tale goes on, line %d, past the harbour and the mill.</p>" % i
        for i in range(25)
    )
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        z.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">tale-1</dc:identifier>'
            "<dc:title>A Harbour Tale</dc:title><dc:creator>A. Teller</dc:creator><dc:language>en</dc:language></metadata>"
            '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>'
            '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
        )
        for i, head in ((1, "The Harbour"), (2, "The Mill")):
            z.writestr(
                "OEBPS/c%d.xhtml" % i,
                '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>%s</title></head>'
                "<body><h2>%s</h2><p>In chapter %d the lantern swung above the quay.</p>%s</body></html>"
                % (head, head, i, para),
            )
    return buf.getvalue()


def _build(path, entries, meta):
    from conftest_zim import _MediaItem
    from libzim.writer import Creator, Hint

    class _Page(_MediaItem):
        def get_title(self):
            return self._t

        def get_hints(self):
            return {Hint.FRONT_ARTICLE: True}

    with Creator(path).config_indexing(False, "eng") as cr:
        cr.set_mainpath(next(iter(entries)))
        for p, (mime, blob, title) in entries.items():
            it = _Page(p, mime, blob)
            it._t = title
            cr.add_item(it)
        for k, v in meta.items():
            cr.add_metadata(k, v)


def _wiki(path, newer=False):
    _build(
        path,
        {
            "A/Lighthouse": ("text/html", _article(newer), "Lighthouse"),
            "A/Plain": ("text/html", _article(), "Plain"),
            "A/Manara": ("text/html", ARABIC, "منارة"),
        },
        {
            "Title": "Lights",
            "Language": "eng",
            "Description": "lights",
            "Date": "2026-01-01",
        },
    )


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from test_book_reader import FILES, G2Z

    from zimi import books
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    _wiki(str(zdir / "hlwiki_en_all_2026-01.zim"))
    _build(
        str(zdir / "gutenberg_mul_all_2026-01.zim"),
        {
            p: ("application/javascript" if p.endswith(".js") else "text/html", b, p)
            for p, b in [("Liber.1", FILES["Liber.1"])]
            + [(k, v) for k, v in FILES.items() if k != "Liber.1"]
        },
        {
            "Scraper": G2Z,
            "Name": "gutenberg_mul_all",
            "Title": "Library",
            "Language": "eng",
            "Description": "books",
            "Date": "2026-01-04",
        },
    )
    _build(
        str(zdir / "hlepub_en_all_2026-01.zim"),
        {
            "index.html": (
                "text/html",
                b"<html><body><p>Books</p></body></html>",
                "Books",
            ),
            "books/tale.epub": ("application/epub+zip", _epub(), "A Harbour Tale"),
        },
        {
            "Title": "Tales",
            "Language": "eng",
            "Description": "tales",
            "Date": "2026-01-01",
        },
    )
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(data))
    if hasattr(books, "request_details"):
        monkeypatch.setattr(books, "request_details", lambda name: None)
    if hasattr(books, "_reset_for_tests"):
        books._reset_for_tests()
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield {"base": "http://127.0.0.1:%d" % httpd.server_address[1], "zdir": zdir}
    httpd.shutdown()


# ── in the page ─────────────────────────────────────────────────────────────
READY = "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0"
LOADED = (
    "() => { var f = document.getElementById('reader-frame'), d = f && f.contentDocument;"
    " return !!(d && d.body && d.readyState === 'complete' && document.getElementById('reader-loading').classList.contains('hidden')); }"
)
# Select the n-th place of a phrase (any case) in the reader's text; with
# visible, only a place on screen (a book's current page).
SELECT = r"""([phrase, n, visible]) => {
  var f = document.getElementById('reader-frame'), d = f.contentDocument, w = f.contentWindow;
  var tw = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT), t, seen = 0, low = phrase.toLowerCase();
  while ((t = tw.nextNode())) {
    var v = t.nodeValue.toLowerCase(), i = -1;
    while ((i = v.indexOf(low, i + 1)) >= 0) {
      var r = d.createRange(); r.setStart(t, i); r.setEnd(t, i + phrase.length);
      var rc = r.getClientRects()[0];
      if (visible && !(rc && rc.left >= 0 && rc.right <= w.innerWidth && rc.top >= 0 && rc.bottom <= w.innerHeight)) continue;
      if (seen++ < n) continue;
      var s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
      return r.toString();
    }
  }
  return null; }"""
# What is painted: each registered highlight's passages, and the paragraph
# (its first words) each one is in.
PAINTED = r"""() => {
  var w = document.getElementById('reader-frame').contentWindow, out = {};
  if (!w.CSS || !w.CSS.highlights) return out;
  w.CSS.highlights.forEach(function (hl, name) {
    out[name] = Array.from(hl).map(function (r) {
      var p = r.startContainer.parentNode.closest('p') || r.startContainer.parentNode;
      return [r.toString(), (p.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24), !!r.getClientRects().length];
    });
  });
  return out; }"""
BAR = "() => { var b = document.getElementById('hl-bar'); return b && b.classList.contains('open') ? Array.from(b.querySelectorAll('button[data-a]')).map(function (x) { return x.dataset.a; }) : null; }"


def _home(pg, base):
    pg.goto(base + "/")
    pg.wait_for_function(READY, timeout=30000)


def _open(pg, zim, path, book=False):
    pg.evaluate("([z, p]) => openArticle(z, p)", [zim, path])
    if book:
        pg.wait_for_function(
            "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.querySelector('.zb-foot'); }",
            timeout=30000,
        )
    pg.wait_for_function(LOADED, timeout=30000)
    pg.wait_for_timeout(500)


def _select(pg, phrase, n=0, visible=False):
    got = pg.evaluate(SELECT, [phrase, n, visible])
    assert got, "found %r to select in %r" % (
        phrase,
        pg.evaluate(
            "() => { var d = document.getElementById('reader-frame').contentDocument; var c = d.querySelector('.zb-cur') || d.body; return c.textContent.slice(0, 300); }"
        ),
    )
    pg.wait_for_function(BAR, timeout=5000)
    return got


def _press(pg, action, touch):
    sel = '#hl-bar button[data-a="%s"]' % action
    if touch:
        pg.tap(sel)
    else:
        pg.click(sel)
    pg.wait_for_timeout(250)


def _saved(pg):
    return pg.evaluate("() => Saved.highlights()")


def _phone(pw, br, **kw):
    return br.new_context(**pw.devices["iPhone 13"], **kw)


def test_an_article_on_a_phone(served):
    from playwright.sync_api import sync_playwright

    base = served["base"]
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = _phone(pw, br)
            pg = ctx.new_page()
            _home(pg, base)
            _open(pg, "hlwiki", "A/Lighthouse")
            # The second of three "the old lighthouse": selected, the bar, Highlight.
            _select(pg, PHRASE, 1)
            assert pg.evaluate(BAR)[:3] == ["add", "note", "copy"]
            _press(pg, "add", True)
            # The bar now edits it: four colors, a note, copy, remove.
            assert pg.evaluate(BAR) == ["color"] * 4 + ["note", "copy", "remove"]
            hl = _saved(pg)
            assert (
                len(hl) == 1
                and hl[0]["exact"].lower() == PHRASE
                and hl[0]["color"] == "yellow"
            )
            assert pg.evaluate(
                "() => Saved.has({zim: 'hlwiki', path: 'A/Lighthouse'})"
            ), "the page is saved too"
            painted = pg.evaluate(PAINTED)
            assert painted["zimi-hl-yellow"][0][:2] == [
                "the old lighthouse",
                "Sailors in the fog trust",
            ]
            # A note, from the bar.
            _press(pg, "note", True)
            pg.fill("#hl-note textarea", "The reef was called the Teeth.")
            pg.tap('#hl-note button[data-a="save"]')
            pg.wait_for_timeout(300)
            assert _saved(pg)[0]["note"] == "The reef was called the Teeth."
            assert "zimi-hl-note" in pg.evaluate(PAINTED)
            pg.screenshot(
                path=os.environ.get("HL_SHOTS", str(served["zdir"]))
                + "/hl-article-390.png"
            )
            # Reloaded: painted again at the same words, the same repeat.
            pg.reload()
            pg.wait_for_function(READY, timeout=30000)
            pg.wait_for_function(LOADED, timeout=30000)
            pg.wait_for_function(
                "() => { var w = document.getElementById('reader-frame').contentWindow; return w.CSS.highlights.has('zimi-hl-yellow'); }",
                timeout=10000,
            )
            painted = pg.evaluate(PAINTED)
            assert painted["zimi-hl-yellow"][0][:2] == [
                "the old lighthouse",
                "Sailors in the fog trust",
            ]
            # A tap on it brings its bar.
            box = pg.evaluate(
                "() => { var f = document.getElementById('reader-frame'), w = f.contentWindow, r = Array.from(w.CSS.highlights.get('zimi-hl-yellow'))[0], rc = r.getClientRects()[0], fr = f.getBoundingClientRect();"
                " return [fr.left + rc.left + rc.width / 2, fr.top + rc.top + rc.height / 2]; }"
            )
            pg.touchscreen.tap(box[0], box[1])
            pg.wait_for_function(BAR, timeout=5000)
            assert "remove" in pg.evaluate(BAR)
            # A tap on the text beside it puts the bar away.
            pg.touchscreen.tap(30, box[1] + 150)
            pg.wait_for_timeout(300)
            assert pg.evaluate(BAR) is None
            # The panel: under the saved page, and under Highlights; opening it
            # from the panel on another page scrolls back to it.
            pg.evaluate(
                "() => { var f = document.getElementById('reader-frame'); f.contentWindow.scrollTo(0, 0); }"
            )
            pg.evaluate("() => toggleLibraryPanel('bookmarks')")
            pg.wait_for_timeout(300)
            rows = pg.evaluate(
                "() => Array.from(document.querySelectorAll('#bm-tree .bm-hl')).map(function (r) { return [r.dataset.fid, r.querySelector('.bm-name').textContent]; })"
            )
            assert ["", "the old lighthouse"] in rows and [
                "__highlights",
                "the old lighthouse",
            ] in rows, rows
            pg.screenshot(
                path=os.environ.get("HL_SHOTS", str(served["zdir"]))
                + "/hl-panel-390.png"
            )
            pg.evaluate("() => _closeLibraryPanel()")
            _open(pg, "hlwiki", "A/Plain")
            pg.evaluate("() => toggleLibraryPanel('bookmarks')")
            pg.wait_for_timeout(300)
            pg.tap('#bm-tree .bm-hl[data-fid="__highlights"]')
            pg.wait_for_function(LOADED, timeout=30000)
            pg.wait_for_function(
                "() => { var w = document.getElementById('reader-frame').contentWindow; return w.CSS.highlights.has('zimi-hl-on'); }",
                timeout=10000,
            )
            onscreen = pg.evaluate(
                "() => { var w = document.getElementById('reader-frame').contentWindow, r = Array.from(w.CSS.highlights.get('zimi-hl-on'))[0].getBoundingClientRect(); return r.top >= 0 && r.bottom <= w.innerHeight && r.height > 0; }"
            )
            assert (
                onscreen and pg.evaluate("() => currentArticle.path") == "A/Lighthouse"
            )
        finally:
            br.close()


HL_ON_SCREEN = r"""(name) => { var w = document.getElementById('reader-frame').contentWindow, h = w.CSS.highlights.get(name);
  if (!h) return false;
  var r = Array.from(h)[0], rc = r.getClientRects()[0];
  return !!rc && rc.left >= 0 && rc.right <= w.innerWidth && rc.top >= 0 && rc.bottom <= w.innerHeight; }"""


def _shot(served, name, pg):
    pg.screenshot(
        path=os.path.join(os.environ.get("HL_SHOTS", str(served["zdir"])), name)
    )


def test_a_book_turning_pages(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = _phone(pw, br).new_page()
            frame = pg.frame_locator("#reader-frame")
            _home(pg, served["base"])
            _open(pg, "gutenberg_mul", "Liber.1", book=True)
            assert pg.evaluate(
                "() => document.getElementById('reader-frame').contentDocument.documentElement.classList.contains('zb-paged')"
            )
            frame.locator(".zb-toc").click()
            pg.wait_for_timeout(300)
            frame.locator('.zb-toc-list button[data-k="1"]').click()
            pg.wait_for_timeout(600)
            # Words on this page, highlighted with the native selection's bar.
            _select(pg, "reading 3.1 reading", 0, visible=True)
            _press(pg, "add", True)
            hl = _saved(pg)
            assert len(hl) == 1 and hl[0]["kind"] == "book" and hl[0]["app"] == "books"
            assert pg.evaluate(PAINTED)["zimi-hl-yellow"][0][0] == "reading 3.1 reading"
            assert pg.evaluate(HL_ON_SCREEN, "zimi-hl-yellow")
            _shot(served, "hl-book-pages-390.png", pg)
            # Bigger type lays the book out again: the same words, still painted.
            pg.touchscreen.tap(195, 520)
            pg.wait_for_timeout(300)
            frame.locator(".zb-aa").click()
            pg.wait_for_timeout(300)
            frame.locator('[data-size="4"]').click()  # Larger
            frame.locator(".zb-set-sheet .zb-x").click()
            pg.wait_for_timeout(500)
            assert pg.evaluate(PAINTED)["zimi-hl-yellow"][0][0] == "reading 3.1 reading"
            # Pages on, then the book closed and opened again: found and painted again.
            for _ in range(3):
                pg.touchscreen.tap(375, 420)
                pg.wait_for_timeout(450)
            assert not pg.evaluate(HL_ON_SCREEN, "zimi-hl-yellow")
            pg.evaluate("() => goHome(null)")
            pg.wait_for_timeout(400)
            _open(pg, "gutenberg_mul", "Liber.1", book=True)
            pg.wait_for_function(
                "() => document.getElementById('reader-frame').contentWindow.CSS.highlights.has('zimi-hl-yellow')",
                timeout=10000,
            )
            assert pg.evaluate(PAINTED)["zimi-hl-yellow"][0][0] == "reading 3.1 reading"
            # From the panel, the book turns to its page.
            pg.evaluate("() => toggleLibraryPanel('bookmarks')")
            pg.wait_for_timeout(300)
            pg.tap('#bm-tree .bm-hl[data-fid="__highlights"]')
            pg.wait_for_timeout(900)
            assert pg.evaluate(
                HL_ON_SCREEN, "zimi-hl-yellow"
            ), "the book turned to the highlight's page"
        finally:
            br.close()


def test_an_epub_chapter(served):
    pytest.importorskip("zimi.epub", reason="this build does not read EPUBs")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = _phone(pw, br).new_page()
            _home(pg, served["base"])
            _open(pg, "hlepub", "books/tale.epub/", book=True)
            _select(pg, "the lantern swung above the quay", 0, visible=True)
            _press(pg, "add", True)
            hl = _saved(pg)
            assert (
                len(hl) == 1
                and hl[0]["path"] == "books/tale.epub/"
                and hl[0]["kind"] == "book"
            )
            pg.reload()
            pg.wait_for_function(READY, timeout=30000)
            pg.wait_for_function(
                "() => { var f = document.getElementById('reader-frame'); return f.contentWindow.CSS && f.contentWindow.CSS.highlights.has('zimi-hl-yellow'); }",
                timeout=15000,
            )
            assert (
                pg.evaluate(PAINTED)["zimi-hl-yellow"][0][0]
                == "the lantern swung above the quay"
            )
            _shot(served, "hl-epub-390.png", pg)
        finally:
            br.close()


def test_desktop_mouse_reader_view_color_remove(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = br.new_context(viewport={"width": 1280, "height": 800}).new_page()
            _home(pg, served["base"])
            _open(pg, "hlwiki", "A/Lighthouse")
            # A real drag of the mouse across the words.
            box = pg.evaluate(
                r"""(phrase) => { var f = document.getElementById('reader-frame'), d = f.contentDocument, fr = f.getBoundingClientRect();
                var tw = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT), t;
                while ((t = tw.nextNode())) { var i = t.nodeValue.indexOf(phrase); if (i < 0) continue;
                  var r = d.createRange(); r.setStart(t, i); r.setEnd(t, i + phrase.length); var rc = r.getClientRects()[0];
                  return [fr.left + rc.left + 1, fr.left + rc.right - 1, fr.top + rc.top + rc.height / 2]; } }""",
                "the storm came in 1881",
            )
            pg.mouse.move(box[0], box[2])
            pg.mouse.down()
            pg.mouse.move((box[0] + box[1]) / 2, box[2], steps=5)
            pg.mouse.move(box[1], box[2], steps=5)
            pg.mouse.up()
            pg.wait_for_function(BAR, timeout=5000)
            _shot(served, "hl-desktop-bar.png", pg)
            _press(pg, "add", False)
            assert (
                pg.evaluate(PAINTED)["zimi-hl-yellow"][0][0].strip()
                == "the storm came in 1881"
            )
            # Reader View swaps the text for a copy: found and painted in it.
            pg.evaluate("() => _readerViewToggle()")
            pg.wait_for_timeout(300)
            assert pg.evaluate(
                "() => !!document.getElementById('reader-frame').contentDocument.querySelector('.zimi-reader')"
            )
            p = pg.evaluate(PAINTED)["zimi-hl-yellow"][0]
            assert p[0].strip() == "the storm came in 1881" and p[2], p
            # A click on it: a color, then removed.
            xy = pg.evaluate(
                "() => { var f = document.getElementById('reader-frame'), r = Array.from(f.contentWindow.CSS.highlights.get('zimi-hl-yellow'))[0].getClientRects()[0], fr = f.getBoundingClientRect();"
                " return [fr.left + r.left + r.width / 2, fr.top + r.top + r.height / 2]; }"
            )
            pg.mouse.click(xy[0], xy[1])
            pg.wait_for_function(BAR, timeout=5000)
            pg.click('#hl-bar button[data-c="green"]')
            pg.wait_for_timeout(200)
            assert _saved(pg)[0]["color"] == "green" and "zimi-hl-green" in pg.evaluate(
                PAINTED
            )
            assert pg.evaluate("() => localStorage.getItem('zimi_hl_color')") == "green"
            _press(pg, "remove", False)
            assert _saved(pg) == [] and pg.evaluate(PAINTED) == {}
            # The page stays saved: removing a highlight is not removing the page.
            assert pg.evaluate("() => Saved.has({zim: 'hlwiki', path: 'A/Lighthouse'})")
        finally:
            br.close()


def test_a_newer_build_of_the_zim(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = _phone(pw, br)
            pg = ctx.new_page()
            _home(pg, served["base"])
            _open(pg, "hlwiki", "A/Lighthouse")
            for phrase, n in (
                ("the storm came in 1881 the old lighthouse", 0),
                ("Lamp oil was carried up", 0),
                (PHRASE, 1),
            ):
                _select(pg, phrase, n)
                _press(pg, "add", True)
            assert len(_saved(pg)) == 3
            state = ctx.storage_state()
            ctx.close()
            # The same ZIM, a newer build: text added before, one passage
            # re-spaced and re-cased, one sentence gone.
            srv.release_zim_handles(["hlwiki"])
            os.remove(str(served["zdir"] / "hlwiki_en_all_2026-01.zim"))
            _wiki(str(served["zdir"] / "hlwiki_en_all_2026-02.zim"), newer=True)
            srv._zim_files_cache = None
            srv.load_cache(force=True)
            ctx = _phone(pw, br, storage_state=state)
            pg = ctx.new_page()
            _home(pg, served["base"])
            _open(pg, "hlwiki", "A/Lighthouse")
            pg.wait_for_function(
                "() => document.getElementById('reader-frame').contentWindow.CSS.highlights.has('zimi-hl-yellow')",
                timeout=10000,
            )
            got = sorted(p[1] for p in pg.evaluate(PAINTED)["zimi-hl-yellow"])
            assert got == ["Sailors in the fog trust", "When the Storm came in 1"], got
            assert len(pg.evaluate("() => _hlReader.missing()")) == 1
            assert "not in this version" in pg.evaluate("() => document.body.innerText")
            # Kept, and listed as not found in this version.
            assert len(_saved(pg)) == 3
            pg.evaluate("() => toggleLibraryPanel('bookmarks')")
            pg.wait_for_timeout(300)
            lost = pg.evaluate(
                "() => Array.from(document.querySelectorAll('#bm-tree .bm-hl-lost .bm-sub')).map(function (e) { return e.textContent; })"
            )
            assert lost and all(x == "Not found in this version" for x in lost), lost
            _shot(served, "hl-not-found-390.png", pg)
        finally:
            br.close()


def test_right_to_left(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = _phone(pw, br).new_page()
            _home(pg, served["base"])
            _open(pg, "hlwiki", "A/Manara")
            _select(pg, "المنارة القديمة", 1)
            _press(pg, "add", True)
            pg.reload()
            pg.wait_for_function(READY, timeout=30000)
            pg.wait_for_function(
                "() => document.getElementById('reader-frame').contentWindow.CSS.highlights.has('zimi-hl-yellow')",
                timeout=10000,
            )
            p = pg.evaluate(PAINTED)["zimi-hl-yellow"][0]
            assert p[0] == "المنارة القديمة" and p[1].startswith("ثم هدمت العاصفة"), p
        finally:
            br.close()


def test_nothing_on_the_primary_path(served):
    """An article with no highlights never fetches the engine; selecting
    text in it does, once."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = _phone(pw, br).new_page()
            fetched = []
            pg.on(
                "request",
                lambda r: (
                    fetched.append(r.url) if "/static/highlights.js" in r.url else None
                ),
            )
            _home(pg, served["base"])
            _open(pg, "hlwiki", "A/Plain")
            pg.wait_for_timeout(500)
            assert (
                fetched == []
                and pg.evaluate("() => typeof ZimiHighlightsEngine") == "undefined"
            )
            assert pg.evaluate(
                "() => !!document.getElementById('reader-frame').contentDocument.__zimiHighlights"
            )
            _select(pg, "guides ships")
            assert (
                len(fetched) == 1
                and pg.evaluate("() => typeof ZimiHighlightsEngine") == "object"
            )
        finally:
            br.close()


ANCHOR = r"""() => {
  var E = ZimiHighlightsEngine, d = document, find = function (root, phrase, n) {
    var tw = d.createTreeWalker(root, NodeFilter.SHOW_TEXT), t, seen = 0, low = phrase.toLowerCase();
    while ((t = tw.nextNode())) { var v = t.nodeValue.toLowerCase(), i = -1;
      while ((i = v.indexOf(low, i + 1)) >= 0) if (seen++ === n) { var r = d.createRange(); r.setStart(t, i); r.setEnd(t, i + phrase.length); return r; } }
    return null; };
  var root = d.getElementById('text'), out = {};
  var sel = E._describe(E._textIndex(root), find(root, 'the old lighthouse', 1));
  var again = function () { var ix = E._textIndex(root), at = E._locateIn(ix.text, sel); if (!at) return null; var r = E._rangeFor(ix, at.start, at.end);
    return [r.toString().replace(/\s+/g, ' '), (r.startContainer.parentNode.closest('p') || {}).id]; };
  out.before = again();
  // Every word in a span of its own: every text node replaced.
  Array.prototype.forEach.call(root.querySelectorAll('p'), function (p) {
    p.innerHTML = p.textContent.split(' ').map(function (w) { return '<span>' + w + '</span>'; }).join(' \n  '); });
  out.wrapped = again();
  // Paragraphs added before, the passage's paragraph re-cased.
  root.insertAdjacentHTML('afterbegin', '<p id="n0">The old lighthouse was painted white in 1920.</p>');
  d.getElementById('p2').innerHTML = d.getElementById('p2').innerHTML.replace('old', 'OLD');
  out.moved = again();
  // Without the Custom Highlight API: <mark>s, the same words, and the text as it was once they go.
  var ix = E._textIndex(root), at = E._locateIn(ix.text, sel), p = E._markPainter(d), text = root.textContent;
  p.set([{ id: 'h_1', range: E._rangeFor(ix, at.start, at.end), color: 'pink', note: true }], '');
  var ms = root.querySelectorAll('mark[data-zimi-hl="h_1"]');
  out.marks = [Array.prototype.map.call(ms, function (m) { return m.textContent; }).join(''), ms[0].closest('p').id, ms[0].getAttribute('data-c'), ms[0].classList.contains('zimi-hl-note')];
  out.markedStill = again();
  p.clear();
  out.unmarked = root.textContent === text && !root.querySelector('mark');
  return out; }"""


def test_the_anchor_survives_the_dom_changing():
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = br.new_page()
            pg.set_content(
                '<div id="text"><p id="p1">The old lighthouse stood on the cape.</p>'
                '<p id="p2">Sailors trusted the old lighthouse in the fog.</p>'
                '<p id="p3">The storm took the old lighthouse lamp.</p></div>'
            )
            # The engine's colours and longest quote are the shell's store's.
            pg.add_script_tag(content=_saved_store())
            pg.add_script_tag(path=ENGINE)
            out = pg.evaluate(ANCHOR)
            assert out["before"] == ["the old lighthouse", "p2"]
            assert (
                out["wrapped"][0].replace(" ", "") == "theoldlighthouse"
                and out["wrapped"][1] == "p2"
            ), out
            assert (
                out["moved"][1] == "p2"
                and out["moved"][0].lower().replace(" ", "") == "theoldlighthouse"
            ), out
            marked = re.sub(r"\s+", "", out["marks"][0]).lower()
            assert marked == "theoldlighthouse", out
            assert out["marks"][1:] == ["p2", "pink", True], out
            assert out["markedStill"][1] == "p2" and out["unmarked"], out
        finally:
            br.close()
