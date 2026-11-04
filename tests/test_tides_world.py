"""The world's tide gauges beside NOAA's (TICON-3, scripts/build_tide_world.py).

Britain and France get their own tide; the middle of England still gets none
(#140); NOAA's stations win where both have a gauge; the source is credited.
"""

import math

import pytest

from zimi import placedata

# The Almanac draws a station's tide within this (static/almanac-tides.js AT_TIDE_NEAR_KM).
NEAR_KM = 80
NOAA_WINS_KM = 5.0


def _nearest(lat, lon):
    return placedata.near(lat, lon)["tides"]["stations"][0]


@pytest.mark.parametrize(
    "place, lat, lon",
    [
        ("Dover", 51.1279, 1.3134),
        ("Brighton", 50.8225, -0.1372),
        ("Brest", 48.3904, -4.4861),
    ],
)
def test_a_european_coast_has_its_own_tide(place, lat, lon):
    st = _nearest(lat, lon)
    assert st["km"] <= NEAR_KM, (place, st["n"], st["km"])
    assert st["src"] == "ticon3" and st["dt"] == "LAT", st


def test_the_middle_of_england_still_has_none():
    assert _nearest(52.6369, -1.1398)["km"] > NEAR_KM


def test_noaa_keeps_its_own_coasts():
    for lat, lon in ((21.3069, -157.8583), (42.3554, -71.0503)):  # Honolulu, Boston
        assert "src" not in _nearest(lat, lon)


def test_no_world_gauge_stands_on_a_noaa_station():
    tides = placedata._load()
    noaa = [s for s in tides["stations"] if s.get("src") != "ticon3"]
    world = [s for s in tides["stations"] if s.get("src") == "ticon3"]
    assert len(world) > 1000
    for w in world:
        near = [
            s
            for s in noaa
            if abs(s["la"] - w["la"]) < 0.1 and abs(s["lo"] - w["lo"]) < 0.15
        ]
        for s in near:
            assert placedata._km(w["la"], w["lo"], s["la"], s["lo"]) >= NOAA_WINS_KM, (
                w["n"],
                s["n"],
            )


def test_every_world_station_is_whole_and_credited():
    tides = placedata._load()
    n = len(tides["meta"]["constituents"])
    for s in tides["stations"]:
        if s.get("src") != "ticon3":
            continue
        assert -90 <= s["la"] <= 90 and -180 <= s["lo"] <= 180, s["id"]
        assert len(s["a"]) == n and len(s["g"]) == n and s["n"], s["id"]
        assert s["z0"] > 0 and s["mhhw"] > s["z0"], s["id"]
    src = {x["id"]: x for x in tides["meta"]["sources"]}["ticon3"]
    assert "CC BY 4.0" in src["credit"] and src["url"].endswith("PANGAEA.951610")
    assert not any(math.isnan(v) for s in tides["stations"] for v in s.get("a", []))
