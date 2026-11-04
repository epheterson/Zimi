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


def _map_files():
    files = {
        _tile_path(9, *OAKLAND): _place_layer(9, [("city", "Oakland", OAKLAND)])
        + _land(),
        _tile_path(10, *DANVILLE): _place_layer(10, [("town", "Danville", DANVILLE)]),
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
    # Danville is read under the zoom 9 tile Oakland is in: land.
    assert _tile_path(9, *OAKLAND) == _tile_path(9, *DANVILLE)
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
    by_name = {name: (cls, ll) for (name, cls, _a, _o), ll in found.items()}
    assert by_name["Oakland"][0] == "city"
    cls, (lat, lng) = by_name["Danville"]
    assert cls == "town"
    assert abs(lat - DANVILLE[0]) < 0.01 and abs(lng - DANVILLE[1]) < 0.01, (lat, lng)
    assert (
        "Seaville" not in by_name
    ), "a zoom 10 tile under the sea's zoom 9 tile was read"


def test_danville_california_is_found_by_the_search(tmp_path, monkeypatch):
    name = _library(tmp_path, monkeypatch)
    mapplaces.build_all()
    groups = search._search_places(["Danville"], {name})
    assert groups and groups[0]["zim"] == name, groups
    places = groups[0]["places"]
    assert places[0]["name"] == "Danville" and places[0]["sub"] == "town"
    assert abs(places[0]["lat"] - DANVILLE[0]) < 0.01, places


def test_the_map_box_gives_its_own_page_and_the_town(tmp_path, monkeypatch):
    name = _library(tmp_path, monkeypatch)
    mapplaces.build_all()
    groups = search.find_places("Danville")
    places = next(g["places"] for g in groups if g["zim"] == name)
    lats = sorted(round(p["lat"]) for p in places)
    assert lats == [38, 46], places  # California's town, Quebec's page


def test_a_map_not_read_yet_answers_nothing_and_asks_for_the_read(
    tmp_path, monkeypatch
):
    name = _library(tmp_path, monkeypatch)
    asked = []
    monkeypatch.setattr(mapplaces._builder, "request", asked.append)
    assert mapplaces.search(name, "Danville") == []
    assert asked == [name]
