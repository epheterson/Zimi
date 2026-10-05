"""POST /almanac/pdf: the Almanac's print document as a PDF (zimi/almanacpdf.py).

The route takes a document the page built, so it is held to what it may do:
no bigger than MAX_PRINT_BYTES, nothing it names is fetched, one render at a
time, the file gone after its time. Where Chromium is missing it says so (501)
and the page prints the book itself (tests/test_almanac_tables_browser.py).

Run: pytest tests/test_almanac_pdf.py -v
"""

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.almanacpdf as apdf  # noqa: E402
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


def test_one_render_at_a_time(monkeypatch):
    monkeypatch.setattr(apdf, "RENDER_QUEUE_SECONDS", 0.05)
    with apdf._render_lock:
        with pytest.raises(apdf.Busy):
            apdf.make(BOOK, "A4", "x")


def test_the_pdf_carries_its_own_maths_font():
    """A server may have no maths font (the NAS's Docker image has none), so
    the equations would fall back to plain glyphs: the document is given
    Zimi's own, as data, before it is drawn."""
    from zimi import almanacpdf

    html = "<html><head><title>t</title></head><body><math><mi>x</mi></math></body></html>"
    out = almanacpdf._with_math_font(html)
    assert "data:font/ttf;base64," in out and out.index("Zimi Math") < out.index("</head>")
    assert almanacpdf._with_math_font("<p>no maths</p>") == "<p>no maths</p>", "only where there is maths"
