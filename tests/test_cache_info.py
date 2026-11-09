"""Cache-info payload: the data-dir storage breakdown that feeds the
Server-settings stacked bar. Verifies the additive breakdown/top_zims fields
without ever walking the ZIM library."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    (d / "titles").mkdir(parents=True)
    (d / "qids").mkdir()
    # Two per-ZIM title indexes of different sizes → top_zims ordering.
    (d / "titles" / "wikipedia.db").write_bytes(b"a" * 3000)
    (d / "titles" / "small.db").write_bytes(b"b" * 100)
    (d / "qids" / "wikipedia.qid.db").write_bytes(b"c" * 500)
    (d / "cache.json").write_bytes(b"{}" * 50)
    (d / "suggest_cache.json").write_bytes(b"x" * 40)
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(d))
    return d


def test_backward_compatible_shape(data_dir):
    p = manage._cache_info_payload()
    assert "caches" in p and "total_bytes" in p
    assert p["caches"]["title_indexes"]["count"] == 2
    assert p["caches"]["title_indexes"]["size_bytes"] == 3100


def test_breakdown_segments_present(data_dir):
    p = manage._cache_info_payload()
    keys = [seg["key"] for seg in p["breakdown"]]
    assert keys == [
        "title_indexes",
        "qid_indexes",
        "catalog_caches",
        "staging",
        "other",
    ]
    seg = {s["key"]: s for s in p["breakdown"]}
    assert seg["title_indexes"]["size_bytes"] == 3100
    assert seg["qid_indexes"]["size_bytes"] == 500


def test_top_zims_sorted_largest_first(data_dir):
    p = manage._cache_info_payload()
    names = [z["name"] for z in p["top_zims"]]
    assert names[0] == "wikipedia"
    assert set(names) == {"wikipedia", "small"}
    assert p["top_zims"][0]["size_bytes"] == 3000


def test_data_dir_total_covers_all_files(data_dir):
    p = manage._cache_info_payload()
    total = sum(seg["size_bytes"] for seg in p["breakdown"])
    assert p["data_dir_total_bytes"] == total
    # Everything we wrote is accounted for (title+qid+catalog json).
    assert p["data_dir_total_bytes"] >= 3100 + 500 + 100 + 40


def test_missing_dirs_yield_zeroes(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "nope"))
    p = manage._cache_info_payload()
    assert p["data_dir_total_bytes"] == 0
    assert p["top_zims"] == []


def _catalog_files(data_dir, tmp_path, monkeypatch):
    zims = tmp_path / "zims"
    zims.mkdir()
    (zims / "installed.zim").write_bytes(b"z")
    monkeypatch.setattr(server, "ZIM_DIR", str(zims))
    (data_dir / "catalog_cache.json").write_bytes(b"c" * 300)
    tdir = data_dir / "bt" / "torrents"
    tdir.mkdir(parents=True)
    (tdir / "installed.zim.torrent").write_bytes(b"t" * 1000)
    (tdir / "elsewhere.zim.torrent").write_bytes(b"t" * 5000)
    return tdir


def test_catalog_copies_are_the_catalog_files_and_torrents_of_what_is_not_installed(data_dir, tmp_path, monkeypatch):
    _catalog_files(data_dir, tmp_path, monkeypatch)
    (data_dir / "catalog_validators.json").write_bytes(b"v" * 20)
    p = manage._cache_info_payload()
    assert p["catalog_copies"] == {"count": 3, "size_bytes": 300 + 20 + 5000}


def test_purging_them_keeps_the_torrent_of_an_installed_zim(data_dir, tmp_path, monkeypatch):
    tdir = _catalog_files(data_dir, tmp_path, monkeypatch)
    assert manage._purge_catalog_copies() == 5300
    assert (tdir / "installed.zim.torrent").exists()
    assert not (tdir / "elsewhere.zim.torrent").exists() and not (data_dir / "catalog_cache.json").exists()
    assert manage._cache_info_payload()["catalog_copies"] == {"count": 0, "size_bytes": 0}
