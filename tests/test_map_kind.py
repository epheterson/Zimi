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
