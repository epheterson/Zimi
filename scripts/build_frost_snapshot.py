#!/usr/bin/env python3
"""Build the frost dates that ship inside Zimi, once, from NOAA NCEI.

    python3 scripts/build_frost_snapshot.py [--tar path/to/archive.tar.gz]

Writes one committed file:

    zimi/assets/frost-normals.json.gz

From the U.S. Climate Normals 1991-2020 (annual/seasonal, by station), for
every station that has the freeze statistics: the dates of the last spring and
first fall freeze at 32 F and 28 F at three probability levels (10, 50 and 90
percent), the growing season's length at 50 percent, and how often a freeze
happens at all. The Almanac (static/almanac-tides.js) shows the nearest
station's dates for a chosen place.

Normals are recomputed every ten years (the next set is 2001-2030), so this is
run once a decade. NOAA data is in the public domain (see
THIRD_PARTY_NOTICES.md). The archive is about 55 MB; pass --tar to reuse a
downloaded copy.
"""

import argparse
import csv
import datetime
import gzip
import io
import json
import os
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "assets", "frost-normals.json.gz")
ARCHIVE = (
    "https://www.ncei.noaa.gov/data/normals-annualseasonal/1991-2020/archive/"
    "us-climate-normals_1991-2020_v1.0.1_annualseasonal_multivariate_by-station_c20230404.tar.gz"
)
UA = "Zimi frost snapshot builder (+https://github.com/epheterson/Zimi)"
MISSING = -9999

# Column order of every station row in the snapshot (also in the payload, so
# the reader never guesses). Dates are day of a non-leap year, 1..365; 0 means
# NCEI has no value (usually: it does not freeze there in most years).
FIELDS = [
    ("l32_10", "ANN-TMIN-PRBLST-T32FP10"),
    ("l32_50", "ANN-TMIN-PRBLST-T32FP50"),
    ("l32_90", "ANN-TMIN-PRBLST-T32FP90"),
    ("f32_10", "ANN-TMIN-PRBFST-T32FP10"),
    ("f32_50", "ANN-TMIN-PRBFST-T32FP50"),
    ("f32_90", "ANN-TMIN-PRBFST-T32FP90"),
    ("l28_10", "ANN-TMIN-PRBLST-T28FP10"),
    ("l28_50", "ANN-TMIN-PRBLST-T28FP50"),
    ("l28_90", "ANN-TMIN-PRBLST-T28FP90"),
    ("f28_10", "ANN-TMIN-PRBFST-T28FP10"),
    ("f28_50", "ANN-TMIN-PRBFST-T28FP50"),
    ("f28_90", "ANN-TMIN-PRBFST-T28FP90"),
    ("gsl32", "ANN-TMIN-PRBGSL-T32FP50"),
    ("gsl28", "ANN-TMIN-PRBGSL-T28FP50"),
    ("occ32", "ANN-TMIN-PRBOCC-LSTH032"),
    ("occ28", "ANN-TMIN-PRBOCC-LSTH028"),
]
DAYS_BEFORE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]


def day_of_year(mmdd):
    """'05/04' -> 124 (non-leap); None for a missing value."""
    try:
        m, d = mmdd.strip().split("/")
        return DAYS_BEFORE[int(m) - 1] + int(d)
    except (ValueError, IndexError):
        return 0


def number(v):
    try:
        x = float(v)
    except ValueError:
        return None
    return None if x <= MISSING else x


def pretty_name(raw):
    """'LOS ANGELES DWTN USC, CA US' -> 'Los Angeles Dwtn Usc, CA'."""
    place, _, rest = raw.partition(",")
    state = rest.strip().split(" ")[0] if rest.strip() else ""
    place = " ".join(w.capitalize() for w in place.split())
    return f"{place}, {state}" if state else place


def station_row(header, row):
    col = {k: i for i, k in enumerate(header)}
    if any(k not in col for _, k in FIELDS):
        return None
    if number(row[col["ANN-TMIN-PRBOCC-LSTH032"]]) is None:
        return None  # no freeze statistics for this station
    vals = []
    for name, key in FIELDS:
        raw = row[col[key]]
        if name.startswith(("l", "f")):
            vals.append(day_of_year(raw) if "/" in raw else 0)
            continue
        x = number(raw)
        if x is None:
            vals.append(-1)
        elif name.startswith("occ"):
            vals.append(round(x * 10))
        else:
            vals.append(round(x))
    try:
        lat, lon = float(row[col["LATITUDE"]]), float(row[col["LONGITUDE"]])
        elev = float(row[col["ELEVATION"]])
    except ValueError:
        return None
    return [
        row[col["STATION"]],
        pretty_name(row[col["NAME"]]),
        round(lat, 4),
        round(lon, 4),
        round(elev),
    ] + vals


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tar", help="a downloaded copy of the NCEI archive")
    args = ap.parse_args()
    if args.tar:
        data = open(args.tar, "rb").read()
    else:
        req = urllib.request.Request(ARCHIVE, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=600) as r:
            data = r.read()
    rows = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar:
            if not m.isfile() or not m.name.endswith(".csv"):
                continue
            text = tar.extractfile(m).read().decode("utf-8", "replace")
            r = list(csv.reader(io.StringIO(text)))
            if len(r) < 2:
                continue
            got = station_row(r[0], r[1])
            if got:
                rows.append(got)
    rows.sort(key=lambda x: x[0])
    payload = {
        "source": "NOAA NCEI U.S. Climate Normals 1991-2020, annual/seasonal (v1.0.1)",
        "licence": "Public domain (U.S. Government work)",
        "normals": "1991-2020",
        "fetched": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        "columns": ["id", "name", "lat", "lon", "elev_m"] + [n for n, _ in FIELDS],
        "notes": "Dates are day of a non-leap year (1-365), 0 = none. "
        "l = last spring freeze, f = first fall freeze; _10/_50/_90 = probability "
        "of a later spring (earlier fall) freeze than that date. gsl = growing "
        "season days at 50%, -1 = none. occ = percent of years with a freeze, x10.",
        "stations": rows,
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    with open(OUT, "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0) as gz:
            gz.write(raw)
    print(
        f"{OUT}: {len(rows)} stations, {len(raw) // 1024} KB raw, {os.path.getsize(OUT) // 1024} KB gzipped"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
