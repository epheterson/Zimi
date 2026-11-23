"""Every mission the 3D view plays is checked against its source document (scripts/missions/<id>.json): each event's place, height,
speed, flight-path angle and heading, read from the shipped tables the way the player reads them, within the event's tolerance
(scripts/mission_check.py). A refit that drifts from the record fails here.

Run: pytest tests/test_mission_events.py -v      (python3 scripts/mission_check.py <id> prints the same table)
"""

import json
import math
import os
import sys

import pytest

np = pytest.importorskip("numpy")  # the desktop build's suite runs without numpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import mission_check as mc  # noqa: E402

MISSIONS = sorted(f[:-5] for f in os.listdir(mc.SOURCES_DIR) if f.endswith(".json"))


@pytest.mark.parametrize("mission", MISSIONS)
def test_every_event_is_within_its_tolerance(mission):
    shipped, source = mc.load(mission)
    for e in source["events"]:
        assert e.get("src") in source["sources"], (e["key"], "an event must cite one of the document's sources")
    rows = mc.check(shipped, source)
    bad = [(ev["key"], {k: (round(m, 2), t) for k, (m, t) in miss.items() if m > t}) for ev, got, miss, ok in rows if not ok and not ev.get("open")]
    assert not bad, bad
    # A gap the document marks open is known and explained; once it closes, the mark must come off (so it is checked from then on).
    closed = [ev["key"] for ev, got, miss, ok in rows if ok and ev.get("open")]
    assert not closed, ("open in the document but within tolerance now", closed)


def test_apollo_11_lands_at_tranquility_base_slowly_and_never_under_the_ground():
    """The lander must not go under the surface, and must slow to the real touchdown rate (about 1 m/s)."""
    shipped, source = mc.load("apollo11")
    eagle = [v for v in shipped["vehicles"] if v["id"] == "eagle"][0]
    leg = [l for l in eagle["legs"] if l["frame"] == "mcmf"][0]
    rows = leg["s"]
    site = [e for e in source["events"] if e["key"] == "landing"][0]
    end = rows[-1]
    r_end = math.sqrt(sum(x * x for x in end[1:4]))
    lat, lon = math.degrees(math.asin(end[3] / r_end)), math.degrees(math.atan2(end[2], end[1]))
    assert abs(lat - site["lat"]) < 0.001 and abs(lon - site["lon"]) < 0.001, (lat, lon)
    t_end = end[0]
    for t in [t_end - k for k in range(0, 61)]:
        p, v = mc.hermite(rows, t)
        assert math.sqrt(sum(x * x for x in p)) >= r_end - 0.001, ("under the ground", t)   # never more than a metre under the touchdown radius
    _, v_last = mc.hermite(rows, t_end - 0.1)
    assert math.sqrt(sum(x * x for x in v_last)) * 1000 < 1.5   # m/s over the ground at touchdown
    _, v_minute = mc.hermite(rows, t_end - 60)
    assert math.sqrt(sum(x * x for x in v_minute)) * 1000 < 6.0   # and already slow a minute before (the report: under 20 ft/s from P66)


def test_perseverance_entry_joins_its_approach():
    """The approach (Horizons, Mars-centred) ends at the entry instant where the entry track begins: no seam to slide across, no wait.
    And the published speeds after the parachute opens stand (only the unpublished hypersonic ones are fitted to the ground)."""
    import mission_perseverance as mp

    m, _ = mc.load("perseverance")
    t_ei = [e["t"] for e in m["events"] if e["k"] == "alm_ms_ev_m20_entry"][0]
    legs = [v for v in m["vehicles"] if v["id"] == "m20"][0]["legs"]
    rel = [l for l in legs if l["frame"] == "rel"][0]
    fix = [l for l in legs if l["frame"] == "mfix"][0]
    assert rel["s"][-1][0] == fix["s"][0][0] == t_ei
    a, _ = mc.hermite(rel["s"], t_ei)
    b, _ = mc.hermite(fix["s"], t_ei)
    x, y, z = mp.mars_frame((m["zeroMs"] / 1000.0 + t_ei) / 86400.0 + 2440587.5)
    assert np.linalg.norm(x * b[0] + y * b[1] + z * b[2] - np.asarray(a)) < 3.0
    for dt, alt, speed in mp.PROFILE:
        if dt >= mp.EVENT_AFTER_EI["chute"] and speed > 5.0:
            _, v = mc.hermite(fix["s"], t_ei + dt)
            assert abs(np.linalg.norm(v) * 1000.0 - speed) < 0.25 * speed + 5.0, (dt, np.linalg.norm(v) * 1000.0, speed)
