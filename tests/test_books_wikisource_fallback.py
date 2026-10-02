"""Wikisource without #ws-data still lists its works.

booksources.wikisource_books read a work's title and author from #ws-data,
a per-wiki template, so the real wikisource_sk_all_maxi_2026-07 (386 pages
at the top, none with it) put nothing on the Bookshelf. Slovak's header is a
table whose cells carry the same ws- ids; Limburgish has no header and its
books are pages with pages under them. The fixtures are cut from both ZIMs
(tests/wikisource_fallback_fixture.py). A wiki that has #ws-data reads it
exactly as before.

Run: pytest tests/test_books_wikisource_fallback.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

pytest.importorskip("libzim.writer")

import books_sources_fixture as fx  # noqa: E402
import wikisource_fallback_fixture as wf  # noqa: E402
from libzim.reader import Archive  # noqa: E402
from test_books_sources import MWOFFLINER, shelf_lib  # noqa: E402,F401
from zimi import booksources  # noqa: E402

SK = "wikisource_sk_all_maxi_2026-07.zim"
SK_MAIN = "Wikizdroje:Hlavná_stránka"


def _entries(pages):
    return {p: ("text/html", html, title) for p, (html, title) in pages.items()}


def _sk():
    return (
        SK,
        {"Scraper": MWOFFLINER, "Name": "wikisource_sk_all", "Language": "slk"},
        _entries(wf.WIKISOURCE_SK_PAGES),
        SK_MAIN,
    )


def _works(tmp_path, pages, main, name="ws.zim"):
    path = str(tmp_path / name)
    fx.build_zim(path, {"Scraper": MWOFFLINER}, _entries(pages), main)
    return {b["title"]: b for b in booksources.wikisource_books(Archive(path))}


def test_a_slovak_work_is_a_page_whose_header_carries_the_ids(tmp_path):
    got = _works(tmp_path, wf.WIKISOURCE_SK_PAGES, SK_MAIN)
    # Biblia is a disambiguation page with no header; the scan's index and
    # page, the project's main page, and pages whose top is not in the ZIM
    # are not works.
    assert set(got) == {"A čija to chyža", "Báseň", "Horská chatrč", "Hájnikova žena"}
    assert got["Horská chatrč"]["author"] == "Pavol Országh Hviezdoslav"
    # A link to the author's page the ZIM left out leaves its namespace in
    # the cell.
    assert got["Báseň"]["author"] == "Jozef Tomášik-Dumín"
    # "neznámy" is unknown; a header with no author row is too.
    assert got["A čija to chyža"]["author"] == ""
    assert got["Hájnikova žena"]["author"] == ""
    # The title is the page's: the ws-title id marks the cell saying "Titulok".
    assert got["Hájnikova žena"]["path"] == "Hájnikova_žena"
    assert got["Hájnikova žena"]["format"] == "html"


def test_an_author_page_link_names_the_author(tmp_path):
    """Where the ZIM carries the Autor: namespace, the header links to it
    instead of leaving the name as text (the Slovak header, its author row
    given that link)."""
    html, title = wf.WIKISOURCE_SK_PAGES["Hájnikova_žena"]
    linked = html.replace(
        "<td>Hájnikova žena\n</td></tr>",
        "<td>Hájnikova žena\n</td></tr><tr><td>Autor</td><td>"
        '<a href="./Autor:Pavol_Orsz%C3%A1gh_Hviezdoslav">P. O. Hviezdoslav</a>'
        "</td></tr>",
    )
    assert linked != html
    pages = {"Hájnikova_žena": (linked, title), SK_MAIN: wf.WIKISOURCE_SK_PAGES[SK_MAIN]}
    got = _works(tmp_path, pages, SK_MAIN)
    assert got["Hájnikova žena"]["author"] == "Pavol Országh Hviezdoslav"


def test_a_work_with_pages_under_it_needs_no_header(tmp_path):
    got = _works(tmp_path, wf.WIKISOURCE_LI_PAGES, "Veurblaad")
    # The main page has pages under it too; a page with neither is not a work.
    assert list(got) == ["Middelärcher"]
    assert got["Middelärcher"]["chapters"] == 2
    assert got["Middelärcher"]["author"] == ""


def test_a_wiki_with_ws_data_reads_only_ws_data(tmp_path):
    """The Esperanto fixture's works, and nothing more, even beside pages
    shaped like Slovak's and Limburgish's."""
    eo, main = fx.WIKISOURCE_PAGES, "Vikifontaro:Ĉefpaĝo"
    alone = _works(tmp_path, eo, main, "eo.zim")
    mixed = {**eo, **wf.WIKISOURCE_SK_PAGES, **wf.WIKISOURCE_LI_PAGES}
    together = _works(tmp_path, mixed, main, "mixed.zim")
    assert set(alone) == {
        "Adjuvilo",
        'Adresaro de la personoj kiuj ellernis la lingvon "Esperanto"',
        "Adiaŭa letero de Stefan Zweig",
        "Aforismoj (Lanti, 1946)",
    }
    assert together == alone


def test_slovak_works_are_on_the_shelf(shelf_lib):  # noqa: F811
    from zimi import books

    names = shelf_lib([_sk()])
    name = names["wikisource_sk_all_maxi_2026-07"]
    got = {b["title"]: b for b in books.listing(limit=50)["books"]}
    assert set(got) == {"A čija to chyža", "Báseň", "Horská chatrč", "Hájnikova žena"}
    work = books.book(name, got["Horská chatrč"]["id"])
    assert work["author"] == "Pavol Országh Hviezdoslav"
    assert work["path"] == "_zimi_book_/Horská_chatrč" and work["lang"] == "sk"
