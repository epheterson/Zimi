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


# A phone's notch and home indicator, as the shell would measure them in an
# installed app (Chromium has none, so the shell's measuring box is told).
NOTCH, HOME = 47, 34


def test_the_bars_and_sheets_keep_clear_of_the_notch_and_home_indicator(shell):
    """Eric, 2026-10-01: "The PWA is rendering the bottom pdf controls in
    safe area home". A framed page is told no safe-area insets (env() is 0
    in a frame), so the shell measures them, with the page run to the
    screen's edges while a reader draws its own bars, and hands them in."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(pw, base, name, "iPhone 13")
        try:
            # The page runs to the edges only while the reader's bars are up.
            assert "viewport-fit=cover" in pg.evaluate(
                "() => document.querySelector('meta[name=viewport]').content"
            )
            pg.add_style_tag(
                content="#zb-insets{padding:%dpx 0 %dpx 0 !important}" % (NOTCH, HOME)
            )
            pg.evaluate("() => window.dispatchEvent(new Event('resize'))")
            fr.wait_for_function(
                "() => getComputedStyle(document.documentElement).getPropertyValue('--zp-sab').trim() === '%dpx'"
                % HOME,
                timeout=5000,
            )
            got = fr.evaluate(
                """() => { const vis = s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length);
              const head = document.querySelector('.zp-head'), foot = document.querySelector('.zp-foot');
              return { vh: innerHeight, headPad: parseFloat(getComputedStyle(head).paddingTop),
                headTop: Math.min(...vis('.zp-head button').map(b => b.getBoundingClientRect().top)),
                footBottom: Math.max(...vis('.zp-foot button, .zp-foot input').map(b => b.getBoundingClientRect().bottom)),
                footEdge: foot.getBoundingClientRect().bottom }; }"""
            )
            # The bars still reach the edges (their ground under the notch and
            # the indicator); what you touch stays clear of both.
            assert got["headPad"] == NOTCH and got["headTop"] >= NOTCH, got
            assert abs(got["footEdge"] - got["vh"]) < 1, got
            assert got["footBottom"] <= got["vh"] - HOME, got
            pg.screenshot(path=os.path.join(os.environ.get("ZIMI_SHOTS", "/tmp"), "pdf-safe-area-390.png"))
            # A sheet's last row clears the indicator too.
            fr.click(".zp-toc-btn")
            fr.wait_for_selector(".zp-sheet.zp-open")
            pad = fr.evaluate(
                "() => parseFloat(getComputedStyle(document.querySelector('.zp-sheet')).paddingBottom)"
            )
            assert pad >= HOME + 16, pad
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


@pytest.mark.parametrize(
    "device", ["iPhone 13", {"viewport": {"width": 1280, "height": 800}}]
)
def test_a_page_back_and_on(shell, device):
    """Either side of "n of N": a page back and a page on, not there at the
    ends; on a wide screen the arrows and Page Up / Page Down turn too."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(pw, base, name, device)
        try:
            _single(fr)
            assert fr.evaluate("() => document.querySelector('.zp-prev').disabled")
            assert not fr.evaluate("() => document.querySelector('.zp-next').disabled")
            # Beside the page: before it and after it, in the reading direction.
            pos = fr.evaluate(
                """() => ['.zp-prev', '.zp-page', '.zp-next'].map(s => document.querySelector(s).getBoundingClientRect())
                .map(r => ({ l: r.left, r: r.right, t: r.top }))"""
            )
            assert (
                pos[0]["r"] <= pos[1]["l"] + 1 and pos[1]["r"] <= pos[2]["l"] + 1
            ), pos
            assert abs(pos[0]["t"] - pos[2]["t"]) < 2, pos
            fr.click(".zp-next")
            fr.wait_for_function("() => zimiPdf.page() === 2", timeout=5000)
            fr.click(".zp-next")
            fr.wait_for_function("() => zimiPdf.page() === 3", timeout=5000)
            fr.click(".zp-prev")
            fr.wait_for_function("() => zimiPdf.page() === 2", timeout=5000)
            assert (
                fr.evaluate("() => document.querySelector('.zp-page').textContent")
                == "2 of %d" % PAGES
            )
            fr.evaluate("() => zimiPdf.goPage(%d)" % PAGES)
            fr.wait_for_function("() => zimiPdf.page() === %d" % PAGES, timeout=5000)
            fr.wait_for_function(
                "() => document.querySelector('.zp-next').disabled", timeout=5000
            )
            assert not fr.evaluate("() => document.querySelector('.zp-prev').disabled")
            if not isinstance(device, str):
                fr.click("#viewerContainer", position={"x": 600, "y": 300})
                fr.evaluate("() => zimiPdf.goPage(5)")
                fr.wait_for_function("() => zimiPdf.page() === 5", timeout=5000)
                for key, want in (
                    ("ArrowRight", 6),
                    ("PageDown", 7),
                    ("ArrowLeft", 6),
                    ("PageUp", 5),
                ):
                    pg.keyboard.press(key)
                    fr.wait_for_function(
                        "() => zimiPdf.page() === %d" % want, timeout=5000
                    )
        finally:
            ctx.browser.close()


def test_two_pages_side_by_side_on_a_wide_screen(shell):
    """A wide window and pages taller than wide: two at a time, stepping by
    the spread; the menu chooses one or two, and the choice is kept."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(
            pw, base, name, {"viewport": {"width": 1280, "height": 800}}
        )
        try:
            fr.wait_for_function(
                "() => PDFViewerApplication.pdfViewer.spreadMode === 1"
            )
            # Pages 1 and 2 side by side, nothing running off the side.
            got = fr.evaluate(
                """() => { const r = n => document.querySelector('.page[data-page-number="' + n + '"]').getBoundingClientRect();
                const c = document.getElementById('viewerContainer');
                return { a: r(1), b: r(2), c: r(3), sw: c.scrollWidth, cw: c.clientWidth }; }"""
            )
            assert abs(got["a"]["top"] - got["b"]["top"]) < 1, got
            assert got["b"]["left"] > got["a"]["right"], got
            assert got["c"]["top"] > got["a"]["bottom"], got
            assert got["sw"] <= got["cw"], got
            # A step is a spread; the count and the slider say the page.
            fr.click(".zp-next")
            fr.wait_for_function("() => zimiPdf.page() === 3", timeout=5000)
            assert (
                fr.evaluate("() => document.querySelector('.zp-page').textContent")
                == "3 of %d" % PAGES
            )
            assert fr.evaluate("() => document.querySelector('.zp-scrub').value") == "3"
            fr.click(".zp-prev")
            fr.wait_for_function("() => zimiPdf.page() === 1", timeout=5000)
            fr.evaluate("() => zimiPdf.goPage(11)")
            fr.wait_for_function("() => zimiPdf.page() === 11", timeout=5000)
            fr.wait_for_function("() => document.querySelector('.zp-next').disabled")
            # One page, chosen in the menu, and kept for the next document.
            fr.click(".zp-more")
            fr.click('.zp-menu [data-zp="one"]')
            fr.wait_for_function(
                "() => PDFViewerApplication.pdfViewer.spreadMode === 0"
            )
            assert (
                fr.evaluate(
                    "() => document.querySelector('.zp-menu [data-zp=\"one\"]').getAttribute('aria-checked')"
                )
                == "true"
            )
            pg.close()
            pg2, fr2, _ = _open(pw, base, name, None, ctx=ctx)
            fr2.wait_for_timeout(500)
            assert fr2.evaluate("() => PDFViewerApplication.pdfViewer.spreadMode") == 0
            fr2.click(".zp-more")
            fr2.click('.zp-menu [data-zp="two"]')
            fr2.wait_for_function(
                "() => PDFViewerApplication.pdfViewer.spreadMode === 1"
            )
        finally:
            ctx.browser.close()
    # A phone: one page, and no such choice.
    with sync_playwright() as pw:
        pg, fr, ctx = _open(pw, base, name, "iPhone 13")
        try:
            assert fr.evaluate("() => PDFViewerApplication.pdfViewer.spreadMode") == 0
            fr.click(".zp-more")
            assert fr.evaluate(
                "() => !document.querySelector('.zp-menu [data-zp=\"two\"]')"
            )
        finally:
            ctx.browser.close()


def test_rotate_turns_the_pages_and_is_kept_for_the_document(shell):
    """A sideways scan: Rotate in the menu turns every page a quarter, the
    menu staying for another; the document opens turned again."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(
            pw, base, name, {"viewport": {"width": 1280, "height": 800}}
        )
        try:
            fr.wait_for_function(
                "() => PDFViewerApplication.pdfViewer.spreadMode === 1"
            )
            size = "() => { const r = document.querySelector('.page[data-page-number=\"1\"]').getBoundingClientRect(); return [r.width, r.height]; }"
            w0, h0 = fr.evaluate(size)
            assert h0 > w0
            fr.click(".zp-more")
            fr.click('.zp-menu [data-zp="rotate"]')
            fr.wait_for_function("() => zimiPdf.rotation() === 90")
            # Wider than tall now: one at a time, and the menu says so.
            fr.wait_for_function(
                "() => PDFViewerApplication.pdfViewer.spreadMode === 0"
            )
            assert fr.evaluate(
                "() => document.querySelector('.zp-menu').classList.contains('zp-open')"
            )
            assert (
                fr.evaluate(
                    "() => document.querySelector('.zp-menu [data-zp=\"one\"]').getAttribute('aria-checked')"
                )
                == "true"
            )
            fr.wait_for_function(
                "() => { const r = document.querySelector('.page[data-page-number=\"1\"]').getBoundingClientRect(); return r.width > r.height; }"
            )
            fr.click('.zp-menu [data-zp="rotate"]')
            fr.wait_for_function("() => zimiPdf.rotation() === 180")
            pg.close()
            pg2, fr2, _ = _open(pw, base, name, None, ctx=ctx)
            fr2.wait_for_function("() => zimiPdf.rotation() === 180", timeout=5000)
            fr2.wait_for_function(
                "() => PDFViewerApplication.pdfViewer.spreadMode === 1"
            )
            fr2.evaluate("() => { zimiPdf.turn(); zimiPdf.turn(); }")
            fr2.wait_for_function("() => zimiPdf.rotation() === 0")
        finally:
            ctx.browser.close()


def test_about_this_pdf_says_what_the_file_says(shell):
    """About this PDF: the fixture's own Info fields, what pdf.js knows of the
    file, and where it lives in Zimi; nothing empty shown."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, ctx = _open(pw, base, name, "iPhone 13")
        try:
            fr.click(".zp-more")
            fr.click('.zp-menu [data-zp="about"]')
            fr.wait_for_selector(".zp-sheet.zp-open .zp-about")
            got = fr.evaluate("""() => { const s = document.querySelector('.zp-sheet');
                const rows = {}; s.querySelectorAll('.zp-row-kv').forEach(r => { rows[r.querySelector('.zp-k').textContent] = r.querySelector('.zp-v').textContent; });
                return { head: s.querySelector('.zp-sheet-head b').textContent, title: s.querySelector('.zp-about-id b').textContent,
                  author: s.querySelector('.zp-about-id span').textContent, rows: rows,
                  focus: document.activeElement === s.querySelector('.zp-x') }; }""")
            assert got["head"] == "About this PDF"
            assert got["title"] == "Water Treatment Handbook"
            assert got["author"] == "Ada Waters"
            rows = got["rows"]
            assert rows["Subject"] == "Treating water at home"
            assert rows["Keywords"] == "water, filters, boiling"
            assert rows["Pages"] == str(PAGES)
            assert rows["Page size"] == "8.5 × 11 in (Letter)"
            assert rows["Size"].endswith("KB"), rows
            assert "2024" in rows["Created"] and "Aug" in rows["Created"], rows
            assert "2024" in rows["Modified"] and "Sep" in rows["Modified"], rows
            assert rows["Application"] == "Zimi Test Writer"
            assert rows["PDF producer"] == "pdf_fixture.py"
            assert rows["PDF version"] == "1.4"
            assert rows["Library"] == "Water Treatment Library"
            assert rows["File"] == DOC
            assert all(v.strip() for v in rows.values()), rows
            assert got["focus"]
            # Nothing runs off the side of a phone.
            assert fr.evaluate(
                "() => { const s = document.querySelector('.zp-sheet'); return s.scrollWidth <= s.clientWidth; }"
            )
            pg.keyboard.press("Escape")
            fr.wait_for_function("() => !document.querySelector('.zp-sheet.zp-open')")
            # Contents still opens as contents after it.
            fr.click(".zp-toc-btn")
            fr.wait_for_selector(".zp-sheet.zp-open .zp-toc")
        finally:
            ctx.browser.close()


SELECT = """(w) => { const sp = [...document.querySelectorAll('.page[data-page-number="' + w.p + '"] .textLayer span')]
  .find(s => s.textContent.includes(w.t)); const n = sp.firstChild, i = n.nodeValue.indexOf(w.t);
  const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.t.length);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r); }"""
# The passage painted on the page: its text, its colour, and the page it is on.
PAINTED = """() => { const out = [];
  for (const c of ['yellow', 'green', 'blue', 'pink']) { const h = CSS.highlights.get('zimi-hl-' + c); if (!h) continue;
    for (const r of h) { const b = r.getBoundingClientRect(); const p = r.startContainer.parentNode.closest('.page');
      out.push({ text: r.toString(), color: c, pg: p && Number(p.dataset.pageNumber), h: b.height,
        inside: !!p && (() => { const q = p.getBoundingClientRect(); return b.left >= q.left - 1 && b.right <= q.right + 1 && b.top >= q.top - 1 && b.bottom <= q.bottom + 1; })() }); } }
  return out; }"""
PASSAGE = "distillation leaves"


def test_a_highlight_on_a_pdf_page_is_zimis_and_kept(shell):
    """Selecting text on a page gives the same bar as an article; the
    highlight is kept in Saved on its page, painted there through a zoom, a
    turn and two pages side by side, after the document is opened again, and
    opened from the Saved panel on a page far from it."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    ref = "{zim: %r, path: %r}" % (name, DOC)
    with sync_playwright() as pw:
        pg, fr, ctx = _open(
            pw, base, name, {"viewport": {"width": 1280, "height": 800}}
        )
        try:
            fr.evaluate("() => zimiPdf.goPage(3)")
            fr.wait_for_selector('.page[data-page-number="3"] .textLayer span')
            fr.evaluate(SELECT, {"p": 3, "t": PASSAGE})
            # The shell's bar: Highlight, Note, Copy.
            pg.wait_for_selector("#hl-bar.open [data-a=add]", timeout=5000)
            pg.click("#hl-bar [data-a=add]")
            pg.wait_for_function("() => Saved.highlights(%s).length === 1" % ref)
            h = pg.evaluate("() => Saved.highlights(%s)[0]" % ref)
            assert h["exact"] == PASSAGE and h["pg"] == 3 and h["color"] == "yellow", h
            assert pg.evaluate(
                "() => Saved.has(%s)" % ref
            ), "a highlighted page is saved"
            fr.wait_for_function("() => (%s)().length === 1" % PAINTED)
            got = fr.evaluate(PAINTED)[0]
            assert got["text"] == PASSAGE and got["pg"] == 3 and got["inside"], got
            # Green, from the bar shown on it now.
            pg.click('#hl-bar [data-c="green"]')
            fr.wait_for_function("() => (%s)()[0].color === 'green'" % PAINTED)
            # A zoom, a turn and one page at a time: still on its page, its words.
            for step in (
                "() => document.querySelector('.zp-in').click()",
                "() => zimiPdf.turn()",
                "() => zimiPdf.setSpread(false)",
            ):
                fr.evaluate(step)
                fr.evaluate("() => zimiPdf.goPage(3)")
                fr.wait_for_function(
                    """() => { const p = (%s)(); return p.length === 1 && p[0].text === %r && p[0].pg === 3 && p[0].inside && p[0].h > 0; }"""
                    % (PAINTED, PASSAGE),
                    timeout=10000,
                )
            fr.evaluate("() => { zimiPdf.turn(); zimiPdf.turn(); zimiPdf.turn(); }")
            pg.close()

            # Opened again: painted when its page is drawn.
            pg2, fr2, _ = _open(pw, base, name, None, ctx=ctx)
            fr2.evaluate("() => zimiPdf.goPage(3)")
            fr2.wait_for_function(
                "() => { const p = (%s)(); return p.length === 1 && p[0].text === %r && p[0].pg === 3; }"
                % (PAINTED, PASSAGE),
                timeout=10000,
            )
            # In Saved, under Highlights; opened from there with the document
            # on its last page, it goes back to page 3 and stands out.
            fr2.evaluate("() => zimiPdf.goPage(%d)" % PAGES)
            fr2.wait_for_function("() => zimiPdf.page() >= %d" % (PAGES - 1))
            pg2.evaluate("() => toggleLibraryPanel('bookmarks')")
            pg2.wait_for_selector('#bm-tree .bm-hl[data-fid="__highlights"]')
            assert (
                pg2.evaluate(
                    "() => document.querySelector('#bm-tree .bm-hl[data-fid=\"__highlights\"] .bm-name').textContent"
                )
                == PASSAGE
            )
            # As on a slow machine: page 3's text let go (pdf.js keeps only
            # the pages near the view), and pdf.js re-scaling just after the
            # jump (its initial view landing late, a resize). Each put back
            # page 12: a stale range scrolled nowhere, and a scroll pdf.js had
            # not yet seen was undone by the re-scale.
            fr2.evaluate("() => PDFViewerApplication.pdfViewer.getPageView(2).reset()")
            pg2.evaluate(
                """() => { const v = document.getElementById('reader-frame').contentWindow.PDFViewerApplication.pdfViewer;
                document.querySelector('#bm-tree .bm-hl[data-fid="__highlights"]').click();
                setTimeout(() => { v.currentScale = v.currentScale * 1.01; }, 0); }"""
            )
            fr2.wait_for_function(
                "() => CSS.highlights.has('zimi-hl-on')", timeout=10000
            )
            assert fr2.evaluate("() => zimiPdf.page()") in (3, 4)
            onscreen = fr2.evaluate(
                "() => { const r = [...CSS.highlights.get('zimi-hl-on')][0].getBoundingClientRect(); return r.height > 0 && r.top > 0 && r.bottom < innerHeight; }"
            )
            assert onscreen
            # A tap on it gives its bar, not the reader's bars going away.
            fr2.evaluate("() => zimiPdf.showBars(true)")
            box = fr2.evaluate(
                "() => { const r = [...CSS.highlights.get('zimi-hl-green')][0].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"
            )
            pg2.mouse.click(box[0], box[1])
            pg2.wait_for_selector("#hl-bar.open [data-a=remove]", timeout=5000)
            assert fr2.evaluate("() => zimiPdf.barsShown()")
        finally:
            ctx.browser.close()


def _single(fr):
    """One page at a time, whatever the width chose."""
    fr.evaluate("() => zimiPdf.setSpread(false)")
    fr.wait_for_function("() => PDFViewerApplication.pdfViewer.spreadMode === 0")


def test_a_page_back_and_on_in_a_right_to_left_zimi(shell):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 1280, "height": 800})
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_ui_lang', 'ar'); } catch (e) {}"
        )
        pg, fr, _ = _open(pw, base, name, None, ctx=ctx)
        try:
            pg.wait_for_function("() => document.documentElement.dir === 'rtl'")
            _single(fr)
            # Back is on the right, on is on the left.
            prev, nxt = fr.evaluate(
                "() => ['.zp-prev', '.zp-next'].map(s => document.querySelector(s).getBoundingClientRect().left)"
            )
            assert prev > nxt
            fr.click("#viewerContainer", position={"x": 600, "y": 300})
            pg.keyboard.press("ArrowLeft")
            fr.wait_for_function("() => zimiPdf.page() === 2", timeout=5000)
            pg.keyboard.press("ArrowRight")
            fr.wait_for_function("() => zimiPdf.page() === 1", timeout=5000)
        finally:
            br.close()



def test_a_jump_is_not_undone_by_a_rescale_in_the_same_moment(shell):
    """A page jumped to (a highlight opened from Saved) stays put when pdf.js
    re-scales before its next frame (the panel closing resizes the frame; on
    a reload its initial view lands late). pdf.js re-scales around the place
    it last saw, so a jump it had not seen yet went back to the old page:
    CI opened a page-3 highlight and stayed on page 12."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    base, name = shell
    with sync_playwright() as pw:
        pg, fr, _ = _open(pw, base, name, {"viewport": {"width": 1280, "height": 800}})
        fr.evaluate("() => zimiPdf.goPage(%d)" % PAGES)
        fr.wait_for_function(
            "() => zimiPdf.page() >= %d && PDFViewerApplication.pdfViewer._location"
            " && PDFViewerApplication.pdfViewer._location.pageNumber > 5" % (PAGES - 1)
        )
        fr.evaluate(
            """() => { zimiPdf.goPage(3);
              const v = PDFViewerApplication.pdfViewer; v.currentScale = v.currentScale * 1.1; }"""
        )
        fr.evaluate(
            "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"
        )
        assert fr.evaluate("() => zimiPdf.page()") in (3, 4)
