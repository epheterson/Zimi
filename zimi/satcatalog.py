"""Every active satellite, for the Almanac's Earth view and its live sky.

satellites.py serves the few the view names (GPS and the ISS). This module
serves the rest, about 10,000 of them, from CelesTrak's GP data (the "active"
group) joined with its SATCAT (owner, launch date, radar size). It follows the
same three sources and the same setting, "Satellite data from the internet",
so one choice governs every fetch the view makes:

    snapshot   zimi/assets/satellites-all-snapshot.json.gz, cut with the
               release (``python3 scripts/build_satellite_snapshot.py --all``)
    cache      the last live fetch, in the data directory (and in memory)
    live       CelesTrak, when the cache is older than CACHE_TTL_S and the
               setting allows it (Automatically: in the background; Ask first:
               an admin's Get fresh data; Never and ZIMI_OFFLINE: not at all)

The payload is columns, not objects, to stay near 600 KB compressed::

    {"fetched", "fetched_at", "cols": COLUMNS, "sats": [[...], ...]}

Elements are rounded to what SGP4 can tell apart (an epoch to 0.09 s, angles
to 0.0001 degrees); the drag terms the propagator does not read are left out.
SATCAT is far bigger and changes slowly, so the owner and launch of a satellite
already known are carried over from the last payload; SATCAT is read again
only for new satellites, and no more often than SATCAT_TTL_S.
"""

import csv
import datetime
import gzip
import io
import json
import logging
import math
import os
import re
import threading
import time
import urllib.request

from zimi import satellites as _sat
from zimi import server as _srv

log = logging.getLogger("zimi")

GP_ACTIVE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json"
SATCAT_URL = "https://celestrak.org/pub/satcat.csv"
SNAPSHOT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "assets",
    "satellites-all-snapshot.json.gz",
)
CACHE_FILENAME = "satellites_all_cache.json"
CACHE_TTL_S = _sat.CACHE_TTL_S
SATCAT_TTL_S = 7 * 24 * 3600
FAIL_COOLDOWN_S = _sat.FAIL_COOLDOWN_S
FETCH_TIMEOUT_S = 60
MAX_GP_BYTES = 40 * 1024 * 1024
MAX_SATCAT_BYTES = 60 * 1024 * 1024
MAX_SATS = 30000

COLUMNS = (
    "norad",
    "name",
    "epoch",
    "mm",
    "ecc",
    "inc",
    "raan",
    "argp",
    "ma",
    "bstar",
    "owner",
    "launch",
    "rcs",
)
# Epoch: days since 2000-01-01T00:00Z. Launch: days since LAUNCH_ORIGIN (the
# year before Sputnik, so every launch is a positive number).
EPOCH_ORIGIN = datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc)
LAUNCH_ORIGIN = datetime.date(1957, 1, 1)
EPOCH_DECIMALS = 6
_ROUND = {"mm": 8, "ecc": 7, "inc": 4, "raan": 4, "argp": 4, "ma": 4}
_SOURCE_FIELDS = {
    "mm": "MEAN_MOTION",
    "ecc": "ECCENTRICITY",
    "inc": "INCLINATION",
    "raan": "RA_OF_ASC_NODE",
    "argp": "ARG_OF_PERICENTER",
    "ma": "MEAN_ANOMALY",
}
_RANGES = _sat._RANGES
BSTAR_DIGITS = 5
_EPOCH_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z?$")

_lock = threading.Lock()
_refreshing = False
_last_fail = 0.0
_memory = None
_snapshot_cache = (None, None)  # (mtime, payload)


def _cache_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, CACHE_FILENAME)


def _epoch_days(text):
    m = _EPOCH_RE.match(str(text or ""))
    if not m:
        return None
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    frac = float(m.group(7) or 0)
    when = datetime.datetime(y, mo, d, h, mi, s, tzinfo=datetime.timezone.utc)
    return round(
        (when - EPOCH_ORIGIN).total_seconds() / 86400 + frac / 86400, EPOCH_DECIMALS
    )


def _sig(value, digits):
    """``value`` to a number of significant digits (BSTAR spans many decades)."""
    if value == 0 or not math.isfinite(value):
        return 0
    return float("%.*e" % (digits - 1, value))


def compact_record(rec):
    """One GP/OMM record as a row of COLUMNS (owner, launch and radar size
    left for ``join_satcat``), or None when it is not a usable Earth orbit."""
    if not isinstance(rec, dict):
        return None
    try:
        norad = int(rec.get("NORAD_CAT_ID"))
        name = str(rec.get("OBJECT_NAME") or "").strip()
        epoch = _epoch_days(rec.get("EPOCH"))
        if norad <= 0 or not name or len(name) > 64 or epoch is None:
            return None
        row = [norad, name, epoch]
        for key in ("mm", "ecc", "inc", "raan", "argp", "ma"):
            val = float(rec[_SOURCE_FIELDS[key]])
            lo_hi = _RANGES[_SOURCE_FIELDS[key]]
            if not math.isfinite(val) or not (lo_hi[0] <= val <= lo_hi[1]):
                return None
            row.append(round(val, _ROUND[key]))
        row.append(_sig(float(rec.get("BSTAR", 0) or 0), BSTAR_DIGITS))
    except (TypeError, ValueError, KeyError):
        return None
    return row + ["", None, None]


def parse_gp(records):
    """Rows from CelesTrak's GP list; raises ValueError when it is not one."""
    if not isinstance(records, list):
        raise ValueError("expected a list")
    seen, rows = set(), []
    for rec in records[:MAX_SATS]:
        row = compact_record(rec)
        if row and row[0] not in seen:
            seen.add(row[0])
            rows.append(row)
    if len(rows) < 100:
        raise ValueError("too few usable elements")
    rows.sort(key=lambda r: r[0])
    return rows


def parse_satcat(text, wanted):
    """``{norad: (owner, launch, rcs)}`` for the numbers in ``wanted``, from
    SATCAT's CSV."""
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            norad = int(row["NORAD_CAT_ID"])
        except (KeyError, TypeError, ValueError):
            continue
        if norad not in wanted:
            continue
        launch = None
        try:
            launch = (
                datetime.date.fromisoformat(row.get("LAUNCH_DATE") or "")
                - LAUNCH_ORIGIN
            ).days
        except ValueError:
            pass
        try:
            rcs = round(float(row.get("RCS") or ""), 1)
        except ValueError:
            rcs = None
        out[norad] = ((row.get("OWNER") or "").strip()[:6], launch, rcs)
    return out


def join_satcat(rows, meta):
    for row in rows:
        m = meta.get(row[0])
        if m:
            row[-3:] = list(m)


def _open(url, limit):
    req = urllib.request.Request(url, headers={"User-Agent": _sat._user_agent()})
    with urllib.request.urlopen(
        req, timeout=FETCH_TIMEOUT_S, context=_srv.SSL_CTX
    ) as resp:
        body = resp.read(limit + 1)
    if len(body) > limit:
        raise ValueError("response too large")
    return body


def build_payload(rows, fetched_at, satcat_at):
    return {
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(fetched_at)),
        "fetched_at": fetched_at,
        "satcat_at": satcat_at,
        "cols": list(COLUMNS),
        "sats": rows,
    }


def fetch_live(previous=None):
    """The whole payload from CelesTrak. Raises on failure. SATCAT is read
    again only when the last one is old and some satellite is new to it."""
    rows = parse_gp(json.loads(_open(GP_ACTIVE_URL, MAX_GP_BYTES).decode("utf-8")))
    now = time.time()
    known = {r[0]: r[-3:] for r in (previous or {}).get("sats", [])}
    satcat_at = float((previous or {}).get("satcat_at") or 0)
    fresh = [r[0] for r in rows if r[0] not in known]
    meta = dict(known)
    if fresh and (not previous or now - satcat_at > SATCAT_TTL_S):
        try:
            text = _open(SATCAT_URL, MAX_SATCAT_BYTES).decode("utf-8", "replace")
            meta.update(parse_satcat(text, {r[0] for r in rows}))
            satcat_at = now
        except Exception as e:
            log.info("SATCAT not read: %s", e)
            if not previous:
                raise
    join_satcat(rows, meta)
    return build_payload(rows, now, satcat_at)


def _valid(payload):
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("sats"), list)
        and payload["sats"]
        and payload.get("cols") == list(COLUMNS)
    )


def _read_json(path, gz=False):
    try:
        with (gzip.open if gz else open)(path, "rt", encoding="utf-8") as f:
            payload = json.load(f)
        if not _valid(payload):
            return None
        payload["fetched_at"] = float(payload.get("fetched_at") or 0)
    except (OSError, ValueError, TypeError, EOFError):
        return None
    return payload


def read_cache():
    return _read_json(_cache_path())


def read_snapshot():
    """The shipped payload, parsed once per file version."""
    global _snapshot_cache
    try:
        mtime = os.path.getmtime(SNAPSHOT_PATH)
    except OSError:
        return None
    if _snapshot_cache[0] != mtime:
        _snapshot_cache = (mtime, _read_json(SNAPSHOT_PATH, gz=True))
    return _snapshot_cache[1]


def write_snapshot(path, payload):
    """Gzipped with no timestamp, one row per line: an unchanged catalogue
    rebuilds byte for byte."""
    lines = [
        '{"fetched":%s,"fetched_at":%s,"satcat_at":%s,"cols":%s,"sats":['
        % (
            json.dumps(payload["fetched"]),
            json.dumps(payload["fetched_at"]),
            json.dumps(payload.get("satcat_at", 0)),
            json.dumps(payload["cols"]),
        )
    ]
    lines.append(
        ",\n".join(
            json.dumps(r, separators=(",", ":"), ensure_ascii=False)
            for r in payload["sats"]
        )
    )
    lines.append("]}\n")
    raw = "\n".join(lines).encode("utf-8")
    with (
        open(path, "wb") as f,
        gzip.GzipFile(filename="", fileobj=f, mode="wb", mtime=0, compresslevel=9) as z,
    ):
        z.write(raw)


def refresh():
    """Fetch live and replace the cache. The payload, or None when the fetch
    failed or another refresh is running (the cache stays)."""
    global _refreshing, _last_fail, _memory
    with _lock:
        if _refreshing:
            return None
        _refreshing = True
    try:
        payload = fetch_live(_newest(read_cache(), _memory, read_snapshot()))
    except Exception as e:
        _last_fail = time.time()
        log.info("Satellite catalogue not refreshed: %s", e)
        return None
    finally:
        with _lock:
            _refreshing = False
    _memory = payload
    _srv._atomic_write_json(_cache_path(), payload)
    log.info("Satellite catalogue refreshed: %d satellites", len(payload["sats"]))
    return payload


def _kick_refresh():
    if _sat._offline() or time.time() - _last_fail < FAIL_COOLDOWN_S:
        return False
    with _lock:
        if _refreshing:
            return True
    threading.Thread(target=refresh, name="satellite-catalogue", daemon=True).start()
    return True


def _newest(*payloads):
    have = [p for p in payloads if p]
    return max(have, key=lambda p: p["fetched_at"]) if have else None


def get(allow_refresh=True):
    """The newest catalogue here, at once, with the state the view reads:
    ``source, fetched, cols, sats, stale, refreshing, mode, locked``. The
    refresh rules are satellites.get's."""
    mode, locked = _sat.update_mode()
    live, snap = _newest(read_cache(), _memory), read_snapshot()
    best, source = None, "none"
    if live and (not snap or live["fetched_at"] >= snap["fetched_at"]):
        best, source = live, "cache"
    elif snap:
        best, source = snap, "snapshot"
    age = time.time() - best["fetched_at"] if best else float("inf")
    stale = age > CACHE_TTL_S
    refreshing = bool(
        allow_refresh and mode == _sat.UPDATE_AUTO and stale and _kick_refresh()
    )
    return {
        "source": source,
        "fetched": best.get("fetched") if best else None,
        "cols": list(COLUMNS),
        "sats": best["sats"] if best else [],
        "stale": stale,
        "refreshing": refreshing,
        "mode": mode,
        "locked": locked,
    }


def refresh_now():
    """An admin's Get fresh data for the catalogue: ``(payload, error)`` with
    satellites.refresh_now's meaning of "never" and "failed"."""
    if _sat.update_mode()[0] == _sat.UPDATE_NEVER:
        return None, "never"
    current = get(allow_refresh=False)
    if not current["stale"]:
        return current, None
    fetched = refresh()
    after = get(allow_refresh=False)
    if fetched is not None or not after["stale"]:
        return after, None
    with _lock:
        running = _refreshing
    if running:
        after["refreshing"] = True
        return after, None
    return after, "failed"


def _reset_for_tests():
    global _refreshing, _last_fail, _memory, _snapshot_cache
    _refreshing = False
    _last_fail = 0.0
    _memory = None
    _snapshot_cache = (None, None)
