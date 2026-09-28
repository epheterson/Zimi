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
            places = pg.evaluate("() => JSON.parse(localStorage.getItem('zimi_book_places') || '{}')")
            assert list(places) == [card["zim"] + "\n" + card["path"]]
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
