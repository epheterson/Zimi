"""POST /almanac/pdf: the Almanac's print document as a PDF (zimi/almanacpdf.py, set in type by zimi/almanacbook.py).

The route takes a document the page built, so it is held to what it may do:
no bigger than MAX_PRINT_BYTES, nothing it names is fetched, one render at a
time in a process of its own (killed at its time), the file gone after its
time. No browser: where PyMuPDF is missing it says so (501) and the page
prints the book itself (tests/test_almanac_tables_browser.py).

Run: pytest tests/test_almanac_pdf.py -v
"""

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pymupdf = pytest.importorskip("pymupdf")

import zimi.almanacbook as abook  # noqa: E402
import zimi.almanacpdf as apdf  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi.http import ZimHandler  # noqa: E402

# The book's shape (almanac-tables.js _tbBookBuild), small: its @page rules (the running foot), a title page, the
# contents linking to each part and chapter (each with the place its page number goes), each part a page of its own,
# each chapter a section carrying its running head, one with an equation (Temml's MathML).
_PAGE_RULES = (
    '@page { margin: 18mm 17mm; @bottom-left { content: "Tables and calculations · Testville"; font-size: 8pt; }'
    ' @bottom-right { content: "Zimi 9.9.9 · " counter(page) " / " counter(pages); font-size: 8pt; } }'
    ' @page :first { @bottom-left { content: none; } @bottom-right { content: none; }'
    ' @bottom-center { content: "Made with Zimi 9.9.9"; font-size: 8pt; } }'
)
_EQ = (
    '<div class="tb-eqs"><div class="tb-sumh">Equations</div><div class="tb-eq"><div class="tb-eq-l">Julian Day</div>'
    '<math display="block"><mrow><mi>a</mi><mo>=</mo><mfrac><mrow><mn>14</mn><mo>−</mo><mi>M</mi></mrow><mn>12</mn>'
    "</mfrac></mrow></math></div></div>"
)


def _chapter(part, n, name, rows, eq=False):
    body = "".join("<tr><th>%d</th><td>Sunrise 07:%02d</td></tr>" % (i, i % 60) for i in range(rows))
    return (
        '<section class="tb-book-page tb-body tb-book-table" data-part="%d" data-head="Part %s · %s" data-ch="%s %s"'
        ' id="tb-ch-%s"><div><header class="tb-printhead"><h2><span class="tb-ch-n">%s</span> %s</h2></header></div>'
        '<div class="tb-out"><div class="tb-frame"><table class="tb-table"><thead><tr><th>Day</th><th>Sunrise</th></tr>'
        "</thead><tbody>%s</tbody></table></div>%s</div></section>"
        % (part[0], part[1], part[2], n, name, n.replace(".", "-"), n, name, body, _EQ if eq else "")
    )


def _part(part, chapters):
    return (
        '<section class="tb-book-part" id="tb-part-%d"><h1><span class="tb-part-n">Part %s<span class="tb-vh">&nbsp;·&nbsp;'
        '</span></span><span class="tb-part-name">%s</span></h1><ol class="tb-part-list">%s</ol></section>'
        % (part[0], part[1], part[2], "".join('<li><span class="tb-toc-n">%s</span>%s</li>' % c for c in chapters))
    )


_PARTS = [((1, "I", "Tables"), [("1.1", "Alpha", 80, True)]), ((2, "II", "Constants"), [("2.1", "Beta", 5, False)])]
CHAPTERED = (
    "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'><title>t</title><style>%s</style></head><body>"
    '<div id="alm-book" class="alm-book"><header class="tb-book-title"><p class="tb-book-kicker">Almanac</p>'
    '<p class="tb-book-name">Tables and calculations</p><p class="tb-book-place">Testville</p></header>'
    '<nav class="tb-book-toc"><h1>Contents</h1>%s</nav>%s</div></body></html>'
) % (
    _PAGE_RULES,
    "".join(
        '<p class="tb-toc-part"><a href="#tb-part-%d"><span class="tb-toc-pn">Part %s</span> %s</a></p><ol>%s</ol>'
        % (p[0], p[1], p[2], "".join(
            '<li><a href="#tb-ch-%s"><span class="tb-toc-n">%s</span><span class="tb-toc-name">%s</span>'
            '<span class="tb-toc-pg" data-pdf-page="tb-ch-%s"></span></a></li>' % (n.replace(".", "-"), n, nm, n.replace(".", "-"))
            for n, nm, _, _ in chs))
        for p, chs in _PARTS
    ),
    "".join(_part(p, [(n, nm) for n, nm, _, _ in chs]) + "".join(_chapter(p, n, nm, r, e) for n, nm, r, e in chs) for p, chs in _PARTS),
)
# One tile printed: its own book, no title page or contents.
BOOK = (
    "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'><title>t</title><style>%s</style></head><body>"
    '<div id="alm-book" class="alm-book alm-book-one">%s</div></body></html>'
) % (_PAGE_RULES.replace("Tables and calculations", "Seasons"), _chapter((1, "I", "Tables"), "", "Seasons", 120))


def _pages(data):
    """Page count: pypdf's when it is here, else the page objects."""
    try:
        import io

        from pypdf import PdfReader

        return len(PdfReader(io.BytesIO(data)).pages)
    except ImportError:
        return len(re.findall(rb"/Type\s*/Page[^s]", data))


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("apdf")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _post(base, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        base + "/almanac/pdf",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def _get(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=30) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def test_oversize_body_is_refused_before_it_is_read(served):
    # The size is judged from Content-Length: the answer comes before a byte
    # of the body is sent.
    import http.client

    host, port = served.split("//")[1].split(":")
    conn = http.client.HTTPConnection(host, int(port), timeout=30)
    conn.putrequest("POST", "/almanac/pdf")
    conn.putheader("Content-Type", "application/json")
    conn.putheader("Content-Length", str(apdf.MAX_PRINT_BYTES + 1))
    conn.endheaders()
    r = conn.getresponse()
    assert r.status == 413, r.status
    conn.close()
    # Under the cap, a big document is read (and judged on what it is).
    big = {"html": "", "pad": "x" * (srv.MAX_POST_BODY * 4)}
    assert _post(served, big)[0] == 400


def test_no_document_is_a_400(served):
    assert _post(served, {"html": "  "})[0] == 400
    assert _post(served, {"paper": "A4"})[0] == 400


def test_without_pymupdf_it_says_so(served, monkeypatch):
    monkeypatch.setattr(apdf, "available", lambda: False)
    status, body = _post(served, {"html": BOOK})
    assert status == 501 and body == {"error": "unavailable"}


def test_a_pdf_of_every_page_under_its_name(served):
    status, body = _post(
        served,
        {"html": BOOK, "paper": "Letter", "name": "Almanac tables - Test - 2026-10-04"},
    )
    assert status == 200, body
    assert (
        body["url"]
        == "/almanac/pdf/%s/Almanac%%20tables%%20-%%20Test%%20-%%202026-10-04.pdf"
        % body["id"]
    )
    code, headers, data = _get(served, body["url"])
    assert code == 200 and headers["Content-Type"] == "application/pdf"
    assert (
        "Almanac%20tables%20-%20Test%20-%202026-10-04.pdf"
        in headers["Content-Disposition"]
    )
    assert data.startswith(b"%PDF-")
    doc = pymupdf.open("pdf", data)
    # Letter, as asked (612 x 792 points); 120 rows run onto a second page, its head said again.
    assert doc.page_count >= 2 and tuple(round(v) for v in doc[0].rect) == (0, 0, 612, 792)
    assert "Sunrise" in doc[1].get_text() and "Sunrise 07:59" in doc[1].get_text()
    # One tile is its own book: page 1 has the running foot, as every page does.
    for k, page in enumerate(doc):
        assert "Zimi 9.9.9 · %d / %d" % (k + 1, doc.page_count) in page.get_text(), k
    # The reader's raw print asks for the same file.
    assert _get(served, body["url"] + "?raw=1")[2] == data


def test_nothing_the_document_names_is_fetched(served):
    hits = []

    class Counter(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()

        def log_message(self, *a):
            pass

    trap = ThreadingHTTPServer(("127.0.0.1", 0), Counter)
    threading.Thread(target=trap.serve_forever, daemon=True).start()
    at = "http://127.0.0.1:%d" % trap.server_address[1]
    try:
        names = (
            "<link rel='stylesheet' href='%s/s.css'><style>@import url('%s/i.css'); body { background: url('%s/bg.png'); }"
            " @font-face { font-family: X; src: url('%s/f.woff2'); } p { font-family: X; }</style>"
            "<img src='%s/x.png'><iframe src='%s/frame'></iframe><p>text</p><script>fetch('%s/script')</script>"
        ) % ((at,) * 7)
        html = BOOK.replace('<div id="alm-book" class="alm-book alm-book-one">', '<div id="alm-book" class="alm-book alm-book-one">' + names)
        status, body = _post(served, {"html": html})
        assert status == 200, body
        assert hits == [], hits
    finally:
        trap.shutdown()


def test_entities_in_the_maths_are_refused_not_expanded():
    """The equations are parsed as XML: a document type (entity expansion, external entities) is not read at all."""
    from zimi import almanacmath

    bomb = '<!DOCTYPE m [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><math><mi>&b;</mi></math>'
    with pytest.raises(ValueError):
        almanacmath.parse(bomb)


def test_the_pdf_expires(served):
    status, body = _post(served, {"html": BOOK, "name": "x"})
    assert status == 200
    path = os.path.join(srv.ZIMI_DATA_DIR, "almanac-pdf", body["id"] + ".pdf")
    assert os.path.exists(path)
    made = apdf._files[body["id"]][2]
    apdf.sweep(now=made + apdf.PDF_TTL_SECONDS - 1)
    assert os.path.exists(path)
    apdf.sweep(now=made + apdf.PDF_TTL_SECONDS + 1)
    assert not os.path.exists(path)
    assert _get(served, body["url"])[0] == 404
    # A render leaves nothing of its own behind (its document and its part-made PDF).
    left = os.listdir(os.path.join(srv.ZIMI_DATA_DIR, "almanac-pdf"))
    assert not [f for f in left if f.startswith("render-")], left


def test_unknown_ids_and_names_are_safe():
    assert apdf.lookup("../../etc/passwd") is None
    assert apdf.lookup("short") is None
    assert apdf.clean_name('a/b\\c:"d"\n') == "a b c d.pdf"
    assert apdf.clean_name("") == "Zimi Almanac.pdf"
    assert apdf.clean_name("x" * 500).endswith("x.pdf")
    assert len(apdf.clean_name("x" * 500)) <= apdf.MAX_NAME_CHARS + 4


def test_a_full_line_is_busy_and_says_when_to_ask_again(served, monkeypatch):
    """One render at a time, QUEUE_DEPTH behind it; one more is a 503 whose
    Retry-After the page waits out before it asks once more."""
    monkeypatch.setattr(apdf, "_pending", apdf.QUEUE_DEPTH + 1)
    with pytest.raises(apdf.Busy):
        apdf.make(BOOK + "<!-- busy -->", "A4", "x")
    req = urllib.request.Request(
        served + "/almanac/pdf",
        data=json.dumps({"html": BOOK + "<!-- busy -->"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(req, timeout=30)
    assert e.value.code == 503
    assert e.value.headers["Retry-After"] == str(apdf.RETRY_AFTER_SECONDS)


def test_a_wait_in_line_has_its_limit(monkeypatch):
    """A request whose turn does not come in RENDER_QUEUE_SECONDS is busy, and leaves the line."""
    monkeypatch.setattr(apdf, "RENDER_QUEUE_SECONDS", 0.3)
    assert apdf._turn.acquire(timeout=5)   # someone else's render, being set
    try:
        t0 = time.monotonic()
        with pytest.raises(apdf.Busy):
            apdf.make(BOOK + "<!-- line -->", "A4", "x")
        assert time.monotonic() - t0 < 5
    finally:
        apdf._turn.release()
    assert apdf._pending == 0


def _counting(monkeypatch):
    """How many documents have been set, from here on."""
    set_ = []
    real = apdf._set

    def counted(html, paper):
        set_.append(html)
        return real(html, paper)

    monkeypatch.setattr(apdf, "_set", counted)
    return set_


def test_the_same_document_again_is_the_same_file(served, monkeypatch):
    """Asked twice, a document is set once: the second answer is the kept
    file, at once, its time renewed; another paper is another file."""
    drawn = _counting(monkeypatch)
    doc = BOOK.replace("Seasons", "Seasons again")
    status, first = _post(served, {"html": doc, "paper": "A4", "name": "cache"})
    assert status == 200 and len(drawn) == 1, first
    made = apdf._files[first["id"]][2]
    t0 = time.monotonic()
    status, again = _post(served, {"html": doc, "paper": "A4", "name": "cache"})
    assert status == 200 and again == first
    assert time.monotonic() - t0 < 0.5 and len(drawn) == 1
    assert apdf._files[first["id"]][2] >= made
    status, letter = _post(served, {"html": doc, "paper": "Letter", "name": "cache"})
    assert status == 200 and letter["id"] != first["id"] and len(drawn) == 2
    # Once it has expired, the document is set again.
    apdf.sweep(now=time.time() + apdf.PDF_TTL_SECONDS + 1)
    status, later = _post(served, {"html": doc, "paper": "A4", "name": "cache"})
    assert status == 200 and later["id"] != first["id"] and len(drawn) == 3


def test_a_render_is_a_process_of_its_own(served, monkeypatch):
    """The layout runs outside the server (seconds of it would hold the server's interpreter): the child is started
    with the document and the paper, and the PDF read back from it."""
    import subprocess

    started = []
    real = subprocess.Popen

    def popen(cmd, *a, **k):
        started.append(list(cmd))
        return real(cmd, *a, **k)

    monkeypatch.setattr(subprocess, "Popen", popen)
    status, body = _post(served, {"html": BOOK + "<!-- child -->", "paper": "Letter"})
    assert status == 200, body
    assert [c[-4:-3] for c in started] == [["zimi.almanacbook"]] and started[0][-3] == "Letter", started


def test_a_failed_render_is_a_500_and_the_next_works(served, monkeypatch):
    """A document the typesetter cannot read (or a child that dies) is that request's 500, with the reason in the
    log; the next render is its own."""
    status, body = _post(served, {"html": "<html><body><p>not the Almanac's book</p></body></html>"})
    assert status == 500 and body == {"error": "render failed"}
    status, body = _post(served, {"html": BOOK + "<!-- after -->"})
    assert status == 200, body


def test_a_stuck_render_is_killed_at_its_time(served, monkeypatch):
    """A render that never finishes is cut off at RENDER_TIMEOUT_SECONDS: its process killed, a 500, and the next
    render is a PDF."""
    import subprocess

    monkeypatch.setattr(apdf, "RENDER_TIMEOUT_SECONDS", 1)
    monkeypatch.setattr(apdf, "_CHILD_PYTHON", (sys.executable, "-c", "import time; time.sleep(60)"))
    started = []
    real = subprocess.Popen

    def popen(cmd, *a, **k):
        p = real(cmd, *a, **k)
        started.append(p)
        return p

    monkeypatch.setattr(subprocess, "Popen", popen)
    t0 = time.monotonic()
    status, _ = _post(served, {"html": BOOK + "<!-- stuck -->"})
    assert status == 500 and time.monotonic() - t0 < 15
    assert started and started[0].poll() is not None, "killed, not left running"
    monkeypatch.undo()
    status, body = _post(served, {"html": BOOK + "<!-- unstuck -->"})
    assert status == 200, body


def test_a_chaptered_book_has_bookmarks_and_real_page_numbers(served):
    """"Add proper like chapter markings and whatnot to the PDF." The outline is the contents, then
    each part with its chapters under it, each going to its page; the contents' page numbers are where each chapter
    fell, and each is a link there; the running heads name the part and the chapter; the title page has only its own
    line at the foot."""
    status, body = _post(served, {"html": CHAPTERED, "paper": "A4", "name": "x"})
    assert status == 200, body
    data = _get(served, body["url"])[2]
    doc = pymupdf.open("pdf", data)
    assert tuple(round(v) for v in doc[0].rect) == (0, 0, 595, 842)
    toc = doc.get_toc()

    def page_of(text):
        return next(k + 1 for k, p in enumerate(doc) if text in p.get_text() and "Contents" not in p.get_text())

    alpha, beta = page_of("Sunrise 07:00"), page_of("2.1 Beta")
    assert toc == [
        [1, "Contents", 2],
        [1, "Part I · Tables", 3],
        [2, "1.1 Alpha", alpha],
        [1, "Part II · Constants", toc[3][2]],
        [2, "2.1 Beta", beta],
    ], toc
    assert alpha == 4 and beta > alpha + 1, (alpha, beta)   # Alpha's 80 rows run over a page
    contents = doc[1].get_text()
    assert re.search(r"1\.1\s*Alpha\s*%d\b" % alpha, contents) and re.search(r"2\.1\s*Beta\s*%d\b" % beta, contents), contents
    links = {lk["page"] + 1 for lk in doc[1].get_links() if lk.get("kind") == pymupdf.LINK_GOTO}
    assert {alpha, beta} <= links, links
    first = doc[0].get_text()
    assert "Made with Zimi 9.9.9" in first and "1 / " not in first
    assert "Part I · Tables" in doc[alpha - 1].get_text() and "1.1 Alpha" in doc[alpha].get_text()
    assert "Zimi 9.9.9 · %d / %d" % (beta, doc.page_count) in doc[beta - 1].get_text()


def test_the_equations_are_drawn_with_their_own_letters(served):
    """The equations are set by Zimi (almanacmath) in Noto Sans Math, embedded: drawn, not blank, and their text
    reads back as the letters they are (maths italics; digits as digits)."""
    status, body = _post(served, {"html": CHAPTERED + "<!-- maths -->", "paper": "A4", "name": "x"})
    assert status == 200, body
    doc = pymupdf.open("pdf", _get(served, body["url"])[2])
    page = next(p for p in doc if "Julian Day" in p.get_text())
    assert any("NotoSansMath" in f[3].replace(" ", "") for f in page.get_fonts()), page.get_fonts()
    text = page.get_text()
    assert "\U0001D44E" in text and "\U0001D440" in text and "14" in text and "12" in text, text   # a, M; 14 over 12
    assert any(d["rect"].width > 5 for d in page.get_drawings()), "the fraction bar"


def test_the_fonts_are_subsets():
    """Only the letters used: the whole book is about a megabyte, and one tile a fraction of it."""
    data = abook.render(BOOK, "A4")
    assert len(data) < 400 * 1024, len(data)
    doc = pymupdf.open("pdf", data)
    assert all("+" in f[3] for p in doc for f in p.get_fonts()), [f[3] for f in doc[0].get_fonts()]


@pytest.mark.parametrize(
    "piece",
    [
        "<" * 200000,
        '<span class="tk-v">' * 20000,
        '<span class="tk-u">a' * 20000,
        '<button aria-checked="false"' * 20000,
        '<span class="tb-vh">' * 20000,
        '<p class="tb-toc-part">a' * 20000,
        '<div class="tb-eq-l">a' * 20000,
        "{pg:|" * 50000 + "{{pg:" * 50000,
    ],
)
def test_pathological_markup_is_read_in_bounded_time(piece):
    """The layout's patterns run on a document a client sent: repeated unclosed openers finish at once, not in quadratic time."""
    start = time.monotonic()
    abook._text(piece)
    abook._control_value(piece)
    abook._end_of(piece, 0, "span")
    abook._pieces(piece)
    abook._fill_pages(piece, {})
    abook.Book._rows(piece)
    abook.Book._part_list(piece)
    abook.Book._cal_list(piece)
    assert time.monotonic() - start < 10
