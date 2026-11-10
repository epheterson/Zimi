"""Every orbital launch ever tried, for the Almanac's Launches list and its reconstructed sky.

Source: Jonathan McDowell's GCAT, the General Catalog of Artificial Space
Objects (https://planet4589.org/space/gcat/, CC-BY 4.0): when (UTC), from which
pad, on what, carrying what, how it went, and the orbit it aimed for; and, from
its satellite catalogue, when the first payload separated and the orbit it was
in a day or so after. Three sources, the newest wins (the rule satcatalog.py
follows):

    snapshot   zimi/assets/launches-snapshot.json.gz, built when the release was
               cut (``python3 scripts/build_launches.py``)
    cache      the last live fetch, in the data directory
    live       GCAT's tab-separated files, fetched when the cache is older than
               CACHE_TTL_S and "Satellite data from the internet" allows it

The setting is satellites.py's (Ask first / Automatically / Never, ZIMI_OFFLINE
forces Never): a request is answered at once from what is here and never
waits on the network.

A launch row is ``COLUMNS`` in order. Times are whole minutes since 1970 (UTC).
``pad`` indexes ``pads`` (site code, pad, site name, latitude, longitude,
country); ``veh`` indexes ``veh``. ``ok`` is 1 for a launch that reached orbit.
The last four columns describe the deployment of a batch (four payloads or more):
the first payload's separation in minutes after liftoff, and the orbit GCAT
recorded ``odays`` days after liftoff (perigee and apogee, km). ``tag`` is the launch's
designator ("2021-038"), which Space-Track names its objects by.
"""

import calendar
import datetime
import gzip
import json
import logging
import os
import re
import threading
import time
import urllib.request

from zimi import satellites as _sat
from zimi import server as _srv

log = logging.getLogger("zimi")

GCAT_BASE = "https://planet4589.org/space/gcat/tsv/"
SOURCE_FILES = {
    "launch": "launch/launch.tsv",
    "sites": "tables/sites.tsv",
    "pads": "tables/lp.tsv",
    "psatcat": "cat/psatcat.tsv",
    "satcat": "cat/satcat.tsv",
}
# Larger than any of the files today (launch 14 MB, satcat 19 MB), small enough that a wrong answer cannot fill the disk.
MAX_BYTES = {
    "launch": 40 << 20,
    "sites": 4 << 20,
    "pads": 4 << 20,
    "psatcat": 20 << 20,
    "satcat": 60 << 20,
}
SNAPSHOT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "assets", "launches-snapshot.json.gz"
)
CACHE_FILENAME = "launches_cache.json"
CACHE_TTL_S = 7 * 24 * 3600
FAIL_COOLDOWN_S = 6 * 3600
FETCH_TIMEOUT_S = 120
COLUMNS = [
    "t",
    "veh",
    "pad",
    "mission",
    "ok",
    "perigee",
    "apogee",
    "inc",
    "az",
    "n",
    "names",
    "sepMin",
    "odays",
    "operi",
    "oapo",
    "tag",
]
MAX_NAMED_PAYLOADS = 3  # payload names kept per launch; the count is always kept
MAX_NAME_LEN = 28
MIN_BATCH = 4  # a launch with this many payloads has a deployment worth reconstructing
MIN_LAUNCHES = 5000  # fewer than this out of a parse is a wrong answer, not a catalogue
ORBITAL_CODES = ("O", "D")  # GCAT launch codes: orbital, and deep space (the Moon and beyond, from an orbit round the Earth)

MONTHS = {m: i for i, m in enumerate(calendar.month_abbr) if m}
PIECE_RE = re.compile(r"^(\d{4}-[A-Z]?\d{2,3})[A-Z]+$")
DATE_RE = re.compile(r"^(\d{4}) (\w{3})\s+(\d{1,2})(?: (\d{2})(\d{2})(?::(\d{2}))?)?")

_lock = threading.Lock()
_refreshing = False
_last_fail = 0.0
_memory = None
_snapshot_cache = (None, None)  # (mtime, payload)


def _cache_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, CACHE_FILENAME)


# ── Reading GCAT ──


def _rows(text):
    for line in text.splitlines():
        if line and not line.startswith("#"):
            yield [c.strip() for c in line.split("\t")]


def _num(text):
    try:
        return float(text.replace("?", ""))
    except ValueError:
        return None


def _whole(value):
    return None if value is None else int(round(value))


def _minutes(text, midnight=False):
    """GCAT's "2021 May  4 1901:05" as whole minutes since 1970 (UTC); None without a time of day
    (``midnight``: a date alone counts as 00:00)."""
    m = DATE_RE.match(text)
    if not m or m.group(2) not in MONTHS or (m.group(4) is None and not midnight):
        return None
    hh, mm = int(m.group(4) or 0), int(m.group(5) or 0)
    return (
        calendar.timegm(
            (int(m.group(1)), MONTHS[m.group(2)], int(m.group(3)), hh, mm, 0)
        )
        // 60
    )


def _payloads(psatcat):
    """Payload names and counts by launch tag (the piece "2021-038A" belongs to launch 2021-038)."""
    names, counts = {}, {}
    for r in _rows(psatcat):
        m = PIECE_RE.match(r[1])
        if not m:
            continue
        tag = m.group(1)
        counts[tag] = counts.get(tag, 0) + 1
        if len(names.setdefault(tag, [])) < MAX_NAMED_PAYLOADS:
            names[tag].append(r[2][:MAX_NAME_LEN])
    return names, counts


def _first_payloads(satcat):
    """The first payload of each launch in the satellite catalogue (its separation and first orbit)."""
    first = {}
    for r in _rows(satcat):
        if r[2] not in first and r[4].startswith("P"):
            first[r[2]] = r
    return first


def _pad(key, sites, pad_rows):
    site = sites.get(key[0])
    row = pad_rows.get(key) or site
    lat, lon = (_num(row[11]), _num(row[10])) if row else (None, None)
    return [
        key[0],
        key[1],
        site[7] if site else key[0],
        round(lat, 3) if lat is not None else None,
        round(lon, 3) if lon is not None else None,
        site[4] if site else "",
    ]


def _deployment(f, t):
    """``(sepMin, odays, operi, oapo)`` from a batch's first payload: separation minutes after liftoff, then the
    orbit GCAT dated days after it."""
    sep_t = _minutes(f[9])
    if sep_t is None:
        return None, None, None, None
    ot = _minutes(f[32], midnight=True)
    if ot is None:
        return sep_t - t, None, None, None
    return (
        sep_t - t,
        round((ot - t) / 1440.0, 1),
        _whole(_num(f[33])),
        _whole(_num(f[35])),
    )


def build(src, today=None):
    """The payload from the five GCAT files' text (``SOURCE_FILES`` keys)."""
    sites = {r[0]: r for r in _rows(src["sites"])}
    pad_rows = {(r[0], r[1]): r for r in _rows(src["pads"])}
    names, counts = _payloads(src["psatcat"])
    first = _first_payloads(src["satcat"])
    veh, veh_ix, pads, pad_ix, out = [], {}, [], {}, []
    for r in _rows(src["launch"]):
        if r[26][:1] not in ORBITAL_CODES:
            continue
        t = _minutes(r[2])
        if t is None:
            continue
        if r[3] not in veh_ix:
            veh_ix[r[3]] = len(veh)
            veh.append(r[3])
        key = (r[11], r[12])
        if key not in pad_ix:
            pad_ix[key] = len(pads)
            pads.append(_pad(key, sites, pad_rows))
        n, f = counts.get(r[0], 0), first.get(r[0])
        peri, apo, inc = _whole(_num(r[15])), _whole(_num(r[16])), _num(r[18])
        if f and n:
            # GCAT's launch row aims at an orbit only for some launches; the first payload's catalogued orbit fills the rest.
            peri = peri if peri is not None else _whole(_num(f[33]))
            apo = apo if apo is not None else _whole(_num(f[35]))
            inc = inc if inc is not None else _num(f[37])
        dep = _deployment(f, t) if f and n >= MIN_BATCH else (None,) * 4
        out.append(
            [
                t,
                veh_ix[r[3]],
                pad_ix[key],
                r[8] if r[8] != "-" else "",
                0 if r[26][1:2] == "F" else 1,
                peri,
                apo,
                inc,
                _num(r[19]),
                n,
                names.get(r[0], []) if n <= 6 else [],
            ]
            + list(dep)
            + [r[0]]
        )
    out.sort(key=lambda x: x[0])
    stamp = (today or datetime.date.today()).isoformat()
    return {
        "gcat": stamp,
        "fetched_at": time.time(),
        "cols": list(COLUMNS),
        "veh": veh,
        "pads": pads,
        "l": out,
    }


def _valid(payload):
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("l"), list)
        and len(payload["l"]) >= MIN_LAUNCHES
        and payload.get("cols") == list(COLUMNS)
        and isinstance(payload.get("pads"), list)
        and isinstance(payload.get("veh"), list)
    )


# ── Fetching ──


def _open(rel, limit):
    req = urllib.request.Request(
        GCAT_BASE + rel, headers={"User-Agent": _sat._user_agent()}
    )
    with urllib.request.urlopen(
        req, timeout=FETCH_TIMEOUT_S, context=_srv.SSL_CTX
    ) as resp:
        body = resp.read(limit + 1)
    if len(body) > limit:
        raise ValueError("response too large")
    return body.decode("utf-8", "replace")


def fetch_live():
    """The whole payload from GCAT. Raises on failure."""
    src = {key: _open(rel, MAX_BYTES[key]) for key, rel in SOURCE_FILES.items()}
    payload = build(src)
    if not _valid(payload):
        raise ValueError("GCAT answer has too few launches")
    return payload


# ── Snapshot, cache, answer ──


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
    """The shipped payload, parsed once per file version. Its ``fetched_at`` is the GCAT date at noon UTC."""
    global _snapshot_cache
    try:
        mtime = os.path.getmtime(SNAPSHOT_PATH)
    except OSError:
        return None
    if _snapshot_cache[0] != mtime:
        payload = _read_json(SNAPSHOT_PATH, gz=True)
        if payload:
            try:
                day = datetime.date.fromisoformat(payload["gcat"])
                payload["fetched_at"] = calendar.timegm(day.timetuple()) + 12 * 3600
            except (KeyError, ValueError):
                payload["fetched_at"] = 0.0
        _snapshot_cache = (mtime, payload)
    return _snapshot_cache[1]


def write_snapshot(path, payload):
    """Gzipped with no timestamp, one launch per line: an unchanged catalogue rebuilds byte for byte."""
    head = ",".join(
        '"%s":%s'
        % (k, json.dumps(payload[k], separators=(",", ":"), ensure_ascii=False))
        for k in ("gcat", "cols", "veh", "pads")
    )
    rows = ",\n".join(
        json.dumps(r, separators=(",", ":"), ensure_ascii=False) for r in payload["l"]
    )
    raw = ('{%s,"l":[\n%s\n]}\n' % (head, rows)).encode("utf-8")
    with (
        open(path, "wb") as f,
        gzip.GzipFile(filename="", fileobj=f, mode="wb", mtime=0, compresslevel=9) as z,
    ):
        z.write(raw)


def refresh():
    """Fetch live and replace the cache. The payload, or None when the fetch failed or another is running."""
    global _refreshing, _last_fail, _memory
    with _lock:
        if _refreshing:
            return None
        _refreshing = True
    try:
        payload = fetch_live()
    except Exception as e:
        _last_fail = time.time()
        log.info("Launch history not refreshed: %s", e)
        return None
    finally:
        with _lock:
            _refreshing = False
    _memory = payload
    _srv._atomic_write_json(_cache_path(), payload)
    log.info("Launch history refreshed: %d launches", len(payload["l"]))
    return payload


def _kick_refresh():
    if _sat._offline() or time.time() - _last_fail < FAIL_COOLDOWN_S:
        return False
    with _lock:
        if _refreshing:
            return True
    threading.Thread(target=refresh, name="launch-history", daemon=True).start()
    return True


def get(allow_refresh=True):
    """The newest history here, at once, with the state the view reads: ``source, gcat, cols, veh, pads, l, stale,
    refreshing, mode, locked``. The refresh rules are satellites.get's."""
    mode, locked = _sat.update_mode()
    live, snap = _memory or read_cache(), read_snapshot()
    if live and (not snap or live["fetched_at"] >= snap["fetched_at"]):
        best, source = live, "cache"
    elif snap:
        best, source = snap, "snapshot"
    else:
        best, source = None, "none"
    age = time.time() - best["fetched_at"] if best else float("inf")
    stale = age > CACHE_TTL_S
    refreshing = bool(
        allow_refresh and mode == _sat.UPDATE_AUTO and stale and _kick_refresh()
    )
    answer = (
        {k: best[k] for k in ("gcat", "cols", "veh", "pads", "l")}
        if best
        else {"gcat": None, "cols": list(COLUMNS), "veh": [], "pads": [], "l": []}
    )
    answer.update(
        source=source, stale=stale, refreshing=refreshing, mode=mode, locked=locked
    )
    return answer


def refresh_now():
    """An admin's Get fresh data: ``(payload, error)`` with satellites.refresh_now's meaning of "never" and "failed"."""
    if _sat.update_mode()[0] == _sat.UPDATE_NEVER:
        return None, "never"
    fetched = refresh()
    after = get(allow_refresh=False)
    if fetched is not None:
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
