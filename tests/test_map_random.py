"""The dice on a map land on a place.

A map has no articles: /random on one used to answer "no articles found",
and the open dice could draw a map and come up empty. Now a map answers
with a place on it and its position, and the open dice leave maps out.

Run: pytest tests/test_map_random.py -v
"""

import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.search as search  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import mapsearch  # noqa: E402


def _place(n, t, lat, lng, **kw):
    d = {"n": n, "t": t, "a": lat, "o": lng}
    d.update(kw)
    return d


STREETZIM_FILES = {
    "search-data/manifest.json": json.dumps({"chunks": {"ka": 3, "ho": 1}, "sub_chunks": {}}).encode(),
    "search-data/ka.json": json.dumps(
        [
            _place("Kailua", "place", 21.39412, -157.74401, s="town"),
            _place("Kailua Beach Park", "leisure", 21.3975, -157.7274),
            _place("123 Kailua Road", "address", 21.395, -157.74),
        ]
    ).encode(),
    "search-data/ho.json": json.dumps([_place("Honolulu", "place", 21.3069, -157.8583, s="city")]).encode(),
}

MAPS2ZIM_FILES = {
    "search/Faleata East": (
        b"<html><head><meta http-equiv=\"refresh\" content=\"0;URL='../index.html#lat=-13.87786&lon=-171.79807&zoom=8'\" />"
        b"</head><body>Faleata East</body></html>"
    ),
}


def _library(tmp_path, monkeypatch, filename, metadata, files):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / filename), metadata, files=files)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    mapsearch._reset_for_tests()
    srv.load_cache(force=True)


# ── the place index ────────────────────────────────────────────────────────


def test_a_random_place_is_a_named_place_when_the_chunk_has_one(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "osm-hawaii-2026-09-08.zim", {"Scraper": "streetzim/1.0"}, STREETZIM_FILES)
    archive = srv.open_archive(os.path.join(srv.ZIM_DIR, "osm-hawaii-2026-09-08.zim"))
    seen = set()
    for seed in range(30):
        p = mapsearch.random_place(archive, random.Random(seed))
        assert p and p["name"] and isinstance(p["lat"], float) and isinstance(p["lng"], float)
        assert p["type"] != "address", "an address was drawn over the named places beside it"
        seen.add(p["name"])
    assert {"Kailua", "Honolulu"} <= seen, seen


def test_a_map_without_a_place_index_has_no_random_place(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "maps_en_samoa_2026-06.zim", {"Scraper": "maps2zim v0.2.1"}, MAPS2ZIM_FILES)
    archive = srv.open_archive(os.path.join(srv.ZIM_DIR, "maps_en_samoa_2026-06.zim"))
    assert mapsearch.random_place(archive) is None


# ── the dice, per publisher ────────────────────────────────────────────────


def test_streetzim_dice_answer_with_the_map_page_and_a_position(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "osm-hawaii-2026-09-08.zim", {"Scraper": "streetzim/1.0"}, STREETZIM_FILES)
    got = search._random_map_place("osm-hawaii")
    assert got and got["zim"] == "osm-hawaii" and got["path"] == "A/Water"  # the fixture's main page
    assert got["title"] in ("Kailua", "Kailua Beach Park", "Honolulu")
    assert got["pos"].startswith("map=") and got["pos"].count("/") == 2


def test_kiwix_dice_read_the_place_out_of_its_page(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "samoa.zim", {"Scraper": "maps2zim v0.2.1"}, MAPS2ZIM_FILES)
    got = search._random_map_place("samoa")
    assert got == {"zim": "samoa", "path": "A/Water", "title": "Faleata East", "pos": "map=8/-13.87786/-171.79807"}


def test_a_map_with_no_place_at_all_is_an_honest_none(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "maps_en_all_2026-06.zim", {"Scraper": "maps2zim v0.2.1"}, {})
    assert search._random_map_place("maps") is None


def test_not_a_map_is_none(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "survival_en_2026-06.zim", None, {})
    assert search._random_map_place("survival") is None
    assert srv._is_map_zim("survival") is False


def test_the_position_regex_reads_maps2zim_pages():
    m = search._MAPS2ZIM_POS_RE.search("x#lat=-13.87786&lon=-171.79807&zoom=8'")
    assert m and (m.group(1), m.group(2), m.group(3)) == ("-13.87786", "-171.79807", "8")
    m = search._MAPS2ZIM_POS_RE.search("#lat=21&lon=-157")
    assert m and m.group(3) is None
