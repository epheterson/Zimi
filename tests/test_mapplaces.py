"""A town on a Kiwix map is found by name.

Eric (2026-11-02): "I see my Danville in CA on the map but it doesn't show
up in search." maps_en_all writes a search/<Place> page for its GeoNames
list only, and Danville, California is not on it: the one "search/Danville"
is in Quebec. The town is labelled in the map's own tiles, so Zimi reads the
labels (zimi.mapplaces) and the search finds it there.

The fixture map carries real Mapbox Vector Tiles, encoded here: Oakland as a
city at zoom 9, Danville as a town at zoom 10 under a land tile, and a town
under a sea tile (which is not read).

Run: pytest tests/test_mapplaces.py -v
"""

import math
import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.search as search  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import mapplaces  # noqa: E402

EXTENT = 4096
DANVILLE = (37.8216, -121.9999)
OAKLAND = (37.8044, -122.2712)
ALAMO = (37.8502, -122.0322)
SAN_RAMON = (37.7647, -121.9544)
WALNUT_CREEK = (37.9021, -122.0619)
# The largest of the Danvilles: a city in Virginia.
DANVILLE_VA = (36.5860, -79.3950)
# A town in the Pacific, under a zoom 9 tile of sea.
SEA_TOWN = (30.0, -140.0)


# ── a Mapbox Vector Tile, by hand ─────────────────────────────────────────


def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _field(num, payload):
    return _varint((num << 3) | 2) + _varint(len(payload)) + payload


def _uint_field(num, n):
    return _varint(num << 3) + _varint(n)


def _zigzag(n):
    return (n << 1) ^ (n >> 31)


def _tile_xy(z, lat, lng):
    n = 2**z
    fx = (lng + 180) / 360 * n
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int(fx), int(fy), fx - int(fx), fy - int(fy)


def _place_layer(z, places):
    """A ``place`` layer: each (class, name, (lat, lng)) as a point."""
    keys, values, feats = ["class", "name"], [], []
    for cls, name, (lat, lng) in places:
        _x, _y, fx, fy = _tile_xy(z, lat, lng)
        tags = []
        for k, v in (("class", cls), ("name", name)):
            values.append(v)
            tags += [keys.index(k), len(values) - 1]
        geom = [1 | (1 << 3), _zigzag(round(fx * EXTENT)), _zigzag(round(fy * EXTENT))]
        feats.append(
            _field(2, b"".join(_varint(t) for t in tags))
            + _uint_field(3, 1)
            + _field(4, b"".join(_varint(g) for g in geom))
        )
    layer = _uint_field(15, 2) + _field(1, b"place")
    layer += b"".join(_field(2, f) for f in feats)
    layer += b"".join(_field(3, k.encode()) for k in keys)
    layer += b"".join(_field(4, _field(1, v.encode())) for v in values)
    layer += _uint_field(5, EXTENT)
    return _field(3, layer)


def _land(size=3000):
    """A layer of nothing much, big enough that its tile reads as land."""
    return _field(
        3,
        _uint_field(15, 2)
        + _field(1, b"landcover")
        + _field(4, _field(1, b"x" * size)),
    )


def _tile_path(z, lat, lng):
    x, y, _fx, _fy = _tile_xy(z, lat, lng)
    return f"tiles/{z}/{x}/{y}.pbf"


# Cities are read from zoom 9, towns from zoom 10 (under a zoom 9 tile of land).
CITIES = [("Oakland", OAKLAND), ("Danville", DANVILLE_VA)]
TOWNS = [
    ("Danville", DANVILLE),
    ("Alamo", ALAMO),
    ("San Ramon", SAN_RAMON),
    ("Walnut Creek", WALNUT_CREEK),
]


def _map_files():
    by_tile = {}
    for name, ll in CITIES:
        by_tile.setdefault((9, _tile_path(9, *ll)), []).append(("city", name, ll))
    for name, ll in TOWNS:
        by_tile.setdefault((10, _tile_path(10, *ll)), []).append(("town", name, ll))
        by_tile.setdefault((9, _tile_path(9, *ll)), [])
    files = {
        path: _place_layer(z, places) + (_land() if z == 9 else b"")
        for (z, path), places in by_tile.items()
    }
    files.update(
        {
            # The sea: a small zoom 9 tile, and a town under it that is not read.
            _tile_path(9, *SEA_TOWN): _place_layer(9, []),
            _tile_path(10, *SEA_TOWN): _place_layer(10, [("town", "Seaville", SEA_TOWN)]),
            # What ground the map covers, as maps2zim writes it: the tiles read
            # are the ones under it, not the world's 262,144.
            "content/config.json": b'{"boundingBox":[[-145.0,25.0],[-70.0,47.0]]}',
            # The map's own place page for another Danville (Quebec).
            "search/Danville": (
                b'<html><head><meta http-equiv="refresh" content="0;URL=\'../index.html'
                b"#lat=45.77194&lon=-72.01734&zoom=10'\" /></head><body>Danville</body></html>"
            ),
        }
    )
    return files


NAME = "maps_en_test_2026-06"


def _library(tmp_path, monkeypatch):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(
        str(zdir / f"{NAME}.zim"), {"Scraper": "maps2zim v0.2.1"}, files=_map_files()
    )
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    mapplaces._reset_for_tests()
    srv.load_cache(force=True)
    return "maps_en_test"


def test_the_towns_are_read_from_the_tiles_where_they_are(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch)
    archive = srv.open_archive(os.path.join(srv.ZIM_DIR, f"{NAME}.zim"))
    found = mapplaces.read_places(archive)
    by_name = {(name, cls): ll for (name, cls, _a, _o), ll in found.items()}
    assert ("Oakland", "city") in by_name
    lat, lng = by_name[("Danville", "town")]
    assert abs(lat - DANVILLE[0]) < 0.01 and abs(lng - DANVILLE[1]) < 0.01, (lat, lng)
    assert not any(
        n == "Seaville" for n, _c in by_name
    ), "a zoom 10 tile under the sea's zoom 9 tile was read"


def test_danville_california_is_found_by_the_search(tmp_path, monkeypatch):
    name = _library(tmp_path, monkeypatch)
    mapplaces.build_all()
    groups = search._search_places(["Danville"], {name})
    assert groups and groups[0]["zim"] == name, groups
    town = [p for p in groups[0]["places"] if p["sub"] == "town"]
    assert town and town[0]["name"] == "Danville", groups
    assert abs(town[0]["lat"] - DANVILLE[0]) < 0.01, town


def test_the_map_box_gives_its_own_page_and_the_town(tmp_path, monkeypatch):
    name = _library(tmp_path, monkeypatch)
    mapplaces.build_all()
    groups = search.find_places("Danville")
    places = next(g["places"] for g in groups if g["zim"] == name)
    lats = sorted(round(p["lat"]) for p in places)
    assert lats == [37, 38, 46], places  # Virginia's city, California's town, Quebec's page


def test_a_map_not_read_yet_answers_nothing_and_asks_for_the_read(
    tmp_path, monkeypatch
):
    name = _library(tmp_path, monkeypatch)
    asked = []
    monkeypatch.setattr(mapplaces._builder, "request", asked.append)
    assert mapplaces.search(name, "Danville") == []
    assert asked == [name]


def test_a_map_whose_read_failed_is_not_read_again_on_every_search(tmp_path, monkeypatch):
    """A failed read keeps {} until the next start: reading the world map takes minutes, so a search
    that touches a map whose read failed must not start it again."""
    name = _library(tmp_path, monkeypatch)
    path = srv.get_zim_files()[name]
    mapplaces._builder.keep(name, path, {})
    asked = []
    monkeypatch.setattr(mapplaces._builder, "request", asked.append)
    assert mapplaces.search(name, "Danville") == []
    assert mapplaces.near(name, DANVILLE[0], DANVILLE[1], 25) == []
    assert asked == []


# ── near: places within a distance of a place ─────────────────────────────
# Eric (2026-11-03): "If we're doing location search should we also include
# like radius near a location?"


def _near(tmp_path, monkeypatch, q, **kw):
    _library(tmp_path, monkeypatch)
    mapplaces.build_all()
    return search.search_all(q, fast=False, **kw)


def test_near_a_town_lists_the_places_around_it_nearest_first(tmp_path, monkeypatch):
    out = _near(tmp_path, monkeypatch, "near:Danville 12km", near_at=DANVILLE)
    assert out["results"] == []
    places = [p for g in out["places"] for p in g["places"]]
    assert [p["name"] for p in places] == ["Danville", "Alamo", "San Ramon", "Walnut Creek"], places
    kms = [p["km"] for p in places]
    assert kms == sorted(kms) and kms[0] < 0.5 and kms[-1] < 12, kms
    assert all(p["sub"] == "town" for p in places)
    assert out["near"]["place"] == "Danville" and out["near"]["unit"] == "km"


def test_miles_and_the_default_distance(tmp_path, monkeypatch):
    out = _near(tmp_path, monkeypatch, "near:Danville 10mi", near_at=DANVILLE)
    names = [p["name"] for g in out["places"] for p in g["places"]]
    assert "Oakland" not in names and "Walnut Creek" in names  # Oakland is 24 km off
    assert out["near"]["unit"] == "mi" and abs(out["near"]["radius_km"] - 16.09) < 0.01
    out = search.search_all("near:Danville", fast=False, near_at=DANVILLE)
    names = [p["name"] for g in out["places"] for p in g["places"]]
    assert "Oakland" in names, names  # 25 km


def test_of_several_danvilles_the_nearest_to_you_else_the_largest(tmp_path, monkeypatch):
    out = _near(tmp_path, monkeypatch, "near:Danville 5km")
    assert out["near"]["by"] == "largest" and out["near"]["others"] == 1
    assert abs(out["near"]["lat"] - DANVILLE_VA[0]) < 0.01, out["near"]
    out = search.search_all("near:Danville 5km", fast=False, near_at=(37.7, -122.1))
    assert out["near"]["by"] == "nearest"
    assert abs(out["near"]["lat"] - DANVILLE[0]) < 0.01, out["near"]


def test_near_a_position_and_the_words_in_a_name(tmp_path, monkeypatch):
    out = _near(tmp_path, monkeypatch, "near:37.82,-122.0 3km")
    assert [p["name"] for g in out["places"] for p in g["places"]] == ["Danville"]
    out = search.search_all("creek near:Danville 15km", fast=False, near_at=DANVILLE)
    assert [p["name"] for g in out["places"] for p in g["places"]] == ["Walnut Creek"]


def test_a_place_no_map_names_says_so(tmp_path, monkeypatch):
    out = _near(tmp_path, monkeypatch, "near:Atlantis")
    assert out["near"] == {"place": "atlantis", "found": False} and "places" not in out


def test_the_map_box_answers_near_too(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch)
    mapplaces.build_all()
    groups = search.find_places("near:Danville 5km", near_at=DANVILLE)
    places = [p for g in groups for p in g["places"]]
    assert [p["name"] for p in places][:2] == ["Danville", "Alamo"] and "km" in places[0]


def test_a_search_without_near_never_asks_for_places_near(tmp_path, monkeypatch):
    """Nothing new on the search path: a plain query does not parse further,
    and an operator query without near: reads no towns."""
    _library(tmp_path, monkeypatch)

    def boom(*a, **k):
        raise AssertionError("asked the towns without near:")

    monkeypatch.setattr(mapplaces, "named", boom)
    monkeypatch.setattr(mapplaces, "near", boom)
    search.search_all("danville", fast=True)
    search.search_all("danville -texas", fast=True)
