#!/usr/bin/env python3
"""Add the world's tide gauges to the tide snapshot, from TICON-3.

    python3 scripts/build_tide_world.py --ticon TICON_3.zip --geonames cities1000.zip

Reads the committed zimi/assets/tides-snapshot.json.gz (NOAA's stations, from
scripts/build_tide_snapshot.py), drops any world stations an earlier run added,
and adds TICON-3's, so it can be run again at any time and after the NOAA
builder.

    TICON-3   Hart-Davis, M. G., Dettmering, D. and Seitz, F. (2022): TICON-3:
              Tidal Constants based on GESLA-3 sea-level records from globally
              distributed tide gauges including gauge type information (data).
              PANGAEA, https://doi.org/10.1594/PANGAEA.951610, CC BY 4.0.
              Amplitudes (cm) and Greenwich phase lags (degrees) of 40
              constituents at about 3,500 gauges.
    GeoNames  cities1000 (https://www.geonames.org, CC BY 4.0): only to name
              each gauge after the town it stands in. TICON has no names.

What goes in:
  - coastal and river gauges (lakes have no astronomical tide worth telling);
  - one record per gauge: TICON lists some gauges more than once (a record
    per epoch), the longest record wins;
  - not where NOAA already has a station within NOAA_WINS_KM: NOAA's datums are
    surveyed, ours are estimated;
  - not where the tide is too small to tell (the Baltic, the Mediterranean's
    quieter coasts): MIN_TIDE_CM across the four main constituents;
  - only the constituents the Almanac's list (NOAA's 37) names, amplitudes to
    the millimetre and phases to the degree, and none below MIN_AMP_MM.

TICON gives no datums, so two are worked out by synthesis over a few years:
the lowest tide (an estimate of Lowest Astronomical Tide, the chart datum of
most of the world) and the mean of the daily highest tides. Heights are above
that lowest tide, as on an Admiralty chart; NOAA's stay above mean lower low
water. Each world station says so (``dt: "LAT"``).

Downloads are checked against pinned hashes and stay in the folder given (a
scratch folder); nothing raw is committed.
"""

import argparse
import gzip
import hashlib
import io
import json
import math
import os
import sys
import zipfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT = os.path.join(ROOT, "zimi", "assets", "tides-snapshot.json.gz")

TICON_URL = "https://download.pangaea.de/dataset/951610/files/TICON_3.zip"
TICON_SHA256 = "6680aaa9a9bfbfc1e124554f03f6ea0e97c21ef320b4ed9973aa9c193e9dcabd"
GEONAMES_URL = "https://download.geonames.org/export/dump/cities1000.zip"
# GeoNames republishes daily, so its hash is the one this snapshot was built
# from; a newer file is used only when asked (--new-names).
GEONAMES_SHA256 = "171dcafa0c9300f24b6c67918fdbf719732dbe88c64742359ec6c2275d986adf"

SOURCE = {
    "id": "ticon3",
    "name": "TICON-3",
    "credit": "Hart-Davis, Dettmering and Seitz (2022), TICON-3, PANGAEA, CC BY 4.0",
    "url": "https://doi.org/10.1594/PANGAEA.951610",
    "names": "GeoNames, CC BY 4.0",
}

# TICON's names for the constituents NOAA spells otherwise.
TICON_ALIAS = {"LM2": "LAM2", "MI2": "MU2", "NI2": "NU2"}

# Speeds in degrees per hour (Schureman), for the datum synthesis only; the
# Almanac's own predictor has the full astronomy.
SPEED = {
    "M2": 28.9841042,
    "S2": 30.0,
    "N2": 28.4397295,
    "K1": 15.0410686,
    "M4": 57.9682084,
    "O1": 13.9430356,
    "M6": 86.9523127,
    "MK3": 44.0251729,
    "S4": 60.0,
    "MN4": 57.4238337,
    "NU2": 28.5125831,
    "S6": 90.0,
    "MU2": 27.9682084,
    "2N2": 27.8953548,
    "OO1": 16.1391017,
    "LAM2": 29.4556253,
    "S1": 15.0,
    "M1": 14.4966939,
    "J1": 15.5854433,
    "MM": 0.5443747,
    "SSA": 0.0821373,
    "SA": 0.0410686,
    "MSF": 1.0158958,
    "MF": 1.0980331,
    "RHO": 13.4715145,
    "Q1": 13.3986609,
    "T2": 29.9589333,
    "R2": 30.0410667,
    "2Q1": 12.8542862,
    "P1": 14.9589314,
    "2SM2": 31.0158958,
    "M3": 43.4761563,
    "L2": 29.5284789,
    "2MK3": 42.9271398,
    "K2": 30.0821373,
    "M8": 115.9364166,
    "MS4": 58.9841042,
}

NOAA_WINS_KM = 5.0  # a TICON gauge this close to a NOAA station is NOAA's
SAME_GAUGE_KM = 2.0  # TICON records this close together are one gauge
MIN_TIDE_CM = 5.0  # M2 + S2 + K1 + O1 below this: no tide worth telling
MIN_AMP_MM = 3  # a constituent smaller than this is left out (0)
NAME_TOWN_KM = 10.0  # a town of NAME_TOWN_POP or more this close names the gauge
NAME_TOWN_POP = 5000
NAME_ANY_KM = 25.0  # else the nearest place this close
DATUM_YEARS = 3  # the synthesis that estimates the datums
DATUM_STEP_MIN = 20
EARTH_RADIUS_KM = 6371.0


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_zip(path, pinned, member_suffix, allow_new=False):
    data = open(path, "rb").read()
    got = sha256(data)
    if got != pinned and not allow_new:
        sys.exit(f"{os.path.basename(path)}: sha256 {got} is not the pinned {pinned}")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        name = next(n for n in z.namelist() if n.endswith(member_suffix))
        return z.read(name).decode("utf-8"), got


def km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


class Grid:
    """Points bucketed by whole degrees, for near-neighbour questions."""

    def __init__(self, items):
        self.cells = {}
        for it in items:
            self.cells.setdefault((math.floor(it[0]), math.floor(it[1])), []).append(it)

    def near(self, lat, lon, radius_km):
        out = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                key = (math.floor(lat) + dy, (math.floor(lon) + dx + 180) % 360 - 180)
                for it in self.cells.get(key, ()):
                    d = km(lat, lon, it[0], it[1])
                    if d <= radius_km:
                        out.append((d, it))
        return sorted(out, key=lambda x: x[0])


def parse_ticon(text, names):
    """{(lat, lon, start, end, source): record} for coastal and river gauges."""
    gauges = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) < 14:
            continue
        lat, const = float(f[0]), f[2]
        lon = (float(f[1]) + 180) % 360 - 180   # TICON writes some longitudes east of 0..360
        amp_cm, phase = float(f[3]), float(f[4])
        n_obs, start, end, src, kind = int(f[8]), f[10], f[11], f[12], f[13]
        if kind == "Lake":
            continue
        key = (lat, lon, start, end, src)
        g = gauges.setdefault(
            key, {"la": lat, "lo": lon, "n_obs": n_obs, "end": end, "c": {}}
        )
        name = TICON_ALIAS.get(const, const)
        if name in names:
            g["c"][name] = (amp_cm, phase)
    return list(gauges.values())


def end_key(g):
    d, m, y = g["end"].split("/")
    return (y, m, d)


def one_per_gauge(gauges):
    """The longest record at each place (then the most recent)."""
    kept = []
    for g in sorted(gauges, key=lambda g: (g["n_obs"], end_key(g)), reverse=True):
        if not any(
            km(g["la"], g["lo"], k["la"], k["lo"]) < SAME_GAUGE_KM for k in kept
        ):
            kept.append(g)
    return kept


def datums(g, names):
    """(z0, mhhw) in mm: mean sea level above the lowest tide, and the mean
    daily highest tide above it, from a synthesis over DATUM_YEARS."""
    steps = int(DATUM_YEARS * 365.25 * 24 * 60 / DATUM_STEP_MIN)
    t = np.arange(steps) * (DATUM_STEP_MIN / 60.0)
    h = np.zeros(steps)
    for name, (amp_cm, phase) in g["c"].items():
        if name in SPEED:
            h += amp_cm * 10 * np.cos(np.radians(SPEED[name] * t - phase))
    low = h.min()
    per_day = int(24 * 60 / DATUM_STEP_MIN)
    days = h[: steps // per_day * per_day].reshape(-1, per_day).max(axis=1)
    return round(-low), round(days.mean() - low)


def name_gauge(g, towns):
    near = towns.near(g["la"], g["lo"], NAME_ANY_KM)
    for d, t in near:
        if d <= NAME_TOWN_KM and t[4] >= NAME_TOWN_POP:
            return t[2], t[3]
    if near:
        return near[0][1][2], near[0][1][3]
    return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--ticon", required=True, help=f"TICON_3.zip from {TICON_URL}")
    ap.add_argument(
        "--geonames", required=True, help=f"cities1000.zip from {GEONAMES_URL}"
    )
    ap.add_argument(
        "--new-names",
        action="store_true",
        help="accept a GeoNames file newer than the pinned one",
    )
    args = ap.parse_args()

    ticon, _ = read_zip(args.ticon, TICON_SHA256, "TICON_3.txt")
    geo, geo_sha = read_zip(
        args.geonames, GEONAMES_SHA256, "cities1000.txt", allow_new=args.new_names
    )

    with gzip.open(SNAPSHOT, "rt", encoding="utf-8") as f:
        snap = json.load(f)
    names = snap["constituents"]
    noaa = [s for s in snap["stations"] if s.get("src") != SOURCE["id"]]
    noaa_grid = Grid([(s["la"], s["lo"]) for s in noaa])

    towns = []
    for line in geo.splitlines():
        f = line.split("\t")
        towns.append((float(f[4]), float(f[5]), f[1], f[8], int(f[14] or 0)))
    towns = Grid(towns)

    gauges = one_per_gauge(parse_ticon(ticon, set(names)))
    world, dropped = [], {"noaa": 0, "small": 0}
    for g in gauges:
        c = g["c"]
        main4 = sum(c.get(k, (0, 0))[0] for k in ("M2", "S2", "K1", "O1"))
        if main4 < MIN_TIDE_CM:
            dropped["small"] += 1
            continue
        if noaa_grid.near(g["la"], g["lo"], NOAA_WINS_KM):
            dropped["noaa"] += 1
            continue
        z0, mhhw = datums(g, names)
        amps, phases = [], []
        for n in names:
            amp_mm, ph = (
                (round(c[n][0] * 10), round(c[n][1]) % 360) if n in c else (0, 0)
            )
            if amp_mm < MIN_AMP_MM:
                amp_mm, ph = 0, 0
            amps.append(amp_mm)
            phases.append(ph * 10)  # the snapshot's phases are in tenths of a degree
        town, country = name_gauge(g, towns)
        la, lo = round(g["la"], 3), round(g["lo"], 3)
        st = {
            "id": "t%d_%d" % (round(la * 1000), round(lo * 1000)),
            "n": town or "%.2f, %.2f" % (la, lo),
            "s": country or "",
            "la": la,
            "lo": lo,
            "src": SOURCE["id"],
            "dt": "LAT",
            "z0": z0,
            "mhhw": mhhw,
            "a": amps,
            "g": phases,
        }
        world.append(st)

    snap["stations"] = noaa + sorted(world, key=lambda s: s["id"])
    snap["sources"] = [
        s for s in snap.get("sources", []) if s.get("id") != SOURCE["id"]
    ] + [dict(SOURCE, geonames_sha256=geo_sha)]
    out = json.dumps(snap, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    with gzip.GzipFile(SNAPSHOT, "wb", mtime=0) as f:
        f.write(out)
    print(
        f"{len(world)} world stations ({dropped['noaa']} left to NOAA, {dropped['small']} with too small a tide),"
        f" {len(noaa)} NOAA; {os.path.getsize(SNAPSHOT) // 1024} KB"
    )


if __name__ == "__main__":
    main()
