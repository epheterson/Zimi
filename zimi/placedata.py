"""Tide stations and frost dates near a place, for the Almanac.

Two datasets ship under ``zimi/assets/``, both from NOAA and in the public
domain, both built once by a script and never fetched at runtime:

    tides-snapshot.json.gz   every NOAA tide prediction station: harmonic
                             constants, or offsets from a reference station
                             (scripts/build_tide_snapshot.py)
    frost-normals.json.gz    1991-2020 climate normals: freeze dates and the
                             growing season, per station
                             (scripts/build_frost_snapshot.py)

The browser (static/almanac-tides.js) does the predicting; this module only
chooses which stations it gets, so a phone downloads a few kilobytes for its
place instead of the whole set. ``GET /almanac-place?lat=..&lon=..`` answers
the nearest stations; ``?q=..`` finds them by name.

Both files are optional: a checkout before the build scripts have run answers
with empty lists, and the Almanac says it has no stations.
"""

import gzip
import json
import logging
import math
import os
import threading
import unicodedata

log = logging.getLogger("zimi")

_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
TIDES_PATH = os.path.join(_ASSETS, "tides-snapshot.json.gz")
FROST_PATH = os.path.join(_ASSETS, "frost-normals.json.gz")

EARTH_RADIUS_KM = 6371.0
NEAR_TIDES = 6
NEAR_FROST = 3
SEARCH_LIMIT = 8
MAX_QUERY = 80

_lock = threading.Lock()
_tides = None  # {"meta": {...}, "stations": [...], "by_id": {...}}
_frost = None  # {"meta": {...}, "stations": [dict, ...]}


def _fold(s):
    """Lower case without accents, for matching names as people type them."""
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def _read(path):
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        log.debug("no %s: %s", os.path.basename(path), e)
        return None


def _load():
    global _tides, _frost
    with _lock:
        if _tides is None:
            raw = _read(TIDES_PATH) or {}
            stations = raw.pop("stations", [])
            for st in stations:
                st["_k"] = _fold(st.get("n", "") + " " + st.get("s", ""))
            _tides = {
                "meta": raw,
                "stations": stations,
                "by_id": {s["id"]: s for s in stations},
            }
        if _frost is None:
            raw = _read(FROST_PATH) or {}
            cols = raw.get("columns") or []
            rows = [dict(zip(cols, r)) for r in raw.pop("stations", [])]
            for st in rows:
                st["_k"] = _fold(st.get("name", ""))
            _frost = {"meta": raw, "stations": rows}
    return _tides, _frost


def _km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def _public(st, extra=None):
    out = {k: v for k, v in st.items() if not k.startswith("_")}
    if extra:
        out.update(extra)
    return out


def _tide_out(tides, st, lat=None, lon=None):
    extra = {}
    if lat is not None:
        extra["km"] = round(_km(lat, lon, st["la"], st["lo"]), 1)
    if "ref" in st:
        ref = tides["by_id"].get(st["ref"])
        if ref:
            extra["refrec"] = _public(ref)
    return _public(st, extra)


def _frost_out(st, lat=None, lon=None):
    extra = (
        {"km": round(_km(lat, lon, st["lat"], st["lon"]), 1)}
        if lat is not None
        else None
    )
    return _public(st, extra)


def _nearest(items, lat, lon, key, n):
    # A flat scan: 3,500 and 7,300 stations, well under a millisecond each
    # with the cheap equirectangular pre-sort; the haversine is for the few.
    coslat = math.cos(math.radians(lat))

    def rough(st):
        la, lo = key(st)
        dlo = (lo - lon + 180) % 360 - 180
        return (la - lat) ** 2 + (dlo * coslat) ** 2

    return sorted(items, key=rough)[:n]


def _meta(tides, frost):
    return {
        "tides": {
            k: tides["meta"].get(k)
            for k in ("constituents", "fetched", "source", "datum")
        },
        "frost": {k: frost["meta"].get(k) for k in ("normals", "fetched", "source")},
    }


def near(lat, lon):
    """The nearest tide stations and frost stations to a place."""
    tides, frost = _load()
    out = _meta(tides, frost)
    out["tides"]["stations"] = [
        _tide_out(tides, s, lat, lon)
        for s in _nearest(
            tides["stations"], lat, lon, lambda s: (s["la"], s["lo"]), NEAR_TIDES
        )
    ]
    out["frost"]["stations"] = [
        _frost_out(s, lat, lon)
        for s in _nearest(
            frost["stations"], lat, lon, lambda s: (s["lat"], s["lon"]), NEAR_FROST
        )
    ]
    return out


def search(q, lat=None, lon=None):
    """Stations whose name holds every word typed, best first: names that
    start with the query, then the nearest (when a place is known)."""
    tides, frost = _load()
    words = _fold(q)[:MAX_QUERY].split()
    out = _meta(tides, frost)
    if not words:
        out["tides"]["stations"], out["frost"]["stations"] = [], []
        return out

    def hits(items, coords):
        found = [s for s in items if all(w in s["_k"] for w in words)]

        def rank(s):
            starts = 0 if s["_k"].startswith(words[0]) else 1
            if lat is None:
                return (starts, s["_k"])
            la, lo = coords(s)
            return (starts, _km(lat, lon, la, lo))

        return sorted(found, key=rank)[:SEARCH_LIMIT]

    out["tides"]["stations"] = [
        _tide_out(tides, s, lat, lon)
        for s in hits(tides["stations"], lambda s: (s["la"], s["lo"]))
    ]
    out["frost"]["stations"] = [
        _frost_out(s, lat, lon)
        for s in hits(frost["stations"], lambda s: (s["lat"], s["lon"]))
    ]
    return out


def parse_coord(v, lo, hi):
    """A finite number within [lo, hi], or None."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) and lo <= x <= hi else None
