"""Zimi Maps' one box: /places finds places on every installed map.

StreetZim maps answer from their place index; Kiwix maps2zim maps from
their search/<Place> pages. One group per map that answered.

Run: pytest tests/test_places_endpoint.py -v
"""

import json
import os
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
    "search-data/manifest.json": json.dumps({"chunks": {"ka": 2}, "sub_chunks": {}}).encode(),
    "search-data/ka.json": json.dumps(
        [_place("Kailua", "place", 21.39412, -157.74401, s="town"), _place("Kailua Beach Park", "park", 21.3975, -157.7274)]
    ).encode(),
}
MAPS2ZIM_FILES = {
    "search/Kailua-Kona": b"<meta http-equiv=\"refresh\" content=\"0;URL='../index.html#lat=19.64&lon=-155.99&zoom=10'\" />",
}
SAMOA_FILES = {
    "search/Faleata East": b"<meta http-equiv=\"refresh\" content=\"0;URL='../index.html#lat=-13.87786&lon=-171.79807&zoom=8'\" />",
}


def _library(tmp_path, monkeypatch, zims):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    for filename, metadata, files in zims:
        build_fixture_zim(str(zdir / filename), metadata, files=files)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    mapsearch._reset_for_tests()
    srv.load_cache(force=True)


def test_places_come_from_both_kinds_of_map(tmp_path, monkeypatch):
    _library(
        tmp_path, monkeypatch,
        [
            ("osm-hawaii-2026-09-08.zim", {"Scraper": "streetzim/1.0"}, STREETZIM_FILES),
            ("maps_en_hawaii_2026-06.zim", {"Scraper": "maps2zim v0.2.1"}, MAPS2ZIM_FILES),
            ("survival_en_2026-06.zim", None, {}),
        ],
    )
    groups = search.find_places("Kailua")
    by = {g["zim"]: g for g in groups}
    assert set(by) == {"osm-hawaii", "maps_en_hawaii"}
    assert [p["name"] for p in by["osm-hawaii"]["places"]][0] == "Kailua"
    kona = by["maps_en_hawaii"]["places"]
    assert kona and kona[0]["name"] == "Kailua-Kona" and (kona[0]["lat"], kona[0]["lng"], kona[0]["zoom"]) == (19.64, -155.99, 10)
    assert all(g["main_path"] == "A/Water" for g in groups)


def test_a_map_with_nothing_matching_is_not_a_group(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("maps_en_samoa_2026-06.zim", {"Scraper": "maps2zim v0.2.1"}, SAMOA_FILES)])
    assert search.find_places("Kailua") == []
    assert search.find_places("   ") == []
    assert [p["name"] for p in search.find_places("Faleata")[0]["places"]] == ["Faleata East"]


def test_the_route_answers_and_is_rate_limited_as_an_api_path():
    from zimi import http

    assert "/places" in http._RATE_LIMITED_API_PATHS
    assert 'parsed.path == "/places"' in open(http.__file__, encoding="utf-8").read()
