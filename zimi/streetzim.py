"""StreetZim's regions, from where StreetZim publishes them.

StreetZim (https://streetzim.web.app) builds offline OpenStreetMap ZIMs with
vector tiles, and on many regions satellite imagery, terrain and routing
data. It is not in the Kiwix catalog; each region is an item on the Internet
Archive named ``streetzim-<region>``, holding one or more dated
``osm-<region>-YYYY-MM-DD.zim`` files. This module turns those items into
catalog entries shaped like Kiwix's, so the Maps category can list them
behind a toggle and the ordinary download path can fetch them.

The listing is cached on disk and served stale while a refresh runs, the
same rule the Kiwix catalog follows: a machine that was online once keeps
what it saw, and a machine that never was sees an honest nothing rather
than an error.
"""

import json
import logging
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from zimi import server as _srv

log = logging.getLogger("zimi")

IA_SEARCH_URL = (
    "https://archive.org/advancedsearch.php?q=identifier%3Astreetzim*"
    "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description"
    "&fl%5B%5D=publicdate&rows=500&output=json"
)
IA_METADATA_URL = "https://archive.org/metadata/{identifier}"
IA_DOWNLOAD_URL = "https://archive.org/download/{identifier}/{filename}"
CACHE_FILENAME = "streetzim_catalog.json"
CACHE_TTL_S = 24 * 3600
FETCH_TIMEOUT_S = 20
_WORKERS = 8
_ZIM_RE = re.compile(r"^osm-(?P<region>.+?)-(?P<date>\d{4}-\d{2}-\d{2})\.zim$")
_FEATURE_KEYS = (
    ("streetzim_satellite", "satellite imagery"),
    ("streetzim_terrain", "terrain"),
    ("streetzim_routing", "routing"),
    ("streetzim_wikidata", "Wikipedia links"),
)

_lock = threading.Lock()
_refreshing = False


def _cache_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, CACHE_FILENAME)


def _user_agent():
    return f"Zimi/{_srv.ZIMI_VERSION} (+https://github.com/epheterson/Zimi)"


def _get_json(url, timeout=FETCH_TIMEOUT_S):
    req = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _truthy(value):
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def humanize_region(region):
    """``silicon-valley`` -> ``Silicon Valley``; ``washington-dc`` -> ``Washington DC``."""
    words = []
    for w in region.replace("_", "-").split("-"):
        if not w:
            continue
        words.append(
            w.upper() if w in ("dc", "nyc", "uk", "usa", "uae", "nz", "us") else w.capitalize()
        )
    return " ".join(words)


def item_from_metadata(identifier, meta, search_row=None):
    """One catalog entry from an Internet Archive item's metadata, or None
    when the item holds no StreetZim map. Picks the newest dated file."""
    files = meta.get("files") or []
    best = None
    for f in files:
        name = f.get("name") or ""
        m = _ZIM_RE.match(name)
        if not m:
            continue
        if best is None or m.group("date") > best[0]:
            best = (m.group("date"), m.group("region"), name, int(f.get("size") or 0))
    if best is None:
        return None
    date, region, filename, size = best
    md = meta.get("metadata") or {}
    features = [label for key, label in _FEATURE_KEYS if _truthy(md.get(key, ""))]
    title = humanize_region(region)
    described = ""
    if search_row and search_row.get("description"):
        described = str(search_row["description"])
    elif md.get("description"):
        described = str(md["description"])
    described = re.sub(r"<[^>]+>", " ", described)
    described = re.sub(r"\s+", " ", described).strip()
    summary = "OpenStreetMap, vector tiles rendered on the device"
    if features:
        summary += ", with " + ", ".join(features)
    summary += ". Built by StreetZim."
    if described and len(described) < 300:
        summary = described
    return {
        "name": "osm-" + region,
        "title": title,
        "summary": summary,
        "category": "maps",
        "language": "eng",
        "size_bytes": size,
        "file": filename,
        "date": date,
        "download_url": IA_DOWNLOAD_URL.format(
            identifier=identifier, filename=urllib.parse.quote(filename)
        ),
        "source": "streetzim",
        "features": features,
        "identifier": identifier,
    }


def fetch_live():
    """Every StreetZim region on the Internet Archive, newest file each.
    Raises on a failed listing; a single item that fails is skipped."""
    listing = _get_json(IA_SEARCH_URL)
    rows = (listing.get("response") or {}).get("docs") or []
    ids = [r.get("identifier") for r in rows if r.get("identifier")]
    by_id = {r.get("identifier"): r for r in rows}

    def one(identifier):
        try:
            meta = _get_json(IA_METADATA_URL.format(identifier=identifier))
            return item_from_metadata(identifier, meta, by_id.get(identifier))
        except Exception as e:
            log.debug("streetzim: %s skipped: %s", identifier, e)
            return None

    items = []
    with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
        for item in pool.map(one, ids):
            if item:
                items.append(item)
    items.sort(key=lambda i: i["title"])
    return items


def _read_cache():
    try:
        with open(_cache_path(), encoding="utf-8") as f:
            payload = json.load(f)
        items = payload.get("items")
        if isinstance(items, list):
            return items, float(payload.get("fetched_at") or 0)
    except (OSError, ValueError):
        pass
    return None, 0.0


def _write_cache(items):
    _srv._atomic_write_json(_cache_path(), {"fetched_at": time.time(), "items": items})


def refresh():
    """Fetch live and replace the cache wholesale. Returns the items, or
    None when the fetch failed (the cache is left as it was)."""
    global _refreshing
    with _lock:
        if _refreshing:
            return None
        _refreshing = True
    try:
        items = fetch_live()
        if items:
            _write_cache(items)
            log.info("StreetZim catalog: %d regions", len(items))
        return items
    except Exception as e:
        log.info("StreetZim catalog not refreshed: %s", e)
        return None
    finally:
        with _lock:
            _refreshing = False


def _offline():
    """The operator's promise that nothing reaches out, read where the rest
    of Zimi reads it."""
    from zimi import p2p

    return bool(p2p.is_offline())


def get(allow_refresh=True):
    """``(items, source, as_of, refreshing)``. Cached items at once; a
    stale or missing cache kicks a background refresh when allowed."""
    items, fetched_at = _read_cache()
    stale = items is None or (time.time() - fetched_at) > CACHE_TTL_S
    if stale and allow_refresh and not _offline():
        with _lock:
            busy = _refreshing
        if not busy:
            threading.Thread(
                target=refresh, name="streetzim-catalog", daemon=True
            ).start()
    if items is None:
        return [], "none", "", _refreshing
    as_of = time.strftime("%Y-%m-%d", time.gmtime(fetched_at)) if fetched_at else ""
    return items, "cache", as_of, _refreshing


def _reset_for_tests():
    global _refreshing
    _refreshing = False
