"""Orbital elements for the Almanac's Earth view: the GPS constellation and the ISS.

The view (static/almanac-earth.js) propagates these with SGP4 in the browser;
this module only decides which element set it gets. Three sources, and the
newest wins:

    snapshot   zimi/assets/satellites-snapshot.json, fetched when the release
               was cut (``python3 scripts/build_satellite_snapshot.py``)
    cache      the last live fetch, in the data directory
    live       CelesTrak's GP data, fetched in the background when the cache is
               older than CACHE_TTL_S and the machine may reach out

A request is answered at once from what is here; a stale answer starts one
background refresh (single flight, with a cooldown after a failure), the same
stale-while-revalidate rule the Kiwix catalog follows. ZIMI_OFFLINE turns the
refresh off. The upstream request carries Zimi's user agent and nothing about
whoever opened the view.

Records are CelesTrak's OMM JSON (the CCSDS Orbit Mean-Elements Message
fields), checked field by field before they are kept: a bad or partial answer
leaves the cache as it was.
"""

import json
import logging
import math
import os
import re
import threading
import time
import urllib.parse
import urllib.request

from zimi import server as _srv

log = logging.getLogger("zimi")

CELESTRAK_GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
# The operational GPS constellation, and the ISS by its catalogue number.
GPS_QUERY = {"GROUP": "gps-ops", "FORMAT": "json"}
ISS_NORAD_ID = 25544
ISS_QUERY = {"CATNR": str(ISS_NORAD_ID), "FORMAT": "json"}
SNAPSHOT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "assets", "satellites-snapshot.json"
)
CACHE_FILENAME = "satellites_cache.json"
# CelesTrak publishes new elements a few times a day and asks clients not to
# fetch the same data more often than it changes. Six hours keeps the ISS's
# place along its orbit within a few km and costs CelesTrak four requests a
# day per Zimi that has the view open.
CACHE_TTL_S = 6 * 3600
FAIL_COOLDOWN_S = 3600
FETCH_TIMEOUT_S = 20
MAX_RESPONSE_BYTES = 512 * 1024
MAX_GPS = 64

# The OMM fields satellite.js's json2satrec reads, plus the name and the
# international designator the view shows.
OMM_NUMBER_FIELDS = (
    "MEAN_MOTION",
    "ECCENTRICITY",
    "INCLINATION",
    "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER",
    "MEAN_ANOMALY",
    "BSTAR",
    "MEAN_MOTION_DOT",
    "MEAN_MOTION_DDOT",
)
# Plausible ranges: an Earth orbit, not a typo. Mean motion in revolutions a
# day (a GPS satellite makes two, the ISS about 15.5).
_RANGES = {
    "MEAN_MOTION": (0.5, 17.0),
    "ECCENTRICITY": (0.0, 0.99),
    "INCLINATION": (0.0, 180.0),
    "RA_OF_ASC_NODE": (0.0, 360.0),
    "ARG_OF_PERICENTER": (0.0, 360.0),
    "MEAN_ANOMALY": (0.0, 360.0),
}
_EPOCH_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z?$")

_lock = threading.Lock()
_refreshing = False
_last_fail = 0.0


def _cache_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, CACHE_FILENAME)


def _user_agent():
    from zimi.library import USER_AGENT

    return USER_AGENT


def _offline():
    from zimi import p2p

    return bool(p2p.is_offline())


def normalize_record(rec):
    """One OMM record, checked and trimmed, or None. The epoch is written to
    the millisecond with a Z, the one form every browser's Date parses (six
    fractional digits are not)."""
    if not isinstance(rec, dict):
        return None
    out = {}
    try:
        name = str(rec.get("OBJECT_NAME") or "").strip()
        if not name or len(name) > 64:
            return None
        norad = int(rec.get("NORAD_CAT_ID"))
        if norad <= 0:
            return None
        m = _EPOCH_RE.match(str(rec.get("EPOCH") or ""))
        if not m:
            return None
        frac = (m.group(2) or ".0")[1:]
        millis = (frac + "000")[:3]
        out["OBJECT_NAME"] = name
        out["OBJECT_ID"] = str(rec.get("OBJECT_ID") or "")[:16]
        out["NORAD_CAT_ID"] = norad
        out["EPOCH"] = f"{m.group(1)}.{millis}Z"
        for key in OMM_NUMBER_FIELDS:
            val = float(rec.get(key, 0) or 0)
            if not math.isfinite(val):
                return None
            lo_hi = _RANGES.get(key)
            if lo_hi and not (lo_hi[0] <= val <= lo_hi[1]):
                return None
            out[key] = val
    except (TypeError, ValueError):
        return None
    return out


def parse_payload(gps_list, iss_list, fetched_at):
    """The payload the view reads, from CelesTrak's two answers. Raises
    ValueError when the answers do not hold what they should."""
    if not isinstance(gps_list, list) or not isinstance(iss_list, list):
        raise ValueError("expected lists")
    gps = [r for r in (normalize_record(x) for x in gps_list[:MAX_GPS]) if r]
    iss = [
        r
        for r in (normalize_record(x) for x in iss_list)
        if r and r["NORAD_CAT_ID"] == ISS_NORAD_ID
    ]
    if not gps or not iss:
        raise ValueError("no usable elements")
    return {
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(fetched_at)),
        "fetched_at": fetched_at,
        "gps": gps,
        "iss": iss[0],
    }


def _get_json(query):
    url = CELESTRAK_GP_URL + "?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
        body = resp.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValueError("response too large")
    return json.loads(body.decode("utf-8"))


def fetch_live():
    """Both element sets from CelesTrak, as one payload. Raises on failure."""
    return parse_payload(_get_json(GPS_QUERY), _get_json(ISS_QUERY), time.time())


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, ValueError):
        return None
    if (
        not isinstance(payload, dict)
        or not payload.get("gps")
        or not payload.get("iss")
    ):
        return None
    try:
        payload["fetched_at"] = float(payload.get("fetched_at") or 0)
    except (TypeError, ValueError):
        return None
    return payload


def read_cache():
    return _read_json(_cache_path())


def read_snapshot():
    return _read_json(SNAPSHOT_PATH)


def write_snapshot(path, payload):
    """Stable bytes (sorted keys, one record per line) so an unchanged
    element set rebuilds byte for byte and a changed one diffs readably."""
    lines = ["{"]
    lines.append(f'  "fetched": {json.dumps(payload["fetched"])},')
    lines.append(f'  "fetched_at": {json.dumps(payload["fetched_at"])},')
    lines.append(f'  "iss": {json.dumps(payload["iss"], sort_keys=True)},')
    lines.append('  "gps": [')
    rows = [f"    {json.dumps(r, sort_keys=True)}" for r in payload["gps"]]
    lines.append(",\n".join(rows))
    lines.append("  ]")
    lines.append("}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def refresh():
    """Fetch live and replace the cache. Returns the payload, or None when
    the fetch failed or another refresh is running (the cache stays)."""
    global _refreshing, _last_fail
    with _lock:
        if _refreshing:
            return None
        _refreshing = True
    try:
        payload = fetch_live()
        _srv._atomic_write_json(_cache_path(), payload)
        log.info("Satellite elements refreshed: %d GPS + ISS", len(payload["gps"]))
        return payload
    except Exception as e:
        _last_fail = time.time()
        log.info("Satellite elements not refreshed: %s", e)
        return None
    finally:
        with _lock:
            _refreshing = False


def _kick_refresh():
    if _offline() or time.time() - _last_fail < FAIL_COOLDOWN_S:
        return
    with _lock:
        if _refreshing:
            return
    threading.Thread(target=refresh, name="satellite-elements", daemon=True).start()


def get(allow_refresh=True):
    """The newest element set here, at once: ``{source, fetched, gps, iss}``.
    A stale one starts a background refresh when allowed."""
    cache, snap = read_cache(), read_snapshot()
    best, source = None, "none"
    if cache and (not snap or cache["fetched_at"] >= snap["fetched_at"]):
        best, source = cache, "cache"
    elif snap:
        best, source = snap, "snapshot"
    age = time.time() - best["fetched_at"] if best else float("inf")
    if allow_refresh and age > CACHE_TTL_S:
        _kick_refresh()
    if not best:
        return {"source": "none", "fetched": None, "gps": [], "iss": None}
    return {
        "source": source,
        "fetched": best.get("fetched"),
        "gps": best["gps"],
        "iss": best["iss"],
    }


def _reset_for_tests():
    global _refreshing, _last_fail
    _refreshing = False
    _last_fail = 0.0
