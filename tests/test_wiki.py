"""Zimipedia: every wiki in the library, as one.

Run: pytest tests/test_wiki.py -v
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
from zimi import wiki  # noqa: E402

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


@pytest.fixture
def served(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    _library(tmp_path, monkeypatch, LIBRARY)
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
