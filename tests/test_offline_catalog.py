"""Which catalog a machine shows, and how it hands over between them.

The rule, in Eric's words on 2026-09-16: "we update on first load or when
first getting internet seamlessly and store the new cache instead."

So: a successful live fetch replaces the cache wholesale, the cache outranks
the shipped snapshot from then on, and the snapshot is never written to or
merged into. The merge is the case worth having tests against, because it is
the tempting one and it produces the worst outcome: a library half of which is
six months old, with nothing on screen to say which half.

Run: pytest tests/test_offline_catalog.py -v
"""

import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi import catalog_snapshot  # noqa: E402
from zimi import library as lib  # noqa: E402
from zimi import server as srv  # noqa: E402

CACHED = [{"name": "from_cache", "title": "Cached"}]
SHIPPED = [{"name": "from_snapshot", "title": "Shipped"}]


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def shipped(tmp_path, monkeypatch):
    """A snapshot in the package, as a released build would have."""
    snap = tmp_path / "snap.json.gz"
    catalog_snapshot.write_snapshot(str(snap), SHIPPED, "2026-09-16")
    monkeypatch.setattr(catalog_snapshot, "SNAPSHOT_PATH", str(snap))
    monkeypatch.setattr(catalog_snapshot, "ICONS_PATH", str(tmp_path / "none.tar"))
    catalog_snapshot._reset_for_tests()
    yield
    catalog_snapshot._reset_for_tests()


@pytest.fixture
def no_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog_snapshot, "SNAPSHOT_PATH", str(tmp_path / "nope.gz"))
    monkeypatch.setattr(catalog_snapshot, "ICONS_PATH", str(tmp_path / "nope.tar"))
    catalog_snapshot._reset_for_tests()
    yield
    catalog_snapshot._reset_for_tests()


# ── the three states ───────────────────────────────────────────────────────


def test_never_online_browses_the_shipped_snapshot(data_dir, shipped):
    items, source, as_of = lib.offline_catalog()
    assert [i["name"] for i in items] == ["from_snapshot"]
    assert source == "snapshot"
    assert as_of == "2026-09-16"


def test_online_once_browses_its_own_cache(data_dir, shipped):
    lib.persist_full_catalog(CACHED)
    items, source, as_of = lib.offline_catalog()
    assert [i["name"] for i in items] == ["from_cache"]
    assert source == "cache"
    assert as_of, "a cached catalog must carry the date it was fetched"


def test_neither_is_an_honest_nothing(data_dir, no_snapshot):
    items, source, as_of = lib.offline_catalog()
    assert (items, source, as_of) == ([], "none", "")


# ── the handover ───────────────────────────────────────────────────────────


def test_the_cache_outranks_the_snapshot_even_when_older(data_dir, shipped):
    """Deliberate. The snapshot's date is when the release was cut, which can
    be later than someone's last fetch, but the cache is THEIR library and the
    rule is that it wins. A snapshot that could overtake a cache would mean a
    machine silently reverting to a catalog it had already replaced."""
    lib.persist_full_catalog(CACHED)
    ancient = os.path.join(str(data_dir), "catalog_full.json")
    with open(ancient, encoding="utf-8") as f:
        payload = json.load(f)
    payload["fetched_at"] = time.time() - 365 * 86400
    with open(ancient, "w", encoding="utf-8") as f:
        json.dump(payload, f)

    items, source, _ = lib.offline_catalog()
    assert source == "cache"
    assert [i["name"] for i in items] == ["from_cache"]


def test_a_new_fetch_replaces_the_cache_wholesale(data_dir, shipped):
    lib.persist_full_catalog([{"name": "old_a"}, {"name": "old_b"}])
    lib.persist_full_catalog([{"name": "new_only"}])
    items, source, _ = lib.offline_catalog()
    assert source == "cache"
    assert [i["name"] for i in items] == ["new_only"], "the old entries survived"


def test_nothing_ever_merges_the_snapshot_into_the_cache(data_dir, shipped):
    """The tempting mistake. A merged library is partly months old with no way
    to tell which half, which is worse than either source alone."""
    lib.persist_full_catalog(CACHED)
    items, _, _ = lib.offline_catalog()
    names = {i["name"] for i in items}
    assert "from_snapshot" not in names


def test_the_snapshot_file_is_never_written_to(data_dir, shipped):
    before = open(catalog_snapshot.SNAPSHOT_PATH, "rb").read()
    lib.persist_full_catalog(CACHED)
    lib.offline_catalog()
    assert open(catalog_snapshot.SNAPSHOT_PATH, "rb").read() == before


# ── writing the cache ──────────────────────────────────────────────────────


def test_an_empty_catalog_is_not_persisted(data_dir):
    """A failed fetch that yielded nothing must not overwrite a good cache
    with emptiness."""
    lib.persist_full_catalog(CACHED)
    assert lib.persist_full_catalog([]) is False
    items, source, _ = lib.offline_catalog()
    assert source == "cache" and len(items) == 1


def test_a_corrupt_cache_falls_through_to_the_snapshot(data_dir, shipped):
    path = os.path.join(str(data_dir), "catalog_full.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write("{not json")
    items, source, _ = lib.offline_catalog()
    assert source == "snapshot"
    assert [i["name"] for i in items] == ["from_snapshot"]


def test_an_unwritable_data_dir_is_not_fatal(tmp_path, monkeypatch):
    """A read-only data directory means no offline survival, not a crash."""
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "does" / "not" / "exist"))
    assert lib.persist_full_catalog(CACHED) is False


# ── assembling from the page cache ─────────────────────────────────────────


def test_the_full_catalog_is_written_only_when_the_pages_cover_it(
    data_dir, monkeypatch
):
    """Assembled from pages already in memory, so it costs no network. But a
    partial write would satisfy offline_catalog() forever with half a library
    and no sign that it was half, so it only writes when complete."""
    pages = {
        "|eng|500|0": (time.time(), 3, [{"name": "a"}, {"name": "b"}]),
    }
    monkeypatch.setattr(lib, "_opds_cache", pages)
    assert lib.maybe_persist_full_catalog(3) is False, "wrote a partial catalog"

    pages["|eng|500|500"] = (time.time(), 3, [{"name": "c"}])
    assert lib.maybe_persist_full_catalog(3) is True
    items, source, _ = lib.offline_catalog()
    assert source == "cache"
    assert [i["name"] for i in items] == ["a", "b", "c"]


def test_duplicate_entries_across_pages_are_collapsed(data_dir, monkeypatch):
    """Pages overlap when the catalog shifts mid-walk, and the same ZIM can
    land twice."""
    monkeypatch.setattr(
        lib,
        "_opds_cache",
        {
            "|eng|500|0": (time.time(), 2, [{"name": "a"}, {"name": "b"}]),
            "|eng|500|500": (time.time(), 2, [{"name": "b"}, {"name": "c"}]),
        },
    )
    assert lib.maybe_persist_full_catalog(2) is True
    items, _, _ = lib.offline_catalog()
    assert [i["name"] for i in items] == ["a", "b", "c"]


def test_search_pages_are_not_mistaken_for_the_catalog(data_dir, monkeypatch):
    """Only browse keys (empty query) describe the whole library. A search
    result page holds a handful of matches and must never be written down as
    if it were the catalog."""
    monkeypatch.setattr(
        lib,
        "_opds_cache",
        {"wikipedia|eng|500|0": (time.time(), 2, [{"name": "hit"}, {"name": "hit2"}])},
    )
    assert lib.maybe_persist_full_catalog(2) is False
    _, source, _ = lib.offline_catalog()
    assert source != "cache"


def test_a_cold_page_answers_from_the_snapshot_and_fetches_behind(data_dir, shipped, monkeypatch):
    """The first browse on a fresh install used to wait on Kiwix. Nothing
    cached, a snapshot in the package: the snapshot answers now, marked
    stale, and the live fetch goes out behind it."""
    import threading
    import urllib.request

    monkeypatch.setattr(lib, "_opds_disk_loaded", True)
    monkeypatch.setattr(lib, "_opds_last_fail", 0.0)
    monkeypatch.setattr(lib, "_thumb_prefetch_started", True)
    lib._opds_cache.clear()
    lib._opds_refreshing.clear()
    lib._catalog_stale_ts = None
    hit = threading.Event()

    def fake_urlopen(req, *a, **k):
        hit.set()
        raise OSError("no network in this test")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    total, items, err = lib._fetch_kiwix_catalog("", "eng", 5, 0)
    assert err is None
    assert total == 1 and [i["name"] for i in items] == ["from_snapshot"]
    assert lib._catalog_stale_ts
    assert hit.wait(3), "the live fetch did not go out behind the answer"
