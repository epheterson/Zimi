"""Build the rovers' journeys the 3D view replays on the timeline: zimi/static/earth/traverses-v1.json.

    python scripts/build_traverses.py [--src DIR]

Curiosity and Perseverance, each the rover's position at the end of every drive: the sol, latitude and longitude (degrees,
six places: a metre or so on Mars) from NASA/JPL's MMGIS waypoint files, "MSL_waypoints.json" and "M20_waypoints.json"
(mars.nasa.gov/mmgis-maps; NASA imagery and data are public domain, credit "NASA/JPL-Caltech/MSL and Mars 2020 teams"). --src
is a folder holding those two files under their own names (else they are fetched). The file keeps one point per sol (the
last of the sol's drives) and every point where the rover has turned by more than a small angle between the points kept,
so the route is the same to within a few metres at a fraction of the size.

Each rover also gets the instant of its landing (its sol 0 begins then, a sol being 88775.244 s), which the view reads to
set the Almanac's clock for a sol.
"""

import argparse
import json
import math
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "static", "earth", "traverses-v1.json")
BASE = "https://mars.nasa.gov/mmgis-maps/%s/Layers/json/%s_waypoints.json"
# key: (mission folder and file stem, name, landing instant in ms since 1970, the landing site's name in landmarks-v1.json)
ROVERS = {
    "msl": ("MSL", "Curiosity", 1344230278000, "Curiosity"),  # 2012-08-06 05:17:58 UTC
    "m20": (
        "M20",
        "Perseverance",
        1613681700000,
        "Perseverance",
    ),  # 2021-02-18 20:55 UTC
}
SOL_S = 88775.244
TURN_DEG = 3.0  # a point is kept where the route bends by more than this
MIN_STEP_M = 4.0
MARS_R_M = 3389500.0


def _fetch(stem, folder, src):
    name = "%s_waypoints.json" % stem
    if src:
        with open(os.path.join(src, name), "rb") as fh:
            return json.loads(fh.read().decode("utf-8-sig"))
    req = urllib.request.Request(
        BASE % (folder, stem), headers={"User-Agent": "Zimi-build/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8-sig"))


def _local(lat, lon, lat0, lon0):
    return (
        (lon - lon0) * math.cos(math.radians(lat0)) * MARS_R_M * math.pi / 180,
        (lat - lat0) * MARS_R_M * math.pi / 180,
    )


def thin(points):
    """One point per sol (the last), then those where the route turns or has gone a few metres."""
    by_sol = {}
    for sol, lat, lon in points:
        by_sol[sol] = (sol, lat, lon)
    pts = [by_sol[s] for s in sorted(by_sol)]
    lat0, lon0 = pts[0][1], pts[0][2]
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = out[-1], pts[i], pts[i + 1]
        ax, ay = _local(a[1], a[2], lat0, lon0)
        bx, by = _local(b[1], b[2], lat0, lon0)
        cx, cy = _local(c[1], c[2], lat0, lon0)
        d1, d2 = math.hypot(bx - ax, by - ay), math.hypot(cx - bx, cy - by)
        if d1 < MIN_STEP_M:
            continue
        turn = abs(
            math.degrees(math.atan2(by - ay, bx - ax) - math.atan2(cy - by, cx - bx))
        )
        turn = min(turn, 360 - turn) if turn > 180 else turn
        if turn > TURN_DEG or d1 > 40:
            out.append(b)
    out.append(pts[-1])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="")
    a = ap.parse_args()
    data = {
        "version": 1,
        "solSeconds": SOL_S,
        "credit": "NASA/JPL-Caltech/MSL and Mars 2020 teams (MMGIS waypoints)",
    }
    for key, (folder, name, landing, site) in ROVERS.items():
        gj = _fetch(folder, folder, a.src)
        pts = []
        for f in gj["features"]:
            p = f["properties"]
            if (
                p.get("lat") is not None
                and p.get("lon") is not None
                and p.get("sol") is not None
            ):
                pts.append((int(p["sol"]), float(p["lat"]), float(p["lon"])))
        kept = thin(pts)
        data[key] = {
            "name": name,
            "site": site,
            "landingMs": landing,
            "sols": [kept[0][0], kept[-1][0]],
            "points": [[s, round(la, 6), round(lo, 6)] for s, la, lo in kept],
        }
        print(
            "%s: %d drives -> %d points, sols %d..%d"
            % (name, len(pts), len(kept), kept[0][0], kept[-1][0])
        )
    with open(OUT, "w") as fh:
        fh.write(
            "{\n"
            + ",\n".join(
                (
                    '"%s": %s'
                    % (k, json.dumps(v, separators=(",", ":"), ensure_ascii=False))
                    if isinstance(v, dict)
                    else '"%s": %s' % (k, json.dumps(v))
                )
                for k, v in data.items()
            )
            + "\n}\n"
        )
    print("%d bytes" % os.path.getsize(OUT))


if __name__ == "__main__":
    main()
