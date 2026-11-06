#!/usr/bin/env python3
"""Regenerate the spacecraft, dwarf-planet and giant-planet tracks that ship with Zimi.

    python3 scripts/build_space_tracks.py            # tracks + the test reference
    python3 scripts/build_space_tracks.py --only voyager1

Needs the internet (JPL Horizons, https://ssd.jpl.nasa.gov/api/horizons.api);
nothing else does, and Zimi itself never calls it. Writes two committed files:

    zimi/static/earth/space-tracks-v1.json
        "tracks": for each probe (and Ceres) and "planets": for Jupiter,
        Saturn, Uranus, Neptune and Pluto over 1970-2050, the heliocentric
        position and velocity in the J2000 ecliptic frame (AU, AU/day), at the
        times a cubic Hermite curve needs to stay within a tolerance of the
        full Horizons table. Planets and probes come from the one source, so a
        flyby is where it was: almanac-space.js interpolates both
        (_spHermite) and falls back on the orrery's elements only outside a
        planet's span. Public domain (NASA/JPL); credited in
        zimi/static/earth/SOURCES.txt. Renaming it means a new -vN name there
        and in almanac-space.js, because static files are served immutable.

    tests/fixtures/horizons-space-reference.json
        Horizons' own vectors for planets, Pluto, probes, moons and the
        closest approaches of the flybys at the stated times, fetched directly
        (not thinned). tests/test_almanac_space.cjs checks the shipped code
        against them, offline.

The thinning keeps the first sample, then the farthest next sample for which a
Hermite curve through the two (positions and velocities) reproduces every
dense sample between them to within a tolerance. For a probe in cruise that is
TOL_ABS_AU + TOL_REL * its distance from the Sun. In the window round each
planetary flyby or orbit insertion (the dense table there is 5 minutes) the
tolerance is also at most NEAR_FRACTION of its distance from that planet, so
the encounter is right to a planetary radius, not to the cruise tolerance. A
giant planet's own track is held to TOL_PLANET_AU. The check is run over the
values as written (rounded), against the same tolerances, before a file is
accepted.
"""

import argparse
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACKS_PATH = os.path.join(ROOT, "zimi", "static", "earth", "space-tracks-v1.json")
REFERENCE_PATH = os.path.join(
    ROOT, "tests", "fixtures", "horizons-space-reference.json"
)
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"

TOL_ABS_AU = 4e-4
TOL_REL = 3e-4  # of the distance from the Sun
TOL_PLANET_AU = 2e-5  # a giant planet's own track: 3,000 km
NEAR_FRACTION = 0.05  # in an encounter window: of the distance to the planet
NEAR_FLOOR_AU = 2e-6  # and never asked for less than 300 km
WINDOW_DAYS = (1.5, 2.0)  # before and after the event's date
WINDOW_STEP = "5m"
WINDOW_STEP_DAYS = 5 / 1440
THIN_MARGIN = 0.85
ROWS_PER_REQUEST = 8000  # Horizons answers a request this size in a second or two
MIN_JD_STEP = 1.0 / 24  # never thinner than an hour of dense data

# What flew where. `id` is the Horizons command; `start`/`end` bound the table
# (the end is the mission's or Horizons' own); `step` is the dense step.
# `events` are [date, kind, body]: the labels are the page's, in the reader's
# language (kind: launch, flyby, orbit, arrive, record, interstellar, end).
PROBES = {
    "voyager1": {
        "name": "Voyager 1",
        "id": "-31",
        "start": "1977-09-06",
        "end": "2100-01-01",
        "step": "1d",
        "events": [
            ["1977-09-05", "launch", ""],
            ["1979-03-05", "flyby", "Jupiter"],
            ["1980-11-12", "flyby", "Saturn"],
            ["1990-02-14", "pale_blue_dot", ""],
            ["2012-08-25", "interstellar", ""],
        ],
    },
    "voyager2": {
        "name": "Voyager 2",
        "id": "-32",
        "start": "1977-08-21",
        "end": "2100-01-01",
        "step": "1d",
        "events": [
            ["1977-08-20", "launch", ""],
            ["1979-07-09", "flyby", "Jupiter"],
            ["1981-08-26", "flyby", "Saturn"],
            ["1986-01-24", "flyby", "Uranus"],
            ["1989-08-25", "flyby", "Neptune"],
            ["2018-11-05", "interstellar", ""],
        ],
    },
    "pioneer10": {
        "name": "Pioneer 10",
        "id": "-23",
        "start": "1972-03-04",
        "end": "2049-12-31",
        "step": "1d",
        "events": [
            ["1972-03-03", "launch", ""],
            ["1973-12-04", "flyby", "Jupiter"],
            ["2003-01-23", "end", ""],
        ],
    },
    "pioneer11": {
        "name": "Pioneer 11",
        "id": "-24",
        "start": "1973-04-07",
        "end": "2049-12-31",
        "step": "1d",
        "events": [
            ["1973-04-06", "launch", ""],
            ["1974-12-03", "flyby", "Jupiter"],
            ["1979-09-01", "flyby", "Saturn"],
            ["1995-09-30", "end", ""],
        ],
    },
    "newhorizons": {
        "name": "New Horizons",
        "id": "-98",
        "start": "2006-01-20",
        "end": "2049-12-31",
        "step": "1d",
        "events": [
            ["2006-01-19", "launch", ""],
            ["2007-02-28", "flyby", "Jupiter"],
            ["2015-07-14", "flyby", "Pluto"],
            ["2019-01-01", "flyby", "Arrokoth"],
        ],
    },
    "parker": {
        "name": "Parker Solar Probe",
        "id": "-96",
        "start": "2018-08-13",
        "end": "2029-12-31",
        "step": "3h",
        "events": [
            ["2018-08-12", "launch", ""],
            ["2018-10-03", "flyby", "Venus"],
            ["2024-12-24", "record", ""],
        ],
    },
    "juno": {
        "name": "Juno",
        "id": "-61",
        "start": "2011-08-06",
        "end": "2028-09-01",
        "step": "1h",
        "events": [
            ["2011-08-05", "launch", ""],
            ["2013-10-09", "flyby", "Earth"],
            ["2016-07-05", "orbit", "Jupiter"],
        ],
    },
    "jwst": {
        "name": "James Webb Space Telescope",
        "id": "-170",
        "start": "2021-12-26",
        "end": "2031-10-04",
        "step": "1d",
        "events": [["2021-12-25", "launch", ""], ["2022-01-24", "arrive", "L2"]],
    },
    "cassini": {
        "name": "Cassini",
        "id": "-82",
        "start": "1997-10-16",
        "end": "2017-09-14",
        "step": "1h",
        "events": [
            ["1997-10-15", "launch", ""],
            ["1999-06-24", "flyby", "Venus"],
            ["2000-12-30", "flyby", "Jupiter"],
            ["2004-07-01", "orbit", "Saturn"],
            ["2017-09-15", "end", ""],
        ],
    },
    "galileo": {
        "name": "Galileo",
        "id": "-77",
        "start": "1989-10-20",
        "end": "2003-09-29",
        "step": "2h",
        "events": [
            ["1989-10-18", "launch", ""],
            ["1995-12-07", "orbit", "Jupiter"],
            ["2003-09-21", "end", ""],
        ],
    },
    "europaclipper": {
        "name": "Europa Clipper",
        "id": "-159",
        "start": "2024-10-15",
        "end": "2034-09-02",
        "step": "1d",
        "events": [
            ["2024-10-14", "launch", ""],
            ["2025-03-01", "flyby", "Mars"],
            ["2026-12-03", "flyby", "Earth"],
            ["2030-04-11", "orbit", "Jupiter"],
        ],
    },
}
# The giant planets (and Pluto), from the same table as the probes.
PLANETS = {
    "Jupiter": "599",
    "Saturn": "699",
    "Uranus": "799",
    "Neptune": "899",
    # The Pluto-Charon barycentre, 2,100 km from Pluto: Pluto itself swings round it every 6.4 days.
    "Pluto": "9",
}
PLANET_SPAN = ("1970-01-01", "2049-12-31", "1d")
# Every planet an encounter window can name: the Horizons command of each.
ENCOUNTER_BODIES = dict(PLANETS, Venus="299", Earth="399", Mars="499")
# Dwarf planets whose elements the orrery does not carry.
BODIES = {
    "ceres": {
        "name": "Ceres",
        "id": "2000001",
        "start": "1900-01-01",
        "end": "2100-01-01",
        "step": "2d",
        "events": [],
    },
}

# Reference checks: Horizons' own vectors, fetched directly. Each date is
# inside the Keplerian elements' stated span (1800-2050) and the probe's.
REF_PLANETS = {
    "Mercury": "199",
    "Venus": "299",
    "Earth": "399",
    "Mars": "499",
    "Jupiter": "599",
    "Saturn": "699",
    "Uranus": "799",
    "Neptune": "899",
    "Pluto": "999",
}
# Moons are checked relative to their planet (Horizons centre 500@<planet>).
REF_MOONS = {"Io": ("501", "599"), "Europa": ("502", "599"), "Ganymede": ("503", "599"), "Callisto": ("504", "599"),
             "Titan": ("606", "699"), "Moon": ("301", "399")}
REF_DATES = ["1990-01-01", "2026-10-13", "2045-06-15"]
# Closest approaches, to the minute (UT): the probe, the planet, the time. The probe is
# checked against the planet's drawn place, not just its own.
REF_FLYBYS = [
    ("voyager2", "Neptune", "1989-08-25 03:56"),
    ("voyager2", "Uranus", "1986-01-24 17:59"),
    ("voyager1", "Saturn", "1980-11-12 23:46"),
    ("pioneer11", "Saturn", "1979-09-01 16:31"),
    ("newhorizons", "Pluto", "2015-07-14 11:50"),
    ("cassini", "Saturn", "2010-06-01 00:00"),
]
REF_PROBE_DATES = {
    "voyager1": ["1985-06-01", "2012-09-01", "2026-10-13"],
    "voyager2": ["1986-02-01", "2008-03-01", "2026-10-13"],
    "pioneer10": ["1975-01-01", "1990-01-01", "2026-10-13"],
    "newhorizons": ["2010-01-01", "2015-07-14", "2026-10-13"],
    "parker": ["2019-01-01", "2024-12-24", "2026-10-13"],
    "juno": ["2012-01-01", "2016-07-05", "2026-10-13"],
    "jwst": ["2022-03-01", "2024-01-01", "2026-10-13"],
}


def _jd_of(date):
    y, m, d = (int(v) for v in date.split("-"))
    if m <= 2:
        y, m = y - 1, m + 12
    a = y // 100
    b = 2 - a + a // 4
    return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5


def horizons(command, start, stop, step, center="500@10"):
    """One Horizons VECTORS table: rows of [jdtdb, x, y, z, vx, vy, vz] (AU, AU/day, ecliptic J2000)."""
    q = {
        "format": "text",
        "COMMAND": "'%s'" % command,
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'",
        "CENTER": "'%s'" % center,
        "START_TIME": "'%s'" % start,
        "STOP_TIME": "'%s'" % stop,
        "STEP_SIZE": "'%s'" % step,
        "REF_PLANE": "'ECLIPTIC'",
        "VEC_TABLE": "'2'",
        "OUT_UNITS": "'AU-D'",
        "CSV_FORMAT": "'YES'",
        "VEC_LABELS": "'NO'",
    }
    url = HORIZONS + "?" + urllib.parse.urlencode(q)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                text = r.read().decode()
            break
        except OSError:
            if attempt == 3:
                raise
    m = re.search(r"\$\$SOE(.*?)\$\$EOE", text, re.S)
    if not m:
        raise RuntimeError(
            "Horizons gave no table for %s %s..%s:\n%s"
            % (command, start, stop, text[:600])
        )
    rows = []
    for line in m.group(1).strip().splitlines():
        f = [v.strip() for v in line.split(",") if v.strip()]
        rows.append([float(f[0])] + [float(v) for v in f[2:8]])
    return rows


def _step_days(step):
    if step.endswith("m"):
        return int(step[:-1]) / 1440
    return int(step[:-1]) / 24 if step.endswith("h") else float(step[:-1])


def dense_table(spec, command=None, jd0=None, jd1=None, step=None):
    """A dense table, fetched in chunks small enough for one request each (a probe's whole span by default)."""
    step = step or spec["step"]
    step_d = _step_days(step)
    jd0 = _jd_of(spec["start"]) if jd0 is None else jd0
    jd1 = _jd_of(spec["end"]) if jd1 is None else jd1
    rows, cur = [], jd0
    chunk = ROWS_PER_REQUEST * step_d
    while cur < jd1:
        stop = min(cur + chunk, jd1)
        part = horizons(command or spec["id"], _cal(cur), _cal(stop), step)
        if rows and part and part[0][0] <= rows[-1][0] + 1e-9:
            part = [r for r in part if r[0] > rows[-1][0] + 1e-9]
        rows.extend(part)
        cur = stop
    return rows


def _cal(jd):
    """A Julian Day as the 'YYYY-MM-DD HH:MM' Horizons takes."""
    jd = round((jd + 0.5) * 1440) / 1440 - 0.5   # to the minute, so 23:59:30 does not become 24:00
    z = int(jd + 0.5)
    f = jd + 0.5 - z
    a = (
        z
        if z < 2299161
        else z
        + 1
        + int((z - 1867216.25) / 36524.25)
        - int(int((z - 1867216.25) / 36524.25) / 4)
    )
    b = a + 1524
    c = int((b - 122.1) / 365.25)
    d = int(365.25 * c)
    e = int((b - d) / 30.6001)
    day = b - d - int(30.6001 * e)
    month = e - 1 if e < 14 else e - 13
    year = c - 4716 if month > 2 else c - 4715
    mins = int(round(f * 1440))
    return "%04d-%02d-%02d %02d:%02d" % (year, month, day, mins // 60, mins % 60)


def hermite(a, b, jd):
    """Cubic Hermite position at jd between samples a and b (rows as above)."""
    h = b[0] - a[0]
    t = (jd - a[0]) / h
    t2, t3 = t * t, t * t * t
    h00, h10, h01, h11 = 2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2
    return [
        h00 * a[1 + k] + h10 * h * a[4 + k] + h01 * b[1 + k] + h11 * h * b[4 + k]
        for k in range(3)
    ]


def _helio_tol(row):
    return TOL_ABS_AU + TOL_REL * math.sqrt(row[1] ** 2 + row[2] ** 2 + row[3] ** 2)


def _fits(rows, tols, i, j):
    a, b = rows[i], rows[j]
    for k in range(i + 1, j):
        p = hermite(a, b, rows[k][0])
        if max(abs(p[n] - rows[k][1 + n]) for n in range(3)) > min(tols[k], tols[i], tols[j]):
            return False
    return True


def thin(rows, tols):
    """The fewest samples whose Hermite curve stays within tolerance of every dense row."""
    keep, i, n = [0], 0, len(rows)
    while i < n - 1:
        # Gallop out until a span fails (or the table ends), then bisect to the farthest that fits.
        lo, hi, span = i + 1, None, 2
        while hi is None and lo < n - 1:
            j = min(i + span, n - 1)
            if _fits(rows, tols, i, j):
                lo, span = j, span * 2
            else:
                hi = j
        while hi is not None and hi - lo > 1:
            mid = (lo + hi) // 2
            if _fits(rows, tols, i, mid):
                lo = mid
            else:
                hi = mid
        keep.append(lo)
        i = lo
    return keep


def verify(rows, tols, kept):
    """The worst miss, in units of its tolerance, of the curve through `kept` rows against the dense table."""
    worst, j = 0.0, 0
    for r, tol in zip(rows, tols):
        while j < len(kept) - 2 and kept[j + 1][0] < r[0]:
            j += 1
        p = hermite(kept[j], kept[j + 1], r[0])
        worst = max(worst, max(abs(p[n] - r[1 + n]) for n in range(3)) / tol)
    return worst


def pack(row):
    return (
        [round(row[0], 6)]
        + [round(v, 6) for v in row[1:4]]
        + [round(v, 9) for v in row[4:7]]
    )


def _merge(rows, extra):
    """The dense table with the encounter windows' finer rows replacing its own inside each window."""
    if not extra:
        return rows
    lo, hi = extra[0][0], extra[-1][0]
    return [r for r in rows if r[0] < lo or r[0] > hi] + extra


def encounter_windows(spec):
    """[(planet, probe rows, planet rows)] at 5 minutes round each flyby or orbit insertion of a planet."""
    out = []
    for date, kind, body in spec["events"]:
        if kind not in ("flyby", "orbit") or body not in ENCOUNTER_BODIES:
            continue
        jd = _jd_of(date)
        probe = dense_table(spec, jd0=jd - WINDOW_DAYS[0], jd1=jd + WINDOW_DAYS[1], step=WINDOW_STEP)
        planet = dense_table(spec, command=ENCOUNTER_BODIES[body], jd0=jd - WINDOW_DAYS[0], jd1=jd + WINDOW_DAYS[1], step=WINDOW_STEP)
        planet_at = {round(r[0], 6): r for r in planet}
        out.append((body, [r for r in probe if round(r[0], 6) in planet_at], planet_at))
    return out


def probe_table(spec):
    """The dense rows and the tolerance of each, with the encounter windows folded in."""
    rows = dense_table(spec)
    near = {}   # JD -> distance to the planet being passed (AU), inside a window
    for body, probe, planet_at in encounter_windows(spec):
        rows = _merge(rows, probe)
        for r in probe:
            p = planet_at[round(r[0], 6)]
            near[round(r[0], 6)] = math.sqrt(sum((r[1 + n] - p[1 + n]) ** 2 for n in range(3)))
    rows.sort(key=lambda r: r[0])
    tols = []
    for r in rows:
        tol = _helio_tol(r)
        d = near.get(round(r[0], 6))
        if d is not None:
            tol = min(tol, NEAR_FRACTION * d + NEAR_FLOOR_AU)
        tols.append(tol)
    return rows, tols


def _entry(spec, rows, tols, events):
    """Thin a table, verify the rounded result, and make its JSON entry."""
    keep = thin(rows, [t * THIN_MARGIN for t in tols])   # leaves room for the rounding of what is written
    packed = [pack(rows[k]) for k in keep]
    miss = verify(rows, tols, packed)
    if miss > 1.0:
        raise RuntimeError("%s: the written curve misses by %.2fx its tolerance" % (spec["name"], miss))
    print("%-14s dense %7d -> kept %5d  worst %.2f of tolerance" % (spec["name"], len(rows), len(keep), miss))
    return {
        "name": spec["name"],
        "id": spec["id"],
        "jd0": packed[0][0],
        "jd1": packed[-1][0],
        "events": events,
        "s": packed,
    }


def build_tracks(only):
    out = {
        "source": "NASA/JPL Horizons System, https://ssd.jpl.nasa.gov/horizons/ (public domain)",
        "frame": "heliocentric, ecliptic and equinox J2000, AU and AU/day; t in Julian Days TDB",
        "tolerance": "cubic Hermite, checked as written: probes within %g AU + %g of the distance from the Sun, "
        "and within %g of the distance to the planet inside a flyby window (%g AU at least); planets within %g AU"
        % (TOL_ABS_AU, TOL_REL, NEAR_FRACTION, NEAR_FLOOR_AU, TOL_PLANET_AU),
        "tracks": {},
        "planets": {},
    }
    for key, spec in list(PROBES.items()) + list(BODIES.items()):
        if only and key != only:
            continue
        rows, tols = probe_table(spec) if key in PROBES else (dense_table(spec), None)
        if tols is None:
            tols = [_helio_tol(r) for r in rows]
        events = [[_jd_of(d), kind, body] for d, kind, body in spec["events"]]
        out["tracks"][key] = _entry(spec, rows, tols, events)
    for name, cmd in PLANETS.items():
        if only and only != name.lower():
            continue
        spec = {"name": name, "id": cmd, "start": PLANET_SPAN[0], "end": PLANET_SPAN[1], "step": PLANET_SPAN[2]}
        rows = dense_table(spec)
        out["planets"][name] = _entry(spec, rows, [TOL_PLANET_AU] * len(rows), [])
    return out


def build_reference():
    ref = {
        "source": "NASA/JPL Horizons, heliocentric ecliptic J2000, AU",
        "bodies": {},
        "probes": {},
    }
    for name, cmd in REF_PLANETS.items():
        ref["bodies"][name] = [
            {"date": d, "xyz": horizons(cmd, d, d + " 00:01", "1m")[0][1:4]}
            for d in REF_DATES
        ]
    ref["moons"] = {}
    for name, (cmd, planet) in REF_MOONS.items():
        ref["moons"][name] = [{"date": d, "xyz": horizons(cmd, d, d + " 00:01", "1m", center="500@" + planet)[0][1:4]}
                              for d in REF_DATES]
    for key, dates in REF_PROBE_DATES.items():
        spec = PROBES[key]
        ref["probes"][key] = [
            {"date": d, "xyz": horizons(spec["id"], d, d + " 00:01", "1m")[0][1:4]}
            for d in dates
        ]
    ref["flybys"] = []
    for key, planet, when in REF_FLYBYS:
        stop = _cal(_jd_of(when[:10]) + (int(when[11:13]) * 60 + int(when[14:16]) + 1) / 1440)
        ref["flybys"].append({
            "probe": key, "planet": planet, "time": when.replace(" ", "T") + ":00Z",
            "probe_xyz": horizons(PROBES[key]["id"], when, stop, "1m")[0][1:4],
            "planet_xyz": horizons(ENCOUNTER_BODIES[planet], when, stop, "1m")[0][1:4],
        })
    return ref


def write_reference():
    with open(REFERENCE_PATH, "w") as f:
        json.dump(build_reference(), f, indent=1)
    print("wrote", REFERENCE_PATH)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--only", help="rebuild a single track (merged into the existing file)"
    )
    ap.add_argument("--no-reference", action="store_true")
    ap.add_argument("--reference-only", action="store_true", help="rewrite only the test reference")
    args = ap.parse_args()
    if args.reference_only:
        write_reference()
        return
    tracks = build_tracks(args.only)
    if args.only and os.path.exists(TRACKS_PATH):
        with open(TRACKS_PATH) as f:
            whole = json.load(f)
        whole["tracks"].update(tracks["tracks"])
        whole.setdefault("planets", {}).update(tracks["planets"])
        tracks = whole
    with open(TRACKS_PATH, "w") as f:
        json.dump(tracks, f, separators=(",", ":"))
    print("wrote %s (%d bytes)" % (TRACKS_PATH, os.path.getsize(TRACKS_PATH)))
    if not args.no_reference:
        write_reference()


if __name__ == "__main__":
    sys.exit(main())
