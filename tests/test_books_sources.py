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


def test_what_a_zim_feeds_is_decided_again_under_a_newer_rule(tmp_path, monkeypatch):
    """Stamped with the version of the rules that decided it, as a ZIM's
    kind is: a rule _zim_feeds learns later reaches the ZIMs already in the
    cache, once. Before, a record with any feeds at all was never read
    again."""
    _library(tmp_path, monkeypatch, [_water()])
    with open(srv._cache_file_path(), encoding="utf-8") as f:
        rec = json.load(f)["files"]["zimgit-water_en_2024-08.zim"]
    assert rec["feeds"] == {"books": "nautilus"}
    assert rec["feeds_v"] == srv.FEEDS_VERSION
    calls = []
    real = srv._read_zim_feeds
    monkeypatch.setattr(
        srv, "_read_zim_feeds", lambda *a: calls.append(a[0]) or real(*a)
    )
    srv.load_cache(force=False)
    assert calls == []
    monkeypatch.setattr(srv, "FEEDS_VERSION", srv.FEEDS_VERSION + 1)
    srv.load_cache(force=False)
    assert len(calls) == 1
    srv.load_cache(force=False)
    assert len(calls) == 1, "the newer version was not written down"


# ── Zimi's own folder ZIMs ─────────────────────────────────────────────────


def _documents_folder(tmp_path):
    src = tmp_path / "Reading room"
    (src / "books").mkdir(parents=True)
    (src / "books" / "aleutian.epub").write_bytes(fx.gutenberg_epub())
    (src / "the_long-walk.pdf").write_bytes(fx.PDF)
    (src / "notes.md").write_text("# Notes\n\nWhat to read next.\n", encoding="utf-8")
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
    (src / "a.md").write_text("# A\n", encoding="utf-8")
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


def _hostile_epub(chapter=None):
    opf = fx.GUTENBERG_EPUB["OEBPS/content.opf"]
    opf = opf.replace(
        "</manifest>",
        '<item href="hostile.xhtml" id="hostile" media-type="application/xhtml+xml"/></manifest>',
    ).replace("</spine>", '<itemref idref="hostile"/></spine>')
    data = fx.gutenberg_epub({"OEBPS/hostile.xhtml": chapter or HOSTILE})
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
    assert (
        epub.member_name("OEBPS/Text", "../Images/a%20b.png#x")
        == "OEBPS/Images/a b.png"
    )
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
    "languages.js": (
        "text/javascript",
        'var languages_json_data = [["English", "en", 1]];',
        "",
    ),
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
            (
                "gutenberg_ale_all_2025-09.zim",
                {
                    "Scraper": "gutenberg2zim-2.2.0",
                    "Name": "gutenberg_ale_all",
                    "Language": "ale",
                },
                GUTENBERG_EPUB_ONLY,
                "Home.html",
            ),
        ],
    )
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    # The pools are keyed by name, and this ZIM's ("gutenberg") is another test's too.
    srv.release_zim_handles(list(srv.get_zim_files()))


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
    book = (
        served_epub
        + "/w/"
        + zim
        + "/"
        + quote("Aleutian Indian and English Dictionary.10040.epub")
    )
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


# ── the shelf beyond Gutenberg ─────────────────────────────────────────────


def _mime(path):
    if path.endswith(".js"):
        return "text/javascript"
    if path.endswith(".jpg"):
        return "image/jpeg"
    return "text/html"


def _gutenberg():
    import test_books

    entries = {p: (_mime(p), data, "") for p, data in test_books.LATIN.items()}
    entries["Home.html"] = ("text/html", "<html><body>Home</body></html>", "Home")
    return (
        "gutenberg_la_all_2026-01.zim",
        {
            "Scraper": "gutenberg2zim-3.0.1",
            "Name": "gutenberg_la_all",
            "Language": "lat",
        },
        entries,
        "Home.html",
    )


def _water():
    return (
        "zimgit-water_en_2024-08.zim",
        {
            "Scraper": NAUTILUS,
            "Name": "zimgit-water_en",
            "Title": "Water Treatment Library",
        },
        _water_entries(),
        "home",
    )


def _lessons():
    """python-class-vc: a PDF lesson, a lesson as a page; and a video item,
    maitre_lucas's shape, which is ZimiTube's."""
    listing = fx.PYTHON_CLASS_DATABASE.replace(
        "];",
        "{'_id': '00002', 'ti': 'Vidéo', 'dsc': '', 'aut': 'Maître Lucas', 'fp': ['cours.mp4']},\n];",
    )
    return (
        "python-class-vc_zh_all_2026-02.zim",
        {"Scraper": NAUTILUS, "Name": "python-class-vc_zh_all", "Language": "zho"},
        {
            "home": ("text/html", "<html><body>Python</body></html>", "Home"),
            "database.js": ("text/javascript", listing, ""),
            "files/class 1_python introduction.pdf": ("application/pdf", fx.PDF, ""),
            "files/class 2_variable_type.html": (
                "text/html",
                "<html><body>變數</body></html>",
                "",
            ),
            "files/cours.mp4": ("video/mp4", b"\x00\x00\x00\x18ftypmp42", ""),
        },
        "home",
    )


def _wikisource():
    entries = {
        p: ("text/html", html, title)
        for p, (html, title) in fx.WIKISOURCE_PAGES.items()
    }
    for p in fx.WIKISOURCE_SCANS:
        entries[p] = ("text/html", "<html><body>scan</body></html>", p)
    return (
        "wikisource_eo_all_nopic_2026-07.zim",
        {"Scraper": MWOFFLINER, "Name": "wikisource_eo_all", "Language": "epo"},
        entries,
        "Vikifontaro:Ĉefpaĝo",
    )


def _wikibooks():
    entries = {
        p: ("text/html", "<html><body><h1>%s</h1></body></html>" % t, t)
        for p, t in fx.WIKIBOOKS_PAGES.items()
    }
    return (
        "wikibooks_sv_all_nopic_2026-07.zim",
        {"Scraper": MWOFFLINER, "Name": "wikibooks_sv_all", "Language": "swe"},
        entries,
        "Wikibooks:Huvudsida",
    )


def _libretexts():
    shared = json.loads(fx.LIBRETEXTS_SHARED)
    entries = {
        "index.html": (
            "text/html",
            "<html><body><div id=app></div></body></html>",
            "Statistics",
        ),
        "content/shared.json": ("application/json", fx.LIBRETEXTS_SHARED, ""),
    }
    for p in shared["pages"]:
        # Every page has its address, a redirect into the ZIM's own app.
        entries[f"index/page_{p['id']}"] = (
            "text/html",
            fx.LIBRETEXTS_REDIRECT.replace(
                "Bookshelves/Probability_Theory/Probability_Mathematical_Statistics_and_Stochastic_Processes_(Siegrist)",
                p["path"],
            ),
            p["title"],
        )
    return (
        "libretexts.org_en_stats_2026-01.zim",
        {
            "Scraper": "mindtouch2zim v0.1.1",
            "Name": "libretexts.org_en_stats",
            "Title": "Statistics LibreTexts",
        },
        entries,
        "index.html",
    )


def _htdp():
    return (
        "htdp.org_en_all_2026-08.zim",
        {
            "Scraper": "warc2zim 2.3.1,Browsertrix-Crawler 1.14.1 (with warcio.js 2.4.11),zimit 3.1.3",
            "Name": "htdp.org_en_all",
            "Title": "How to Design Programs",
            "Description": "Introductory book focused on the program design process",
            "Creator": "-",
        },
        {
            "htdp.org/2020-8-1/Book/index.html": (
                "text/html",
                "<html><body><h1>How to Design Programs</h1></body></html>",
                "HtDP",
            )
        },
        "htdp.org/2020-8-1/Book/index.html",
    )


@pytest.fixture
def shelf_lib(tmp_path, monkeypatch):
    """A library of every family, read as the startup worker reads it."""
    from zimi import books, epub

    books._reset_for_tests()
    epub._reset_for_tests()

    def build(zims, details=True):
        _library(tmp_path, monkeypatch, zims)
        books._reset_for_tests()
        if details:
            books.build_all_details()
            books._builder.wait()
            books._sources.wait()
        return {z["file"][:-4]: z["name"] for z in srv.list_zims()}

    yield build
    books._reset_for_tests()
    srv.release_zim_handles(list(srv.get_zim_files()))


def _titles(**kw):
    from zimi import books

    return [b["title"] for b in books.listing(limit=200, **kw)["books"]]


def test_kiwix_document_libraries_are_on_the_shelf(shelf_lib):
    from zimi import books

    names = shelf_lib([_gutenberg(), _water(), _lessons()])
    water, lessons = (
        names["zimgit-water_en_2024-08"],
        names["python-class-vc_zh_all_2026-02"],
    )
    home = books.home()
    assert home["details"] is True
    assert {s["reader"] for s in home["sources"]} == {"gutenberg", "nautilus"}
    got = books.listing(zim=water, limit=50)
    assert got["total"] == 7
    first = got["books"][0]
    assert first["title"] == "Distillation For Home Water Treatment"
    assert first["author"] == "Michigan State University" and first["lang"] == "en"
    assert first["path"] == "files/Water (1).pdf" and first["format"] == "pdf"
    assert first["id"] == water + "/00000" and first["source"] == "nautilus"
    one = books.book(water, first["id"])
    assert one["description"] == "For people with a water quality problem"
    # A lesson as a page opens as one; the video is ZimiTube's, not a book.
    assert {b["title"]: b["path"] for b in books.listing(zim=lessons)["books"]} == {
        "1. Python 程式設計的第一步": "files/class 1_python introduction.pdf",
        "2. 從變數到型態": "files/class 2_variable_type.html",
    }
    # Gutenberg's books are still the most read; the others follow.
    assert _titles()[0] == "Aeneidos" and books.home()["total"] == 6 + 7 + 2
    # Found by a word, by author.
    assert _titles(q="giardia") == ["Giardia: Drinking Water Factsheet"]
    assert _titles(author="Michigan State University") == [
        "Distillation For Home Water Treatment"
    ]


def test_opening_the_shelf_reads_no_zim_of_the_other_families(shelf_lib, monkeypatch):
    """The other families are read in the background; the shelf opens on
    what is read, and says the rest is coming."""
    from zimi import books, booksources

    asked = []
    request, books_in = books.request_sources, booksources.books_in
    monkeypatch.setattr(books, "request_sources", asked.append)
    monkeypatch.setattr(booksources, "books_in", lambda *a: pytest.fail("read on open"))
    names = shelf_lib([_gutenberg(), _water()], details=False)
    books._builder.keep(
        names["gutenberg_la_all_2026-01"],
        srv.get_zim_files()[names["gutenberg_la_all_2026-01"]],
        {},
    )
    home = books.home()
    assert home["total"] == 6 and home["details"] is False
    assert asked == [names["zimgit-water_en_2024-08"]]
    monkeypatch.setattr(books, "request_sources", request)
    monkeypatch.setattr(booksources, "books_in", books_in)
    books._sources.build_one(names["zimgit-water_en_2024-08"])
    home = books.home()
    assert home["total"] == 13 and home["details"] is True


def test_libretexts_textbooks_from_the_page_tree(shelf_lib):
    from zimi import books

    names = shelf_lib([_libretexts()])
    got = books.listing(sort="popular", limit=50)["books"]
    # The library's shelves first; the Workbench, and a page with no chapters, are not books.
    assert [b["title"] for b in got] == [
        "Probability, Mathematical Statistics, and Stochastic Processes (Siegrist)",
        "Graduate-Level Statistics in Psychology",
    ]
    siegrist = books.book("", got[0]["id"])
    assert (
        siegrist["author"] == "Siegrist" and siegrist["subject"] == "Probability Theory"
    )
    assert siegrist["chapters"] == 20 and siegrist["path"] == "index/page_10114"
    assert "author" not in books.book("", got[1]["id"])
    assert srv.list_zims()[0]["name"] == names["libretexts.org_en_stats_2026-01"]


def test_wikisource_works_are_on_the_shelf_and_stay_in_zimipedia(shelf_lib):
    from zimi import books, wiki

    names = shelf_lib([_wikisource()])
    name = names["wikisource_eo_all_nopic_2026-07"]
    entry = srv.list_zims()[0]
    assert entry["kind"] == "wiki" and entry["project"] == "wikisource"
    assert wiki.is_wiki(name)
    got = {b["title"]: b for b in books.listing(limit=50)["books"]}
    # Scans, the index of a scan, the project's page and a periodical's article are not works.
    assert set(got) == {
        "Adjuvilo",
        'Adresaro de la personoj kiuj ellernis la lingvon "Esperanto"',
        "Adiaŭa letero de Stefan Zweig",
        "Aforismoj (Lanti, 1946)",
    }
    adj = books.book(name, got["Adjuvilo"]["id"])
    assert adj["author"] == "Claudius Colas" and adj["translator"] == "Roy McCoy"
    assert adj["year"] == 1910 and adj["era"] == 1900 and adj["chapters"] == 3
    assert adj["path"] == "Adjuvilo" and adj["lang"] == "eo"
    # The older header (ids, not classes) is read too.
    assert (
        got['Adresaro de la personoj kiuj ellernis la lingvon "Esperanto"']["year"]
        == 1889
    )
    # Longest first.
    assert _titles()[0] == "Adjuvilo"


def test_wikibooks_are_books_by_their_pages(shelf_lib):
    from zimi import books

    shelf_lib([_wikibooks()])
    got = books.listing(limit=50)["books"]
    # Two pages under it are not a book; nor pages with no contents page,
    # nor the project's own.
    assert [b["title"] for b in got] == [
        "Berimbau - en handbok för nya capoerister",
        "Poker",
    ]
    assert got[1]["path"] == "Poker" and got[1]["lang"] == "sv"
    assert "author" not in got[1]


def test_a_zim_that_is_one_book(shelf_lib, tmp_path):
    from zimi import books

    names = shelf_lib([_htdp(), _water()])
    htdp, water = names["htdp.org_en_all_2026-08"], names["zimgit-water_en_2024-08"]
    got = books.listing(zim=htdp)["books"]
    assert [(b["title"], b["path"]) for b in got] == [
        ("How to Design Programs", "htdp.org/2020-8-1/Book/index.html")
    ]
    assert books.book(htdp, got[0]["id"])["description"].startswith("Introductory book")
    # By hand: off the shelf, and a ZIM of another family on it as one book.
    assert books.set_whole(htdp, False) == ""
    assert books.listing(zim=htdp)["total"] == 0
    assert books.set_whole(water, None) == "nautilus"
    # Kept across a restart.
    books._whole.update(loaded=False, names={})
    books._shelf["key"] = None
    assert books.listing(zim=htdp)["total"] == 0
    books.set_whole(htdp, None)
    assert books.listing(zim=htdp)["total"] == 1


def test_a_zim_can_be_put_on_the_shelf_by_hand(shelf_lib):
    from zimi import books

    other = (
        "survival-guide_en_all_2026-01.zim",
        {
            "Scraper": "zimit 3.1.3",
            "Name": "survival-guide_en_all",
            "Title": "Survival Guide",
        },
        {"index.html": ("text/html", "<html><body>Guide</body></html>", "Guide")},
        "index.html",
    )
    names = shelf_lib([other])
    name = names["survival-guide_en_all_2026-01"]
    assert books.home()["total"] == 0
    assert books.set_whole(name, True) == "whole"
    assert _titles() == ["Survival Guide"]


def test_a_folder_zim_from_before_the_listing_shows_its_files(shelf_lib):
    """A folder of documents packed by 1.11 has no listing: its PDFs and
    EPUBs are there by their files, an EPUB titled from its own package."""
    from zimi import books

    old = (
        "reading-room_en_2026-09.zim",
        {
            "Scraper": "Zimi 1.11.0",
            "Name": "reading-room_en",
            "X-Zimi-History": json.dumps(
                [{"op": "created", "mode": "folder", "ts": 1}]
            ),
        },
        {
            "index": (
                "text/html",
                "<html><body>Reading room</body></html>",
                "Reading room",
            ),
            "field_guide-1956.pdf": ("application/pdf", fx.PDF, "field_guide-1956.pdf"),
            "books/aleutian.epub": (
                "application/epub+zip",
                fx.gutenberg_epub(),
                "aleutian.epub",
            ),
        },
        "index",
    )
    names = shelf_lib([old])
    got = {b["title"]: b for b in books.listing(limit=50)["books"]}
    assert set(got) == {
        "field guide-1956",
        "Aleutian Indian and English Dictionary / Common Words in the Dialects of the Aleutian Indian Language as Spoken by the Oogashik, Egashik, Anangashuk and Misremie Tribes Around Sulima River and Neighboring Parts of the Alaska Peninsula",
    }
    ebook = [b for t, b in got.items() if t.startswith("Aleutian")][0]
    assert (
        ebook["path"] == "books/aleutian.epub/" and ebook["author"] == "Charles A. Lee"
    )
    assert ebook["cover"] == "books/aleutian.epub/" + fx.GUTENBERG_EPUB_COVER
    assert ebook["year"] == 2003 and ebook["format"] == "epub"
    one = books.book(names["reading-room_en_2026-09"], ebook["id"])
    assert one["epub"] == "books/aleutian.epub"


def test_a_folder_zim_made_now_is_on_the_shelf_from_its_listing(
    shelf_lib, tmp_path, monkeypatch
):
    from zimi import books, creator

    monkeypatch.setattr(srv, "HAS_PYMUPDF", False)
    out = tmp_path / "zims"
    out.mkdir()
    creator.create_folder_zim(str(_documents_folder(tmp_path)), out_dir=str(out))
    shelf_lib([])
    got = {b["title"]: b for b in books.listing(limit=50)["books"]}
    assert "the long-walk" in got
    ebook = [b for t, b in got.items() if t.startswith("Aleutian")][0]
    assert ebook["source"] == "folder" and ebook["path"] == "books/aleutian.epub/"


def test_a_restricted_account_sees_only_the_shelves_it_may_read(shelf_lib, monkeypatch):
    from zimi import books

    names = shelf_lib([_gutenberg(), _water()])
    water = names["zimgit-water_en_2024-08"]
    monkeypatch.setattr(srv, "zim_allowed", lambda name: name == water)
    books._shelf["key"] = None
    assert books.home()["total"] == 7
    assert books.book("", water + "/00000")["zim"] == water
    monkeypatch.setattr(srv, "zim_allowed", lambda name: name != water)
    books._shelf["key"] = None
    assert books.book(water, water + "/00000") is None


def test_a_book_of_another_family_through_http(shelf_lib):
    from http.server import ThreadingHTTPServer
    import threading
    import urllib.parse
    import urllib.request

    from zimi.http import ZimHandler

    names = shelf_lib([_water()])
    water = names["zimgit-water_en_2024-08"]
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    try:
        url = base + "/books/book?zim=%s&id=%s" % (
            water,
            urllib.parse.quote(water + "/00003"),
        )
        with urllib.request.urlopen(url, timeout=10) as r:
            got = json.loads(r.read())
        assert got["title"] == "Plants as Indicator of Ground Water"
        assert got["author"] == "Oscar Edward MEinzer" and got["format"] == "pdf"
    finally:
        httpd.shutdown()


def test_manage_puts_a_zim_on_the_shelf_as_one_book(shelf_lib):
    from http.server import ThreadingHTTPServer
    import threading
    import urllib.error
    import urllib.request

    from zimi import books
    from zimi.http import ZimHandler

    other = (
        "survival-guide_en_all_2026-01.zim",
        {"Scraper": "zimit 3.1.3", "Name": "survival-guide_en_all", "Title": "Survival Guide"},
        {"index.html": ("text/html", "<html><body>Guide</body></html>", "Guide")},
        "index.html",
    )
    name = shelf_lib([other])["survival-guide_en_all_2026-01"]
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]

    def post(body):
        req = urllib.request.Request(
            base + "/manage/books/whole",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, {}

    try:
        assert post({"zim": name, "whole": True}) == (
            200,
            {"zim": name, "whole": True, "reader": "whole"},
        )
        assert _titles() == ["Survival Guide"]
        with urllib.request.urlopen(base + "/manage/books/whole", timeout=10) as r:
            assert json.loads(r.read()) == {"zims": {name: True}}
        assert post({"zim": "nope", "whole": True})[0] == 404
        assert post({"zim": name, "whole": "yes"})[0] == 400
        assert post({"zim": name, "whole": None})[1]["reader"] == ""
        assert books.home()["total"] == 0
    finally:
        httpd.shutdown()


def test_an_epub_reads_in_the_e_reader_on_a_phone(served_epub):
    """Gutenberg's EPUB-only book, from the shelf's own path for it, in a
    real browser at 390px: Zimi's header away, the book's own chrome, its
    title and author from the package, pages to turn, the place kept."""
    import zimi.renderer as renderer
    from zimi import books

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    card = books.listing()["books"][0]
    assert card["path"] == "Aleutian Indian and English Dictionary.10040.epub/"
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(**pw.devices["iPhone 13"]).new_page()
        try:
            pg.goto(served_epub + "/")
            pg.wait_for_function(
                "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
                timeout=30000,
            )
            pg.evaluate("(b) => openArticle(b.zim, b.path)", card)
            pg.wait_for_function(
                "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.querySelector('.zb-foot'); }",
                timeout=30000,
            )
            pg.wait_for_timeout(500)
            got = pg.evaluate(
                """() => { var f = document.getElementById('reader-frame'), d = f.contentDocument;
                  return { title: d.querySelector('.zb-title b').textContent, author: d.querySelector('.zb-title span').textContent,
                    paged: d.documentElement.classList.contains('zb-paged'), held: document.body.classList.contains('chrome-held'),
                    text: d.body.textContent.indexOf('PREFACE') >= 0 }; }"""
            )
            assert got["title"].startswith("Aleutian Indian and English Dictionary")
            assert got["author"] == "Charles A. Lee" and got["text"]
            assert got["paged"] and got["held"]
            pg.touchscreen.tap(365, 420)
            pg.wait_for_timeout(1200)
            # Reading positions live in the Saved store (1.12), keyed by the
            # ZIM's short name and the book's path.
            where = pg.evaluate("(k) => { var p = Saved.position(k); return p && p.where; }", card["zim"] + "\n" + card["path"])
            assert where, "turning a page keeps the place in this EPUB"
        finally:
            br.close()


def test_a_kept_epub_is_not_served_to_an_account_that_may_not_read_it(
    served_epub, monkeypatch
):
    from zimi import epub

    zim = srv.list_zims()[0]["name"]
    path = "Aleutian Indian and English Dictionary.10040.epub/"
    assert epub.respond(zim, path)[1]  # read, and kept
    monkeypatch.setattr(srv, "zim_allowed", lambda name: False)
    assert epub.respond(zim, path) is None


def test_newest_to_gutenberg_holds_only_gutenberg_books(shelf_lib):
    from zimi import books

    shelf_lib([_water(), _wikibooks()])
    home = books.home()
    assert home["details"] is True and home["total"] == 9
    assert home["recent"] == []


# ── no script of a book runs ───────────────────────────────────────────────

# The classic ways past a regex sanitizer, each of which would set a mark in
# the shell (the reader's frame's parent) if it ran.
BYPASS = (
    '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
    "<head><title>Bypass</title></head><body><h2>Bypass</h2><p>A chapter with a past.</p>"
    "<svg><script>window.parent.__pwned='svg-script'</script></svg>"
    "<img src=x onerror=\"window.parent.__pwned='img-onerror'\">"
    "<img/src=\"x\"/onerror=\"window.parent.__pwned='img-slash'\">"
    "<img src=\"x\"onerror=\"window.parent.__pwned='img-quote'\">"
    "<IMG\tSRC=x\tONERROR=\"window.parent.__pwned='img-tab'\">"
    "<a id=\"js\" href=\"jav&#x09;ascript:window.parent.__pwned='js-url'\">a link</a>"
    "<iframe srcdoc=\"<script>window.parent.parent.__pwned='srcdoc'</script>\"></iframe>"
    "<details open ontoggle=\"window.parent.__pwned='toggle'\"><summary>more</summary>x</details>"
    "</body></html>"
)
_BYPASS_MARKS = (
    "svg-script", "img-onerror", "img-slash", "img-quote", "img-tab", "js-url", "srcdoc", "toggle",
)


@pytest.fixture
def served_bypass(tmp_path, monkeypatch):
    """A ZIM holding an EPUB whose last chapter is BYPASS, served."""
    from http.server import ThreadingHTTPServer
    import threading

    from zimi import epub
    from zimi.http import ZimHandler

    epub._reset_for_tests()
    _library(
        tmp_path,
        monkeypatch,
        [
            (
                "bypass_en_2026-09.zim",
                {"Name": "bypass_en"},
                {
                    "index": ("text/html", "<html><body>Books</body></html>", "Books"),
                    "bypass.epub": ("application/epub+zip", _hostile_epub(BYPASS), ""),
                },
                "index",
            )
        ],
    )
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], srv.list_zims()[0]["name"]
    httpd.shutdown()
    epub._reset_for_tests()
    srv.release_zim_handles(list(srv.get_zim_files()))


def test_every_answer_from_inside_an_epub_blocks_its_scripts(served_bypass):
    """The guarantee, whatever gets past the strip: the book's page, a
    chapter opened on its own and a picture (an SVG is a document too) all
    carry a policy under which no script runs."""
    base, zim = served_bypass
    book = base + "/w/" + zim + "/bypass.epub/"
    for url in (book, book + "OEBPS/hostile.xhtml", book + fx.GUTENBERG_EPUB_COVER):
        status, _ctype, _body, headers = _fetch(url)
        csp = headers.get("Content-Security-Policy") or ""
        assert status == 200, url
        for rule in ("script-src 'none'", "object-src 'none'", "base-uri 'none'", "frame-src 'none'"):
            assert rule in csp, (url, rule, csp)
        assert "'unsafe-inline'" not in csp.split("script-src", 1)[1].split(";")[0]
        assert headers.get("X-Content-Type-Options") == "nosniff"


def test_the_strip_drops_the_classic_bypasses_too():
    """The second layer: what the policy blocks is not sent either."""
    from zimi import epub

    page = epub.Book(_hostile_epub(BYPASS)).page().decode()
    chapter = page.split('id="zb-c3"', 1)[1]
    low = chapter.lower()
    for bad in ("<script", "onerror", "ontoggle", "srcdoc", "<iframe", "ascript:"):
        assert bad not in low, bad
    assert 'id="js" href="#"' in chapter and "A chapter with a past." in chapter


def _open_in_the_reader(base, zim, path):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(**pw.devices["iPhone 13"]).new_page()
        try:
            pg.goto(base + "/")
            pg.wait_for_function(
                "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
                timeout=30000,
            )
            pg.evaluate("(a) => openArticle(a[0], a[1])", [zim, path])
            pg.wait_for_function(
                "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.querySelector('.zb-foot'); }",
                timeout=30000,
            )
            pg.wait_for_timeout(800)
            # Follow the javascript: link as a reader's tap would.
            pg.evaluate(
                "() => { var a = document.getElementById('reader-frame').contentDocument.getElementById('js'); if (a) a.click(); }"
            )
            pg.wait_for_timeout(800)
            return pg.evaluate(
                """() => { var d = document.getElementById('reader-frame').contentDocument;
                  return { pwned: window.__pwned === undefined ? null : String(window.__pwned),
                    text: d.body.textContent.indexOf('A chapter with a past.') >= 0,
                    handlers: d.querySelectorAll('[onerror],[ontoggle],iframe[srcdoc],svg script').length }; }"""
            )
        finally:
            br.close()


def test_a_chapter_that_gets_past_the_strip_still_runs_nothing(served_bypass, monkeypatch):
    """With the strip turned off entirely, every bypass reaches the reader,
    and the policy alone keeps each one from running."""
    import zimi.renderer as renderer
    from zimi import epub

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    monkeypatch.setattr(epub, "_chapter_body", epub._body_of)
    monkeypatch.setattr(epub, "_rewrite_urls", lambda body, base_dir, index: body)
    base, zim = served_bypass
    got = _open_in_the_reader(base, zim, "bypass.epub/")
    assert got["text"] and got["handlers"] >= 4, got  # the payload is really there
    assert got["pwned"] is None, got


def test_a_hostile_chapter_runs_nothing_in_the_reader(served_bypass):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    base, zim = served_bypass
    got = _open_in_the_reader(base, zim, "bypass.epub/")
    assert got["text"] and got["pwned"] is None and got["handlers"] == 0, got


# ── what the book says about its own files ────────────────────────────────

# A manifest type whose character references ElementTree keeps as a real CR
# LF: sent as the Content-Type, it ended the answer's headers there, the
# policy landed in the body and the script ran on Zimi's origin.
INJECTED_TYPE = (
    "image/png&#13;&#10;&#13;&#10;&lt;script&gt;window.parent.__pwned=1&lt;/script&gt;"
)


def _epub_with_member(media_type, member="evil.png", data=None):
    """The fixture EPUB with one more manifest item, ``OEBPS/<member>``,
    declared as ``media_type`` (written into the package as it is)."""
    import io
    import zipfile

    opf = fx.GUTENBERG_EPUB["OEBPS/content.opf"].replace(
        "</manifest>",
        f'<item href="{member}" id="extra" media-type="{media_type}"/></manifest>',
    )
    src = zipfile.ZipFile(
        io.BytesIO(fx.gutenberg_epub({f"OEBPS/{member}": data or fx.PNG}))
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for info in src.infolist():
            z.writestr(
                info.filename,
                opf if info.filename == "OEBPS/content.opf" else src.read(info),
            )
    return buf.getvalue()


@pytest.mark.parametrize(
    "declared, served",
    [
        (INJECTED_TYPE, "image/png"),
        ("image/png&#10;", "image/png"),
        ("image/png&#13;&#10;X-Evil: 1", "image/png"),
        ("image/webp", "image/webp"),
        ("Image/PNG", "image/png"),
    ],
)
def test_a_manifest_type_is_a_type_or_nothing(declared, served):
    """A media-type is taken only as ``type/subtype``; anything else is
    no type, and the member's extension names it."""
    from zimi import epub

    book = epub.Book(_epub_with_member(declared))
    assert book.types["OEBPS/evil.png"] in ("", served)
    for t in book.types.values():
        assert "\r" not in t and "\n" not in t and "<" not in t


@pytest.fixture
def serve_one_zim(tmp_path, monkeypatch):
    """``serve(entries)``: one ZIM of ``entries`` in the library, served;
    returns ``(base URL, the ZIM's name)``."""
    from http.server import ThreadingHTTPServer
    import threading

    from zimi import epub
    from zimi.http import ZimHandler

    servers = []

    def serve(entries):
        epub._reset_for_tests()
        _library(
            tmp_path,
            monkeypatch,
            [("shelf_en_2026-09.zim", {"Name": "shelf_en"}, entries, "index")],
        )
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        servers.append(httpd)
        return (
            "http://127.0.0.1:%d" % httpd.server_address[1],
            srv.list_zims()[0]["name"],
        )

    yield serve
    for httpd in servers:
        httpd.shutdown()
    epub._reset_for_tests()
    srv.release_zim_handles(list(srv.get_zim_files()))


def _raw_get(base, path):
    """``(status line and headers, body)`` as the bytes came off the socket:
    a client library would take a header block ended early at its word."""
    import socket
    from urllib.parse import urlsplit

    u = urlsplit(base)
    with socket.create_connection((u.hostname, u.port), timeout=10) as s:
        s.sendall(
            f"GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\nConnection: close\r\n\r\n".encode()
        )
        data = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    head, _sep, body = data.partition(b"\r\n\r\n")
    return head.decode("latin-1"), body


def _index():
    return {"index": ("text/html", "<html><body>Books</body></html>", "Books")}


def test_a_manifest_type_cannot_end_the_answers_headers(serve_one_zim):
    base, zim = serve_one_zim(
        dict(
            _index(),
            **{
                "evil.epub": (
                    "application/epub+zip",
                    _epub_with_member(INJECTED_TYPE),
                    "",
                )
            },
        )
    )
    head, body = _raw_get(base, f"/w/{zim}/evil.epub/OEBPS/evil.png")
    assert head.startswith("HTTP/1.1 200"), head
    assert "Content-Type: image/png\r\n" in head + "\r\n", head
    assert "script-src 'none'" in head, "the policy was pushed into the body"
    assert body == fx.PNG


def test_a_header_with_a_line_break_is_never_sent():
    """The one place Zimi sends a header refuses a name or value with a
    line break, and drops the answer begun, so the error reply starts clean."""
    from zimi.http import ZimHandler

    h = ZimHandler.__new__(ZimHandler)
    h.request_version = "HTTP/1.1"
    for name, value in (
        ("Content-Type", "image/png\r\n\r\n<script>alert(1)</script>"),
        ("Content-Type", "text/html\nX-Evil: 1"),
        ("Location", "/a\rb"),
        ("X-Evil\r\nSet-Cookie", "1"),
    ):
        h._headers_buffer = [b"HTTP/1.1 200 OK\r\n"]
        with pytest.raises(ValueError):
            h.send_header(name, value)
        assert h._headers_buffer == []
    h.send_header("Content-Type", "image/png")
    assert h._headers_buffer == [b"Content-Type: image/png\r\n"]


def test_text_goes_gzipped_and_pictures_as_they_are(serve_one_zim):
    """The four ways out that gzip (a ZIM's entry, a file in an EPUB, the
    app's own files, every JSON answer) share one rule."""
    import gzip
    import urllib.request

    base, zim = serve_one_zim(
        dict(
            _index(),
            **{
                "page.html": ("text/html", "<html><body>" + "words " * 200 + "</body></html>", "Page"),
                "pic.png": ("image/png", fx.PNG * 40, ""),
                "book.epub": ("application/epub+zip", fx.gutenberg_epub(), ""),
            },
        )
    )

    def get(path):
        req = urllib.request.Request(
            base + path, headers={"Accept-Encoding": "gzip", "Sec-Fetch-Dest": "iframe"}
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.headers.get("Content-Encoding"), r.read()

    for path in (f"/w/{zim}/page.html", f"/w/{zim}/book.epub/", "/static/app.css", "/list"):
        enc, body = get(path)
        assert enc == "gzip" and gzip.decompress(body), path
    enc, body = get(f"/w/{zim}/pic.png")
    assert enc is None and body == fx.PNG * 40
    enc, body = get(f"/w/{zim}/book.epub/" + fx.GUTENBERG_EPUB_COVER)
    assert enc is None and body == fx.PNG


def test_a_route_that_would_send_a_broken_header_answers_500(
    serve_one_zim, monkeypatch
):
    from zimi import epub

    base, zim = serve_one_zim(_index())
    monkeypatch.setattr(
        epub,
        "respond",
        lambda z, p: ("image/png\r\n\r\n<script>alert(1)</script>", fx.PNG),
    )
    head, body = _raw_get(base, f"/w/{zim}/any.epub/x.png")
    assert head.startswith("HTTP/1.1 500"), head
    assert b"<script" not in body and "<script" not in head


# ── a folder of EPUBs alone, whatever the Python ───────────────────────────

# What Python 3.10 to 3.13's own table lacks (Docker and CI run 3.11, the
# desktop app 3.12); 3.14 has them all.
PY311_LACKS = (".epub", ".ogg", ".m4a", ".mkv", ".flac", ".ogv", ".m4v", ".webp")


def python311_mime_db(monkeypatch):
    """zimwriter's table as a Python without ``PY311_LACKS`` builds it,
    whatever Python runs the test; put in place for the ZIMs it writes."""
    import mimetypes

    from zimi import zimwriter

    stripped = {
        k: v for k, v in mimetypes._types_map_default.items() if k not in PY311_LACKS
    }
    monkeypatch.setattr(mimetypes, "_types_map_default", stripped)
    assert mimetypes.MimeTypes().guess_type("a.epub")[0] is None
    db = zimwriter._mime_db()
    monkeypatch.setattr(zimwriter, "_MIME_DB", db)
    return db


def test_the_types_zimi_writes_do_not_depend_on_the_python(monkeypatch):
    from zimi import zimwriter

    python311_mime_db(monkeypatch)
    for ext, want in (
        (".epub", "application/epub+zip"),
        (".ogg", "audio/ogg"),
        (".oga", "audio/ogg"),
        (".m4a", "audio/mp4"),
        (".flac", "audio/flac"),
        (".wav", "audio/wav"),
        (".mkv", "video/x-matroska"),
        (".ogv", "video/ogg"),
        (".m4v", "video/mp4"),
        (".webp", "image/webp"),
    ):
        assert zimwriter.guess_mime("x" + ext) == want, ext
    # Every file a document library or ZimiTube reads by its extension has
    # a type of its own.
    for ext in nautilus.DOC_EXTS | nautilus.VIDEO_EXTS | nautilus.AUDIO_EXTS:
        assert zimwriter.guess_mime("x" + ext) != "application/octet-stream", ext


def test_a_folder_of_epubs_alone_is_on_the_shelf(shelf_lib, tmp_path, monkeypatch):
    """The folder the review found: EPUBs and nothing else, stored as
    application/octet-stream on Python 3.11, never reached the shelf."""
    from zimi import books, creator

    python311_mime_db(monkeypatch)
    src = tmp_path / "Ebooks"
    src.mkdir()
    (src / "aleutian.epub").write_bytes(fx.gutenberg_epub())
    out = tmp_path / "zims"
    out.mkdir()
    creator.create_folder_zim(str(src), out_dir=str(out))
    shelf_lib([])
    assert [z.get("feeds") for z in srv.list_zims()] == [{"books": "folder"}]
    got = books.listing(limit=50)["books"]
    assert [b["path"] for b in got] == ["aleutian.epub/"] and got[0][
        "source"
    ] == "folder"


# ── the sanitizer is linear ────────────────────────────────────────────────

_MB = 1024 * 1024
# Each is a shape that made one of the sanitizer's patterns scan to the end
# of the chapter again at every step: 4,000 unclosed <script> took 1.8 s.
HOSTILE_SHAPES = {
    "unclosed script": "<script>x",
    "a tag that never ends": "<script",
    "a body never closed": "<body>x",
    "a bracket that never closes": "<",
    "spaces in an anchor": None,
    "a quote that never closes": None,
}


def _hostile_chapter(shape, size):
    if shape == "spaces in an anchor":
        return "<html><body><a" + " " * size + "x"
    if shape == "a quote that never closes":
        return '<html><body><img src="' + "x" * size
    unit = HOSTILE_SHAPES[shape]
    return "<html><body>" + unit * (size // len(unit))


def _sanitize(text):
    from zimi import epub

    body = epub._chapter_body(text)
    body = epub._rewrite_urls(body, "OEBPS", {})
    epub._TEXT_RE.sub("", body)


def _cpu_seconds(shape, size):
    """The process's own time, not the clock's: the bound holds on a
    machine busy with other work."""
    import time

    text = _hostile_chapter(shape, size)
    t0 = time.process_time()
    _sanitize(text)
    return time.process_time() - t0


@pytest.mark.parametrize("shape", list(HOSTILE_SHAPES))
def test_a_hostile_chapter_is_sanitized_in_linear_time(shape):
    """32 KB first, so a quadratic sanitizer fails in seconds rather than
    running for an hour on the megabyte (the old one took 1.5 s on 20 KB of
    unclosed <script>). A megabyte whose every character is a place a tag
    could start costs a pass per pattern; the review's own case, unclosed
    <script>, is well under 100 ms."""
    small = _cpu_seconds(shape, 32 * 1024)
    assert small < 0.05, f"{shape}: 32 KB took {small:.2f}s"
    big = _cpu_seconds(shape, _MB)
    assert big < (0.1 if shape == "unclosed script" else 0.5), f"{shape}: 1 MB took {big:.2f}s"


def test_an_xhtml_self_closed_script_keeps_the_rest_of_the_chapter():
    """An unclosed <script> goes to the end of the chapter, as a browser
    would read it; one closed XHTML's way is only itself."""
    from zimi import epub

    body = epub._chapter_body(
        '<html><body><script src="a.js"/><p>One</p><iframe src="x"/><p>Two</p>'
        "<script>alert(1)</script><p>Three</p><object data='x'/><p>Four</p>"
        "<script>never closed<p>Gone</p></body></html>"
    )
    assert "<p>One</p>" in body and "<p>Two</p>" in body and "<p>Three</p>" in body
    assert "<p>Four</p>" in body
    low = body.lower()
    assert "<script" not in low and "<iframe" not in low and "<object" not in low
    assert "alert" not in body and "Gone" not in body


# ── a read that fails is not "nothing there" ───────────────────────────────


class _Damaged:
    """An archive whose every read fails as a damaged cluster does."""

    entry_count = 3

    def get_entry_by_path(self, path):
        raise RuntimeError("damaged cluster")

    def has_entry_by_path(self, path):
        raise RuntimeError("damaged cluster")

    def _get_entry_by_id(self, i):
        raise RuntimeError("damaged cluster")


class _Empty(_Damaged):
    """An archive with no such entry."""

    def get_entry_by_path(self, path):
        raise KeyError(path)

    def has_entry_by_path(self, path):
        return False


def test_a_listing_that_will_not_read_is_not_taken_for_none():
    from zimi import booksources

    assert nautilus.items(_Empty()) == []
    assert booksources.libretexts_books(_Empty()) == []
    with pytest.raises(RuntimeError):
        nautilus.items(_Damaged())
    for reader in ("nautilus", "folder", "libretexts", "wikisource", "wikibooks"):
        with pytest.raises(RuntimeError):
            booksources.books_in(_Damaged(), reader)


def test_a_failed_read_is_read_again_at_the_next_start(tmp_path, monkeypatch):
    """A background read that fails leaves no file, so the next start reads
    the ZIM again; before, the failure was written down as "no books"."""
    from zimi import books

    _library(tmp_path, monkeypatch, [_water()])
    books._reset_for_tests()
    real_open = srv.open_archive

    class _Flaky:
        def __init__(self, archive):
            self._a = archive

        def __getattr__(self, name):
            return getattr(self._a, name)

        def get_entry_by_path(self, path):
            if path == nautilus.DATABASE_PATH:
                raise RuntimeError("damaged cluster")
            return self._a.get_entry_by_path(path)

    monkeypatch.setattr(srv, "open_archive", lambda path: _Flaky(real_open(path)))
    books.build_all_details()
    books._sources.wait()
    assert books.listing(limit=50)["total"] == 0
    name = srv.list_zims()[0]["name"]
    assert not os.path.exists(books._sources.path(name))

    # The next start, with the ZIM reading again.
    monkeypatch.setattr(srv, "open_archive", real_open)
    books._reset_for_tests()
    books.build_all_details()
    books._sources.wait()
    assert books.listing(limit=50)["total"] == 7


# ── a walk of a folder is bounded ──────────────────────────────────────────


def test_a_folder_walk_stops_at_its_bound(monkeypatch):
    """A folder ZIM from before its listing was walked to its last entry,
    under the archive's lock."""
    from zimi import booksources, tube

    class _Entry:
        is_redirect = False
        title = ""

        def __init__(self, i):
            self.path = f"doc{i}.pdf"

        def get_item(self):
            return type("I", (), {"mimetype": "application/pdf", "size": 1})()

    class _Many:
        entry_count = 10_000
        seen = 0

        def _get_entry_by_id(self, i):
            _Many.seen += 1
            return _Entry(i)

    monkeypatch.setattr(srv, "MAX_WALK_ENTRIES", 50, raising=False)
    assert len(booksources._document_entries(_Many())) == 50
    assert _Many.seen == 50
    _Many.seen = 0
    tube._folder_walk(_Many())
    assert _Many.seen == 50


# ── a path under a file that is not an EPUB ────────────────────────────────


def test_a_path_under_a_file_that_is_not_an_epub_is_read_once(
    serve_one_zim, monkeypatch
):
    """``notes.epub`` that is no zip was read and parsed again (up to
    50 MB) on every request for a path under it; and a folder named
    ``site.epub/`` is still served by the ordinary lookup."""
    from urllib.parse import quote

    from zimi import epub

    base, zim = serve_one_zim(
        dict(
            _index(),
            **{
                "notes.epub": ("application/epub+zip", b"not a zip at all", ""),
                "site.epub/ch1.html": (
                    "text/html",
                    "<html><body>Chapter one</body></html>",
                    "One",
                ),
            },
        )
    )
    opened = []
    real = epub.Book

    def book(data):
        opened.append(len(data))
        return real(data)

    monkeypatch.setattr(epub, "Book", book)
    for _ in range(3):
        # Answered by the ordinary lookup (the page for a missing entry).
        _fetch(f"{base}/w/{zim}/notes.epub/OEBPS/a.png")
    assert len(opened) == 1, "the entry was read and parsed again"
    status, _ctype, body, _h = _fetch(f"{base}/w/{zim}/{quote('site.epub/ch1.html')}")
    assert status == 200 and b"Chapter one" in body
