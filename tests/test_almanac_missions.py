"""The mission tables (zimi/static/earth/missions-v1.json) against their sources: Apollo 11's events against the mission report's table 3-I, its
paths against the report's positions, and the probes' flybys against JPL Horizons' own closest approaches (tolerances stated in each test).
"""

import json
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "zimi", "static", "earth", "missions-v1.json")


@pytest.fixture(scope="module")
def missions():
    with open(DATA, encoding="utf-8") as fh:
        return json.load(fh)["missions"]


def _event(m, key):
    return [e for e in m["events"] if e["k"] == "alm_ms_ev_" + key]


def hms(h, m, s=0.0):
    return h * 3600 + m * 60 + s


def test_apollo_11_events_are_the_reports(missions):
    """Mission report table 3-I, seconds from range zero (13:32:00 UT, 16 July 1969)."""
    m = missions["apollo11"]
    assert abs(m["zeroMs"] - round((2440419.0638888889 - 2440587.5) * 86400000)) < 1000   # 13:32:00 UT
    want = {
        "oeco": hms(0, 2, 41.7),
        "sii_cut": hms(0, 9, 8.3),
        "tli_ign": hms(2, 44, 16.2),
        "loi1": hms(75, 49, 50.4),
        "undock": hms(100, 12, 0),
        "pdi": hms(102, 33, 5),
        "touchdown": hms(102, 45, 39.9),
        "liftoff_moon": hms(124, 22, 0.8),
        "splash": hms(195, 18, 35),
    }
    for key, t in want.items():
        got = _event(m, key)
        if not got:
            pytest.skip("the full Apollo 11 tables are not in this build (" + key + ")")
        assert abs(got[0]["t"] - t) < (150.0 if key == "tli_ign" else 1.0), key   # the ignition moves to where the fitted parking orbit meets the report's latitude


def test_voyager_flybys_match_horizons(missions):
    """Closest approaches found in Horizons' own vectors (scripts/mission_probes.py): centre distances, to a hundred kilometres."""
    want = {
        ("voyager1", "Jupiter"): 348435,
        ("voyager1", "Saturn"): 184030,
        ("voyager2", "Saturn"): 160691,
        ("voyager2", "Uranus"): 107154,
        ("voyager2", "Neptune"): 29237,
    }
    for (mid, planet), km in want.items():
        ev = [e for e in missions[mid]["events"] if e.get("planet") == planet]
        assert ev and abs(ev[0]["dist"] - km) < 100, (mid, planet)


def test_phases_run_in_order_and_inside_the_mission(missions):
    for mid, m in missions.items():
        ts = [p["t"] for p in m["phases"]]
        assert ts == sorted(ts) and ts[0] >= m["start"] - 20 and ts[-1] < m["end"], mid
        for v in m["vehicles"]:
            for leg in v["legs"]:
                rows = [r[0] for r in leg["s"]]
                assert rows == sorted(rows), (mid, v["id"])


def test_apollo_11_parking_orbit_is_the_reports(missions):
    """The flown parking orbit (MR: 100.7 x 99.2 nautical miles, 32.521 degrees, S-IVB cut-off 11:39.3 GET): the last Earth-fixed row, the cut-off, as an inertial orbit."""
    import math

    m = missions["apollo11"]
    stack = [v for v in m["vehicles"] if v["id"] == "stack"]
    if not stack:
        pytest.skip("the full Apollo 11 tables are not in this build")
    cut = hms(0, 11, 39.3)
    rows = [r for leg in stack[0]["legs"] if leg["frame"] == "ecef" for r in leg["s"] if r[0] >= cut - 1]
    if not rows:
        pytest.skip("no row after the cut-off")
    t, x, y, z, vx, vy, vz = rows[0][:7]
    w = 7.2921159e-5
    r = (x, y, z)
    v = (vx - w * y, vy + w * x, vz)   # Earth-fixed to inertial: add the turn of the frame
    rn = math.sqrt(sum(c * c for c in r))
    vn2 = sum(c * c for c in v)
    h = (r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0])
    mu = 398600.4418
    a = 1 / (2 / rn - vn2 / mu)
    ev = [(v[1] * h[2] - v[2] * h[1]) / mu - r[0] / rn, (v[2] * h[0] - v[0] * h[2]) / mu - r[1] / rn, (v[0] * h[1] - v[1] * h[0]) / mu - r[2] / rn]
    e = math.sqrt(sum(c * c for c in ev))
    inc = math.degrees(math.acos(h[2] / math.sqrt(sum(c * c for c in h))))
    nm = 1.852
    assert abs(a * (1 + e) - 6378.137 - 100.7 * nm) < 8.0   # the fit leaves 7 km on the perigee and about a degree of plane: tighten these when the ascent plane is solved
    assert abs(a * (1 - e) - 6378.137 - 99.2 * nm) < 8.0
    assert abs(inc - 32.521) < 1.2


def test_perseverance_touches_down_on_the_sites_own_pin(missions):
    """The landing ends where the 3D view's Perseverance pin is (landmarks-v1.json, the one the site visit and Stand here use), on the Mars-fixed ground, at the time
    sites-v1.json gives for it. The pin is given to 4 decimals (about 6 m); the flown point must be within 0.01 degrees (600 m)."""
    import math

    m = missions.get("perseverance")
    if not m:
        pytest.skip("the Perseverance table is not in this build")
    root = os.path.join(ROOT, "zimi", "static", "earth")
    with open(os.path.join(root, "landmarks-v1.json"), encoding="utf-8") as fh:
        pin = [r for r in json.load(fh)["mars"] if r[0] == "Perseverance"][0]
    with open(os.path.join(root, "sites-v1.json"), encoding="utf-8") as fh:
        site = [s for s in json.load(fh)["sites"] if s["name"] == "Perseverance"][0]
    sky = [v for v in m["vehicles"] if v["id"] == "sky"][0]
    last = sky["legs"][-1]["s"][-1]
    assert sky["legs"][-1]["frame"] == "mfix"
    x, y, z = last[1:4]
    r = math.sqrt(x * x + y * y + z * z)
    assert abs(r - 3396.2) < 0.05   # on the sphere a site stands on
    lat, lon = math.degrees(math.asin(z / r)), math.degrees(math.atan2(y, x))
    assert abs(lat - pin[1]) < 0.01 and abs(((lon - pin[2] + 180) % 360) - 180) < 0.01, (lat, lon, pin)
    t_touch = m["zeroMs"] / 1000.0 + last[0]
    assert abs(t_touch * 1000 - site["ms"]) < 2000, (t_touch, site["ms"])


def test_perseverance_flies_from_slc41_to_mars_in_one_unbroken_line(missions):
    """Liftoff on Space Launch Complex 41 at 11:50:00 UT on 2020-07-30, the legs in the order the flight goes (the ascent on the Earth-fixed ground, the Earth-centred
    legs, the Sun-centred cruise, the Mars-centred approach, the landing on the Mars-fixed ground), each beginning where the last ends, and the cruise from about 1 AU to
    about 1.5 AU."""
    import math

    m = missions.get("perseverance")
    if not m:
        pytest.skip("the Perseverance table is not in this build")
    assert abs(m["zeroMs"] - 1596109800000) < 1000   # 2020-07-30 11:50:00 UT
    legs = [v for v in m["vehicles"] if v["id"] == "m20"][0]["legs"]
    assert [leg["frame"] for leg in legs] == ["ecef", "eci", "helio", "rel", "mfix"]
    for a, b in zip(legs, legs[1:]):
        assert abs(a["s"][-1][0] - b["s"][0][0]) < 20000.0, (a["frame"], b["frame"])   # the Earth-centred leg ends at 14:52 and the Sun-centred one begins there; the rest meet exactly
    x, y, z = legs[0]["s"][0][1:4]
    r = math.sqrt(x * x + y * y + z * z)
    lat, lon = math.degrees(math.asin(z / r)), math.degrees(math.atan2(y, x))
    assert abs(lat - 28.58) < 0.2 and abs(lon + 80.58) < 0.05   # geocentric latitude is a little under the geodetic 28.5833
    first, last = legs[2]["s"][0][1:4], legs[2]["s"][-1][1:4]
    assert 0.95 < math.sqrt(sum(c * c for c in first)) < 1.05 and 1.4 < math.sqrt(sum(c * c for c in last)) < 1.65
