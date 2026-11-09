"""PDF collections (#142): zimgit-water's PDFs are found by search, listed by
MIME type, and their text is in Zimi's own index.

The fixture is the shape the reporter described: a nautilus ZIM whose full-text
index covers only its shell page, a ``database.js`` listing, and PDFs under
``files/``. Before the document index a search for "Giardia" found nothing.

Run: pytest tests/test_docindex.py -v
"""

import json
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from zimi import docindex, search  # noqa: E402

pymupdf = pytest.importorskip("pymupdf")

NAME = "zimgit-water"
LISTING = """var DATABASE = [
{'_id': '00000', 'ti': 'Giardia: Drinking Water Factsheet', 'dsc': 'A protozoan in lakes', 'aut': 'US Environmental Protection Agency', 'fp': ['Water (3).pdf']},
{'_id': '00001', 'ti': 'Distillation For Home Water Treatment', 'dsc': 'For people with a water quality problem', 'aut': 'Michigan State University', 'fp': ['Water (1).pdf']},
{'_id': '00002', 'ti': 'Scanned Pamphlet', 'dsc': 'Pictures only', 'aut': 'Nobody', 'fp': ['Scan.pdf']},
];
"""


def make_pdf(*pages):
    """A PDF with one page per string; "" is a page with no text layer."""
    doc = pymupdf.open()
    for text in pages:
        page = doc.new_page()
        if text:
            page.insert_text((72, 72), text)
    data = doc.tobytes()
    doc.close()
    return data


def make_pdf_zim(path):
    from conftest_zim import build_fixture_zim

    return build_fixture_zim(
        path,
        {"Scraper": "nautiluszim 1.1.1", "Name": NAME},
        files={
            "database.js": LISTING.encode(),
            "files/Water (3).pdf": make_pdf(
                "Cryptosporidium and cysts.", "Boil water one minute to kill cysts."
            ),
            "files/Water (1).pdf": make_pdf("Distillation leaves minerals behind."),
            "files/Scan.pdf": make_pdf("", ""),
            "files/Orphan.pdf": make_pdf("Chlorination basics for wells."),
        },
    )


@pytest.fixture
def lib(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    make_pdf_zim(str(zdir / f"{NAME}.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    search._reset_search_caches() if hasattr(search, "_reset_search_caches") else None
    yield NAME
    # A search made before the index was read asked for it: let that build
    # end before the next test's ZIM is the one it would be kept for.
    docindex._builder.wait(120)
    docindex._builder._kept.clear()


def build(name):
    """The build, in this process (the child's work, without its start-up)."""
    path = srv.get_zim_files()[name]
    docindex.build_docs(name, path)
    docindex._builder.keep(name, path, True)


def titles(res, zim=NAME):
    return [r["title"] for r in res["results"] if r["zim"] == zim]


# ── list_entries ──────────────────────────────────────────────────────────


def test_list_entries_filters_by_mime_and_pages(lib):
    got = docindex.list_entries(lib, mime="application/pdf")
    assert [e["path"] for e in got["entries"]] == [
        "files/Orphan.pdf",
        "files/Scan.pdf",
        "files/Water (1).pdf",
        "files/Water (3).pdf",
    ]
    assert got["next"] is None
    assert all(e["mime"] == "application/pdf" and e["size"] > 0 for e in got["entries"])
    first = docindex.list_entries(lib, mime="application/pdf", limit=3)
    assert first["count"] == 3 and first["next"]
    rest = docindex.list_entries(
        lib, mime="application/pdf", limit=3, cursor=first["next"]
    )
    assert [e["path"] for e in rest["entries"]] == ["files/Water (3).pdf"]
    assert rest["next"] is None


def test_list_entries_by_prefix_and_family(lib):
    got = docindex.list_entries(lib, prefix="files/Water")
    assert [e["path"] for e in got["entries"]] == [
        "files/Water (1).pdf",
        "files/Water (3).pdf",
    ]
    assert docindex.list_entries(lib, prefix="zzz")["entries"] == []
    html = docindex.list_entries(lib, mime="text/")
    assert html["entries"] and all(
        e["mime"].startswith("text/") for e in html["entries"]
    )


def test_list_entries_errors(lib):
    assert "not found" in docindex.list_entries("nope")["error"]
    assert "error" in docindex.list_entries(lib, cursor="abc")
    assert "error" in docindex.list_entries(lib, cursor="-5")


def test_list_entries_over_http_and_mcp(lib):
    pytest.importorskip("mcp")
    from zimi import mcp_server

    got = json.loads(mcp_server.list_entries(lib, mime="application/pdf", limit=2))
    assert got["count"] == 2 and got["next"]
    assert mcp_server.list_entries("nope").startswith("Error:")
    assert "list_entries" in dict(mcp_server.FULL_TOOLS)


def test_entries_route(lib):
    import threading
    import urllib.error
    import urllib.request
    from http.server import ThreadingHTTPServer

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def get(path):
        try:
            with urllib.request.urlopen(base + path, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    try:
        code, body = get(f"/entries?zim={lib}&mime=application/pdf&limit=2")
        assert code == 200 and body["count"] == 2 and body["next"]
        code, body = get(f"/entries?zim={lib}&mime=application/pdf&cursor={body['next']}")
        assert code == 200 and body["next"] is None
        assert get("/entries")[0] == 400
        assert get("/entries?zim=nope")[0] == 404
        assert get(f"/entries?zim={lib}&cursor=x")[0] == 400
    finally:
        httpd.shutdown()


# ── the document index ────────────────────────────────────────────────────


def test_the_reporters_search_found_nothing_then_finds_the_factsheet(lib):
    # The reproduction in #142: the shell page is all the full-text index holds.
    before = search.search_all("Giardia", filter_zim=NAME)
    assert titles(before) == []
    build(lib)
    after = search.search_all("Giardia", filter_zim=NAME)
    hit = next(r for r in after["results"] if r["zim"] == NAME)
    assert hit["title"] == "Giardia: Drinking Water Factsheet"
    assert hit["path"] == "files/Water (3).pdf"
    # Across the library, not only scoped.
    assert "Giardia: Drinking Water Factsheet" in titles(search.search_all("Giardia"))
    # And on the keystroke path.
    fast = search.search_all("Giard", filter_zim=NAME, fast=True)
    assert "Giardia: Drinking Water Factsheet" in titles(fast)


def test_search_reaches_the_text_inside_pdfs(lib):
    build(lib)
    res = search.search_all("cryptosporidium", filter_zim=NAME)
    assert titles(res) == ["Giardia: Drinking Water Factsheet"]
    assert "ryptosporidium" in res["results"][0]["snippet"]
    # A PDF the listing does not name is still a document, titled by its file.
    assert titles(search.search_all("chlorination", filter_zim=NAME)) == ["Orphan"]
    # Title words outrank body words.
    both = docindex.search(lib, "water")
    assert both and both[0]["path"].startswith("files/Water")


def test_the_build_reads_the_listing_alone_without_pymupdf(lib, monkeypatch):
    # In this process: a child would have its own PyMuPDF.
    monkeypatch.setattr(srv, "HAS_PYMUPDF", False)
    build(lib)
    assert titles(search.search_all("Giardia", filter_zim=NAME))
    assert titles(search.search_all("cryptosporidium", filter_zim=NAME)) == []


def test_pages_without_text_are_counted(lib):
    build(lib)
    conn = sqlite3.connect(docindex._builder.path(lib))
    rows = {
        p: (n, b)
        for p, n, b in conn.execute("SELECT path, pages, blank_pages FROM docs")
    }
    conn.close()
    assert rows["files/Scan.pdf"] == (2, 2)
    assert rows["files/Water (3).pdf"] == (2, 0)


def test_a_zim_that_is_not_a_collection_pays_a_lookup_only(lib):
    assert docindex.search("wikipedia-not-here", "water") == []
    assert not docindex.ready("wikipedia-not-here")
    # No request was made for it.
    assert "wikipedia-not-here" not in docindex._builder._queued


def test_the_first_search_asks_for_the_index_and_a_second_finds_it(lib):
    # Not built: asks for it, and the build runs in a child process.
    search.search_all("Giardia", filter_zim=NAME)
    assert docindex._builder.wait(60)
    assert titles(search.search_all("Giardia", filter_zim=NAME))


def test_pdf_scan_is_bounded():
    pdf = make_pdf(*["page %d text" % i for i in range(10)])
    text, pages, blank = docindex.pdf_scan(pdf, max_pages=3)
    assert pages == 10 and "page 2" in text and "page 3" not in text
    assert docindex.pdf_scan(pdf, max_chars=5)[0] == "page "
    assert search.extract_pdf_text(pdf).startswith("page 0 text page 1 text")
