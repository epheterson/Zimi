"""ZimiExchange: every Stack Exchange site in the library, as one place.

Run: pytest tests/test_exchange.py -v
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from sotoki_fixture import LISTING, QUESTION, TAGS  # noqa: E402
from zimi import exchange  # noqa: E402

FILES = {
    "questions": LISTING.encode(),
    "questions_page=2": LISTING.replace("567", "999").encode(),
    "questions/tagged/onions": LISTING.encode(),
    "tags": TAGS.encode(),
    "questions/567/how-can-i-chop-onions-without-crying": QUESTION.encode(),
}


def _library(tmp_path, monkeypatch, zims):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    for filename, metadata, files in zims:
        build_fixture_zim(str(zdir / filename), metadata, files=files)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    exchange._reset_for_tests()
    srv.load_cache(force=True)


def test_a_sotoki_zim_is_a_qa_site():
    assert srv._zim_kind("sotoki v3.1.1", "_category:stack_exchange;stack_exchange", "") == "qa"
    assert srv._zim_kind("mwoffliner 1.13", "stack_exchange", "") is None


def test_the_listing_is_the_sites_own_order_with_votes_answers_and_tags():
    rows = exchange.rows_from_listing(LISTING)
    assert [(r["id"], r["title"], r["votes"], r["answers"], r["accepted"]) for r in rows] == [
        ("567", "How can I chop onions without crying?", 265, 21, True),
        ("82174", "Why using low temperature cooking for potatoes?", 5, 2, False),
    ]
    assert rows[0]["page"] == "questions/567/how-can-i-chop-onions-without-crying"
    assert rows[0]["tags"] == ["onions", "knife-skills"] and rows[1]["tags"] == ["potatoes"]
    assert rows[0]["excerpt"].startswith("Onions are an excellent") and '"cry"' in rows[0]["excerpt"]
    assert exchange.pages_in(LISTING) == 100


def test_the_tags_page_gives_tags_with_counts():
    assert exchange.tags_from_page(TAGS) == [
        {"tag": "baking", "description": "Questions about cooking by dry heat.", "count": 2666},
        {"tag": "bread", "description": "Bread.", "count": 1500},
    ]


def test_a_question_is_owned_answers_scored_accepted_first_links_rebased():
    q = exchange.question_from_page(QUESTION, "questions/567/how-can-i-chop-onions-without-crying", "cooking")
    assert q["title"] == "How can I chop onions without crying?"
    assert q["votes"] == 265 and q["author"] == "Michael"
    assert q["tags"] == ["onions", "knife-skills"]
    assert "<b>cry</b>" in q["body"]
    assert 'href="/w/cooking/questions/82174/why-using-low-temperature-cooking-for-potatoes" data-q="questions/82174/why-using-low-temperature-cooking-for-potatoes"' in q["body"]
    assert 'src="/w/cooking/images/abc"' in q["body"]
    assert [(a["id"], a["score"], a["accepted"], a["author"]) for a in q["answers"]] == [
        ("570", 158, True, "Ryan Elkins"),
        ("2092", 172, False, "Aaronut"),
    ]
    assert "<script" not in q["answers"][0]["body"] and "<code>sharp</code>" in q["answers"][0]["body"]


def test_the_whole_thing_through_a_zim(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("cooking.stackexchange.com_en_all_2026-07.zim", {"Scraper": "sotoki v3.1.1", "Name": "cooking.stackexchange.com_en_all"}, FILES), ("survival_en_2026-06.zim", None, {})])
    name = srv._zim_short_name("cooking.stackexchange.com_en_all_2026-07.zim")
    assert [s["name"] for s in exchange.sites()] == [name]
    home = exchange.home()
    assert home["sites"][0]["rows"][0]["title"].startswith("How can I chop") and home["sites"][0]["pages"] == 100
    assert [t["tag"] for t in home["sites"][0]["tags"]] == ["baking", "bread"]
    assert exchange.listing(name, 2)["rows"][0]["id"] == "999"
    assert exchange.listing(name, 1, "onions")["rows"][0]["id"] == "567"
    assert exchange.listing(name, 1, "nothing") == {"rows": [], "pages": 0}
    q = exchange.question(name, "questions/567/how-can-i-chop-onions-without-crying")
    assert q and q["answers"][0]["accepted"]
    assert exchange.question(name, "questions/1/missing") is None
    assert exchange.question("survival", "questions") is None


def test_the_routes_are_rate_limited_as_api_paths():
    from zimi import http

    assert "/exchange" in http._RATE_LIMITED_API_PATHS


# ── one site once ──────────────────────────────────────────────────────────


def test_two_builds_of_one_site_are_one_shelf_the_newest(tmp_path, monkeypatch):
    """Eric, 2026-09-19: "handle deduplication if we're merging multiple
    Zims." A nopic beside a maxi, or last month's file beside this month's,
    is one site; the newest build (then the fullest) is the one read."""
    _library(tmp_path, monkeypatch, [
        ("cooking.stackexchange.com_en_all_nopic_2026-07.zim", {"Scraper": "sotoki v3.1.1", "Name": "cooking.stackexchange.com_en_all_nopic", "Date": "2026-07-01"}, FILES),
        ("cooking.stackexchange.com_en_all_maxi_2026-08.zim", {"Scraper": "sotoki v3.1.1", "Name": "cooking.stackexchange.com_en_all_maxi", "Date": "2026-08-01"}, FILES),
    ])
    sites = exchange.sites()
    assert len(sites) == 1 and str(sites[0]["date"]).startswith("2026-08"), sites
    assert len(exchange.home()["sites"]) == 1


def test_newest_per_keeps_the_newest_then_the_fullest_and_the_keyless():
    rows = [
        {"id": "a", "date": "2026-01", "size_bytes": 1},
        {"id": "b", "date": "2026-03", "size_bytes": 1},
        {"id": "c", "date": "2026-03", "size_bytes": 9},
        {"id": "d"},
    ]
    kept = srv.newest_per(rows, lambda r: "" if r["id"] == "d" else "k")
    assert [r["id"] for r in kept] == ["c", "d"]
