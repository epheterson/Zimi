"""Places autocomplete: type "Spri" after near:, pick "Springfield, Illinois".

Eric (2026-11-05): "do we have like places autocomplete or whatnot? So if they
know part of their city or they want to match the right state or country,
that's possible." The towns of a Kiwix map are read from its tiles
(zimi.mapplaces); each is given its region and country, from the tiles' tags
or offline from the outlines Zimi ships (zimi.regions), and the index answers
a prefix with the biggest places first. A place may be asked for by where it
is: "Springfield, IL", "Paris Texas", "Paris, France".

The map is made here: real Mapbox Vector Tiles with the tags the real ones
carry (class, name, name:en, rank, capital), real cities, so the regions the
outlines give can be checked against what everyone knows.

Run: pytest tests/test_place_autocomplete.py -v
"""

import os
import sqlite3
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

import zimi.search as search  # noqa: E402
import zimi.server as srv  # noqa: E402
from test_mapplaces import (  # noqa: E402
    EXTENT,
    _field,
    _land,
    _tile_path,
    _tile_xy,
    _uint_field,
    _varint,
    _zigzag,
)
from zimi import mapplaces, regions  # noqa: E402

NAME = "maps_en_places_2026-06"
MAP = "maps_en_places"

# (class, tags, (lat, lng)); rank is the tiles' own, 1 the biggest.
PLACES = [
    ("city", {"name": "Springfield", "rank": 6}, (39.80, -89.64)),  # Illinois
    ("city", {"name": "Springfield", "rank": 7}, (37.21, -93.29)),  # Missouri
    ("town", {"name": "Springfield"}, (42.10, -72.59)),  # Massachusetts
    ("town", {"name": "Springfield"}, (44.05, -123.02)),  # Oregon
    ("town", {"name": "Springdale"}, (36.19, -94.13)),  # Arkansas
    ("city", {"name": "Paris", "rank": 1, "capital": "2"}, (48.857, 2.352)),
    ("town", {"name": "Paris"}, (33.66, -95.56)),  # Texas
    ("city", {"name": "Köln", "name:en": "Cologne", "rank": 5}, (50.94, 6.96)),
    ("city", {"name": "Boston", "rank": 4}, (42.36, -71.06)),
]


def _place_layer(z, places):
    """A ``place`` layer: each (class, tags, (lat, lng)) as a point."""
    keys, values, feats = [], [], []
    for cls, tags, (lat, lng) in places:
        _x, _y, fx, fy = _tile_xy(z, lat, lng)
        pairs = []
        for k, v in (("class", cls), *tags.items()):
            if k not in keys:
                keys.append(k)
            if isinstance(v, int):  # a uint_value, as the real tiles' rank is
                values.append(_uint_field(5, v))
            else:
                values.append(_field(1, v.encode()))
            pairs += [keys.index(k), len(values) - 1]
        geom = [1 | (1 << 3), _zigzag(round(fx * EXTENT)), _zigzag(round(fy * EXTENT))]
        feats.append(
            _field(2, b"".join(_varint(t) for t in pairs))
            + _uint_field(3, 1)
            + _field(4, b"".join(_varint(g) for g in geom))
        )
    layer = _uint_field(15, 2) + _field(1, b"place")
    layer += b"".join(_field(2, f) for f in feats)
    layer += b"".join(_field(3, k.encode()) for k in keys)
    layer += b"".join(_field(4, v) for v in values)
    layer += _uint_field(5, EXTENT)
    return _field(3, layer)


def _map_files():
    by_tile = {}
    for cls, tags, ll in PLACES:
        z = 9 if cls == "city" else 10
        by_tile.setdefault((z, _tile_path(z, *ll)), []).append((cls, tags, ll))
        if z == 10:
            by_tile.setdefault((9, _tile_path(9, *ll)), [])
    files = {
        path: _place_layer(z, places) + (_land() if z == 9 else b"")
        for (z, path), places in by_tile.items()
    }
    files["content/config.json"] = b'{"boundingBox":[[-125.0,32.0],[10.0,52.0]]}'
    return files


# Every test runs twice: with the prefix table holding every prefix more than
# two rows begin with (so the table answers), and with the real threshold (so
# nothing is in it and the index is read).
@pytest.fixture(scope="module", params=[2, mapplaces.SCAN_MAX], ids=["table", "scan"])
def library(request, tmp_path_factory, monkeypatch_module):
    from conftest_zim import build_fixture_zim

    monkeypatch_module.setattr(mapplaces, "SCAN_MAX", request.param)

    root = tmp_path_factory.mktemp("places")
    zdir = root / "zims"
    zdir.mkdir()
    build_fixture_zim(
        str(zdir / f"{NAME}.zim"), {"Scraper": "maps2zim v0.2.1"}, files=_map_files()
    )
    saved = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(zdir), str(root / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    mapplaces._reset_for_tests()
    srv.load_cache(force=True)
    mapplaces.build_all()
    yield MAP
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = saved
    mapplaces._reset_for_tests()


@pytest.fixture(scope="module")
def monkeypatch_module():
    with pytest.MonkeyPatch.context() as mp:
        yield mp


def _rows(sql, *args):
    conn = sqlite3.connect(mapplaces._builder.path(MAP))
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


# ── the index knows where each place is ───────────────────────────────────


def test_each_place_has_its_region_and_country_from_the_outlines(library):
    where = {
        (name, round(lat)): (region, postal, country)
        for name, lat, region, postal, country in _rows(
            "SELECT DISTINCT name, lat, region, postal, country FROM places"
        )
    }
    assert where[("Springfield", 40)] == ("Illinois", "IL", "United States")
    assert where[("Springfield", 37)] == ("Missouri", "MO", "United States")
    assert where[("Springfield", 42)][0] == "Massachusetts"
    assert where[("Springfield", 44)][0] == "Oregon"
    assert where[("Paris", 34)][0] == "Texas"
    # Outside the countries that write two letters, no postal code.
    assert where[("Paris", 49)] == ("Paris", "", "France")
    assert where[("Cologne", 51)][2] == "Germany"


def test_the_tiles_own_tags_win_over_the_outlines(tmp_path):
    extra = {"state": "Elsewhere", "country": "Nowhere"}
    assert mapplaces._where(extra, 39.8, -89.64)[0::2] == ("Elsewhere", "Nowhere")
    assert mapplaces._where({}, 39.8, -89.64)[0] == "Illinois"


def test_a_name_in_another_language_is_kept_and_found(library):
    assert _rows("SELECT DISTINCT name, local FROM places WHERE name = 'Cologne'") == [
        ("Cologne", "Köln")
    ]
    names = [p["name"] for p in mapplaces.suggest(library, "Köl")]
    assert names == ["Cologne"], names
    assert mapplaces.suggest(library, "Colo")[0]["local"] == "Köln"


def test_the_index_is_a_new_version_so_an_old_one_is_read_again(library):
    path = srv.get_zim_files()[library]
    assert mapplaces._builder.current(library, path)
    conn = sqlite3.connect(mapplaces._builder.path(library))
    conn.execute("UPDATE meta SET value = '2' WHERE key = 'schema_version'")
    conn.commit()
    conn.close()
    try:
        assert not mapplaces._builder.current(library, path)
    finally:
        mapplaces._builder.build_one(library)
    assert mapplaces._builder.current(library, path)


# ── autocomplete: biggest first, with where ───────────────────────────────


def test_a_prefix_offers_the_biggest_places_first_with_where(library):
    got = mapplaces.suggest(library, "Spri")
    assert [p["label"] for p in got] == [
        "Springfield, Illinois, United States",
        "Springfield, Missouri, United States",
        # Towns the tiles do not rank: by name, then where.
        "Springdale, Arkansas, United States",
        "Springfield, Massachusetts, United States",
        "Springfield, Oregon, United States",
    ], [p["label"] for p in got]
    assert got[0]["token"] == "Springfield, Illinois"
    assert abs(got[0]["lat"] - 39.80) < 0.01


def test_a_common_start_asks_the_short_table_not_every_town(library):
    got = mapplaces.suggest(library, "s")
    assert [p["label"].split(",")[0] for p in got][:2] == ["Springfield", "Springfield"]
    # Five rows begin with s: more than the threshold, they are in the table.
    kept = _rows("SELECT COUNT(*) FROM top WHERE prefix = 's'")[0][0]
    assert kept == (5 if mapplaces.SCAN_MAX == 2 else 0)
    assert mapplaces.suggest(library, "p")[0]["label"] == "Paris, France"  # rank 1, a capital


def test_a_place_with_no_region_in_its_name_does_not_repeat_it(library):
    labels = [p["label"] for p in mapplaces.suggest(library, "Paris")]
    assert labels == ["Paris, France", "Paris, Texas, United States"], labels
    assert [p["token"] for p in mapplaces.suggest(library, "Paris")] == [
        "Paris, France",
        "Paris, Texas",
    ]


@pytest.mark.parametrize(
    "typed, expect",
    [
        ("Springfield, IL", ["Illinois"]),
        ("Springfield, Ill", ["Illinois"]),  # as it is being typed
        ("Springfield Illinois", ["Illinois"]),
        ("springfield il", ["Illinois"]),
        ("Springfield, Missouri, United States", ["Missouri"]),
        ("Springfield MO USA", ["Missouri"]),
        ("Springfield, Oregon", ["Oregon"]),
        ("Paris, France", ["Paris"]),
        ("Paris Texas", ["Texas"]),
        ("Paris, TX", ["Texas"]),
        ("Paris, Tex", ["Texas"]),
    ],
)
def test_where_after_the_name_narrows_to_that_place(library, typed, expect):
    got = mapplaces.suggest(library, typed)
    assert got and got[0]["region"] == expect[0], (typed, [p["label"] for p in got])
    # Only the places there rank first; a place elsewhere is not offered above it.
    assert all(p["region"] == expect[0] for p in got[:1])


def test_the_qualifier_only_narrows(library):
    assert mapplaces.suggest(library, "Springfield, Narnia") == []
    assert len(mapplaces.suggest(library, "Springfield")) == 4


# ── near: takes where, typed after the place ──────────────────────────────


def _anchor(q, **kw):
    near = search.search_all(q, fast=False, **kw)["near"]
    return near["lat"], near["lng"], near


@pytest.mark.parametrize(
    "q, lat",
    [
        ("near:Springfield", 39.80),  # the biggest: rank 6, over rank 7
        ("near:Springfield, IL", 39.80),
        ("near:Springfield, Missouri", 37.21),
        ('near:"Springfield, Missouri"', 37.21),
        ("near:Springfield Missouri", 37.21),
        ("near:Springfield MO", 37.21),
        ("near:Springfield, Oregon, United States", 44.05),
        ("near:Paris", 48.857),
        ("near:Paris, France", 48.857),
        ("near:Paris, Texas", 33.66),
        ("near:Paris 5mi Texas", 33.66),
        ("near:Paris TX", 33.66),
        ("near:Cologne", 50.94),
        ("near:Köln", 50.94),
    ],
)
def test_near_takes_the_place_it_is_told_where_about(library, q, lat):
    got_lat, _lng, near = _anchor(q)
    assert near["found"] and abs(got_lat - lat) < 0.01, (q, near)


def test_the_answer_says_where_the_place_it_took_is(library):
    _lat, _lng, near = _anchor("near:Paris, Texas")
    assert near["place"] == "Paris" and near["where"] == "Texas, United States"
    assert near["by"] == "largest" and near["others"] == 0


def test_words_after_a_place_that_are_not_where_still_filter_names(library):
    out = search.search_all("spring near:Boston 400km", fast=False)
    names = [p["name"] for g in out["places"] for p in g["places"]]
    assert names and all("spring" in n.lower() for n in names), names
    assert out["near"]["place"] == "Boston"


def test_an_unknown_qualifier_is_a_name_filter_not_a_miss(library):
    # "Narnia" is no region of Springfield: the old reading, a word in the names.
    out = search.search_all("near:Springfield narnia", fast=False)
    assert out["near"]["found"] and "places" not in out


def test_the_map_box_takes_where_too(library):
    groups = search.find_places("Paris, Texas")
    places = [p for g in groups for p in g["places"]]
    assert places[0]["name"] == "Paris" and abs(places[0]["lat"] - 33.66) < 0.01, places
    assert places[0]["locality"] == "Texas, United States"
    groups = search.find_places("near:Paris, Texas 5km")
    assert [p["name"] for g in groups for p in g["places"]][:1] == ["Paris"]


# ── the endpoint ──────────────────────────────────────────────────────────


def test_suggest_places_merges_maps_and_gives_the_label_and_token(library):
    got = search.suggest_places("spri")
    assert got[0] == {
        "label": "Springfield, Illinois, United States",
        "token": "Springfield, Illinois",
        "name": "Springfield",
        "region": "Illinois",
        "country": "United States",
        "lat": got[0]["lat"],
        "lng": got[0]["lng"],
        "zoom": got[0]["zoom"],
    }
    assert search.suggest_places("") == []
    assert len(search.suggest_places("s", limit=2)) == 2


def test_regions_locate_the_cities_everyone_knows():
    assert regions.locate(41.88, -87.63)["region"] == "Illinois"
    assert regions.locate(-33.87, 151.21)["country"] == "Australia"
    assert regions.locate(35.68, 139.69)["iso"] == "JP"
    # A point on a coast the coarse outline cuts short is still somewhere near.
    assert regions.locate(21.31, -157.86)["region"] == "Hawaii"
    # Open sea is nowhere.
    assert regions.locate(30.0, -140.0) is None
