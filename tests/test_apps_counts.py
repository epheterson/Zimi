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


def test_the_worker_counts_them_first_after_it_settles(monkeypatch):
    """The background worker that already reads ZIMs after start counts
    them, before the provenance walk opens every archive."""
    order = []
    monkeypatch.setattr(srv, "_SHAPE_SETTLE_SECONDS", 0)
    monkeypatch.setattr(srv, "_app_items_warm", lambda: order.append("counts"))

    def _stop():
        order.append("provenance")
        raise StopIteration

    monkeypatch.setattr(srv, "_provenance_warm", _stop)
    try:
        srv._shape_backfill()
    except StopIteration:
        pass
    assert order == ["counts", "provenance"]


def test_a_fresh_server_counts_questions_and_posts_without_the_apps_opening(
    tmp_path, monkeypatch
):
    """A fresh server's Apps page shows ZimiExchange's questions and Reddot's
    posts before either app has been opened; counted once, nothing is read
    again, and the Apps page's own read (the library's list) reads no listing."""
    import test_exchange
    import test_reddot
    from conftest_zim import build_fixture_zim
    from zimi import exchange, reddot

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(
        str(zdir / "cooking.stackexchange.com_en_all_2026-07.zim"),
        {"Scraper": "sotoki v3.1.1", "Name": "cooking.stackexchange.com_en_all"},
        files=test_exchange.FILES,
    )
    build_fixture_zim(
        str(zdir / "reddit_kiwix.zim"),
        {"Scraper": "arcticzim", "Name": "reddit_kiwix", "Tags": "_category:reddit"},
        files=test_reddot.FILES,
    )
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    exchange._reset_for_tests()
    reddot._reset_for_tests()
    srv.load_cache(force=True)
    site = srv._zim_short_name("cooking.stackexchange.com_en_all_2026-07.zim")
    sub = srv._zim_short_name("reddit_kiwix.zim")
    assert "items" not in _entry(site) and "items" not in _entry(sub)

    srv._app_items_warm()
    assert _entry(site)["items"]["exchange"] > 0
    assert _entry(sub)["items"]["reddot"] > 0
    reads = []
    monkeypatch.setattr(exchange, "listing", lambda *a, **k: reads.append(a))
    monkeypatch.setattr(reddot, "listing", lambda *a, **k: reads.append(a))
    srv._app_items_warm()
    assert _reloaded(site)["items"]["exchange"] > 0
    assert _reloaded(sub)["items"]["reddot"] > 0
    assert reads == []
    srv.release_zim_handles(list(srv.get_zim_files()))
