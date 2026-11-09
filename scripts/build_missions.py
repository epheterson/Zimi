#!/usr/bin/env python3
"""Regenerate zimi/static/earth/missions-v1.json, the flights the Almanac's mission player replays.

    python3 scripts/build_missions.py [--only apollo11] [--cache DIR]

Needs the internet for JPL Horizons (https://ssd.jpl.nasa.gov/api/horizons.api; answers are cached in --cache, default
~/.cache/zimi-missions) and numpy + scipy; nothing else does, and Zimi itself never calls it. Public domain data (NASA/JPL):
credited in zimi/static/earth/SOURCES.txt. The queries are recorded in each mission's "source" and in the functions below.

A mission is its vehicles (each a few model parts, a window it exists in and its path as legs of rows [t, x, y, z, vx, vy,
vz]), its phases and its events. See zimi/static/almanac-missions.js for how they are played. Paths of Apollo 11 are
reconstructions: JPL has no ephemeris of Columbia or Eagle, so each stage of the flight is integrated (Earth with J2, the
Moon and the Sun from Horizons, finite burns) and solved against the positions, speeds and times in the mission report.
"""

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mission_physics as mp  # noqa: E402
from mission_tables import pack, thin  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "static", "earth", "missions-v1.json")


def mission_ms(jd_zero):
    return round((jd_zero - 2440587.5) * 86400000)


def build_apollo11():
    import mission_apollo11_story as story
    import mission_apollo11_vehicles as av
    import mission_apollo11_path as path
    from mission_apollo11 import EVENTS, ZERO_JD

    r = av.assemble(verbose=True)
    moon = path.ephemerides()[0]
    ref = np.hstack([moon.t[:, None], moon.p, moon.v])
    return {
        "name": "Apollo 11",
        "zeroMs": mission_ms(ZERO_JD),
        "start": -3.0,
        "end": EVENTS["splash"] + 60.0,
        "follow": "stack",
        "ref": {"moon": pack(ref, 3, 8)},
        "source": "NASA Apollo 11 Mission Report MSC-00171 (events, positions, masses); JPL Horizons 301 (the Moon) and 10 (the Sun), UT, ecliptic J2000; "
                  "the spacecraft's paths are integrated and fitted to the report, see scripts/mission_apollo11*.py",
        "vehicles": r["V"],
        "phases": story.phases(),
        "events": story.events(),
    }


def _sec(date, zero):
    from datetime import datetime, timezone

    fmt = "%Y-%m-%d %H:%M:%S" if len(date) > 16 else "%Y-%m-%d %H:%M"
    return (datetime.strptime(date, fmt).replace(tzinfo=timezone.utc) - zero).total_seconds()


DAY = 86400.0


def build_probe(key):
    """A probe flown on its own Horizons table: cruise, each flyby (the days round the closest approach, close in on the planet), and on."""
    from datetime import datetime, timezone

    import mission_probes as pr

    spec = pr.SPECS[key]
    zero = datetime.strptime(spec["launch"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    tracks = json.load(open(os.path.join(ROOT, "zimi", "static", "earth", "space-tracks-v1.json")))["tracks"][key]
    t0 = (tracks["jd0"] - 2440587.5) * DAY - zero.timestamp()
    end = min((tracks["jd1"] - 2440587.5) * DAY - zero.timestamp(), (datetime(2026, 11, 9, tzinfo=timezone.utc) - zero).total_seconds())
    flys = pr.flyby_table(key)
    phases, events = [], []

    def add_phase(t, k, en, w, rate, cam, **kw):
        d = {"t": round(t, 1), "k": "alm_ms_ph_" + k, "en": en, "w": w, "rate": rate, "follow": "probe", "cam": cam, "ref": "sun"}
        d.update(kw)
        phases.append(d)

    cruise_cam = {"d": 1.5e10, "az": 0.4, "el": 0.35, "body": "sun", "mix": 0.0}
    cursor = t0
    for i, f in enumerate(flys):
        tc = (pr.when(f["jd"]) - zero).total_seconds()
        a, b = tc - f["shown_days"] * DAY, tc + f["shown_days"] * DAY
        if a > cursor:
            add_phase(cursor, "cruise", "Cruise", 1.0, 20 * DAY if i == 0 else 30 * DAY, cruise_cam)
        key_planet = f["planet"].lower()
        add_phase(a, "flyby", "%s flyby" % f["planet"], 1.2, DAY / 4.0, {"body": key_planet, "d": 45, "az": 0.16, "el": 0.12, "mix": 1.0},
                  planet=f["planet"], dist=round(f["dist_km"]), alt_km=round(f["altitude_km"]), at=round(tc, 1))
        events.append({"t": round(tc, 1), "k": "alm_ms_ev_flyby", "en": "%s closest approach" % f["planet"], "planet": f["planet"], "icon": "dot", "dist": round(f["dist_km"])})
        cursor = b
    add_phase(cursor, "outbound", "Outbound", 1.2, 3e7 if key.startswith("voyager") else 1e7, cruise_cam)
    if key.startswith("voyager"):
        for date, k, en in ([("1990-02-14 04:48", "pale", "The Pale Blue Dot photographed")] if key == "voyager1" else []) + \
                [("2012-08-25 00:00" if key == "voyager1" else "2018-11-05 00:00", "interstellar", "Crosses into interstellar space")]:
            tt = _sec(date, zero)
            if tt < end:
                events.append({"t": tt, "k": "alm_ms_ev_" + k, "en": en, "icon": "dot"})
    events.sort(key=lambda e: e["t"])
    for e_ in events:
        e_["t"] = round(e_["t"], 1)
    return {
        "name": {"voyager1": "Voyager 1", "voyager2": "Voyager 2", "newhorizons": "New Horizons", "cassini": "Cassini"}[key],
        "zeroMs": round(zero.timestamp() * 1000),
        "start": round(t0, 1),
        "end": round(end, 1),
        "follow": "probe",
        "ref": {"moon": []},
        "source": "JPL Horizons, the probe's and the planet's own vectors (zimi/static/earth/space-tracks-v1.json); closest approaches found by scripts/mission_probes.py",
        "vehicles": [{"id": "probe", "on": round(t0, 1), "off": round(end, 1), "legs": [{"frame": "probe", "key": key, "s": [[round(t0, 1), 0, 0, 0, 0, 0, 0], [round(end, 1), 0, 0, 0, 0, 0, 0]]}],
                      "parts": [], "flames": [], "dot": False}],
        "phases": phases,
        "events": events,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--cache", default="")
    args = ap.parse_args()
    if args.cache:
        mp.CACHE = args.cache
    out = {"version": 1, "missions": {}}
    wanted = [m for m in args.only.split(",") if m] or ["apollo11", "voyager1", "voyager2"]
    if "apollo11" in wanted:
        out["missions"]["apollo11"] = build_apollo11()
    for k in ("voyager1", "voyager2", "newhorizons", "cassini"):
        if k in wanted:
            out["missions"][k] = build_probe(k)
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))


if __name__ == "__main__":
    main()
