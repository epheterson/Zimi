"""A map ZIM files under Maps whatever its file is called.

Kiwix ships maps as maps_en_<region>.zim, and the filename heuristic catches
that. But files get renamed (samoa.zim), and StreetZim names its output after
the region with no "maps" anywhere (osm_osm_-_hawaii). The Scraper and Tags
metadata survive a rename, so the category comes from those first.

Run: pytest tests/test_map_kind.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from zimi import server as srv  # noqa: E402

SCRATCH = os.environ.get("ZIMI_SCRATCH_MAPS", "")


@pytest.mark.parametrize(
    "scraper,tags,meta_name",
    [
        ("maps2zim v0.2.1", "_sw:no;_ftindex:no", ""),  # Kiwix
        ("streetzim/1.0", "", ""),
        ("AtlasZim 2.0", "", ""),
        ("", "maps;osm;offline;_pictures:yes", ""),  # tagged, unknown scraper
        ("", "", "maps_en_samoa"),  # only the Name metadata says so
    ],
)
def test_a_map_is_recognised_from_its_metadata(scraper, tags, meta_name):
    assert srv._zim_kind(scraper, tags, meta_name) == "map"


@pytest.mark.parametrize(
    "scraper,tags,meta_name",
    [
        ("mwoffliner 1.13", "wikipedia;_category:wikipedia", "wikipedia_en_all"),
        ("", "sitemaps;seo", "sitemaps_en"),  # a tag merely containing "maps"
        ("", "", "openstreetmap-wiki_en_all"),  # the wiki about OSM, not a map
        ("", "", ""),
    ],
)
def test_everything_else_is_not(scraper, tags, meta_name):
    assert srv._zim_kind(scraper, tags, meta_name) is None


def test_kind_beats_the_filename_but_not_the_folder(monkeypatch):
    monkeypatch.setattr(srv, "_zim_folder", lambda path: "")
    assert srv._effective_category("samoa", "/zims/samoa.zim", "map") == "Maps"
    assert srv._effective_category("samoa", "/zims/samoa.zim", None) is None
    monkeypatch.setattr(srv, "_zim_folder", lambda path: "pacific")
    monkeypatch.setattr(srv, "_folder_category", lambda folder: "Pacific")
    assert srv._effective_category("samoa", "/zims/pacific/samoa.zim", "map") == "Pacific"


def test_the_kiwix_filename_still_files_without_metadata():
    assert srv._categorize_zim("maps_en_samoa") == "Maps"
    # maps_en_all_2026-06.zim strips all the way to the stem "maps".
    assert srv._categorize_zim("maps") == "Maps"
    assert srv._categorize_zim("maps_fr_all") == "Maps"
    assert srv._categorize_zim("openstreetmap-wiki") == "Wikimedia"


@pytest.mark.skipif(
    not (SCRATCH and os.path.exists(os.path.join(SCRATCH, "samoa.zim"))),
    reason="set ZIMI_SCRATCH_MAPS to a directory holding samoa.zim and hawaii.zim",
)
@pytest.mark.parametrize("stem", ["samoa", "hawaii"])
def test_real_map_zims_scan_as_maps(stem):
    """samoa.zim is Kiwix's maps_en_samoa renamed; hawaii.zim is StreetZim's."""
    info, archive = srv._extract_zim_metadata(stem, os.path.join(SCRATCH, f"{stem}.zim"))
    assert info["kind"] == "map"
    assert info["category"] == "Maps"


def test_kind_survives_the_metadata_cache(tmp_path, monkeypatch):
    """The disk cache is a whitelist of fields. A fresh scan filed samoa.zim
    under Maps and the next boot, served from the cache, filed it under
    nothing, because ``kind`` had not been written down."""
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "samoa.zim"), {"Scraper": "maps2zim v0.2.1"})
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)

    srv.load_cache(force=True)
    fresh = next(z for z in srv._zim_list_cache if z["name"] == "samoa")
    assert (fresh["category"], fresh["kind"]) == ("Maps", "map")

    srv.load_cache(force=False)  # the cache hit
    hit = next(z for z in srv._zim_list_cache if z["name"] == "samoa")
    assert (hit["category"], hit.get("kind")) == ("Maps", "map")


def _library_with(tmp_path, monkeypatch, filename, metadata=None):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / filename), metadata)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)


def test_a_record_from_before_kind_existed_is_backfilled_on_a_cache_hit(tmp_path, monkeypatch):
    """Eric's world map: registered by 1.9 half an hour before 1.10 booted, so
    its cache record had no kind, and a cache hit never reopened the archive
    to find out. It listed under Other. A legacy record is read once, on the
    next boot, and the answer written down with the rest."""
    import json

    _library_with(tmp_path, monkeypatch, "maps_en_all_2026-06.zim", {"Scraper": "maps2zim v0.2.1"})
    srv.load_cache(force=True)
    cache_path = srv._cache_file_path()
    with open(cache_path, encoding="utf-8") as f:
        payload = json.load(f)
    record = payload["files"]["maps_en_all_2026-06.zim"]
    assert record["kind"] == "map"
    del record["kind"]  # what a 1.9 record looks like
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)

    srv.load_cache(force=False)  # the cache hit
    entry = next(z for z in srv._zim_list_cache if z["file"] == "maps_en_all_2026-06.zim")
    assert (entry["name"], entry["category"], entry.get("kind")) == ("maps", "Maps", "map")
    with open(cache_path, encoding="utf-8") as f:
        assert json.load(f)["files"]["maps_en_all_2026-06.zim"]["kind"] == "map", "not written down"


def test_a_non_map_is_decided_once_not_reread_every_boot(tmp_path, monkeypatch):
    import json

    _library_with(tmp_path, monkeypatch, "survival_en_2026-06.zim")
    srv.load_cache(force=True)
    with open(srv._cache_file_path(), encoding="utf-8") as f:
        record = json.load(f)["files"]["survival_en_2026-06.zim"]
    assert "kind" in record and record["kind"] == ""
    calls = []
    monkeypatch.setattr(srv, "_read_zim_kind", lambda path: calls.append(path) or ("", False))
    srv.load_cache(force=False)
    assert calls == [], "a decided record was read again"


@pytest.mark.parametrize(
    "scraper,expected",
    [("streetzim/1.0", True), ("AtlasZim 2.0", True), ("maps2zim v0.2.1", False), ("", False)],
)
def test_only_maps_with_a_search_box_offer_one(scraper, expected):
    assert srv._zim_map_search(scraper) is expected


def test_map_search_rides_the_cache(tmp_path, monkeypatch):
    _library_with(tmp_path, monkeypatch, "osm-hawaii-2026-09-08.zim", {"Scraper": "streetzim/1.0", "Tags": "maps;osm"})
    srv.load_cache(force=True)
    fresh = next(z for z in srv._zim_list_cache if z["file"] == "osm-hawaii-2026-09-08.zim")
    assert (fresh["kind"], fresh.get("map_search")) == ("map", True)
    srv.load_cache(force=False)
    hit = next(z for z in srv._zim_list_cache if z["file"] == "osm-hawaii-2026-09-08.zim")
    assert (hit["kind"], hit.get("map_search")) == ("map", True)


def test_a_map_record_without_map_search_learns_it_too(tmp_path, monkeypatch):
    """The first 1.10 build wrote kind but not map_search; a StreetZim map
    registered by it would never get the search-box offer."""
    import json

    _library_with(tmp_path, monkeypatch, "osm-hawaii-2026-09-08.zim", {"Scraper": "streetzim/1.0"})
    srv.load_cache(force=True)
    cache_path = srv._cache_file_path()
    with open(cache_path, encoding="utf-8") as f:
        payload = json.load(f)
    del payload["files"]["osm-hawaii-2026-09-08.zim"]["map_search"]
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    srv.load_cache(force=False)
    hit = next(z for z in srv._zim_list_cache if z["file"] == "osm-hawaii-2026-09-08.zim")
    assert hit.get("map_search") is True
