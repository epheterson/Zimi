"""Zimipedia: every wiki in the library, as one.

Run: pytest tests/test_wiki.py -v
"""

import datetime
import json
import logging
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
from zimi import datepages, wiki  # noqa: E402

MW = "mwoffliner 1.14.0"

# A date page shaped like mwoffliner's: a year, a dash, a sentence naming
# an article. Fire and Water are in the fixture ZIM; Nowhere is not.
DATE_PAGE = b"""<html><body>
<h2 id="Events">Events</h2>
<ul>
<li><a href="./1666">1666</a> - The <a href="./Fire">Great Fire</a> of London begins.</li>
<li><a href="./1700">1700</a> - Something at <a href="./Nowhere">a place this subset lacks</a>.</li>
<li><a href="./1854">1854</a> - <a href="./Water">Water</a> is shown to carry cholera.</li>
</ul>
<h2 id="References">References</h2>
</body></html>"""


def _library(tmp_path, monkeypatch, zims):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    for filename, metadata, files in zims:
        build_fixture_zim(str(zdir / filename), metadata, files=files)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    wiki._reset_for_tests()
    srv.load_cache(force=True)


LIBRARY = [
    (
        "wikipedia_en_all_maxi_2026-08.zim",
        {
            "Scraper": MW,
            "Name": "wikipedia_en_all",
            "Language": "eng",
            "Title": "Wikipedia",
        },
        {"A/September_25": DATE_PAGE},
    ),
    (
        "wikipedia_fr_all_nopic_2026-07.zim",
        {
            "Scraper": MW,
            "Name": "wikipedia_fr_all",
            "Language": "fra",
            "Title": "Wikipédia",
        },
        {},
    ),
    (
        "wiktionary_en_all_nopic_2026-07.zim",
        {
            "Scraper": MW,
            "Name": "wiktionary_en_all",
            "Language": "eng",
            "Title": "Wiktionary",
        },
        {},
    ),
    (
        "wikem_en_all_2026-06.zim",
        {"Scraper": MW, "Name": "wikem_en_all", "Language": "eng", "Title": "WikEM"},
        {},
    ),
    # Not wikis: a Stack Exchange site, a TED build, a plain ZIM with no word
    # on who made it, and a How-to whose name starts "wiki" but whose maker
    # is not mwoffliner and whose Name is not a Wikimedia project.
    (
        "cooking.stackexchange.com_en_all_2026-07.zim",
        {"Scraper": "sotoki v3.1.1", "Name": "cooking.stackexchange.com_en_all"},
        {},
    ),
    (
        "ted_en_technology_2026-07.zim",
        {"Scraper": "ted2zim 3.0", "Name": "ted_en_technology"},
        {},
    ),
    ("survival_en_2026-06.zim", None, {}),
    (
        "wikihow_en_maxi_2026-06.zim",
        {"Scraper": "wikihow2zim 1.0", "Name": "wikihow_en_maxi"},
        {},
    ),
]


def test_a_mediawiki_zim_is_a_wiki_by_its_maker_or_its_name():
    assert (
        srv._zim_kind(
            "mwoffliner 1.14.0", "wikipedia;_category:wikipedia", "wikipedia_en_all"
        )
        == "wiki"
    )
    assert (
        srv._zim_kind("mwoffliner 1.9", "", "wikem_en_all") == "wiki"
    )  # a wiki beyond Wikimedia
    assert (
        srv._zim_kind("", "", "wikivoyage_en_all") == "wiki"
    )  # too old to say who made it
    assert srv._zim_kind("", "", "wikihow_en_maxi") is None
    assert srv._zim_kind("sotoki v3.1.1", "", "") == "qa"


def test_a_renamed_wiki_is_filed_by_its_metadata_name(tmp_path, monkeypatch):
    """server._zim_kind knows a renamed enwiki.zim is a wiki by its Name;
    Zimipedia files it under the same Name, not the filename."""
    _library(
        tmp_path,
        monkeypatch,
        [
            (
                "enwiki.zim",
                {
                    "Scraper": MW,
                    "Name": "wikipedia_en_all",
                    "Language": "eng",
                    "Title": "Wikipedia",
                },
                {},
            ),
            (
                "wikipedia_quotes.zim",
                {
                    "Scraper": MW,
                    "Name": "wikiquote_en_all",
                    "Language": "eng",
                    "Title": "Wikiquote",
                },
                {},
            ),
        ],
    )
    got = {w["name"]: w["project"] for w in wiki.wikis()}
    assert got == {"enwiki": "wikipedia", "wikipedia_quotes": "wikiquote"}
    # A library read before the project was kept reads the Name once.
    path = str(tmp_path / "zims" / "enwiki.zim")
    assert srv._read_wiki_project(path, "enwiki") == "wikipedia"


def test_project_of_names_the_wikimedia_project():
    assert wiki.project_of("wikipedia_fr") == "wikipedia"
    assert wiki.project_of("wiktionary") == "wiktionary"
    assert wiki.project_of("wikispecies") == "wikispecies"
    assert wiki.project_of("wikem") == ""


def test_the_app_lists_only_the_wikis_grouped_by_project_then_language(
    tmp_path, monkeypatch
):
    _library(tmp_path, monkeypatch, LIBRARY)
    got = wiki.wikis()
    assert [(w["project"], w["language"]) for w in got] == [
        ("wikipedia", "en"),
        ("wikipedia", "fr"),
        ("wiktionary", "en"),
        ("", "en"),  # the wiki beyond Wikimedia comes last
    ]
    assert got[0]["project_title"] == "Wikipedia" and got[-1]["title"] == "WikEM"
    assert got[0]["main_path"] and "entries" in got[0]
    names = {w["name"] for w in got}
    assert not any(
        n.startswith(("cooking", "ted", "survival", "wikihow")) for n in names
    )


def test_a_restricted_account_sees_only_the_wikis_it_may_read(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, LIBRARY)
    en = next(
        w["name"]
        for w in wiki.wikis()
        if w["project"] == "wikipedia" and w["language"] == "en"
    )
    monkeypatch.setattr(srv, "zim_allowed", lambda name: name == en)
    assert [w["name"] for w in wiki.wikis()] == [en]


def test_on_this_day_lists_the_events_whose_article_the_zim_holds(
    tmp_path, monkeypatch
):
    _library(tmp_path, monkeypatch, LIBRARY)
    en = next(
        w["name"]
        for w in wiki.wikis()
        if w["project"] == "wikipedia" and w["language"] == "en"
    )
    events = wiki.on_this_day(en, "0925")
    assert [(e["event_year"], e["path"]) for e in events] == [
        ("1666", "A/Fire"),
        ("1854", "A/Water"),
    ]
    assert events[0]["title"] == "Fire" and "Great Fire" in events[0]["event_text"]
    # Read once per day: a second ask is the kept answer.
    assert wiki.on_this_day(en, "0925") is events
    # A day with no page, a malformed date, and a wiki that is not a Wikipedia.
    assert wiki.on_this_day(en, "0101") == []
    assert wiki.on_this_day(en, "25-9") == []
    wikt = next(w["name"] for w in wiki.wikis() if w["project"] == "wiktionary")
    assert wiki.on_this_day(wikt, "0925") == []


def test_the_dated_pick_still_carries_its_event(tmp_path, monkeypatch):
    """The Discover card's On this day reads the same date page through the
    shared helpers."""
    import random

    from zimi.search import _get_dated_entry

    _library(tmp_path, monkeypatch, LIBRARY)
    en = next(
        w["name"]
        for w in wiki.wikis()
        if w["project"] == "wikipedia" and w["language"] == "en"
    )
    with srv._zim_lock:
        got = _get_dated_entry(srv.get_archive(en), en, "0925", rng=random.Random(1))
    assert got["path"] in ("A/Fire", "A/Water") and got["event_year"] in (
        "1666",
        "1854",
    )


# ── through HTTP ────────────────────────────────────────────────────────────


DAY = datetime.date(2026, 9, 25)


@pytest.fixture
def served(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    _library(tmp_path, monkeypatch, LIBRARY)
    monkeypatch.setattr(wiki, "_today", lambda: DAY)
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
    status, home = _get(served + "/wiki/home")
    assert status == 200 and len(home["wikis"]) == 4
    en = home["wikis"][0]["name"]
    status, otd = _get(served + "/wiki/onthisday?zim=%s&date=0925" % en)
    assert status == 200 and [e["event_year"] for e in otd["events"]] == [
        "1666",
        "1854",
    ]
    assert _get(served + "/wiki/onthisday?zim=nope&date=0925")[0] == 404
    assert _get(served + "/wiki/nothing")[0] == 404


def test_pills_scope_search_to_the_chosen_wikis(served):
    """The page searches through /search with the chosen wikis as the zim
    filter: a word every fixture ZIM holds is found only in those named."""
    status, home = _get(served + "/wiki/home")
    chosen = [w["name"] for w in home["wikis"] if w["project"] == "wiktionary"]
    status, got = _get(
        served + "/search?q=fire&fast=1&limit=20&zim=" + ",".join(chosen)
    )
    assert status == 200 and got["results"]
    assert {r["zim"] for r in got["results"]} == set(chosen)
    status, got = _get(
        served
        + "/search?q=fire&fast=1&limit=20&zim="
        + ",".join(w["name"] for w in home["wikis"])
    )
    assert got["results"]
    assert {r["zim"] for r in got["results"]} <= {w["name"] for w in home["wikis"]}


def test_the_page_is_served_with_the_shared_parts_inlined(served):
    with urllib.request.urlopen(served + "/static/wiki.html", timeout=10) as r:
        body = r.read().decode()
    assert "<!--@apps.css@-->" not in body and "<!--@apps.js@-->" not in body
    assert "function zpath(" in body and ".chips {" in body


# ── On this day: what can be asked, and what a failure does ───────────────


def test_only_today_yesterday_and_tomorrow_can_be_asked_for(monkeypatch):
    monkeypatch.setattr(wiki, "_today", lambda: datetime.date(2026, 1, 1))
    assert wiki.open_days() == {"20251231", "20260101", "20260102"}
    assert wiki.mmdd_open("1231") and wiki.mmdd_open("0102")
    assert not wiki.mmdd_open("0925")
    # Month 00 is not December, and September has no 31st.
    assert not wiki.mmdd_open("0015") and not wiki.mmdd_open("0931")


def test_the_date_is_checked_before_anything_is_read(served):
    en = _get(served + "/wiki/home")[1]["wikis"][0]["name"]
    for bad in ("0015", "1301", "0931", "1225", "x"):
        assert _get(served + "/wiki/onthisday?zim=%s&date=%s" % (en, bad))[0] == 400
    assert _get(served + "/wiki/onthisday?zim=%s&date=0926" % en)[0] == 200  # tomorrow


def _broken(*a, **k):
    raise RuntimeError("disk gone")


def test_a_failed_read_is_logged_not_kept(tmp_path, monkeypatch, caplog):
    _library(tmp_path, monkeypatch, LIBRARY)
    en = next(
        w["name"]
        for w in wiki.wikis()
        if w["language"] == "en" and w["project"] == "wikipedia"
    )
    real = datepages.read_page
    monkeypatch.setattr(datepages, "read_page", _broken)
    with caplog.at_level(logging.WARNING, logger="zimi"):
        assert wiki.on_this_day(en, "0925") is None
    assert any(
        "disk gone" in r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING
    )
    # Not kept: once the page reads again, the events are there.
    monkeypatch.setattr(datepages, "read_page", real)
    assert [e["event_year"] for e in wiki.on_this_day(en, "0925")] == ["1666", "1854"]


def test_a_failure_answers_503_not_an_empty_day(served, monkeypatch):
    en = _get(served + "/wiki/home")[1]["wikis"][0]["name"]
    monkeypatch.setattr(datepages, "read_page", _broken)
    assert _get(served + "/wiki/onthisday?zim=%s&date=0925" % en)[0] == 503


class _CountingLock:
    def __init__(self, lock):
        self.lock, self.n = lock, 0

    def __enter__(self):
        self.n += 1
        return self.lock.__enter__()

    def __exit__(self, *a):
        return self.lock.__exit__(*a)


def test_the_library_lock_is_held_per_read_not_for_the_whole_day(tmp_path, monkeypatch):
    """Every other request needs the library lock: On this day takes it for
    the date page and again for each line's article, never across them."""
    _library(tmp_path, monkeypatch, LIBRARY)
    en = next(
        w["name"]
        for w in wiki.wikis()
        if w["language"] == "en" and w["project"] == "wikipedia"
    )
    counting = _CountingLock(srv._zim_lock)
    monkeypatch.setattr(srv, "_zim_lock", counting)
    wiki.on_this_day(en, "0925")
    # The archive, the page, and each of the three lines: five times.
    assert counting.n == 5


def test_every_wikipedia_language_reads_its_own_date_page(tmp_path, monkeypatch):
    """A German Wikipedia's page for the day is 25._September, a Hebrew
    one's 25_בספטמבר, each under its own heading for the events."""
    de_page = (
        '<h2>Ereignisse</h2><ul><li><a href="./1666">1666</a>: Der '
        '<a href="./Fire">Große Brand</a> von London beginnt.</li></ul>'
        '<h2>Geboren</h2><ul><li>1854: <a href="./Water">Wasser</a></li></ul>'
    ).encode()
    he_page = (
        '<h2>אירועים היסטוריים ביום זה</h2><ul><li><a href="./1854">1854</a> – '
        '<a href="./Water">מים</a> נושאים כולרה</li></ul>'
    ).encode()
    _library(
        tmp_path,
        monkeypatch,
        [
            (
                "wikipedia_de_all_2026-08.zim",
                {
                    "Scraper": MW,
                    "Name": "wikipedia_de_all",
                    "Language": "deu",
                    "Title": "Wikipedia",
                },
                {"25._September": de_page},
            ),
            (
                "wikipedia_he_all_2026-08.zim",
                {
                    "Scraper": MW,
                    "Name": "wikipedia_he_all",
                    "Language": "heb",
                    "Title": "ויקיפדיה",
                },
                {"25_בספטמבר": he_page},
            ),
        ],
    )
    got = {w["language"]: wiki.on_this_day(w["name"], "0925") for w in wiki.wikis()}
    assert [(e["event_year"], e["path"]) for e in got["de"]] == [("1666", "A/Fire")]
    assert [(e["event_year"], e["path"]) for e in got["he"]] == [("1854", "A/Water")]


# ── Today: one thing from every wiki ──────────────────────────────────────


def _wiki_zim(path, name, language, title, pages, main="Main_Page"):
    """A wiki ZIM holding only ``pages`` ({path: (title, html)}) and a front
    page, so a day's pick can only land on one of them."""
    from conftest_zim import _Article
    from libzim.writer import Creator

    with Creator(path).config_indexing(True, "eng") as c:
        c.set_mainpath(main)
        c.add_item(
            _Article(
                main,
                "Main Page",
                b"<html><body><p>Welcome to the wiki, the front page.</p></body></html>",
            )
        )
        for p, (t, h) in pages.items():
            c.add_item(_Article(p, t, h.encode()))
        for k, v in {
            "Scraper": MW,
            "Name": name,
            "Language": language,
            "Title": title,
            "Description": "x",
        }.items():
            c.add_metadata(k, v)


def _page(inner):
    return '<html><body><div id="mw-content-text">%s</div></body></html>' % inner


TODAY_LIBRARY = {
    "wiktionary_he_all": (
        "heb",
        "ויקימילון",
        {
            "צנף": (
                "צנף",
                _page(
                    "<table><tr><td><p>ניתוח דקדוקי של המילה, טבלה ולא הגדרה</p></td></tr></table>"
                    "<ol><li><small>עברית חדשה</small> כרך מסביב, עטף. ”הצטנף בשמיכה“<ul><li>דוגמה</li></ul></li></ol>"
                ),
            )
        },
    ),
    "wikiquote_fr_all": (
        "fra",
        "Wikiquote",
        {
            "Voltaire": (
                "Voltaire",
                _page(
                    '<ul><li><a href="Candide">Candide</a> (1759)</li></ul>'
                    "<ul><li>« Il faut cultiver notre jardin. » ~ Candide</li></ul>"
                    "<h2>Voir aussi</h2><h2>Liens</h2>"
                ),
            )
        },
    ),
    "wikibooks_en_all": (
        "eng",
        "Wikibooks",
        {
            "Cookbook": (
                "Cookbook",
                _page(
                    "<p>A cookbook of recipes from around the world, free to read and to change.</p>"
                ),
            ),
            "Cookbook/Bread": (
                "Cookbook/Bread",
                _page(
                    "<p>Chapter on bread: flour, water, salt and yeast, and time.</p>"
                ),
            ),
        },
    ),
}


@pytest.fixture
def today_lib(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    for name, (lang, title, pages) in TODAY_LIBRARY.items():
        _wiki_zim(str(zdir / (name + "_2026-08.zim")), name, lang, title, pages)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    monkeypatch.setattr(wiki, "_today", lambda: DAY)
    wiki._reset_for_tests()
    srv.load_cache(force=True)
    return {w["project"]: w["name"] for w in wiki.wikis()}


def test_each_wiki_gives_the_thing_it_is_for_in_its_own_language(today_lib):
    word = wiki.pick(today_lib["wiktionary"], "20260925")
    assert word["role"] == "word" and word["title"] == "צנף" and word["lang"] == "he"
    # The sense: not the table, the register label, or the example after it.
    assert word["blurb"] == "כרך מסביב, עטף."
    quote = wiki.pick(today_lib["wikiquote"], "20260925")
    # Not the list of works; the quote, its marks left to the page's language.
    assert (
        quote["role"] == "quote" and quote["blurb"] == "Il faut cultiver notre jardin."
    )
    assert quote["kick"] == "Candide"
    book = wiki.pick(today_lib["wikibooks"], "20260925")
    # A book is its front page, never a chapter.
    assert book["role"] == "book" and book["path"] == "Cookbook"


def test_a_day_s_pick_holds_all_day_and_is_read_once(today_lib, monkeypatch):
    name = today_lib["wikibooks"]
    first = wiki.pick(name, "20260925")
    calls = []
    monkeypatch.setattr(wiki, "_work_pick", lambda *a: calls.append(a) or {})
    assert wiki.pick(name, "20260925") is first and not calls


def test_today_answers_for_the_wikis_named_and_home_carries_what_is_known(
    today_lib, monkeypatch
):
    # No background pass here: what home carries is what today() worked out.
    monkeypatch.setattr(
        wiki.threading,
        "Thread",
        lambda *a, **k: type("T", (), {"start": lambda self: None})(),
    )
    names = list(today_lib.values())
    home = wiki.home("20260925")
    assert home["day"] == "20260925" and home["picks"] == {}
    got = wiki.today("20260925", names + ["not_a_wiki"])
    assert set(got["picks"]) == set(names) and not got["failed"]
    assert set(wiki.home("20260925")["picks"]) == set(names)
    assert "picks" not in wiki.home("20270101")  # a day that cannot be asked for


def test_today_route_bounds_what_a_caller_can_ask(served):
    wikis = _get(served + "/wiki/home")[1]["wikis"]
    names = ",".join(w["name"] for w in wikis)
    status, got = _get(served + "/wiki/today?day=20260925&zim=" + names)
    assert status == 200 and set(got["picks"]) == {w["name"] for w in wikis}
    assert [e["event_year"] for e in got["otd"][wikis[0]["name"]]] == ["1666", "1854"]
    assert _get(served + "/wiki/today?day=20260101&zim=" + names)[0] == 400
    assert (
        _get(served + "/wiki/today?day=20260925&zim=" + ",".join(["x"] * 9))[0] == 400
    )


class _BrokenArchive:
    def get_entry_by_path(self, path):
        raise RuntimeError("disk gone")


def test_an_event_s_article_that_cannot_be_read_is_an_error_not_a_miss():
    """A subset not holding an event's article is a miss (KeyError: the next
    line is tried); a read that fails is an error, so the day is not kept
    as if it had no events."""
    from zimi import search

    with pytest.raises(RuntimeError):
        search._otd_event_entry(
            _BrokenArchive(), {"link": "X", "year": "1", "text": "t"}
        )
