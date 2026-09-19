"""StreetZim's regions as catalog entries, from the Internet Archive.

Run: pytest tests/test_streetzim.py -v
"""

import json
import os
import sys
import time

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

from zimi import server as srv  # noqa: E402
from zimi import streetzim  # noqa: E402


def _meta(files, **md):
    return {"files": files, "metadata": md}


def _f(name, size):
    return {"name": name, "size": str(size)}


# ── one item ───────────────────────────────────────────────────────────────


def test_the_newest_dated_file_is_the_one_offered():
    item = streetzim.item_from_metadata(
        "streetzim-hawaii",
        _meta(
            [
                _f("osm-hawaii-2026-09-06.zim", 253900646),
                _f("osm-hawaii-2026-09-08.zim", 254984574),
                _f("streetzim-hawaii_archive.torrent", 35574),
                _f("osm-hawaii-2026-09-08.zim_meta.txt", 12),
            ]
        ),
    )
    assert item["file"] == "osm-hawaii-2026-09-08.zim"
    assert item["date"] == "2026-09-08"
    assert item["size_bytes"] == 254984574
    assert (
        item["download_url"]
        == "https://archive.org/download/streetzim-hawaii/osm-hawaii-2026-09-08.zim"
    )


def test_the_entry_is_shaped_like_a_catalog_item():
    item = streetzim.item_from_metadata(
        "streetzim-silicon-valley", _meta([_f("osm-silicon-valley-2026-09-01.zim", 10)])
    )
    assert item["name"] == "osm-silicon-valley"
    assert item["title"] == "Silicon Valley"
    assert item["category"] == "maps"
    assert item["language"] == "eng"
    assert item["source"] == "streetzim"


def test_features_come_from_the_items_metadata_flags():
    item = streetzim.item_from_metadata(
        "streetzim-x",
        _meta(
            [_f("osm-x-2026-01-01.zim", 1)],
            streetzim_satellite="true",
            streetzim_routing="yes",
            streetzim_terrain="false",
        ),
    )
    assert item["features"] == ["satellite imagery", "routing"]
    assert "satellite imagery, routing" in item["summary"]


def test_a_short_item_description_is_used_as_the_summary():
    item = streetzim.item_from_metadata(
        "streetzim-x",
        _meta([_f("osm-x-2026-01-01.zim", 1)]),
        search_row={"description": "<p>Offline map of <b>X</b>.</p>"},
    )
    assert item["summary"].startswith("Offline map of X")


def test_an_item_without_a_map_file_is_nothing():
    assert (
        streetzim.item_from_metadata("streetzim-empty", _meta([_f("notes.txt", 1)]))
        is None
    )


@pytest.mark.parametrize(
    "region,title",
    [
        ("hawaii", "Hawaii"),
        ("silicon-valley", "Silicon Valley"),
        ("washington-dc", "Washington DC"),
        ("nyc-metro", "NYC Metro"),
        ("australia-nz", "Australia NZ"),
    ],
)
def test_region_names_read_as_titles(region, title):
    assert streetzim.humanize_region(region) == title


# ── the cache ──────────────────────────────────────────────────────────────


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(streetzim, "_offline", lambda: False)
    streetzim._reset_for_tests()
    yield tmp_path
    streetzim._reset_for_tests()


def test_never_fetched_is_an_honest_nothing_and_a_refresh(data_dir, monkeypatch):
    kicked = []
    monkeypatch.setattr(
        streetzim.threading,
        "Thread",
        lambda **kw: type("T", (), {"start": lambda self: kicked.append(kw["name"])})(),
    )
    items, source, as_of, _ = streetzim.get()
    assert (items, source, as_of) == ([], "none", "")
    assert kicked == ["streetzim-catalog"]


def test_a_fresh_cache_is_served_without_a_refresh(data_dir, monkeypatch):
    streetzim._write_cache([{"name": "osm-hawaii", "title": "Hawaii"}])
    kicked = []
    monkeypatch.setattr(
        streetzim.threading,
        "Thread",
        lambda **kw: type("T", (), {"start": lambda self: kicked.append(1)})(),
    )
    items, source, as_of, _ = streetzim.get()
    assert [i["name"] for i in items] == ["osm-hawaii"]
    assert source == "cache" and as_of == time.strftime("%Y-%m-%d", time.gmtime())
    assert kicked == []


def test_a_stale_cache_is_served_and_refreshed(data_dir, monkeypatch):
    with open(streetzim._cache_path(), "w", encoding="utf-8") as f:
        json.dump(
            {"fetched_at": time.time() - 3 * 86400, "items": [{"name": "osm-old"}]}, f
        )
    kicked = []
    monkeypatch.setattr(
        streetzim.threading,
        "Thread",
        lambda **kw: type("T", (), {"start": lambda self: kicked.append(1)})(),
    )
    items, source, _, _ = streetzim.get()
    assert [i["name"] for i in items] == ["osm-old"] and source == "cache"
    assert kicked == [1]


def test_offline_never_reaches_for_the_network(data_dir, monkeypatch):
    monkeypatch.setattr(streetzim, "_offline", lambda: True)
    kicked = []
    monkeypatch.setattr(
        streetzim.threading,
        "Thread",
        lambda **kw: type("T", (), {"start": lambda self: kicked.append(1)})(),
    )
    assert streetzim.get()[1] == "none"
    assert kicked == []


def test_a_failed_refresh_keeps_the_cache(data_dir, monkeypatch):
    streetzim._write_cache([{"name": "osm-hawaii"}])

    def boom():
        raise OSError("no network")

    monkeypatch.setattr(streetzim, "fetch_live", boom)
    assert streetzim.refresh() is None
    assert [i["name"] for i in streetzim.get(allow_refresh=False)[0]] == ["osm-hawaii"]


def test_a_refresh_replaces_the_cache_wholesale(data_dir, monkeypatch):
    streetzim._write_cache([{"name": "osm-old"}])
    monkeypatch.setattr(streetzim, "fetch_live", lambda: [{"name": "osm-new"}])
    assert streetzim.refresh() == [{"name": "osm-new"}]
    assert [i["name"] for i in streetzim.get(allow_refresh=False)[0]] == ["osm-new"]


def test_the_live_listing_skips_an_item_that_fails(data_dir, monkeypatch):
    def fake_get_json(url, timeout=0):
        if "advancedsearch" in url:
            return {
                "response": {
                    "docs": [
                        {"identifier": "streetzim-a"},
                        {"identifier": "streetzim-b"},
                    ]
                }
            }
        if url.endswith("streetzim-a"):
            return _meta([_f("osm-a-2026-01-01.zim", 5)])
        raise OSError("item b is down")

    monkeypatch.setattr(streetzim, "_get_json", fake_get_json)
    assert [i["name"] for i in streetzim.fetch_live()] == ["osm-a"]
