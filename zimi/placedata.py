"""Tide stations near a place, for the Almanac.

One dataset ships under ``zimi/assets/``, from NOAA and in the public domain,
built once by a script and never fetched at runtime:

    tides-snapshot.json.gz   every NOAA tide prediction station: harmonic
                             constants, or offsets from a reference station
                             (scripts/build_tide_snapshot.py)

Harmonic constants describe the Moon, the Sun and a harbour's shape, and hold
for decades. The Almanac ships nothing that goes stale within one (climate
normals such as frost dates do, and were dropped for it).

The browser (static/almanac-tides.js) does the predicting; this module only
chooses which stations it gets, so a phone downloads a few kilobytes for its
place instead of the whole set. ``GET /almanac-place?lat=..&lon=..`` answers
the nearest stations; ``?q=..`` finds them by name.

The file is optional: a checkout before the build script has run answers with
an empty list, and the Almanac says it has no station.
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

EARTH_RADIUS_KM = 6371.0
NEAR_TIDES = 6
SEARCH_LIMIT = 8
MAX_QUERY = 80

_lock = threading.Lock()
_tides = None  # {"meta": {...}, "stations": [...], "by_id": {...}}


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
    global _tides
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
    return _tides


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


def _nearest(items, lat, lon, key, n):
    # A flat scan: 3,500 stations, well under a millisecond with the cheap
    # equirectangular pre-sort; the haversine is for the few.
    coslat = math.cos(math.radians(lat))

    def rough(st):
        la, lo = key(st)
        dlo = (lo - lon + 180) % 360 - 180
        return (la - lat) ** 2 + (dlo * coslat) ** 2

    return sorted(items, key=rough)[:n]


def _meta(tides):
    return {
        "tides": {
            k: tides["meta"].get(k)
            for k in ("constituents", "fetched", "source", "datum")
        }
    }


def near(lat, lon):
    """The nearest tide stations to a place."""
    tides = _load()
    out = _meta(tides)
    out["tides"]["stations"] = [
        _tide_out(tides, s, lat, lon)
        for s in _nearest(
            tides["stations"], lat, lon, lambda s: (s["la"], s["lo"]), NEAR_TIDES
        )
    ]
    return out


def search(q, lat=None, lon=None):
    """Stations whose name holds every word typed, best first: names that
    start with the query, then the nearest (when a place is known)."""
    tides = _load()
    words = _fold(q)[:MAX_QUERY].split()
    out = _meta(tides)
    if not words:
        out["tides"]["stations"] = []
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
    return out


def parse_coord(v, lo, hi):
    """A finite number within [lo, hi], or None."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) and lo <= x <= hi else None
