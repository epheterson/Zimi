"""Zimi's PDF reader: its own chrome over pdf.js (static/pdfreader.js).

Eric, 2026-10-01: "PDF toolbar at least on mobile is ugly af." pdf.js now
only draws the pages; Zimi draws a top bar (back, the document's name, find,
more) and a bottom bar (contents, a page slider, the page, the fit), both
stepping aside while you read and back on a tap. Where you are is kept in
Saved and the document opens there again.

These drive the real viewer in the real shell, at 390px and at desktop
size, over a twelve-page PDF in a zimgit-style ZIM (tests/pdf_fixture.py).

Run: pytest tests/test_pdf_reader.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import books_sources_fixture as fx  # noqa: E402
import zimi.server as srv  # noqa: E402
from pdf_fixture import multipage_pdf  # noqa: E402
from zimi import http  # noqa: E402

PAGES = 12
DOC = "files/Water (1).pdf"


@pytest.fixture
def shell(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    zdir = tmp_path / "zims"
    zdir.mkdir()
    entries = {
        "home": ("text/html", "<html><body>Water</body></html>", "Home"),
        "database.js": ("text/javascript", fx.WATER_DATABASE, "database.js"),
        DOC: ("application/pdf", multipage_pdf(PAGES), ""),
    }
    fx.build_zim(
        str(zdir / "zimgit-water_en_2024-08.zim"),
        {
            "Scraper": "nautiluszim 1.1.1",
            "Name": "zimgit-water_en",
            "Title": "Water Treatment Library",
        },
        entries,
        "home",
    )
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), http.ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    name = srv.list_zims()[0]["name"]
    yield "http://127.0.0.1:%d" % httpd.server_address[1], name
    httpd.shutdown()
    srv.release_zim_handles(list(srv.get_zim_files()))


def _skip_without_browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")


def _open(pw, base, name, device, ctx=None):
    """The shell, opened on the PDF; returns (page, the viewer's frame)."""
    if ctx is None:
        br = pw.chromium.launch()
        args = dict(pw.devices[device]) if isinstance(device, str) else dict(device)
        ctx = br.new_context(**args)
    pg = ctx.new_page()
    pg.goto(base + "/?a=" + name + "%2F" + DOC.replace("/", "%2F").replace(" ", "%20"))
    frame = None
    for _ in range(200):
        frame = next((f for f in pg.frames if "/static/pdfjs/" in f.url), None)
        if frame:
            try:
                if frame.evaluate("() => !!(window.zimiPdf && zimiPdf.pages() > 0)"):
                    break
            except Exception:
                pass
        pg.wait_for_timeout(100)
    assert frame is not None, "the PDF viewer never opened"
    frame.wait_for_function("() => zimiPdf.pages() === %d" % PAGES, timeout=20000)
    return pg, frame, ctx


BARS = """() => { const r = s => { const e = document.querySelector(s); const b = e.getBoundingClientRect();
  const cs = getComputedStyle(e); return { top: b.top, bottom: b.bottom, h: b.height, shown: cs.visibility !== 'hidden' && cs.opacity !== '0' }; };
  return { head: r('.zp-head'), foot: r('.zp-foot'), vh: innerHeight, vw: innerWidth, sw: document.documentElement.scrollWidth,
    stock: !!(document.querySelector('#toolbarContainer') && document.querySelector('#toolbarContainer').getClientRects().length),
    shown: zimiPdf.barsShown() }; }"""


@pytest.mark.parametrize(
    "device", ["iPhone 13", {"viewport": {"width": 1280, "height": 800}}]
)
def test_the_bars_are_zimis_and_step_aside_while_reading(shell, device):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(pw, base, name, device)
        try:
            got = fr.evaluate(BARS)
            assert got["shown"] and got["head"]["shown"] and got["foot"]["shown"], got
            assert not got["stock"], "pdf.js's own toolbar is put away"
            assert (
                got["head"]["top"] == 0 and abs(got["foot"]["bottom"] - got["vh"]) < 1
            ), got
            # Nothing runs off the side, in the frame or in the shell.
            assert got["sw"] <= got["vw"], got
            assert pg.evaluate(
                "() => document.documentElement.scrollWidth <= innerWidth"
            )
            # Zimi's own header steps aside for the reader's (held, as for a book).
            assert pg.evaluate("() => document.body.classList.contains('chrome-held')")
            # Every control a finger can reach is 44px.
            small = fr.evaluate(
                """() => [...document.querySelectorAll('.zp-bar button')].filter(b => b.getClientRects().length)
              .map(b => b.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length"""
            )
            assert small == 0
            # Reading down by hand: the bars step aside...
            vw = got["vw"]
            pg.mouse.move(vw / 2, 400)
            pg.mouse.wheel(0, 900)
            fr.wait_for_function("() => !zimiPdf.barsShown()", timeout=5000)
            pg.wait_for_timeout(400)
            assert not fr.evaluate(BARS)["head"]["shown"]
            # ...and a tap on the page brings them back.
            pg.mouse.click(vw / 2, 420)
            fr.wait_for_function("() => zimiPdf.barsShown()", timeout=5000)
        finally:
            ctx.browser.close()


def test_the_slider_moves_through_the_pages(shell):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(pw, base, name, "iPhone 13")
        try:
            assert fr.evaluate("() => document.querySelector('.zp-scrub').max") == str(
                PAGES
            )
            assert (
                fr.evaluate("() => document.querySelector('.zp-page').textContent")
                == "1 of %d" % PAGES
            )
            fr.evaluate(
                """() => { const s = document.querySelector('.zp-scrub'); s.value = '9';
                s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); }"""
            )
            fr.wait_for_function("() => zimiPdf.page() === 9", timeout=5000)
            assert fr.evaluate("() => PDFViewerApplication.page") == 9
            assert (
                fr.evaluate("() => document.querySelector('.zp-page').textContent")
                == "9 of %d" % PAGES
            )
            # The page, typed.
            fr.click(".zp-page")
            fr.fill(".zp-page-input", "3")
            fr.press(".zp-page-input", "Enter")
            fr.wait_for_function("() => zimiPdf.page() === 3", timeout=5000)
            # Contents: the outline's chapters, the one you are in marked.
            fr.click(".zp-toc-btn")
            fr.wait_for_selector(".zp-sheet.zp-open .zp-toc")
            assert (
                fr.evaluate("() => document.querySelectorAll('.zp-toc > li').length")
                == PAGES
            )
            assert (
                fr.evaluate(
                    "() => document.querySelector('.zp-toc li[aria-current=\"true\"]').textContent"
                )
                == "Chapter 3"
            )
            fr.click('.zp-toc li[data-i="10"] > button')
            fr.wait_for_function("() => zimiPdf.page() === 11", timeout=5000)
        finally:
            ctx.browser.close()


def test_find_inside_the_pdf(shell):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(
            pw, base, name, {"viewport": {"width": 1280, "height": 800}}
        )
        try:
            # Ctrl+F is Zimi's find, not pdf.js's own bar.
            fr.click("#viewerContainer")
            pg.keyboard.press("Control+f")
            fr.wait_for_function(
                "() => document.documentElement.classList.contains('zp-finding')"
            )
            assert fr.evaluate(
                "() => document.activeElement === document.querySelector('.zp-find input')"
            )
            pg.keyboard.type("aquifer")
            fr.wait_for_function(
                "() => document.querySelector('.zp-count').textContent === '1 of 1'",
                timeout=10000,
            )
            # The match is on page 7, and pdf.js has gone there and marked it.
            assert (
                fr.evaluate(
                    "() => PDFViewerApplication.findController.selected.pageIdx"
                )
                == 6
            )
            fr.wait_for_selector(".textLayer .highlight.selected")
            # A word that is nowhere says so.
            fr.fill(".zp-find input", "zeppelin")
            fr.wait_for_function(
                "() => document.querySelector('.zp-count').textContent === 'No matches'",
                timeout=10000,
            )
            pg.keyboard.press("Escape")
            fr.wait_for_function(
                "() => !document.documentElement.classList.contains('zp-finding')"
            )
        finally:
            ctx.browser.close()


def test_the_place_is_kept_in_saved_and_the_document_opens_there(shell):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(pw, base, name, "iPhone 13")
        try:
            fr.evaluate("() => zimiPdf.goPage(5)")
            pg.wait_for_function(
                "() => { const p = Saved.position({zim: %r, path: %r}); return p && p.where && p.where.p === 5; }"
                % (name, DOC),
                timeout=5000,
            )
            where = pg.evaluate(
                "() => Saved.position({zim: %r, path: %r}).where" % (name, DOC)
            )
            assert where["f"] == round(4 / (PAGES - 1), 3)
            pg.close()
            # Opened again (same browser, so the same Saved): on page 5.
            pg2, fr2, _ = _open(pw, base, name, None, ctx=ctx)
            fr2.wait_for_function("() => zimiPdf.page() === 5", timeout=5000)
            assert fr2.evaluate("() => PDFViewerApplication.page") == 5
        finally:
            ctx.browser.close()


def test_the_viewer_is_one_document_asked_for_each_time():
    """The reader is inlined at the viewer's marks, and the viewer (loaded at
    its bare address) is never cached for a year."""
    with open(os.path.join(http._STATIC_DIR, http.PDF_VIEWER), "rb") as f:
        raw = f.read()
    served = http._inline_apps_assets(raw, http._INLINED_PAGES[http.PDF_VIEWER])
    for mark, name, _, _ in http._PDF_ASSETS:
        assert raw.count(mark) == 1, name
        assert mark not in served, name
    assert b".zp-bar" in served and b"zimiPdf" in served
    # The reader's script runs before pdf.js's module, so it hears webviewerloaded.
    assert served.index(b"zimiPdf") < served.rindex(b"</body>")
    src = open(http.__file__, encoding="utf-8").read()
    branch = src[src.index("elif rel_path == PDF_VIEWER:") :]
    assert 'self.send_header("Cache-Control", "no-cache")' in branch[:200]
    assert '_static_hash("pdfreader.js")' in src
