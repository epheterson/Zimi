"""The Apps page counts what each app shows, not ZIM entries (1.12.1).

Each app notes how many of its things a ZIM holds when it has read them
anyway (server.note_app_items): the Bookshelf when a ZIM's books are read in
the background, ZimiTube when it lists a ZIM's videos, ZimiExchange and
Reddot when their front reads a site's first listing. The count rides the
library's list and the metadata cache beside it, so the Apps page shows it
at the next load with nothing read on its way (tests/test_apps_counts.cjs
has the page's side).

Run: pytest tests/test_apps_counts.py -v
"""

import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from test_books_sources import (  # noqa: E402,F401
    _gutenberg,
    _libretexts,
    _wikisource,
    shelf_lib,
)


def _entry(name):
    return next(z for z in srv.list_zims() if z["name"] == name)


def _reloaded(name):
    """The entry as the next start reads it, from the metadata cache."""
    srv._zim_list_cache = None
    srv.load_cache()
    return _entry(name)


def test_a_paged_listing_is_counted_by_its_first_and_last_pages():
    pages = {1: {"rows": [1, 2, 3], "pages": 4}, 4: {"rows": [1]}}
    assert srv.paged_count(pages[1], pages.get) == 10
    assert srv.paged_count({"rows": [1, 2], "pages": 1}, pages.get) == 2
    assert srv.paged_count({"rows": [], "pages": 0}, pages.get) == 0


def test_the_bookshelf_counts_each_zims_books(shelf_lib):
    from zimi import books

    names = shelf_lib([_gutenberg(), _wikisource(), _libretexts()])
    gutenberg = names["gutenberg_la_all_2026-01"]
    ws = names["wikisource_eo_all_nopic_2026-07"]
    lt = names["libretexts.org_en_stats_2026-01"]
    per_zim = {s["name"]: s["n"] for s in books.home()["sources"]}
    for name in (gutenberg, ws, lt):
        entry = _entry(name)
        assert entry["items"]["books"] == per_zim[name], (name, entry.get("items"))
        # Not its entries: a Gutenberg ZIM's covers, EPUBs and listings, a
        # wiki's every page.
        assert entry["items"]["books"] < entry["entries"]
    # Kept with the library: the next start has it before any app runs.
    assert _reloaded(ws)["items"]["books"] == per_zim[ws]


def test_exchange_and_reddot_count_questions_and_posts(tmp_path, monkeypatch):
    import test_exchange
    import test_reddot
    from zimi import exchange, reddot

    (tmp_path / "qa").mkdir()
    test_exchange._library(
        tmp_path / "qa",
        monkeypatch,
        [
            (
                "cooking.stackexchange.com_en_all_2026-07.zim",
                {
                    "Scraper": "sotoki v3.1.1",
                    "Name": "cooking.stackexchange.com_en_all",
                },
                test_exchange.FILES,
            )
        ],
    )
    site = srv._zim_short_name("cooking.stackexchange.com_en_all_2026-07.zim")
    assert "items" not in _entry(site)
    exchange.home()
    first = exchange.listing(site, 1)
    want = srv.paged_count(first, lambda p: exchange.listing(site, p))
    assert want and _entry(site)["items"] == {"exchange": want}
    assert _reloaded(site)["items"] == {"exchange": want}
    srv.release_zim_handles(list(srv.get_zim_files()))

    (tmp_path / "rd").mkdir()
    test_reddot._library(
        tmp_path / "rd",
        monkeypatch,
        [
            (
                "reddit_kiwix.zim",
                {
                    "Scraper": "arcticzim",
                    "Name": "reddit_kiwix",
                    "Tags": "_category:reddit",
                },
                test_reddot.FILES,
            )
        ],
    )
    name = srv._zim_short_name("reddit_kiwix.zim")
    reddot.home()
    want = sum(
        srv.paged_count(
            reddot.listing(name, sub, "top", 1),
            lambda p, sub=sub: reddot.listing(name, sub, "top", p),
        )
        for sub in reddot.subreddits(name)
    )
    assert want and _entry(name)["items"] == {"reddot": want}
    srv.release_zim_handles(list(srv.get_zim_files()))
