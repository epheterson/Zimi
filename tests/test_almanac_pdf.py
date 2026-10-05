"""POST /almanac/pdf: the Almanac's print document as a PDF (zimi/almanacpdf.py).

The route takes a document the page built, so it is held to what it may do:
no bigger than MAX_PRINT_BYTES, nothing it names is fetched, one render at a
time, the file gone after its time. Where Chromium is missing it says so (501)
and the page prints the book itself (tests/test_almanac_tables_browser.py).

Run: pytest tests/test_almanac_pdf.py -v
"""

import json
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.almanacpdf as apdf  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi.http import ZimHandler  # noqa: E402

BOOK = (
    "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Almanac tables - Test - 2026-10-04</title>"
    "<style>@page { size: Letter; margin: 16mm; } section + section { break-before: page; }</style></head><body>"
    + "".join(
        "<section><h1>Page %d</h1><p>Sunrise 07:05</p></section>" % i
        for i in range(1, 4)
    )
    + "</body></html>"
)


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


def _needs_chromium():
    if not apdf.available():
        pytest.skip("playwright + chromium are not usable here")


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


def test_without_chromium_it_says_so(served, monkeypatch):
    monkeypatch.setattr(apdf, "available", lambda: False)
    status, body = _post(served, {"html": BOOK})
    assert status == 501 and body == {"error": "unavailable"}


def test_a_pdf_of_every_page_under_its_name(served):
    _needs_chromium()
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
    assert _pages(data) == 3
    # Letter, as asked (612 x 792 points).
    assert re.search(rb"/MediaBox\s*\[\s*0\s+0\s+612(\.0+)?\s+792", data)
    # The reader's raw print asks for the same file.
    assert _get(served, body["url"] + "?raw=1")[2] == data


def test_nothing_the_document_names_is_fetched(served):
    _needs_chromium()
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
        html = (
            "<!DOCTYPE html><html><head><link rel='stylesheet' href='%s/s.css'>"
            "<style>@import url('%s/i.css'); body { background: url('%s/bg.png'); }"
            " @font-face { font-family: X; src: url('%s/f.woff2'); } p { font-family: X; }</style></head>"
            "<body><img src='%s/x.png'><iframe src='%s/frame'></iframe><p>text</p>"
            "<script>fetch('%s/script')</script></body></html>"
        ) % ((at,) * 7)
        status, body = _post(served, {"html": html})
        assert status == 200, body
        assert hits == [], hits
    finally:
        trap.shutdown()


def test_the_pdf_expires(served):
    _needs_chromium()
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


def test_unknown_ids_and_names_are_safe():
    assert apdf.lookup("../../etc/passwd") is None
    assert apdf.lookup("short") is None
    assert apdf.clean_name('a/b\\c:"d"\n') == "a b c d.pdf"
    assert apdf.clean_name("") == "Almanac tables.pdf"
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
    """A request whose turn does not come in RENDER_QUEUE_SECONDS is busy,
    and its render is dropped from the line."""
    monkeypatch.setattr(apdf, "RENDER_QUEUE_SECONDS", 0.3)
    # A line nobody takes from.
    line = queue.Queue()
    monkeypatch.setattr(apdf, "_jobs", line)
    monkeypatch.setattr(apdf, "_ensure_worker", lambda: None)
    t0 = time.monotonic()
    with pytest.raises(apdf.Busy):
        apdf.make(BOOK + "<!-- line -->", "A4", "x")
    assert time.monotonic() - t0 < 5
    assert line.get_nowait().cancelled
    assert apdf._pending == 0


def _counting(monkeypatch):
    """How many documents the browser has drawn, from here on."""
    drawn = []
    real = apdf._draw

    def draw(browser, html, paper):
        drawn.append(html)
        return real(browser, html, paper)

    monkeypatch.setattr(apdf, "_draw", draw)
    return drawn


def test_the_same_document_again_is_the_same_file(served, monkeypatch):
    """Asked twice, a document is drawn once: the second answer is the kept
    file, at once, its time renewed; another paper is another file."""
    _needs_chromium()
    drawn = _counting(monkeypatch)
    doc = BOOK.replace("Page 1", "Page one")
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
    # Once it has expired, the document is drawn again.
    apdf.sweep(now=time.time() + apdf.PDF_TTL_SECONDS + 1)
    status, later = _post(served, {"html": doc, "paper": "A4", "name": "cache"})
    assert status == 200 and later["id"] != first["id"] and len(drawn) == 3


def test_the_browser_stays_warm_between_renders(served):
    _needs_chromium()
    assert _post(served, {"html": BOOK + "<!-- w1 -->"})[0] == 200
    launches = apdf._launches
    assert _post(served, {"html": BOOK + "<!-- w2 -->"})[0] == 200
    assert apdf._launches == launches and apdf._worker.pid


def _wait(cond, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_a_killed_browser_is_replaced_on_the_next_render(served):
    """Killed while it waits (the OOM killer, a crash): the next render
    launches another and succeeds."""
    _needs_chromium()
    assert _post(served, {"html": BOOK + "<!-- k1 -->"})[0] == 200
    pid, launches = apdf._worker.pid, apdf._launches
    apdf._worker.kill()
    assert _wait(lambda: not renderer._process_alive(pid))
    status, body = _post(served, {"html": BOOK + "<!-- k2 -->"})
    assert status == 200, body
    assert apdf._launches == launches + 1
    assert _get(served, body["url"])[2].startswith(b"%PDF-")


def test_a_crash_mid_render_fails_that_one_and_the_next_works(served, monkeypatch):
    """The browser dies between the two passes: that request is a 500 (and
    the log says why), the next is a PDF from a new browser."""
    _needs_chromium()
    real = apdf.dest_pages

    def crash(data):
        apdf._worker.kill()
        return real(data)

    monkeypatch.setattr(apdf, "dest_pages", crash)
    status, body = _post(served, {"html": CHAPTERED + "<!-- crash -->"})
    assert status == 500 and body == {"error": "render failed"}
    monkeypatch.setattr(apdf, "dest_pages", real)
    status, body = _post(served, {"html": CHAPTERED + "<!-- crash -->"})
    assert status == 200, body


def test_a_stuck_render_is_killed_at_its_time(served, monkeypatch):
    """A render that never finishes (here, fonts that never settle) is cut
    off at RENDER_TIMEOUT_SECONDS: its browser killed, a 500, and the next
    render launches a new one."""
    _needs_chromium()
    assert _post(served, {"html": BOOK + "<!-- s0 -->"})[0] == 200
    pid = apdf._worker.pid
    monkeypatch.setattr(apdf, "RENDER_TIMEOUT_SECONDS", 2)
    monkeypatch.setattr(apdf, "_FONTS_READY_JS", "new Promise(() => {})")
    t0 = time.monotonic()
    status, _ = _post(served, {"html": BOOK + "<!-- s1 -->"})
    assert status == 500 and time.monotonic() - t0 < 15
    assert _wait(lambda: not renderer._process_alive(pid))
    monkeypatch.undo()
    status, body = _post(served, {"html": BOOK + "<!-- s2 -->"})
    assert status == 200, body


def test_the_warm_browser_closes_when_idle(served, monkeypatch):
    _needs_chromium()
    monkeypatch.setattr(apdf, "BROWSER_IDLE_SECONDS", 0.5)
    # The browser's thread reads the idle time as it starts to wait: start
    # it afresh so it waits the short one.
    apdf.shutdown()
    assert _post(served, {"html": BOOK + "<!-- idle -->"})[0] == 200
    pid = apdf._worker.pid
    assert pid and renderer._process_alive(pid)
    assert _wait(lambda: apdf._worker.pid is None and not renderer._process_alive(pid))
    assert _post(served, {"html": BOOK + "<!-- idle 2 -->"})[0] == 200


def test_the_browser_is_launched_afresh_after_its_share(served, monkeypatch):
    _needs_chromium()
    monkeypatch.setattr(apdf, "RENDERS_PER_BROWSER", 2)
    apdf.shutdown()
    launches = apdf._launches
    for i in range(3):
        assert _post(served, {"html": BOOK + "<!-- n%d -->" % i})[0] == 200
    # One for the first two, a new one for the third.
    assert apdf._launches == launches + 2


def test_shutdown_closes_the_browser(served):
    _needs_chromium()
    assert _post(served, {"html": BOOK + "<!-- bye -->"})[0] == 200
    pid = apdf._worker.pid
    apdf.shutdown()
    assert not apdf._worker.is_alive()
    assert _wait(lambda: not renderer._process_alive(pid))


def test_the_pdf_carries_its_own_maths_font():
    """A server may have no maths font (the NAS's Docker image has none), so
    the equations would fall back to plain glyphs: the document is given
    Zimi's own, as data, before it is drawn."""
    from zimi import almanacpdf

    html = (
        "<html><head><title>t</title></head><body><math><mi>x</mi></math></body></html>"
    )
    out = almanacpdf._with_math_font(html)
    assert "data:font/ttf;base64," in out and out.index("Zimi Math") < out.index(
        "</head>"
    )
    assert (
        almanacpdf._with_math_font("<p>no maths</p>") == "<p>no maths</p>"
    ), "only where there is maths"


def _outline(data):
    """The outline read back, [(title, page, [children]), ...]: pypdf's
    reading when it is here, else the file's own objects walked from the
    catalog's /Outlines along /First and /Next."""
    try:
        import io

        from pypdf import PdfReader

        r = PdfReader(io.BytesIO(data), strict=True)

        def walk(items):
            out = []
            for it in items:
                if isinstance(it, list):
                    out[-1][2].extend(walk(it))
                else:
                    out.append((it.title, r.get_destination_page_number(it) + 1, []))
            return out

        return walk(r.outline)
    except ImportError:
        pass
    rows, trailer, _ = apdf._xref(data)

    def obj(n):
        return apdf._object(data, rows, n)

    def ref(d, key):
        m = re.search(rb"/" + key + rb"\s+(\d+) 0 R", d)
        return int(m.group(1)) if m else None

    cat = obj(ref(trailer, b"Root"))
    order = apdf._page_order(obj, ref(cat, b"Pages"))

    def text(d):
        m = re.search(rb"/Title\s*(\((?:[^)\\]|\\.)*\)|<[0-9A-Fa-f]+>)", d).group(1)
        if m.startswith(b"<"):
            return bytes.fromhex(m[1:-1].decode()).decode("utf-16")
        return re.sub(rb"\\(.)", rb"\1", m[1:-1]).decode("latin-1")

    def walk(n):
        out = []
        while n is not None:
            d = obj(n)
            page = int(re.search(rb"/Dest\s*\[\s*(\d+) 0 R", d).group(1))
            out.append((text(d), order.index(page) + 1, walk(ref(d, b"First"))))
            n = ref(d, b"Next")
        return out

    return walk(ref(obj(ref(cat, b"Outlines")), b"First"))


# The book's shape (almanac-tables.js _tbBookBuild): the contents, linking
# to each part and chapter; each part a page of its own (id="tb-part-N");
# each chapter a section (id="tb-ch-N-M") headed by its number and name.
CHAPTERED = (
    "<!DOCTYPE html><html><head><meta charset='utf-8'><title>t</title><style>"
    "@page { size: A4; margin: 20mm; } section { break-before: page; }"
    ".pg { display: inline-block; min-width: 3em; }</style></head><body>"
    '<nav class="tb-book-toc"><h1>Contents</h1>'
    '<p><a href="#tb-part-1">Part I · Tables</a></p>'
    '<p><a href="#tb-ch-1-1">1.1 Alpha <span class="pg" data-pdf-page="tb-ch-1-1"></span></a></p>'
    '<p><a href="#tb-part-2">Part II · Constants</a></p>'
    '<p><a href="#tb-ch-2-1">2.1 Beta <span class="pg" data-pdf-page="tb-ch-2-1"></span></a></p></nav>'
    '<section class="tb-book-part" id="tb-part-1"><h1><span>Part I<span>&nbsp;·&nbsp;</span></span>'
    "<span>Tables</span></h1><ol><li>1.1 Alpha</li></ol></section>"
    '<section id="tb-ch-1-1"><div><header><h2><span>1.1</span> Alpha</h2></header></div><p>one</p>'
    "<details open><summary><div class='tb-sumh'>How this is made</div></summary><p>how</p>"
    "<details open><summary><div class='tb-sumh'>Equations</div></summary><p>e</p></details></details></section>"
    "<section><p>more of Alpha</p></section>"
    '<section class="tb-book-part" id="tb-part-2"><h1>Part II · Constants</h1></section>'
    '<section id="tb-ch-2-1"><h2>2.1 Beta</h2><p>two</p></section>'
    "</body></html>"
)
CHAPTERED_OUTLINE = [
    ("Contents", 1, []),
    ("Part I · Tables", 2, [("1.1 Alpha", 3, [])]),
    ("Part II · Constants", 5, [("2.1 Beta", 6, [])]),
]


def test_a_chaptered_book_has_bookmarks_and_real_page_numbers(served):
    """Eric, 2026-10-05: small and fast, with "a better balance". The PDF is
    untagged (a sixth of the size), and its outline is Zimi's own: the
    contents, then each part with its chapters under it, each going to its
    page. The contents' page numbers are where each chapter fell."""
    _needs_chromium()
    status, body = _post(served, {"html": CHAPTERED, "paper": "A4", "name": "x"})
    assert status == 200, body
    data = _get(served, body["url"])[2]
    assert b"/StructTreeRoot" not in data, "untagged"
    assert b"/PageMode /UseOutlines" in data
    assert _outline(data) == CHAPTERED_OUTLINE
    pages = apdf.dest_pages(data)
    assert pages["tb-ch-1-1"] == 3 and pages["tb-ch-2-1"] == 6, pages
    import shutil
    import subprocess

    if shutil.which("pdftotext"):
        text = subprocess.run(
            ["pdftotext", "-f", "1", "-l", "1", "-", "-"],
            input=data,
            capture_output=True,
            check=True,
        ).stdout.decode()
        assert re.search(r"1\.1 Alpha\s*3\b", text) and re.search(
            r"2\.1 Beta\s*6\b", text
        ), text
    if shutil.which("qpdf"):
        subprocess.run(["qpdf", "--check", "-"], input=data, check=True)


def test_without_its_bookmarks_the_pdf_is_still_served(served, monkeypatch, caplog):
    """The outline is a nicety: when it cannot be written the PDF is the one
    Chromium drew, with one line in the log."""
    _needs_chromium()

    def broken(data, marks):
        raise ValueError("mangled")

    monkeypatch.setattr(apdf, "with_outline", broken)
    with caplog.at_level("WARNING", logger="zimi"):
        status, body = _post(served, {"html": CHAPTERED + "<!-- plain -->"})
    assert status == 200, body
    data = _get(served, body["url"])[2]
    assert data.startswith(b"%PDF-") and b"/Outlines" not in data
    assert _pages(data) == 6
    assert [r for r in caplog.records if "no bookmarks" in r.getMessage()]


def _tiny_pdf(pages=4):
    """A small classic PDF as a writer like Chromium's makes it, its pages
    under two nested Pages nodes."""
    half = pages // 2
    kids = [list(range(10, 10 + half)), list(range(10 + half, 10 + pages))]
    objs = {
        1: b"<</Title (tiny)>>",
        2: b"<</Type /Catalog\n/Pages 3 0 R>>",
        3: b"<</Type /Pages /Kids [4 0 R 5 0 R] /Count %d>>" % pages,
    }
    for n, ks in zip((4, 5), kids):
        objs[n] = b"<</Type /Pages /Parent 3 0 R /Kids [%s] /Count %d>>" % (
            b" ".join(b"%d 0 R" % k for k in ks),
            len(ks),
        )
        for k in ks:
            objs[k] = b"<</Type /Page /Parent %d 0 R /MediaBox [0 0 200 200]>>" % n
    out, at = bytearray(b"%PDF-1.4\n"), {}
    for n in sorted(objs):
        at[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    size = max(objs) + 1
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for n in range(1, size):
        out += b"%010d 00000 n \n" % at[n] if n in at else b"0000000000 65535 f \n"
    out += (
        b"trailer\n<</Size %d\n/Root 2 0 R\n/Info 1 0 R>>\nstartxref\n%d\n%%%%EOF\n"
        % (
            size,
            xref,
        )
    )
    return bytes(out)


def test_the_outline_is_an_incremental_update():
    """The bookmarks are appended: Chromium's bytes stay as they were, then
    the outline, a new catalog and a cross-reference section whose /Prev is
    the old one. Titles that are not ASCII (a place, another language) are
    UTF-16 with its byte order mark; pages come from the page tree, nested
    Pages nodes and all."""
    data = _tiny_pdf(4)
    marks = [
        ["Contents", 1, []],
        [
            "Part I · Tables",
            2,
            [["1.1 Sun and Moon", 3, []], ["1.2 Tides (Zürich)", 4, []]],
        ],
        ["Teil II · 東京 · Αθήνα", 4, [["2.1 \\ (back)", 4, []]]],
    ]
    out = apdf.with_outline(data, marks)
    assert out.startswith(data)
    tail = out[len(data) :]
    assert b"/Prev %d" % apdf._xref(data)[2] in tail
    assert b"<FEFF" in tail and b"(1.1 Sun and Moon)" in tail
    assert b"/PageMode /UseOutlines" in tail and b"/Info 1 0 R" in tail
    want = [
        ("Contents", 1, []),
        (
            "Part I · Tables",
            2,
            [("1.1 Sun and Moon", 3, []), ("1.2 Tides (Zürich)", 4, [])],
        ),
        ("Teil II · 東京 · Αθήνα", 4, [("2.1 \\ (back)", 4, [])]),
    ]
    assert _outline(out) == want
    # Counts: the root counts every open item, a part its chapters.
    assert re.search(rb"/Type /Outlines [^>]*/Count 6>>", tail), tail[-600:]
    # Updated again (the chain of sections is followed), the newer outline
    # is the one read.
    again = apdf.with_outline(out, [["Only", 2, []]])
    assert _outline(again) == [("Only", 2, [])]


def test_a_mangled_or_unreadable_pdf_keeps_no_outline():
    """Anything it cannot read is left as it is: no cross-reference table,
    a cross-reference stream (written by other PDF makers), a page that is
    not there, nothing to mark."""
    marks = [["Contents", 1, []]]
    good = _tiny_pdf(2)
    stream = good.replace(b"xref\n0 ", b"1 0 obj <</Type /XRef>> ")
    broken = good[: good.rindex(b"startxref")] + b"startxref\n7\n%%EOF\n"
    for bad in (b"%PDF-1.4 not a real file", b"", stream, broken):
        assert apdf._bookmarked(bad, CHAPTERED, {"tb-ch-1-1": 1}) == bad
    with pytest.raises(ValueError):
        apdf.with_outline(good, [["Past the end", 3, []]])
    with pytest.raises(ValueError):
        apdf.with_outline(good, [])
    assert apdf.with_outline(good, marks) != good


def test_the_marks_are_the_contents_then_parts_with_their_chapters():
    """The outline is read off the book's own HTML: the contents' heading
    (made a link target, so the first pass places it), each part's and
    chapter's heading text, whitespace and entities settled; a chapter
    the first pass did not place is left out."""
    html = apdf._mark_contents(CHAPTERED)
    assert '<h1 id="zimi-pdf-contents">' in html
    assert '<a href="#zimi-pdf-contents" style="display:none"></a>' in html
    pages = {
        "zimi-pdf-contents": 1,
        "tb-part-1": 2,
        "tb-ch-1-1": 3,
        "tb-part-2": 5,
        "tb-ch-2-1": 6,
    }
    assert apdf.outline_marks(html, pages) == [
        [t, p, [[ct, cp, []] for ct, cp, _ in kids]] for t, p, kids in CHAPTERED_OUTLINE
    ]
    del pages["tb-ch-2-1"]
    assert apdf.outline_marks(html, pages)[-1] == ["Part II · Constants", 5, []]
    # No page marks, no contents to mark.
    assert apdf._mark_contents(BOOK) == BOOK


def test_unreadable_pdfs_have_no_pages():
    assert apdf.dest_pages(b"%PDF-1.4 not a real file") == {}
    assert apdf.dest_pages(b"") == {}
