"""Where each catalog map is, from the shipped table.

Run: pytest tests/test_mapregions.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from zimi import mapregions  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    mapregions._reset_for_tests()
    yield
    mapregions._reset_for_tests()


def test_the_shipped_table_places_every_map_in_both_snapshots():
    import glob
    import gzip

    assets = os.path.dirname(mapregions.ASSET_PATH)
    for pattern, prefix in (("catalog-snapshot*.json.gz", "maps_"), ("streetzim-snapshot.json.gz", "osm-")):
        paths = sorted(glob.glob(os.path.join(assets, pattern)))
        if not paths:
            pytest.skip("no " + pattern)
        with gzip.open(paths[-1], "rt", encoding="utf-8") as f:
            payload = json.load(f)
        names = [it["name"] for it in (payload.get("items") or payload.get("entries") or []) if str(it.get("name", "")).startswith(prefix)]
        assert names
        missing = [n for n in names if mapregions.bounds_for(n) is None]
        assert missing == [], "run scripts/build_map_regions.py and add an alias or a box"


def test_boxes_are_boxes():
    table = mapregions._load()
    assert len(table) > 200
    for name, (w, s, e, n) in table.items():
        assert -180 <= w <= 180 and -180 <= e <= 180 and -90 <= s < n <= 90, name


def test_samoa_hawaii_and_the_world():
    assert mapregions.bounds_for("maps_en_samoa") == pytest.approx([-172.8, -14.06, -171.4, -13.43], abs=0.2)
    assert mapregions.bounds_for("osm-hawaii") == [-178.5, 18.5, -154.5, 28.5]
    assert mapregions.is_world(mapregions.bounds_for("maps_en_all"))
    assert not mapregions.is_world(mapregions.bounds_for("osm-hawaii"))
    assert not mapregions.is_world(mapregions.bounds_for("osm-russia")), "a wrap across the antimeridian is not the planet"
    assert mapregions.bounds_for("nope") is None


def test_annotate_marks_maps_and_leaves_the_rest(monkeypatch):
    items = [
        {"name": "maps_en_samoa", "title": "Samoa"},
        {"name": "maps_en_all", "title": "World"},
        {"name": "wikipedia_en_all", "title": "Wikipedia"},
        "not a dict",
    ]
    mapregions.annotate(items)
    assert "bounds" in items[0] and "world" not in items[0]
    assert items[1]["world"] is True
    assert "bounds" not in items[2]


def test_a_missing_or_broken_table_is_an_empty_one(tmp_path, monkeypatch):
    monkeypatch.setattr(mapregions, "ASSET_PATH", str(tmp_path / "nope.json"))
    assert mapregions.bounds_for("maps_en_samoa") is None
    mapregions._reset_for_tests()
    (tmp_path / "bad.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(mapregions, "ASSET_PATH", str(tmp_path / "bad.json"))
    assert mapregions.annotate([{"name": "maps_en_samoa"}]) == [{"name": "maps_en_samoa"}]
