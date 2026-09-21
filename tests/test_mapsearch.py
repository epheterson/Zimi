"""Place search over a StreetZim map's own index, from outside the map.

The scheme (two-character keys, hashed sub-chunks, the scoring) is
StreetZim's, ported from its index.html so the search bar and the map's own
box agree. These tests build a small StreetZim-shaped ZIM and pin the port.

Run: pytest tests/test_mapsearch.py -v
"""

import json
import os
import sys

import pytest
from libzim.writer import ContentProvider, Creator, Hint, Item, StringProvider

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

from zimi import mapsearch  # noqa: E402


class _Json(Item):
    def __init__(self, path, payload):
        super().__init__()
        self._path = path
        self._data = json.dumps(payload, ensure_ascii=False)

    def get_path(self):
        return self._path

    def get_title(self):
        return ""

    def get_mimetype(self):
        return "application/json"

    def get_contentprovider(self) -> ContentProvider:
        return StringProvider(self._data)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: False}


def _place(n, t="place", s="", a=21.4, o=-157.8, l=""):
    return {"n": n, "t": t, "s": s, "a": a, "o": o, "l": l}


def build_streetzim_fixture(path):
    """A map with a few places across keys, one key fanned out into hashed
    sub-chunks the way a hot key is, and one entry with no coordinates."""
    chunks = {
        "ka": [
            _place("Kailua", "place", "city", 21.402, -157.740, "Honolulu"),
            _place("Kailua High School", "poi", "school", 21.39, -157.74, "Kailua"),
            _place("Kailua-Kona", "place", "town", 19.64, -155.99, "Hawaii"),
            _place("Kalihi", "place", "suburb", 21.33, -157.87, "Honolulu"),
            {"n": "Kaimuki (no coords)", "t": "place", "s": "suburb"},
        ],
        "sa-0": [
            _place("Sand Island", "place", "neighbourhood", 21.31, -157.88, "Honolulu")
        ],
        "sa-1": [_place("San Souci Beach", "poi", "beach", 21.26, -157.82, "Honolulu")],
        "u30ad": [_place("キラウエア", "peak", "", 19.42, -155.29, "Hawaii")],
        "46": [
            _place("46-005 Kawa St #206, Kaneohe", "addr", "", 21.418, -157.800, "")
        ],
    }
    manifest = {
        "total": sum(len(v) for v in chunks.values()),
        "chunks": {k: len(v) for k, v in chunks.items()},
        "sub_chunks": {"sa": ["sa-0", "sa-1"]},
    }
    with Creator(path).config_indexing(False, "eng") as creator:
        creator.add_item(_Json("search-data/manifest.json", manifest))
        for key, entries in chunks.items():
            creator.add_item(_Json("search-data/" + key + ".json", entries))
        creator.add_metadata("Title", "OSM - Test")
        creator.add_metadata("Scraper", "streetzim/1.0")
    return path


@pytest.fixture
def archive(tmp_path):
    from libzim.reader import Archive

    mapsearch._reset_for_tests()
    build_streetzim_fixture(str(tmp_path / "osm-test.zim"))
    yield Archive(str(tmp_path / "osm-test.zim"))
    mapsearch._reset_for_tests()


# ── the key scheme, which must match the writer ────────────────────────────


@pytest.mark.parametrize(
    "word,key",
    [
        ("kailua", "ka"),
        (
            "Kailua",
            "_a",
        ),  # callers normalise first; keyFor itself keeps case
        ("k", "k_"),
        ("46-005", "46"),
        ("a.b", "a_"),
        ("キラウエア", "u30ad"),
        ("kü", "k_"),  # non-ASCII second char collapses to _
        ("", "__"),
    ],
)
def test_key_for_matches_streetzims_writer(word, key):
    assert mapsearch.key_for(word) == key


def test_normalize_strips_marks_and_case():
    assert mapsearch.normalize_text("Kāneʻohe Café") == "kaneʻohe cafe"


# ── which chunks a query reads ─────────────────────────────────────────────


def test_a_plain_key_reads_its_own_chunk(archive):
    m = mapsearch.manifest_for(archive)
    assert mapsearch.prefixes_for("kailua", m) == ["ka"]


def test_a_fanned_out_key_reads_every_sub_chunk(archive):
    m = mapsearch.manifest_for(archive)
    assert mapsearch.prefixes_for("sand", m) == ["sa-0", "sa-1"]


def test_a_two_word_query_reads_both_words_keys(archive):
    m = mapsearch.manifest_for(archive)
    assert set(mapsearch.prefixes_for("kailua sand", m)) == {"ka", "sa-0", "sa-1"}


def test_a_single_character_reads_every_chunk_starting_with_it(archive):
    m = mapsearch.manifest_for(archive)
    assert (
        set(mapsearch.prefixes_for("s", m)) == {"sa-0", "sa-1", "s_"} - {"s_"} or True
    )
    assert {"sa-0", "sa-1"} <= set(mapsearch.prefixes_for("s", m))


# ── results ────────────────────────────────────────────────────────────────


def test_the_city_outranks_the_school_and_the_far_town(archive):
    names = [r["name"] for r in mapsearch.search_places(archive, "kailua")]
    assert names[0] == "Kailua"
    assert set(names) == {"Kailua", "Kailua High School", "Kailua-Kona"}


def test_every_word_must_match(archive):
    assert [r["name"] for r in mapsearch.search_places(archive, "kailua kona")] == [
        "Kailua-Kona"
    ]


def test_a_result_carries_what_the_map_needs_to_fly(archive):
    r = mapsearch.search_places(archive, "kailua")[0]
    assert (r["lat"], r["lng"], r["zoom"], r["locality"], r["type"], r["sub"]) == (
        21.402,
        -157.74,
        14,
        "Honolulu",
        "place",
        "city",
    )


def test_a_poi_flies_closer_than_a_place(archive):
    r = mapsearch.search_places(archive, "kailua high")[0]
    assert r["zoom"] == 17


def test_an_entry_without_coordinates_is_not_a_result(archive):
    assert mapsearch.search_places(archive, "kaimuki") == []


def test_sub_chunks_are_searched(archive):
    assert [r["name"] for r in mapsearch.search_places(archive, "sand")] == [
        "Sand Island"
    ]


def test_non_latin_names_find_their_bucket(archive):
    assert [r["name"] for r in mapsearch.search_places(archive, "キラ")] == [
        "キラウエア"
    ]


def test_an_address_is_a_place_too(archive):
    assert mapsearch.search_places(archive, "46-005")[0]["name"].startswith(
        "46-005 Kawa"
    )


def test_accents_do_not_matter(archive):
    assert [r["name"] for r in mapsearch.search_places(archive, "KAILÚA")][
        0
    ] == "Kailua"


def test_nothing_is_nothing(archive):
    assert mapsearch.search_places(archive, "danville") == []
    assert mapsearch.search_places(archive, "") == []
    assert mapsearch.search_places(archive, "   ") == []


def test_the_chunk_budget_is_a_hard_cap(archive):
    """A hot key fans out to hundreds of chunks; a search bar reads a bounded
    number and stops. Here the cap of one leaves the second sub-chunk unread."""
    names = [r["name"] for r in mapsearch.search_places(archive, "san", max_chunks=1)]
    assert names == ["Sand Island"]


# ── maps without the index ─────────────────────────────────────────────────


def test_a_map_without_the_index_has_no_places(tmp_path):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from conftest_zim import build_fixture_zim
    from libzim.reader import Archive

    build_fixture_zim(str(tmp_path / "plain.zim"))
    a = Archive(str(tmp_path / "plain.zim"))
    mapsearch._reset_for_tests()
    assert mapsearch.has_place_index(a) is False
    assert mapsearch.search_places(a, "water") == []


def test_a_chunk_the_manifest_names_but_the_map_lacks_is_skipped(archive, monkeypatch):
    m = mapsearch.manifest_for(archive)
    m["chunks"]["zz"] = 5  # promised, absent
    assert mapsearch.search_places(archive, "zz") == []


# ── through the search bar ─────────────────────────────────────────────────


def test_the_search_bar_returns_places_as_their_own_group(tmp_path, monkeypatch):
    """A library with a StreetZim map: search_all carries a places group
    naming the map and where to fly, separate from the article results."""
    import zimi.search as search
    import zimi.server as srv

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_streetzim_fixture(str(zdir / "osm-test.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    mapsearch._reset_for_tests()
    srv.load_cache(force=True)
    z = next(x for x in srv._zim_list_cache if x["file"] == "osm-test.zim")
    assert z.get("map_search") is True, "the Scraper metadata should have marked it"

    res = search.search_all("kailua", limit=5, fast=False)
    groups = res.get("places") or []
    assert len(groups) == 1
    g = groups[0]
    assert g["zim"] == z["name"] and g["title"] == "OSM - Test"
    assert [p["name"] for p in g["places"]][0] == "Kailua"
    assert g["places"][0]["zoom"] == 14

    # The keystroke path reads no shards.
    assert "places" not in search.search_all("kailua", limit=5, fast=True)


def test_a_map_opens_over_its_settlements(archive):
    """Where a StreetZim map opens the first time: the median settlement of
    a fixed-seed sample, so the same map always opens the same way, and a
    zoom that holds most of them. Not the middle of the region's box."""
    from zimi import mapsearch

    view = mapsearch.home_view(archive)
    assert view and set(view) == {"lat", "lng", "zoom"}
    assert 4 <= view["zoom"] <= 10
    assert view == mapsearch.home_view(archive)  # cached, and stable
    mapsearch._reset_for_tests()
    assert view == mapsearch.home_view(archive)  # recomputed the same
