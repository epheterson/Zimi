"""/almanac-place: the tide and frost stations the Almanac shows for a place.

Only shipped data (zimi/assets/tides-snapshot.json.gz, frost-normals.json.gz);
the predictions themselves are checked against NOAA in
tests/test_almanac_tides.cjs.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import placedata  # noqa: E402

SF = (37.8063, -122.4659)  # the Golden Gate tide station
BOULDER = (40.015, -105.27)


def test_nearest_tide_station_is_the_one_you_are_standing_on():
    out = placedata.near(*SF)
    first = out["tides"]["stations"][0]
    assert first["id"] == "9414290"
    assert first["km"] < 1
    assert len(first["a"]) == len(out["tides"]["constituents"]) == 37
    assert len(out["tides"]["stations"]) == placedata.NEAR_TIDES


def test_subordinate_stations_carry_their_reference():
    out = placedata.search("Castleton")
    sub = [s for s in out["tides"]["stations"] if s["id"] == "8518989"]
    assert sub and sub[0]["refrec"]["id"] == sub[0]["ref"] and "a" in sub[0]["refrec"]


def test_frost_station_near_boulder_has_its_dates():
    f = placedata.near(*BOULDER)["frost"]["stations"][0]
    assert "Boulder" in f["name"] and f["km"] < 10
    # Last spring freeze before first fall freeze, 90% date before 10% date.
    assert (
        0
        < f["l32_90"]
        < f["l32_50"]
        < f["l32_10"]
        < f["f32_10"]
        < f["f32_50"]
        < f["f32_90"]
    )
    assert f["gsl32"] > 100


def test_search_folds_case_and_spacing():
    out = placedata.search("  SAN   francisco ", *SF)
    names = [s["n"] for s in out["tides"]["stations"]]
    assert names and all("san francisco" in n.lower() for n in names)
    assert all("km" in s for s in out["tides"]["stations"])
    starts = [
        s
        for s in out["tides"]["stations"]
        if s["n"].lower().startswith("san francisco")
    ]
    assert starts
    assert placedata.search("")["tides"]["stations"] == []
    assert placedata.search("zzzz-no-such-place")["frost"]["stations"] == []


def test_coordinates_are_checked():
    assert placedata.parse_coord("45.5", -90, 90) == 45.5
    for bad in ("", None, "nan", "inf", "91", "abc"):
        assert placedata.parse_coord(bad, -90, 90) is None


def test_route_is_rate_limited_like_the_other_almanac_routes():
    from zimi import http as _http

    limited, _content = _http._rate_class("/almanac-place")
    assert limited
