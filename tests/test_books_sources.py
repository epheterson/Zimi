"""Bookshelf beyond Gutenberg: Kiwix's document libraries (nautilus),
LibreTexts, Wikisource and Wikibooks, Zimi's own folder ZIMs, EPUBs read in
the browser, and ZIMs that are one book each.

Eric, 2026-09-27: "We should have more than Gutenberg in the book app,
support as many as we can across all the apps as well. Be sure to support
our own."

The fixtures are cut from the real ZIMs (tests/books_sources_fixture.py).

Run: pytest tests/test_books_sources.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import books_sources_fixture as fx  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import nautilus, search  # noqa: E402

NAUTILUS = "nautiluszim 1.1.1"
MWOFFLINER = "mwoffliner 1.17.5"


def _water_entries():
    entries = {
        "home": ("text/html", "<html><body>Water</body></html>", "Home"),
        "database.js": ("text/javascript", fx.WATER_DATABASE, "database.js"),
    }
    for i in range(1, 8):
        entries[f"files/Water ({i}).pdf"] = ("application/pdf", fx.PDF, "")
    return entries


def _library(tmp_path, monkeypatch, zims):
    """``zims``: [(filename, metadata, entries, main_path)], loaded as the
    library."""
    zdir = tmp_path / "zims"
    zdir.mkdir(exist_ok=True)
    for filename, metadata, entries, main in zims:
        fx.build_zim(str(zdir / filename), metadata, entries, main)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    return zdir


# ── one parser for every document listing ──────────────────────────────────


def test_one_parser_reads_every_document_listing():
    items = nautilus.parse(fx.WATER_DATABASE)
    assert len(items) == 7
    assert items[0]["ti"] == "Distillation For Home Water Treatment"
    assert nautilus.files_of(items[0]) == ["files/Water (1).pdf"]
    # nautiluszim 1.0.x wrote no spaces around the =.
    assert (
        nautilus.parse("var DATABASE=[{'_id':'1','ti':'x','fp':['a.pdf']}];")[0]["ti"]
        == "x"
    )
    # A subfolder and typographic quotes survive.
    prunelle = nautilus.parse(fx.PRUNELLE_DATABASE)
    assert nautilus.files_of(prunelle[0]) == [
        "files/Anglais (20 titres)/’Mvoo′ Laa′na the hunter.pdf"
    ]
    assert nautilus.parse("not a listing") == [] and nautilus.parse("") == []


@pytest.mark.parametrize(
    "fp,media",
    [
        (["Water (1).pdf"], "document"),
        (["class 2_variable_type.html"], "document"),
        (["book.epub"], "document"),
        (["cours.mp4"], "video"),
        (["lecture.webm", "notes.pdf"], "video"),
        # youscribe_fr_audiobooks: one item, a list of tracks.
        (["Fables/01.ogg", "Fables/02.ogg"], "audio"),
        (["jeu.swf"], ""),
    ],
)
def test_an_item_is_a_document_a_video_or_audio(fp, media):
    assert nautilus.media_of({"fp": fp}) == media


def test_the_listing_round_trips():
    rows = [{"_id": "1", "ti": "L'île", "aut": "", "dsc": "", "fp": ["a.epub"]}]
    assert nautilus.parse(nautilus.listing_text(rows)) == rows


def test_the_catalog_reads_through_the_shared_parser(tmp_path):
    from libzim.reader import Archive

    path = fx.build_zim(
        str(tmp_path / "water.zim"), {"Scraper": NAUTILUS}, _water_entries(), "home"
    )
    got = search.parse_catalog(Archive(path))
    assert [i["ti"] for i in got] == [
        i["ti"] for i in nautilus.parse(fx.WATER_DATABASE)
    ]
    bare = fx.build_zim(
        str(tmp_path / "bare.zim"),
        {},
        {"home": ("text/html", "<html></html>", "Home")},
    )
    assert search.parse_catalog(Archive(bare)) is None


# ── a ZIM can feed two apps ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "kind,project,scraper,name,counter,history,feeds",
    [
        (
            "wiki",
            "wikisource",
            MWOFFLINER,
            "wikisource_eo_all",
            "",
            "",
            {"books": "wikisource"},
        ),
        (
            "wiki",
            "wikibooks",
            MWOFFLINER,
            "wikibooks_sv_all",
            "",
            "",
            {"books": "wikibooks"},
        ),
        ("wiki", "wikipedia", MWOFFLINER, "wikipedia_en_all", "", "", {}),
        # zimgit-water: documents only.
        (
            "",
            "",
            NAUTILUS,
            "zimgit-water_en",
            "application/pdf=7;image/png=2",
            "",
            {"books": "nautilus"},
        ),
        # maitre_lucas_planete_terre: PDFs and videos, in both apps.
        (
            "",
            "",
            NAUTILUS,
            "maitre_lucas_planete_terre_fr",
            "application/pdf=8;video/mp4=8",
            "",
            {"books": "nautilus", "tube": "nautilus"},
        ),
        # youscribe_fr_audiobooks: tracks only.
        (
            "",
            "",
            "nautiluszim 1.0.8",
            "youscribe_fr_audiobooks",
            "audio/ogg=530",
            "",
            {"tube": "nautilus"},
        ),
        # python-class-vc: its lessons are pages.
        (
            "",
            "",
            NAUTILUS,
            "python-class-vc_zh_all",
            "text/html=8",
            "",
            {"books": "nautilus"},
        ),
        (
            "",
            "",
            "mindtouch2zim v0.1.1",
            "libretexts.org_en_stats",
            "",
            "",
            {"books": "libretexts"},
        ),
        (
            "",
            "",
            "Zimi 1.12.0",
            "papers_en",
            "application/epub+zip=2;application/pdf=1",
            json.dumps([{"op": "created", "mode": "folder"}]),
            {"books": "folder"},
        ),
        (
            "",
            "",
            "Zimi 1.12.0",
            "clips_en",
            "video/mp4=3",
            json.dumps([{"op": "created", "mode": "folder"}]),
            {"tube": "folder"},
        ),
        (
            "",
            "",
            "Zimi 1.12.0",
            "notes_en",
            "text/html=3",
            json.dumps([{"op": "created", "mode": "folder"}]),
            {},
        ),
        # A captured site full of PDFs is not a folder of documents.
        (
            "",
            "",
            "Zimi 1.12.0",
            "site_en",
            "application/pdf=3",
            json.dumps([{"op": "created", "mode": "site"}]),
            {},
        ),
        (
            "",
            "",
            "warc2zim 2.3.1,zimit 3.1.3",
            "htdp.org_en_all",
            "text/html=15",
            "",
            {"books": "whole"},
        ),
        (
            "books",
            "",
            "gutenberg2zim-3.0.1",
            "gutenberg_en_all",
            "application/epub+zip=9",
            "",
            {},
        ),
    ],
)
def test_a_zim_feeds_apps_beside_its_kind(
    kind, project, scraper, name, counter, history, feeds
):
    assert srv._zim_feeds(kind, project, scraper, name, counter, history) == feeds


def test_what_a_zim_feeds_rides_the_list_and_the_cache(tmp_path, monkeypatch):
    """Decided once at load, from metadata the load reads anyway; a record
    from before is read once more, and only once."""
    wikisource = {
        p: ("text/html", html, title)
        for p, (html, title) in fx.WIKISOURCE_PAGES.items()
    }
    _library(
        tmp_path,
        monkeypatch,
        [
            (
                "zimgit-water_en_2024-08.zim",
                {"Scraper": NAUTILUS, "Name": "zimgit-water_en"},
                _water_entries(),
                "home",
            ),
            (
                "wikisource_eo_all_nopic_2026-07.zim",
                {"Scraper": MWOFFLINER, "Name": "wikisource_eo_all", "Language": "epo"},
                wikisource,
                "Vikifontaro:Ĉefpaĝo",
            ),
        ],
    )
    by = {z["file"][:-4]: z for z in srv.list_zims()}
    assert by["zimgit-water_en_2024-08"]["feeds"] == {"books": "nautilus"}
    assert by["wikisource_eo_all_nopic_2026-07"]["kind"] == "wiki"
    assert by["wikisource_eo_all_nopic_2026-07"]["feeds"] == {"books": "wikisource"}
    with open(srv._cache_file_path(), encoding="utf-8") as f:
        payload = json.load(f)
    assert payload["files"]["zimgit-water_en_2024-08.zim"]["feeds"] == {
        "books": "nautilus"
    }

    # A record written before feeds existed.
    for rec in payload["files"].values():
        rec.pop("feeds", None)
    with open(srv._cache_file_path(), "w", encoding="utf-8") as f:
        json.dump(payload, f)
    calls = []
    real = srv._read_zim_feeds
    monkeypatch.setattr(
        srv, "_read_zim_feeds", lambda *a: calls.append(a[0]) or real(*a)
    )
    srv.load_cache(force=False)
    assert len(calls) == 2
    by = {z["file"][:-4]: z for z in srv.list_zims()}
    assert by["wikisource_eo_all_nopic_2026-07"]["feeds"] == {"books": "wikisource"}
    srv.load_cache(force=False)
    assert len(calls) == 2, "the backfill was not written down"


# ── Zimi's own folder ZIMs ─────────────────────────────────────────────────


def _documents_folder(tmp_path):
    src = tmp_path / "Reading room"
    (src / "books").mkdir(parents=True)
    (src / "books" / "aleutian.epub").write_bytes(fx.gutenberg_epub())
    (src / "the_long-walk.pdf").write_bytes(fx.PDF)
    (src / "notes.md").write_text("# Notes\n\nWhat to read next.\n")
    return src


def test_a_folder_of_documents_lists_them_as_a_document_library(tmp_path, monkeypatch):
    """At create time, in nautilus's shape: title, author, date and cover
    from the EPUB's package; a PDF by its Info (PyMuPDF) or its name."""
    from libzim.reader import Archive

    from zimi import creator

    monkeypatch.setattr(srv, "HAS_PYMUPDF", False)
    info = creator.create_folder_zim(
        str(_documents_folder(tmp_path)), out_dir=str(tmp_path / "out")
    )
    archive = Archive(info["path"])
    rows = nautilus.items(archive, nautilus.ZIMI_DATABASE_PATH)
    by = {r["fp"][0]: r for r in rows}
    assert set(by) == {"books/aleutian.epub", "the_long-walk.pdf"}
    book = by["books/aleutian.epub"]
    assert book["ti"].startswith("Aleutian Indian and English Dictionary")
    assert book["aut"] == "Charles A. Lee" and book["dt"] == "2003-11-01"
    assert book["cv"] == "books/aleutian.epub/" + fx.GUTENBERG_EPUB_COVER
    assert by["the_long-walk.pdf"]["ti"] == "the long-walk"
    assert by["the_long-walk.pdf"]["aut"] == ""
    # The files themselves, and nothing else listed.
    assert nautilus.files_of(book, "") == ["books/aleutian.epub"]
    assert archive.has_entry_by_path("books/aleutian.epub")
    # On the shelf by what the load reads anyway: the creation record's
    # mode and the Counter of mimetypes.
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path / "out"))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    assert [z.get("feeds") for z in srv.list_zims()] == [{"books": "folder"}]


def test_a_pdfs_own_info_names_it_when_pymupdf_is_there(tmp_path):
    from zimi import creator

    if not srv.HAS_PYMUPDF:
        pytest.skip("PyMuPDF is not installed")
    doc = srv.fitz.open()
    doc.new_page()
    doc.set_metadata(
        {
            "title": "The Long Walk",
            "author": "Slavomir Rawicz",
            "creationDate": "D:19560301",
        }
    )
    path = tmp_path / "walk.pdf"
    doc.save(str(path))
    got = creator._folder_documents([(str(path), "walk.pdf")])
    assert got[0]["ti"] == "The Long Walk" and got[0]["aut"] == "Slavomir Rawicz"
    assert got[0]["dt"] == "1956-03-01"


def test_a_folder_without_documents_writes_no_listing(tmp_path):
    from libzim.reader import Archive

    from zimi import creator

    src = tmp_path / "notes"
    src.mkdir()
    (src / "a.md").write_text("# A\n")
    info = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))
    assert not Archive(info["path"]).has_entry_by_path(nautilus.ZIMI_DATABASE_PATH)


# ── EPUBs read in the browser ──────────────────────────────────────────────

# A chapter a hostile EPUB could carry, added to the real book's spine.
HOSTILE = (
    '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
    "<head><title>x</title><script>alert(1)</script></head><body>"
    '<h2 onclick="alert(2)">Chapter Two</h2><a id="k"/>After the anchor.'
    '<script src="evil.js"></script><img src="images/../2284091321212351877_10040-cover.png"/>'
    '<a href="7315379960072063660_10040-0-0.txt.xhtml#id00010">the preface</a>'
    '<a href="../../../../etc/passwd">out</a><a href="javascript:alert(3)">js</a>'
    '<a href="https://www.gutenberg.org">site</a></body></html>'
)


def _hostile_epub():
    opf = fx.GUTENBERG_EPUB["OEBPS/content.opf"]
    opf = opf.replace(
        "</manifest>",
        '<item href="hostile.xhtml" id="hostile" media-type="application/xhtml+xml"/></manifest>',
    ).replace("</spine>", '<itemref idref="hostile"/></spine>')
    data = fx.gutenberg_epub({"OEBPS/hostile.xhtml": HOSTILE})
    import io
    import zipfile

    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for info in src.infolist():
            body = opf if info.filename == "OEBPS/content.opf" else src.read(info)
            z.writestr(info.filename, body)
    return buf.getvalue()


def test_an_epub_is_one_page_of_its_chapters():
    from zimi import epub

    book = epub.Book(fx.gutenberg_epub())
    page = book.page().decode()
    assert book.title.startswith("Aleutian Indian and English Dictionary")
    assert book.creators == ["Charles A. Lee"] and book.language == "en"
    assert book.cover == fx.GUTENBERG_EPUB_COVER
    # What the reader reads: Dublin Core in the head, as a Gutenberg page has.
    assert '<meta name="dc.creator" content="Charles A. Lee">' in page
    assert '<meta name="zimi-book" content="epub">' in page and 'lang="en"' in page
    # The chapters in spine order; the cover's wrapper, with nothing to read, is not one.
    assert page.index('id="zb-c1"') < page.index('id="zb-c2"')
    assert 'id="zb-c0"' not in page and "<svg" not in page
    assert "PREFACE" in page and "END OF THE PROJECT GUTENBERG EBOOK" in page


def test_nothing_inside_an_epub_is_trusted():
    from zimi import epub

    assert epub.member_name("OEBPS", "../../etc/passwd") is None
    assert epub.member_name("", "/etc/passwd") is None
    assert epub.member_name("OEBPS", "https://x.org/a.png") is None
    assert epub.member_name("OEBPS/Text", "../Images/a%20b.png#x") == "OEBPS/Images/a b.png"
    page = epub.Book(_hostile_epub()).page().decode()
    body = page.split('id="zb-c3"', 1)[1]
    assert "<script" not in body and "onclick" not in body and "alert(3)" not in body
    # <a id="k"/> in XHTML is an empty anchor, not one around the rest of the chapter.
    assert '<a id="k"></a>After the anchor.' in body
    # A picture resolves inside the book; a link to a chapter lands in the page.
    assert 'src="OEBPS/2284091321212351877_10040-cover.png"' in body
    assert 'href="#id00010"' in body
    assert 'href="https://www.gutenberg.org"' in body
    # An entity-laden package (billion laughs, XXE) is refused, not expanded.
    bomb = fx.GUTENBERG_EPUB["OEBPS/content.opf"].replace(
        "<package", '<!DOCTYPE package [<!ENTITY a "aaaaaaaaaa">]><package', 1
    )
    with pytest.raises(epub.EpubError):
        epub.Book(_swap(fx.gutenberg_epub(), "OEBPS/content.opf", bomb))


def _swap(data, name, text):
    import io
    import zipfile

    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for info in src.infolist():
            z.writestr(info.filename, text if info.filename == name else src.read(info))
    return buf.getvalue()


def test_an_epub_member_over_its_bound_is_not_read(monkeypatch):
    from zimi import epub

    book = epub.Book(fx.gutenberg_epub())
    monkeypatch.setattr(epub, "MAX_MEMBER_BYTES", 16)
    assert book.read(fx.GUTENBERG_EPUB_COVER, epub.MAX_MEMBER_BYTES) is None
    assert book.read("OEBPS/../../x") is None


GUTENBERG_EPUB_ONLY = {
    "Home.html": ("text/html", "<html><body>Home</body></html>", "Home"),
    "full_by_popularity.js": (
        "text/javascript",
        'var json_data = [["Aleutian Indian and English Dictionary", "Charles A. Lee", "010", 10040, "PM"]];',
        "",
    ),
    "languages.js": ("text/javascript", 'var languages_json_data = [["English", "en", 1]];', ""),
    "Aleutian Indian and English Dictionary_cover.10040": (
        "text/html",
        "<html><body>cover</body></html>",
        "",
    ),
    "Aleutian Indian and English Dictionary.10040.epub": (
        "application/epub+zip",
        fx.gutenberg_epub(),
        "",
    ),
}


@pytest.fixture
def served_epub(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi import books, epub
    from zimi.http import ZimHandler

    monkeypatch.setattr(books, "request_details", lambda name: None)
    books._reset_for_tests()
    epub._reset_for_tests()
    _library(
        tmp_path,
        monkeypatch,
        [
            ("gutenberg_ale_all_2025-09.zim",
             {"Scraper": "gutenberg2zim-2.2.0", "Name": "gutenberg_ale_all", "Language": "ale"},
             GUTENBERG_EPUB_ONLY, "Home.html"),
        ],
    )
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _fetch(url):
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, headers={"Sec-Fetch-Dest": "iframe"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read(), e.headers


def test_an_epub_in_a_zim_opens_as_a_book(served_epub):
    """Before 1.12 an EPUB could only be downloaded: a browser cannot show
    one, and Gutenberg's EPUB-only books had nothing to open."""
    from urllib.parse import quote

    zim = srv.list_zims()[0]["name"]
    book = served_epub + "/w/" + zim + "/" + quote("Aleutian Indian and English Dictionary.10040.epub")
    status, ctype, body, _h = _fetch(book + "/")
    assert status == 200 and ctype.startswith("text/html")
    assert b'<meta name="zimi-book" content="epub">' in body and b"PREFACE" in body
    status, ctype, body, _h = _fetch(book + "/" + quote(fx.GUTENBERG_EPUB_COVER))
    assert status == 200 and ctype == "image/png" and body == fx.PNG
    assert _fetch(book + "/OEBPS/missing.png")[0] == 404
    assert _fetch(book + "/" + quote("../../META-INF/container.xml"))[0] == 404
    # The file itself still downloads.
    status, ctype, _b, headers = _fetch(book)
    assert status == 200 and "attachment" in (headers.get("Content-Disposition") or "")
