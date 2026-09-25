"""Bookshelf: every Project Gutenberg ZIM in the library, as one shelf.

The fixtures carry gutenberg2zim's own shapes, copied from
gutenberg_la_all_2026-01, gutenberg_he_all_2026-01 and
gutenberg_en_lcc-pm_2026-03: the listing files its browsing UI reads, book
pages at ``<title>.<id>`` with Project Gutenberg's Dublin Core record in
the head, and covers at ``covers/<id>_cover_image.jpg``.

Run: pytest tests/test_books.py -v
"""

import json
import os
import sys
import threading
import urllib.request

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from zimi import books  # noqa: E402

G2Z = "gutenberg2zim-3.0.1"


def _js(var, rows):
    return ("var %s = %s;" % (var, json.dumps(rows))).encode()


def _book_page(title, creators, subjects, created, lang="la"):
    """A book page as gutenberg2zim writes one: no doctype, Gutenberg's
    record in the head, the book in the body."""
    meta = "".join('<meta content="%s" name="dc.creator"/>\n' % c for c in creators)
    meta += "".join('<meta content="%s" name="dc.subject"/>\n' % s for s in subjects)
    return (
        '<html lang="%s"><head><meta content="text/html; charset=utf-8" http-equiv="Content-Type"/>\n'
        '<link href="http://purl.org/dc/terms/" rel="schema.dcterms"/>\n'
        '<meta content="%s" name="dc.title"/>\n%s'
        '<meta content="%s" name="dcterms.created"/>\n'
        '<link href="http://www.gutenberg.org/ebooks/1" rel="dcterms.isFormatOf"/>\n'
        "<title>%s</title></head><body><h2>LIBER I</h2><p>Arma virumque cano.</p>"
        "<h2>LIBER II</h2><p>Conticuere omnes.</p></body></html>"
        % (lang, title, meta, created, title)
    ).encode()


LONG = (
    "Mr. Ray's travels, Vol. 2 : $b A collection of curious travels "
    + "and voyages " * 30
)
LATIN = {
    "full_by_popularity.js": _js(
        "json_data",
        [
            ["Aeneidos", "Virgil", "110", 227, "PA"],
            ["Catulli Carmina", "Gaius Valerius Catullus", "110", 23294, "PA"],
            ["Biblia Sacra Vulgata - Psalmi XXII", "Anonymous", "010", 19635, "BS"],
            [LONG, "John Ray", "110", 76193, "G"],
            ["Georgicon", "Virgil", "110", 232, "PA"],
            ["Tales / Fables", "Carl Ewald", "110", 5139, "PT"],
        ],
    ),
    "languages.js": _js(
        "languages_json_data", [["Latina", "la", 5], ["עברית", "he", 1]]
    ),
    "lang_la_by_title.js": _js(
        "json_data",
        [
            ["Aeneidos", "Virgil", "110", 227, "PA"],
            ["Catulli Carmina", "", "110", 23294, "PA"],
            ["Biblia", "", "010", 19635, "BS"],
            [LONG, "", "110", 76193, "G"],
            ["Georgicon", "", "110", 232, "PA"],
        ],
    ),
    "lang_he_by_title.js": _js(
        "json_data", [["Tales / Fables", "Carl Ewald", "110", 5139, "PT"]]
    ),
    "Aeneidos.227": _book_page(
        "Aeneidos",
        ["Virgil, 71 BCE-20 BCE"],
        ["Epic poetry, Latin", "Legends -- Rome -- Poetry"],
        "1995-03-01",
    ),
    "Catulli Carmina.23294": _book_page(
        "Catulli Carmina",
        ["Catullus, Gaius Valerius, 84? BCE-54 BCE", "Ellis, Robinson, 1834-1913"],
        ["Poetry"],
        "2007-11-02",
    ),
    "Georgicon.232": _book_page(
        "Georgicon", ["Virgil, 71 BCE-20 BCE"], [], "1995-03-01"
    ),
    books.book_path(LONG, 76193): _book_page(
        "Mr. Ray", ["Ray, John, 1627-1705"], [], "2025-05-30"
    ),
    "Tales - Fables.5139": _book_page(
        "Tales", ["Ewald, Carl, 1856-1908"], [], "2004-02-01", lang="he"
    ),
    "Biblia Sacra Vulgata - Psalmi XXII_cover.19635": b"<html><body>cover</body></html>",
    "covers/227_cover_image.jpg": b"\xff\xd8\xff",
}
# An LCC subset built later that carries one of the same books.
SUBSET = {
    "full_by_popularity.js": _js(
        "json_data",
        [
            ["Aeneidos", "Virgil", "110", 227, "PA"],
            ["Cicero's Orations", "Cicero", "110", 226, "PA"],
        ],
    ),
    "languages.js": _js("languages_json_data", [["English", "en", 2]]),
    "covers/227_cover_image.jpg": b"\xff\xd8\xff",
    "Aeneidos.227": _book_page(
        "Aeneidos", ["Virgil, 71 BCE-20 BCE"], [], "1995-03-01", lang="en"
    ),
    "Cicero's Orations.226": _book_page(
        "Cicero",
        ["Cicero, Marcus Tullius, 106 BCE-43 BCE"],
        [],
        "1995-02-01",
        lang="en",
    ),
}
LIBRARY = [
    (
        "gutenberg_la_all_2026-01.zim",
        {
            "Scraper": G2Z,
            "Name": "gutenberg_la_all",
            "Language": "lat",
            "Title": "Bibliotheca",
            "Date": "2026-01-04",
        },
        LATIN,
    ),
    (
        "gutenberg_en_lcc-pa_2026-03.zim",
        {
            "Scraper": G2Z,
            "Name": "gutenberg_en_lcc-pa",
            "Language": "eng",
            "Title": "Project Gutenberg Library",
            "Date": "2026-03-06",
        },
        SUBSET,
    ),
    (
        "wikipedia_en_all_2026-08.zim",
        {"Scraper": "mwoffliner 1.14.0", "Name": "wikipedia_en_all"},
        {},
    ),
]


def _library(tmp_path, monkeypatch, zims=LIBRARY, details=True):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    for filename, metadata, files in zims:
        build_fixture_zim(str(zdir / filename), metadata, files=files)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    if not details:
        monkeypatch.setattr(books, "request_details", lambda name: None)
    books._reset_for_tests()
    srv.load_cache(force=True)
    if details:
        # The startup worker may have claimed a ZIM already: wait for it.
        books.build_all_details()
        books.wait_for_builds()


# ── reading a ZIM ──────────────────────────────────────────────────────────


def test_a_gutenberg_zim_is_books_by_its_maker_or_its_name():
    assert (
        srv._zim_kind(G2Z, "_category:gutenberg;gutenberg", "gutenberg_la_all")
        == "books"
    )
    assert srv._zim_kind("", "", "gutenberg_en_lcc-pm") == "books"
    assert srv._zim_kind("mwoffliner 1.14", "", "wikibooks_en_all") == "wiki"


def test_the_path_rule_is_gutenberg2zims():
    assert books.book_path("Tales / Fables", 5139) == "Tales - Fables.5139"
    assert books.book_path("Tales", 5139, cover=True) == "Tales_cover.5139"
    assert books.book_path(LONG, 1) == LONG[:230] + ".1"


@pytest.mark.parametrize(
    "value,expected,era",
    [
        ("Ewald, Carl, 1856-1908", ("Ewald, Carl", 1856, 1908), 1900),
        ("Virgil, 71 BCE-20 BCE", ("Virgil", -71, -20), -100),
        (
            "Catullus, Gaius Valerius, 84? BCE-54 BCE",
            ("Catullus, Gaius Valerius", -84, -54),
            -100,
        ),
        ("Homer, 751? BCE-651? BCE", ("Homer", -751, -651), -700),
        ("Wiskott, Dawid", ("Wiskott, Dawid", None, None), None),
        ("Vaknin, Samuel, 1961-", ("Vaknin, Samuel", 1961, None), 2000),
        ("Anonymous, -1900", ("Anonymous", None, 1900), 1900),
    ],
)
def test_a_writers_years_and_era(value, expected, era):
    got = books.creator_years(value)
    assert got == expected
    assert books.era_of(got[1], got[2]) == era


def test_the_head_carries_gutenbergs_record():
    facts = books.head_facts(LATIN["Catulli Carmina.23294"].decode())
    assert facts["creators"][0] == ("Catullus, Gaius Valerius", -84, -54)
    assert facts["creators"][1] == ("Ellis, Robinson", 1834, 1913)
    assert facts["subjects"] == ["Poetry"] and facts["created"] == "2007-11-02"


def test_a_marc_subtitle_is_a_subtitle():
    assert books.split_title("Aztec place-names : $b Their meaning") == (
        "Aztec place-names",
        "Their meaning",
    )
    assert books.split_title("Aeneidos") == ("Aeneidos", "")


# ── the shelf ──────────────────────────────────────────────────────────────


def test_the_listings_alone_make_the_shelf(tmp_path, monkeypatch):
    """Before any book is read the shelf is there, most read first, each
    book in its language and on its LCC shelf; an EPUB-only book opens on
    its cover page."""
    _library(tmp_path, monkeypatch, details=False)
    home = books.home()
    assert home["total"] == 7 and home["details"] is False and home["eras"] == []
    assert [b["title"] for b in home["popular"][:2]] == [
        "Aeneidos",
        "Cicero's Orations",
    ]
    by = {b["id"]: b for b in books.listing(limit=50)["books"]}
    assert by[5139]["lang"] == "he" and by[23294]["lang"] == "la"
    assert by[19635]["html"] is False and by[19635]["path"].endswith("_cover.19635")
    assert by[5139]["path"] == "Tales - Fables.5139"
    assert {s["code"] for s in home["shelves"]} == {"PA", "B", "G", "PT"}


def test_one_book_in_two_zims_is_one_book_from_the_newest(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, details=False)
    got = books.listing(q="aeneidos")
    assert got["total"] == 1 and got["books"][0]["zim"] == "gutenberg_en_lcc-pa"


def test_search_finds_title_and_author_without_accents_or_case(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, details=False)
    assert {b["id"] for b in books.listing(q="VIRGIL")["books"]} == {227, 232}
    assert [b["id"] for b in books.listing(q="catulli")["books"]] == [23294]
    assert books.listing(q="virgil carmina")["total"] == 0


def test_filters_and_orders(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch)
    assert {b["id"] for b in books.listing(author="Virgil")["books"]} == {227, 232}
    assert {b["id"] for b in books.listing(shelf_code="pa")["books"]} == {
        227,
        232,
        23294,
        226,
    }
    assert [b["id"] for b in books.listing(lang="he")["books"]] == [5139]
    assert [b["title"] for b in books.listing(sort="title", limit=2)["books"]] == [
        "Aeneidos",
        "Biblia Sacra Vulgata - Psalmi XXII",
    ]
    # Newest to Gutenberg: the day each came, from its record.
    assert books.listing(sort="recent")["books"][0]["id"] == 76193
    # Filed by surname once the record is read: Catullus before Cicero before Ewald.
    order = [b["id"] for b in books.listing(sort="author")["books"]]
    assert order.index(23294) < order.index(226) < order.index(5139)
    page = books.listing(sort="title", offset=2, limit=2)
    assert page["total"] == 7 and len(page["books"]) == 2


def test_the_records_give_eras_covers_and_the_real_page(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch)
    home = books.home()
    assert home["details"] is True
    eras = {e["from"]: e["n"] for e in home["eras"]}
    assert eras[-100] == 4 and eras[1900] == 1 and eras[1700] == 1
    assert {b["id"] for b in books.listing(era="-100")["books"]} == {227, 232, 226, 23294}
    by = {b["id"]: b for b in books.listing(limit=50)["books"]}
    assert by[227]["cover"] == "covers/227_cover_image.jpg"
    assert "cover" not in by[23294]  # no picture: the page sets one in type
    assert (
        by[76193]["subtitle"].startswith("A collection") and by[76193]["born"] == 1627
    )


def test_authors_by_surname_and_by_books(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch)
    got = books.authors()
    names = [a["name"] for a in got["authors"]]
    assert got["total"] == 6 and names.index("Gaius Valerius Catullus") < names.index(
        "Carl Ewald"
    )
    assert books.authors(sort="books")["authors"][0] == {
        "name": "Virgil",
        "n": 2,
        "born": -71,
        "died": -20,
    }
    assert [a["name"] for a in books.authors(q="ray")["authors"]] == ["John Ray"]


def test_one_book_with_more_by_its_author(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch)
    b = books.book("gutenberg_la", 232)
    assert b["title"] == "Georgicon" and [m["id"] for m in b["more"]] == [227]
    assert (
        b["epub"] == "Georgicon.232.epub" and b["cover_page"] == "Georgicon_cover.232"
    )
    assert books.book("", 99999) is None


def test_the_records_file_is_not_read_twice(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch)
    path = os.path.join(str(tmp_path / "data"), "books", "gutenberg_la.db")
    before = os.path.getmtime(path)
    books._reset_for_tests()
    books.build_all_details()
    assert os.path.getmtime(path) == before
    assert books.home()["details"] is True


def test_a_restricted_account_sees_only_the_books_it_may_read(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, details=False)
    monkeypatch.setattr(srv, "zim_allowed", lambda name: name == "gutenberg_la")
    books._shelf["key"] = None
    assert books.home()["total"] == 6
    assert {b["zim"] for b in books.listing(limit=50)["books"]} == {"gutenberg_la"}


# ── through HTTP ────────────────────────────────────────────────────────────


@pytest.fixture
def served(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    _library(tmp_path, monkeypatch)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_the_routes(served):
    status, home = _get(served + "/books/home")
    assert status == 200 and home["total"] == 7
    status, got = _get(served + "/books/list?author=Virgil&sort=title")
    assert status == 200 and [b["title"] for b in got["books"]] == [
        "Aeneidos",
        "Georgicon",
    ]
    status, got = _get(served + "/books/authors?sort=books&limit=1")
    assert status == 200 and got["authors"][0]["name"] == "Virgil"
    status, got = _get(served + "/books/book?id=232")
    assert status == 200 and got["more"][0]["id"] == 227
    assert _get(served + "/books/book?id=nope")[0] == 404
    assert _get(served + "/books/nothing")[0] == 404


def test_a_book_page_and_its_cover_are_served(served):
    status, got = _get(served + "/books/book?id=5139")
    with urllib.request.urlopen(
        served + "/w/%s/%s" % (got["zim"], urllib.request.quote(got["path"])),
        timeout=10,
    ) as r:
        assert b"dcterms.isFormatOf" in r.read()


def test_the_page_is_served_with_the_shared_parts_inlined(served):
    with urllib.request.urlopen(served + "/static/books.html", timeout=10) as r:
        body = r.read().decode()
    assert "<!--@apps.css@-->" not in body and "<!--@apps.js@-->" not in body
    assert "function zpath(" in body and ".chips {" in body
