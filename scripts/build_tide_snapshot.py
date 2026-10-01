#!/usr/bin/env python3
"""Build the tide stations that ship inside Zimi, once, from NOAA CO-OPS.

    python3 scripts/build_tide_snapshot.py

Writes one committed file:

    zimi/assets/tides-snapshot.json.gz

Every NOAA tide prediction station (the United States and its territories):

    harmonic stations     37 harmonic constituents (amplitude, Greenwich
                          phase), the station's mean sea level above mean lower
                          low water, and its mean higher high water, so the
                          Almanac (static/almanac-tides.js) predicts the tide
                          for any date by harmonic synthesis, with no network
    subordinate stations  NOAA's time and height offsets from a harmonic
                          reference station, applied to the reference's highs
                          and lows exactly as NOAA does

Harmonic constants change only when NOAA re-analyses a station (years apart)
and the tidal datums only with a new National Tidal Datum Epoch, so this is
run rarely, not every release. NOAA data is in the public domain (see
THIRD_PARTY_NOTICES.md).

About 4,800 small requests to the CO-OPS metadata API, four at a time.
"""

import concurrent.futures as futures
import datetime
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "assets", "tides-snapshot.json.gz")
MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi"
UA = "Zimi tide snapshot builder (+https://github.com/epheterson/Zimi)"
WORKERS = 4
TIMEOUT = 60
RETRIES = 6

# The 37 constituents NOAA publishes for every harmonic station, in NOAA's own
# order. The snapshot stores amplitudes and phases in this order, so the
# browser never needs the names twice.
CONSTITUENTS = [
    "M2",
    "S2",
    "N2",
    "K1",
    "M4",
    "O1",
    "M6",
    "MK3",
    "S4",
    "MN4",
    "NU2",
    "S6",
    "MU2",
    "2N2",
    "OO1",
    "LAM2",
    "S1",
    "M1",
    "J1",
    "MM",
    "SSA",
    "SA",
    "MSF",
    "MF",
    "RHO",
    "Q1",
    "T2",
    "R2",
    "2Q1",
    "P1",
    "2SM2",
    "M3",
    "L2",
    "2MK3",
    "K2",
    "M8",
    "MS4",
]


CACHE = os.environ.get("TIDE_BUILD_CACHE")  # a directory: reruns skip the network


def fetch_json(url):
    if CACHE:
        os.makedirs(CACHE, exist_ok=True)
        path = os.path.join(CACHE, re.sub(r"[^\w.-]", "_", url.split("/webapi/")[-1]))
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        data = _fetch_json(url)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return data
    return _fetch_json(url)


def _fetch_json(url):
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last = e
            time.sleep(5 * (attempt + 1))  # CO-OPS answers bursts with 403s
    raise RuntimeError(f"{url}: {last}")


def harmonic(st):
    """One harmonic station: constituents (mm, 0.1 deg) and datums (mm)."""
    sid = st["id"]
    hc = fetch_json(f"{MDAPI}/stations/{sid}/harcon.json?units=metric")
    dt = fetch_json(f"{MDAPI}/stations/{sid}/datums.json?units=metric")
    by_name = {c["name"].upper(): c for c in hc.get("HarmonicConstituents") or []}
    if not by_name:
        return None
    amps, phases = [], []
    for name in CONSTITUENTS:
        c = by_name.get(name)
        amps.append(round((c["amplitude"] if c else 0) * 1000))
        phases.append(round((c["phase_GMT"] if c else 0) * 10) % 3600)
    if not any(amps):
        return None
    # Where NOAA analysed more than the standard 37 (Cook Inlet, where shallow
    # water makes overtides matter), its predictions use them too, so they
    # ship as {name: [mm, 0.1 deg, speed]}; the browser rebuilds each from its
    # name (almanac-tides.js compoundOf).
    extra = {
        name: [round(c["amplitude"] * 1000), round(c["phase_GMT"] * 10) % 3600, c["speed"]]
        for name, c in by_name.items()
        if name not in CONSTITUENTS and c.get("amplitude")
    }
    datums = {
        d["name"]: d["value"]
        for d in dt.get("datums") or []
        if d.get("value") is not None
    }
    if "MSL" not in datums or "MLLW" not in datums:
        return None
    z0 = round((datums["MSL"] - datums["MLLW"]) * 1000)
    mhhw = round((datums.get("MHHW", datums["MSL"]) - datums["MLLW"]) * 1000)
    rec = {"z0": z0, "mhhw": mhhw, "a": amps, "g": phases}
    if extra:
        rec["x"] = extra
    return rec


def subordinate(st):
    off = fetch_json(f"{MDAPI}/stations/{st['id']}/tidepredoffsets.json")
    ref = off.get("refStationId")
    keys = (
        "heightOffsetHighTide",
        "heightOffsetLowTide",
        "timeOffsetHighTide",
        "timeOffsetLowTide",
    )
    if not ref or any(off.get(k) is None for k in keys):
        return None
    ratio = off.get("heightAdjustedType") == "R"
    return {
        "ref": ref,
        # Height offsets: a ratio, or feet to add (NOAA publishes additive
        # offsets in feet even through the metric API); kept as published.
        "hh": off["heightOffsetHighTide"],
        "hl": off["heightOffsetLowTide"],
        "th": off["timeOffsetHighTide"],
        "tl": off["timeOffsetLowTide"],
        "r": 1 if ratio else 0,
    }


def main():
    listing = fetch_json(f"{MDAPI}/stations.json?type=tidepredictions")["stations"]
    print(f"{len(listing)} prediction stations")
    out, dropped = [], []

    def one(st):
        try:
            data = harmonic(st) if st.get("type") == "R" else subordinate(st)
        except RuntimeError as e:
            return st, None, str(e)
        return st, data, None

    with futures.ThreadPoolExecutor(WORKERS) as pool:
        for i, (st, data, err) in enumerate(pool.map(one, listing)):
            if data is None:
                dropped.append((st["id"], st.get("name"), err or "no usable data"))
                continue
            rec = {
                "id": st["id"],
                "n": (st.get("name") or "").strip(),
                "s": (st.get("state") or "").strip(),
                "la": round(float(st["lat"]), 4),
                "lo": round(float(st["lng"]), 4),
            }
            rec.update(data)
            out.append(rec)
            if (i + 1) % 250 == 0:
                print(f"  {i + 1}/{len(listing)}", flush=True)

    harm = {r["id"] for r in out if "a" in r}
    # A subordinate whose reference was dropped cannot be predicted.
    orphans = [r for r in out if "ref" in r and r["ref"] not in harm]
    for r in orphans:
        dropped.append((r["id"], r["n"], f"reference {r['ref']} missing"))
    out = [r for r in out if "a" in r or r["ref"] in harm]
    out.sort(key=lambda r: r["id"])

    payload = {
        "source": "NOAA CO-OPS metadata API (harcon, datums, tidepredoffsets)",
        "licence": "Public domain (U.S. Government work)",
        "fetched": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        "datum": "MLLW",
        "constituents": CONSTITUENTS,
        "stations": out,
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    # mtime=0: the same data builds the same bytes, so a rebuild is no diff.
    with open(OUT, "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0) as gz:
            gz.write(raw)
    print(
        f"{OUT}: {len(harm)} harmonic + {len(out) - len(harm)} subordinate stations, "
        f"{len(raw) // 1024} KB raw, {os.path.getsize(OUT) // 1024} KB gzipped"
    )
    if dropped:
        print(f"dropped {len(dropped)}:")
        for d in dropped[:40]:
            print("  ", *d)
    return 0


if __name__ == "__main__":
    sys.exit(main())
