"""The towns index read from tags a real Kiwix map carries.

tests/fixtures/map_place_sample.json holds fourteen real features from the
place layer of maps_en_all_2026-06, with the tags as the tiles have them: name
(the local one), name:en, name_en, name_int, name:latin, name_de, class, rank
(1 the biggest to 22, stored as sint) and capital (the admin level of what the
place seats, sint). A town carries no population, region, country or ISO code;
a country's own point alone has iso_a2. So where a place is comes from the
outlines Zimi ships, and how big it is from rank and capital.

Run: pytest tests/test_place_real_tags.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from test_mapplaces import (
    EXTENT,
    _field,
    _land,
    _tile_path,
    _tile_xy,
    _uint_field,
    _varint,
    _zigzag,
)  # noqa: E402
from zimi import mapplaces  # noqa: E402

SAMPLE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "map_place_sample.json"
)
NAME = "maps_en_real_2026-06"
MAP = "maps_en_real"


# The country's own point, as the real tiles carry one (class=country, iso_a2): the sample has none, and without one
# "a country point is not a place to be near" would be true of any index.
COUNTRY_POINT = {
    "z": 9,
    "lat": 42.5,
    "lng": 12.5,
    "tags": {
        "name": "Italia",
        "name:en": "Italy",
        "class": "country",
        "iso_a2": "IT",
        "rank": ["sint", 1],
    },
}


def _sample():
    with open(SAMPLE, encoding="utf-8") as f:
        return json.load(f)["features"] + [COUNTRY_POINT]


def _layer(z, features):
    """A place layer from the sample's features, values typed as the tiles
    type them: text for a string, sint (field 6) for [sint, n]."""
    keys, values, feats = [], [], []
    for feat in features:
        pairs = []
        for k, v in feat["tags"].items():
            if k not in keys:
                keys.append(k)
            if isinstance(v, list):
                assert v[0] == "sint", v
                values.append(_uint_field(6, _zigzag(v[1])))
            else:
                values.append(_field(1, v.encode()))
            pairs += [keys.index(k), len(values) - 1]
        _x, _y, fx, fy = _tile_xy(z, feat["lat"], feat["lng"])
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


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    from conftest_zim import build_fixture_zim

    by_tile = {}
    for feat in _sample():
        # Every feature in the z9 tile it was sampled from, the state too (the
        # reader must leave it out), as the real map has them.
        by_tile.setdefault(_tile_path(9, feat["lat"], feat["lng"]), []).append(feat)
    files = {path: _layer(9, feats) + _land() for path, feats in by_tile.items()}
    files["content/config.json"] = b'{"boundingBox":[[-92.0,34.0],[140.0,52.0]]}'
    root = tmp_path_factory.mktemp("real")
    zdir = root / "zims"
    zdir.mkdir()
    build_fixture_zim(
        str(zdir / f"{NAME}.zim"), {"Scraper": "maps2zim v0.2.1"}, files=files
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


def _suggest(library, text):
    return mapplaces.suggest(library, text)


def test_cities_and_towns_are_read_but_not_villages_or_states(library):
    names = {
        p["name"]
        for text in ("s", "d", "k", "c", "t", "a", "p", "w", "j")
        for p in _suggest(library, text)
    }
    assert {
        "Springfield",
        "Decatur",
        "Alton",
        "Cologne",
        "Tokyo",
        "Paris",
        "Chicago",
        "Altenkirchen",
    } <= names, names
    # The village Springfield (Michigan) is not read, so there is one Springfield; Alabama is a state.
    assert [p["region"] for p in _suggest(library, "Springfield")] == ["Illinois"]
    assert _suggest(library, "Alabama") == []


def test_the_name_in_english_is_shown_and_the_local_one_found(library):
    cologne = _suggest(library, "Cologne")[0]
    assert cologne["name"] == "Cologne" and cologne["local"] == "Köln", cologne
    assert _suggest(library, "Köl")[0]["name"] == "Cologne"
    # Düsseldorf's English name drops the umlaut; typing it with or without finds it.
    assert [p["name"] for p in _suggest(library, "Düssel")] == ["Dusseldorf"]
    assert [p["name"] for p in _suggest(library, "Dussel")] == ["Dusseldorf"]
    tokyo = _suggest(library, "Tok")[0]
    assert tokyo["name"] == "Tokyo" and tokyo["local"] == "東京都", tokyo
    assert _suggest(library, "東京")[0]["name"] == "Tokyo"
    # name:en is "Woodside Township" where the OSM name is "Woodside": both are found.
    assert _suggest(library, "Woodside")[0]["name"] == "Woodside Township"


def test_where_comes_from_the_outlines_since_the_tiles_do_not_say(library):
    where = {
        p["name"]: (p["region"], p["country"])
        for text in ("s", "d", "c", "t", "p", "a")
        for p in _suggest(library, text)
    }
    assert where["Springfield"] == ("Illinois", "United States")
    assert where["Alton"] == ("Illinois", "United States")
    assert where["Cologne"][1] == "Germany" and where["Dusseldorf"][1] == "Germany"
    assert where["Tokyo"][1] == "Japan" and where["Paris"][1] == "France"
    assert where["Chicago"] == ("Illinois", "United States")


def test_size_is_the_tiles_rank_then_a_capital(library):
    """Rank 1 is the biggest. Decatur and Dusseldorf are both rank 7; Dusseldorf
    seats a state (capital 4), Decatur a county (6), so Dusseldorf is first."""
    order = [p["name"] for p in _suggest(library, "d")]
    assert order[:2] == ["Dusseldorf", "Decatur"], order
    # Chicago (rank 2) over Springfield (6), Tokyo (1, a national capital) over both.
    first = [p["name"] for p in _suggest(library, "c")]
    assert first[:2] == ["Chicago", "Cologne"], first
    weights = {
        n: mapplaces._tag_rank(
            {"class": c, "rank": str(r), **({"capital": str(k)} if k else {})}
        )
        for n, c, r, k in (
            ("Tokyo", "city", 1, 2),
            ("Chicago", "city", 2, 6),
            ("Springfield", "city", 6, 4),
            ("Alton", "town", 7, 0),
            ("Woodside", "town", 11, 0),
        )
    }
    assert list(weights) == sorted(weights, key=lambda n: -weights[n]), weights


def test_a_country_point_is_not_a_place_to_be_near(library):
    assert _suggest(library, "Italia") == []
    assert _suggest(library, "Italy") == []
