"""The exact sky of a past date: Space-Track's historical elements, with the person's own login.

The Almanac reconstructs the satellites a launch left from its orbit (launches.py, almanac-launchflight.js). For the exact
positions, 18 SDS's elements of the day (Space-Track's ``gp_history``) are fetched with the Space-Track login the person
enters in the Almanac, kept in the same prefs file the BitTorrent client's password lives in, and used only for that.

  - Never shipped or redistributed: the cache is per machine, in the data directory, and only an admin reads it back
    (the routes are /manage's).
  - Never logged: the login appears in no log line, no exception text and no answer; the view is told only whether one is saved.
  - "Satellite data from the internet" decides whether Zimi reaches out (satellites.py): Never, and ZIMI_OFFLINE, fetch
    nothing; a day already cached is answered either way, since nothing is fetched.
  - One launch and one day per fetch, one request at a time and a few seconds apart (Space-Track allows 30 a minute).

The answer is OMM records (normalized by satellites.normalize_record), the element set at or just before the instant asked
for, one per object of the launch.
"""

import datetime
import http.cookiejar
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from zimi import p2p
from zimi import satellites as _sat
from zimi import server as _srv

log = logging.getLogger("zimi")

HOST = "https://www.space-track.org"
LOGIN_PATH = "/ajaxauth/login"
QUERY_PATH = "/basicspacedata/query/class/gp_history/OBJECT_ID/~~%s/EPOCH/%s--%s/orderby/NORAD_CAT_ID%%20asc,EPOCH%%20asc/format/json"
PREF_USER = "spacetrack_user"
PREF_PASSWORD = "spacetrack_password"
ENV_USER = "ZIMI_SPACETRACK_USER"
ENV_PASSWORD = "ZIMI_SPACETRACK_PASSWORD"
TAG_RE = re.compile(r"^\d{4}-[A-Z]?\d{2,3}$")
CACHE_DIR = "spacetrack"
WINDOW_DAYS_BEFORE = 4  # the elements of the days before the instant are asked for: the last one at or before it is used
WINDOW_DAYS_AFTER = 1
MIN_INTERVAL_S = 3.0  # between two requests (Space-Track: 30 a minute, 300 an hour)
TIMEOUT_S = 60
MAX_BYTES = 8 << 20
MAX_RECORDS = 400

_lock = threading.Lock()
_last_request = 0.0


class SpaceTrackError(Exception):
    """``status`` is the HTTP status the route answers with; ``code`` a word the view reads."""

    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


def credentials():
    """``(user, password)``; environment first, then the saved pair. Either may be empty."""
    user = os.environ.get(ENV_USER, "").strip()
    password = os.environ.get(ENV_PASSWORD, "")
    if user and password:
        return user, password
    prefs = p2p._read_prefs()
    return str(prefs.get(PREF_USER) or "").strip(), str(prefs.get(PREF_PASSWORD) or "")


def view():
    """What Settings may show: never the password, only whether one is saved."""
    user, password = credentials()
    return {
        "user": user,
        "password_set": bool(password),
        "locked": bool(os.environ.get(ENV_USER)),
    }


def save(user, password):
    """Keep (or, with either empty, forget) the login. False when the prefs file cannot be written."""
    user = str(user or "").strip()[:128]
    password = str(password or "")[:256]
    if not user or not password:
        user = password = ""
    return p2p.set_prefs({PREF_USER: user, PREF_PASSWORD: password})


def _day(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).date()


def _cache_path(tag, ms):
    return os.path.join(
        _srv.ZIMI_DATA_DIR, CACHE_DIR, "%s_%s.json" % (tag, _day(ms).strftime("%Y%m%d"))
    )


def _read_cache(tag, ms):
    try:
        with open(_cache_path(tag, ms), encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, ValueError):
        return None
    return (
        payload.get("records")
        if isinstance(payload, dict) and isinstance(payload.get("records"), list)
        else None
    )


def _write_cache(tag, ms, records):
    path = _cache_path(tag, ms)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _srv._atomic_write_json(path, {"fetched_at": time.time(), "records": records})
    except OSError as e:
        log.info("Space-Track elements not cached: %s", e.strerror)


def _pace():
    global _last_request
    wait = MIN_INTERVAL_S - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    _last_request = time.time()


def _request(opener, url, data=None):
    req = urllib.request.Request(
        url, data=data, headers={"User-Agent": _sat._user_agent()}
    )
    try:
        with opener.open(req, timeout=TIMEOUT_S) as resp:
            body = resp.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        # Only the status goes on: the exception text carries the address, which for the login holds nothing, but nothing is kept.
        raise SpaceTrackError(
            401 if e.code in (401, 403) else 502,
            "login" if e.code in (401, 403) else "failed",
        ) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise SpaceTrackError(502, "failed") from None
    if len(body) > MAX_BYTES:
        raise SpaceTrackError(502, "failed")
    return body


def _fetch(tag, ms, user, password):
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=_srv.SSL_CTX),
    )
    day = _day(ms)
    start, end = day - datetime.timedelta(
        days=WINDOW_DAYS_BEFORE
    ), day + datetime.timedelta(days=WINDOW_DAYS_AFTER)
    with _lock:
        _pace()
        form = urllib.parse.urlencode({"identity": user, "password": password}).encode()
        answer = _request(opener, HOST + LOGIN_PATH, form)
        if (
            b"Failed" in answer[:200]
        ):  # a bad login is answered 200 with {"Login":"Failed"}
            raise SpaceTrackError(401, "login")
        _pace()
        body = _request(
            opener, HOST + QUERY_PATH % (tag, start.isoformat(), end.isoformat())
        )
    try:
        rows = json.loads(body.decode("utf-8"))
    except ValueError:
        raise SpaceTrackError(502, "failed") from None
    if not isinstance(rows, list):
        raise SpaceTrackError(502, "failed")
    return rows


def at_instant(rows, ms):
    """One normalized record per object: the newest whose epoch is at or before ``ms``; the first after it where none is."""
    when = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    best = {}
    for rec in rows:
        norm = _sat.normalize_record(rec)
        if not norm:
            continue
        before = norm["EPOCH"][:19] <= when
        have = best.get(norm["NORAD_CAT_ID"])
        if have is None:
            take = True
        elif before:
            take = not have[0] or norm["EPOCH"] > have[1]["EPOCH"]
        else:
            take = not have[0] and norm["EPOCH"] < have[1]["EPOCH"]
        if take:
            best[norm["NORAD_CAT_ID"]] = (before, norm)
    return [best[k][1] for k in sorted(best)][:MAX_RECORDS]


def get(tag, ms):
    """The records for a launch (``tag`` "2021-038") at an instant. A cached day answers with no network.
    Raises SpaceTrackError."""
    if not TAG_RE.match(str(tag or "")):
        raise SpaceTrackError(400, "tag")
    ms = int(ms)
    cached = _read_cache(tag, ms)
    if cached is not None:
        return cached
    if _sat.update_mode()[0] == _sat.UPDATE_NEVER:
        raise SpaceTrackError(409, "never")
    user, password = credentials()
    if not user or not password:
        raise SpaceTrackError(424, "login")
    records = at_instant(_fetch(tag, ms, user, password), ms)
    if not records:
        raise SpaceTrackError(404, "none")
    _write_cache(tag, ms, records)
    return records


def _reset_for_tests():
    global _last_request
    _last_request = 0.0
