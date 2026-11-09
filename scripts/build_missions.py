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
    import mission_apollo11 as a11
    import mission_apollo11_path as path
    from mission_atmo import fall

    E = a11.EVENTS
    moon, sun = path.ephemerides()
    t_asc, y_asc = path.load_ascent()
    res = path.build_translunar()
    fl = res["fl"]
    vehicles = []
    events = []

    def ecef_rows(t, y, hold=None):
        rows = []
        if hold is not None:
            p0 = path.ecef_state(t[0], y[0])
            rows.append(np.concatenate([[hold], p0[:3], [0, 0, 0]]))
        for ti, yi in zip(t, y):
            rows.append(np.concatenate([[ti], path.ecef_state(ti, yi)]))
        return np.array(rows)

    # The stack: the climb in Earth-fixed rows, the parking orbit and the translunar burn in inertial ones.
    asc = ecef_rows(t_asc, y_asc, hold=-15.0)
    stack_legs = [
        {
            "frame": "ecef",
            "s": pack(thin(asc, 0.02, max_gap=30.0), 4, 6),
            "ref": "earth",
        }
    ]
    t_park = res["t_park"]
    park = np.hstack([t_park[:, None], res["y_park"][:, 0:6]])
    return dict(
        asc=asc,
        park=park,
        res=res,
        vehicles=vehicles,
        events=events,
        stack_legs=stack_legs,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--cache", default="")
    args = ap.parse_args()
    if args.cache:
        mp.CACHE = args.cache
    out = {"version": 1, "missions": {}}
    wanted = [m for m in args.only.split(",") if m] or ["apollo11"]
    if "apollo11" in wanted:
        out["missions"]["apollo11"] = build_apollo11()
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))


if __name__ == "__main__":
    main()
