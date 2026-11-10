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
    assert abs(a * (1 + e) - 6378.137 - 100.7 * nm) < 3.0
    assert abs(a * (1 - e) - 6378.137 - 99.2 * nm) < 3.0
    assert abs(inc - 32.521) < 0.1
