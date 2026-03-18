"""Library management for Zimi — auto-update, downloads, catalog, and thumb proxy.

Extracted from server.py to keep the main module focused on core ZIM operations.
All server state (ZIM_DIR, locks, caches) is accessed via ``zimi.server`` to
maintain a single source of truth.
"""

import glob
import json
import logging
import os
import random as _random
import re
import shutil
import ssl
import threading
import time
import xml.etree.ElementTree as ET
import urllib.error
import urllib.request
from urllib.parse import urlparse, urlencode

import zimi.server as _srv

log = logging.getLogger("zimi")


# ============================================================================
# Auto-Update
# ============================================================================

# If ZIMI_AUTO_UPDATE env var is set, it's an admin override (UI locked).
# If not set, the UI controls it and settings persist to disk.
_AUTO_UPDATE_CONFIG = os.path.join(_srv.ZIMI_DATA_DIR, "auto_update.json")
_auto_update_env_locked = "ZIMI_AUTO_UPDATE" in os.environ

def _load_auto_update_config():
    """Load auto-update settings. Env var overrides; otherwise use persisted config."""
    # Look up through _srv so test monkey-patches on server.py propagate
    locked = getattr(_srv, '_auto_update_env_locked', _auto_update_env_locked)
    config_path = getattr(_srv, '_AUTO_UPDATE_CONFIG', _AUTO_UPDATE_CONFIG)
    if locked:
        enabled = os.environ.get("ZIMI_AUTO_UPDATE", "0") == "1"
        freq = os.environ.get("ZIMI_UPDATE_FREQ", "weekly")
        return enabled, freq
    try:
        with open(config_path) as f:
            cfg = json.loads(f.read())
            return cfg.get("enabled", False), cfg.get("frequency", "weekly")
    except (OSError, json.JSONDecodeError, KeyError):
        return False, "weekly"

def _save_auto_update_config(enabled, freq):
    """Persist auto-update settings to disk."""
    config_path = getattr(_srv, '_AUTO_UPDATE_CONFIG', _AUTO_UPDATE_CONFIG)
    _srv._atomic_write_json(config_path, {"enabled": enabled, "frequency": freq})

_auto_update_enabled, _auto_update_freq = False, "weekly"  # defaults; loaded by _init()
_auto_update_last_check = None
_auto_update_thread = None

_FREQ_SECONDS = {"daily": 86400, "weekly": 604800, "monthly": 2592000}

def _auto_update_loop(initial_delay=0):
    """Background thread that checks for and applies ZIM updates.

    Reads _auto_update_enabled / _auto_update_freq via _srv so that
    manage.py's runtime toggles (which write to server.py's namespace)
    are visible immediately. Without this, the loop would read stale
    values from library.py's own module namespace.
    """
    if initial_delay > 0:
        log.info("Auto-update: first check in %ds", initial_delay)
        for _ in range(initial_delay):
            if not getattr(_srv, '_auto_update_enabled', _auto_update_enabled):
                return
            time.sleep(1)
    log.info("Auto-update enabled: checking every %s",
             getattr(_srv, '_auto_update_freq', _auto_update_freq))
    while getattr(_srv, '_auto_update_enabled', _auto_update_enabled):
        try:
            _srv._auto_update_last_check = time.time()
            updates = _check_updates()
            if updates:
                log.info("Auto-update: %d updates available", len(updates))
                for upd in updates:
                    url = upd.get("download_url")
                    if not url:
                        continue
                    # Strip .meta4 suffix to get the actual filename
                    raw_name = url.rsplit("/", 1)[-1] if "/" in url else url
                    if raw_name.endswith(".meta4"):
                        raw_name = raw_name[:-len(".meta4")]
                    filename = raw_name
                    # Skip if already downloading this file
                    with _download_lock:
                        already = any(d["filename"] == filename and not d.get("done")
                                      for d in _active_downloads.values())
                    if already:
                        log.info("Auto-update: skipping %s (already downloading)", filename)
                        continue
                    # Skip if file already exists on disk (prevents infinite re-download loop)
                    if os.path.exists(os.path.join(_srv.ZIM_DIR, filename)):
                        log.info("Auto-update: skipping %s (already on disk)", filename)
                        continue
                    dl_id, err = _start_download(url)
                    if err:
                        log.warning("Auto-update download failed for %s: %s", upd.get("name", "?"), err)
                    else:
                        log.info("Auto-update started download: %s (id=%s)", upd.get("name", "?"), dl_id)
            else:
                log.info("Auto-update: all ZIMs up to date")
        except Exception as e:
            log.warning("Auto-update check failed: %s", e)
        # Sleep in 60s chunks so we can exit cleanly; re-read frequency each cycle
        freq = getattr(_srv, '_auto_update_freq', _auto_update_freq)
        interval = _FREQ_SECONDS.get(freq, 604800)
        for _ in range(max(interval // 60, 1)):
            if not getattr(_srv, '_auto_update_enabled', _auto_update_enabled):
                break
            time.sleep(60)


# ============================================================================
# Library Management
# ============================================================================

_active_downloads = {}  # {id: {"url": ..., "filename": ..., "pid": ..., "started": ...}}
_download_counter = 0
_download_lock = threading.Lock()

KIWIX_OPDS_BASE = "https://library.kiwix.org/catalog/search"

# Server-side catalog cache: {cache_key: (timestamp, total, items)}
_opds_cache = {}
_OPDS_CACHE_TTL = 86400  # 24 hours — catalog changes rarely


def _thumb_dir():
    """Lazily create and return thumbnail cache directory."""
    d = os.path.join(_srv.ZIMI_DATA_DIR, "thumbs")
    os.makedirs(d, exist_ok=True)
    return d


def _fetch_thumb(url):
    """Fetch a thumbnail from Kiwix, caching to disk. Returns (bytes, content_type) or (None, None)."""
    # Only allow library.kiwix.org
    if not url.startswith("https://library.kiwix.org/"):
        return None, None
    # Use URL hash as filename
    import hashlib as _hl
    key = _hl.md5(url.encode()).hexdigest()
    cache_path = os.path.join(_thumb_dir(), key)
    meta_path = cache_path + ".meta"
    # Serve from disk cache if exists
    if os.path.exists(cache_path) and os.path.exists(meta_path):
        with open(meta_path) as f:
            ct = f.read().strip() or "image/png"
        with open(cache_path, "rb") as f:
            return f.read(), ct
    # Fetch from Kiwix (no redirects to prevent SSRF)
    try:
        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                raise urllib.error.HTTPError(req.full_url, code, "Redirect blocked", headers, fp)
        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(url, headers={"User-Agent": "Zimi/1.0"})
        with opener.open(req, timeout=10) as resp:
            ct = resp.headers.get("Content-Type", "image/png")
            # Only serve image content types
            if not ct.startswith("image/"):
                return None, None
            data = resp.read()
        # Write to disk cache
        with open(cache_path, "wb") as f:
            f.write(data)
        with open(meta_path, "w") as f:
            f.write(ct)
        return data, ct
    except Exception as e:
        log.debug("Failed to fetch thumbnail from %s: %s", url, e)
        return None, None


def _clear_thumb_cache():
    """Remove all cached thumbnails."""
    d = os.path.join(_srv.ZIMI_DATA_DIR, "thumbs")
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)


def _fetch_kiwix_catalog(query="", lang="eng", count=20, start=0):
    """Fetch and parse the Kiwix OPDS catalog. Returns (total, items, error).
    Results are cached server-side for 1 hour to avoid hammering Kiwix."""
    cache_key = f"{query}|{lang}|{count}|{start}"
    cached = _opds_cache.get(cache_key)
    if cached:
        ts, total, items = cached
        if time.time() - ts < _OPDS_CACHE_TTL:
            return total, items, None
        del _opds_cache[cache_key]
    # Cap cache size
    if len(_opds_cache) > 100:
        _opds_cache.clear()
    params = {"count": str(count), "start": str(start)}
    if query:
        params["q"] = query
    if lang:
        params["lang"] = lang
    url = KIWIX_OPDS_BASE + "?" + urlencode(params)

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Zimi/1.0"})
        with urllib.request.urlopen(req, timeout=15, context=_srv.SSL_CTX) as resp:
            xml_bytes = resp.read()
    except Exception as e:
        log.warning("OPDS fetch failed: %s", e)
        return 0, [], "Catalog fetch failed"

    # Parse OPDS (Atom) XML
    ns = {
        "atom": "http://www.w3.org/2005/Atom",
        "opds": "http://opds-spec.org/2010/catalog",
        "dc": "http://purl.org/dc/terms/",
    }
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        log.warning("OPDS parse failed: %s", e)
        return 0, [], "Catalog parse failed"

    # Total results — Kiwix puts this in the Atom namespace (not OpenSearch)
    atom_ns = ns["atom"]
    total_el = root.find(f"{{{atom_ns}}}totalResults")
    if total_el is None:
        total_el = root.find(".//{http://a9.com/-/spec/opensearch/1.1/}totalResults")
    try:
        total = int(total_el.text or "0") if total_el is not None else 0
    except (ValueError, TypeError):
        total = 0

    # Build set of installed filename bases (date-stripped) for accurate matching
    local_bases = set()
    for path in glob.glob(os.path.join(_srv.ZIM_DIR, "*.zim")):
        base, _ = _srv._extract_zim_date(os.path.basename(path))
        local_bases.add(base.lower())
    items = []
    for entry in root.findall("atom:entry", ns):
        name = ""
        title = ""
        summary = ""
        language = ""
        category = ""
        author = ""
        date = ""
        article_count = 0
        media_count = 0
        size_bytes = 0
        download_url = ""
        icon_url = ""

        # Most fields are in the Atom namespace (default)
        _t = lambda tag: entry.findtext(f"{{{atom_ns}}}{tag}") or ""
        name = _t("name")
        title = _t("title")
        summary = _t("summary")
        language = _t("language")
        category = _t("category")
        try:
            article_count = int(_t("articleCount"))
        except (ValueError, TypeError):
            pass
        try:
            media_count = int(_t("mediaCount"))
        except (ValueError, TypeError):
            pass

        # Author is nested: <author><name>...</name></author>
        author_el = entry.find("atom:author/atom:name", ns)
        if author_el is not None and author_el.text and author_el.text != "-":
            author = author_el.text

        # Date from dc:issued
        date_el = entry.find("dc:issued", ns)
        if date_el is not None and date_el.text:
            date = date_el.text[:10]  # Just YYYY-MM-DD

        for link in entry.findall("atom:link", ns):
            rel = link.get("rel", "")
            href = link.get("href", "")
            ltype = link.get("type", "")
            if rel == "http://opds-spec.org/acquisition/open-access" and ltype == "application/x-zim":
                download_url = href
                try:
                    size_bytes = int(link.get("length", "0"))
                except (ValueError, TypeError):
                    pass
            elif rel == "http://opds-spec.org/image/thumbnail":
                icon_url = "https://library.kiwix.org" + href if href.startswith("/") else href

        # Determine if installed by matching download URL filename against local ZIMs
        installed = False
        if download_url:
            dl_fn = download_url.split("/")[-1]
            dl_base, _ = _srv._extract_zim_date(dl_fn)
            installed = dl_base.lower() in local_bases

        # Normalize language to 2-letter codes (OPDS uses 3-letter)
        if language:
            norm_parts = []
            for lp in language.split(","):
                lp = lp.strip().lower()
                if lp:
                    norm_parts.append(_srv._ISO639_3_TO_1.get(lp, lp))
            language = ",".join(norm_parts)
        items.append({
            "name": name,
            "title": title,
            "summary": summary,
            "language": language,
            "category": category,
            "author": author,
            "date": date,
            "article_count": article_count,
            "media_count": media_count,
            "size_bytes": size_bytes,
            "download_url": download_url,
            "icon_url": icon_url,
            "installed": installed,
        })

    _opds_cache[cache_key] = (time.time(), total, items)
    return total, items, None


def _check_updates():
    """Compare installed ZIMs against Kiwix catalog to find available updates.

    Fetches a large batch from the catalog and matches by base name.
    Returns list of {name, installed_date, latest_date, download_url}.
    """
    zims = _srv.get_zim_files()
    # Build lookup: catalog_prefix → (short_name, installed_date, filename)
    # Match by checking if installed filename starts with catalog name + '_'
    installed_files = []
    for name, path in zims.items():
        filename = os.path.basename(path)
        _, date = _srv._extract_zim_date(filename)
        if date:
            installed_files.append({"name": name, "date": date, "filename": filename, "filebase": filename.replace('.zim', '')})

    if not installed_files:
        return []

    # Fetch full catalog to check all installed ZIMs (paginated)
    all_items = []
    total, items, err = _fetch_kiwix_catalog(query="", lang="eng", count=500, start=0)
    if err:
        return []
    all_items.extend(items)
    while len(all_items) < total:
        _, more, err = _fetch_kiwix_catalog(query="", lang="eng", count=500, start=len(all_items))
        if err or not more:
            break
        all_items.extend(more)

    # Build index: for each catalog item, note its name and date
    catalog_index = []
    for item in all_items:
        dl_url = item.get("download_url", "")
        if not dl_url:
            continue
        cat_name = item.get("name", "")
        cat_date = item.get("date", "")[:7] if item.get("date") else ""
        if not cat_date or not cat_name:
            continue
        catalog_index.append((cat_name, cat_date, item))

    # For each installed ZIM, find the best catalog match (longest prefix = exact flavor)
    updates = []
    for inst in installed_files:
        best = None
        best_len = 0
        for cat_name, cat_date, item in catalog_index:
            if inst["filebase"].startswith(cat_name + "_") and cat_date > inst["date"]:
                if len(cat_name) > best_len:
                    best = (cat_name, cat_date, item)
                    best_len = len(cat_name)
        if best:
            _, cat_date, item = best
            updates.append({
                "name": inst["name"],
                "installed_file": inst["filename"],
                "installed_date": inst["date"],
                "latest_date": cat_date,
                "download_url": item.get("download_url", ""),
                "title": item.get("title", ""),
                "size_bytes": item.get("size_bytes", 0),
            })

    return updates


def _download_from_url(dl, url, tmp_dest):
    """Attempt to download from a single URL. Returns (success, error_msg).

    Downloads to a .zim.tmp file first. Supports resuming via HTTP Range header.
    On transient failure, keeps the .tmp file for resume on the next mirror.
    """
    dl["_mirror_url"] = url  # track current mirror for UI display
    existing_size = 0
    if os.path.exists(tmp_dest):
        existing_size = os.path.getsize(tmp_dest)
    req = urllib.request.Request(url, headers={"User-Agent": "Zimi/1.0"})
    if existing_size > 0:
        req.add_header("Range", f"bytes={existing_size}-")
        log.info("Resuming download of %s from %d bytes via %s",
                 dl["filename"], existing_size, urlparse(url).hostname)
    else:
        log.info("Downloading %s from %s", dl["filename"], urlparse(url).hostname)
    try:
        resp = urllib.request.urlopen(req, timeout=600, context=_srv.SSL_CTX)
    except urllib.error.HTTPError as e:
        if e.code == 416 and existing_size > 0:
            # Range not satisfiable — file already complete
            return True, None
        return False, f"HTTP {e.code} from {urlparse(url).hostname}"
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        return False, f"{type(e).__name__} from {urlparse(url).hostname}: {e}"
    if resp.status == 206:
        content_range = resp.headers.get("Content-Range", "")
        try:
            if "/" in content_range:
                total = int(content_range.split("/")[1])
            else:
                total = existing_size + int(resp.headers.get("Content-Length", 0))
        except (ValueError, IndexError):
            total = existing_size + int(resp.headers.get("Content-Length", 0))
        dl["total_bytes"] = total
        dl["downloaded_bytes"] = existing_size
        mode = "ab"
    else:
        total = int(resp.headers.get("Content-Length", 0))
        dl["total_bytes"] = total
        dl["downloaded_bytes"] = 0  # reset: mirror doesn't support resume
        existing_size = 0
        mode = "wb"
    try:
        with open(tmp_dest, mode) as f:
            while not dl.get("cancelled"):
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                dl["downloaded_bytes"] = dl.get("downloaded_bytes", 0) + len(chunk)
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        resp.close()
        return False, f"Transfer error from {urlparse(url).hostname}: {e}"
    resp.close()
    if dl.get("cancelled"):
        return True, "Cancelled"
    # Verify size
    if total > 0:
        actual = os.path.getsize(tmp_dest)
        if actual != total:
            return False, f"Size mismatch from {urlparse(url).hostname}: expected {total}, got {actual}"
    return True, None


def _title_from_filename(filename):
    """Extract a readable title from a ZIM filename for history events."""
    name = re.sub(r'_\d{4}-\d{2}\.zim$', '', filename).replace('.zim', '')
    # Try OPDS cache for a proper title
    for _ts, _total, items in _opds_cache.values():
        for it in items:
            dl_fn = (it.get("download_url") or "").split("/")[-1]
            if dl_fn == filename:
                return {"title": it.get("title", ""), "name": it.get("name", name)}
    # Fallback: humanize filename
    return {"title": name.replace("_", " ").title(), "name": name}


def _download_thread(dl):
    """Background thread that downloads a file with mirror rotation.

    Tries mirrors in random order for load distribution. On failure, rotates
    to the next mirror. Downloads to a .zim.tmp file first, then atomically
    renames on completion. The .tmp file is preserved across mirror attempts
    so resume works even when switching mirrors.
    """
    tmp_dest = dl["dest"] + ".tmp"
    mirrors = list(dl.get("mirrors", [dl["url"]]))
    _random.shuffle(mirrors)
    try:
        success = False
        last_error = None
        for mirror_url in mirrors:
            if dl.get("cancelled"):
                dl["done"] = True
                dl["error"] = "Cancelled"
                return
            ok, err = _download_from_url(dl, mirror_url, tmp_dest)
            if ok:
                if err == "Cancelled":
                    dl["done"] = True
                    dl["error"] = "Cancelled"
                    return
                success = True
                break
            last_error = err
            log.warning("Mirror failed for %s: %s", dl["filename"], err)
        if not success:
            dl["done"] = True
            dl["error"] = f"All {len(mirrors)} mirror(s) failed. Last: {last_error}"
            _srv._append_history({"event": "download_failed", "ts": time.time(), "filename": dl["filename"],
                             "error": dl["error"], **_title_from_filename(dl["filename"])})
            return
        # Atomic rename: tmp → final
        os.replace(tmp_dest, dl["dest"])
        dl["done"] = True  # Mark done immediately so UI shows completion
        log.info("Download complete: %s via %s, refreshing library",
                 dl["filename"], urlparse(dl.get("_mirror_url", dl["url"])).hostname)
        # Remove older versions of the same ZIM
        base = re.match(r'^(.+?)_\d{4}-\d{2}\.zim$', dl["filename"])
        if base:
            prefix = base.group(1)
            for f in os.listdir(_srv.ZIM_DIR):
                if f.startswith(prefix + "_") and f.endswith(".zim") and f != dl["filename"]:
                    try:
                        os.remove(os.path.join(_srv.ZIM_DIR, f))
                        log.info(f"Removed old version: {f}")
                    except OSError:
                        pass
        with _srv._zim_lock:
            _srv.load_cache(force=True)
        _srv._search_cache_clear()
        _srv._suggest_cache_clear()
        _srv._clean_stale_title_indexes()
        # Rebuild Q-ID indexes and detect has_qids for the new ZIM
        threading.Thread(target=_srv._build_all_qid_indexes, daemon=True).start()
        # Cache ZIM metadata in history so entries survive deletion
        zim_info = {}
        try:
            for z in (_srv._zim_list_cache or []):
                if z.get("file") == dl["filename"]:
                    zim_info = {"title": z.get("title", ""), "name": z.get("name", ""), "has_icon": z.get("has_icon", False)}
                    break
        except Exception as e:
            log.debug("Failed to cache ZIM metadata for download history: %s", e)
            pass
        event_type = "updated" if dl.get("is_update") else "download"
        _srv._append_history({"event": event_type, "ts": time.time(), "filename": dl["filename"],
                         "size_bytes": dl.get("total_bytes", 0), **zim_info})
    except Exception as e:
        is_transient = isinstance(e, (urllib.error.URLError, TimeoutError, ConnectionError, OSError))
        if not is_transient:
            try:
                os.remove(tmp_dest)
            except OSError:
                pass
        dl["done"] = True
        log.error("Download thread exception for %s: %s", dl["filename"], e, exc_info=True)
        dl["error"] = "Download failed"
        if not dl.get("cancelled"):
            _srv._append_history({"event": "download_failed", "ts": time.time(), "filename": dl["filename"],
                             "error": "Download failed", **_title_from_filename(dl["filename"])})


def _fetch_mirrors(meta4_url):
    """Fetch mirror URLs from a Metalink .meta4 file. Returns list of URLs sorted by priority."""
    try:
        req = urllib.request.Request(meta4_url, headers={"User-Agent": "Zimi/1.0"})
        with urllib.request.urlopen(req, timeout=15, context=_srv.SSL_CTX) as resp:
            xml_bytes = resp.read()
        root = ET.fromstring(xml_bytes)
        ns = "urn:ietf:params:xml:ns:metalink"
        mirrors = []
        for file_el in root.findall(f"{{{ns}}}file"):
            for url_el in file_el.findall(f"{{{ns}}}url"):
                href = (url_el.text or "").strip()
                if not href or not href.startswith("https://"):
                    continue
                # Skip publisher URL (kiwix.org root)
                if href.rstrip("/") == "https://kiwix.org":
                    continue
                try:
                    priority = int(url_el.get("priority", "99"))
                except (ValueError, TypeError):
                    priority = 99
                location = url_el.get("location", "")
                mirrors.append((priority, location, href))
        mirrors.sort(key=lambda x: x[0])
        return [m[2] for m in mirrors]
    except Exception as e:
        log.warning("Failed to fetch mirrors from %s: %s", meta4_url, e)
        return []


def _start_download(url):
    """Start a background download via urllib. Returns download ID."""
    global _download_counter
    # Validate URL — only allow Kiwix official downloads
    if not url.startswith("https://download.kiwix.org/"):
        return None, "URL must be from download.kiwix.org"

    # OPDS catalog provides .meta4 metalink URLs — fetch mirrors from it
    mirrors = []
    if url.endswith(".meta4"):
        mirrors = _fetch_mirrors(url)
        url = url[:-len(".meta4")]  # direct URL as primary fallback

    # If we got mirrors, use them; otherwise fall back to the direct URL
    if not mirrors:
        mirrors = [url]
    elif url not in mirrors:
        mirrors.append(url)  # ensure direct URL is always a fallback

    filename = url.split("/")[-1]
    # Prevent path traversal and validate filename
    filename = os.path.basename(filename)
    if not filename or ".." in filename:
        return None, "Invalid filename in URL"
    if not filename.endswith(".zim"):
        return None, "Only .zim files can be downloaded"
    # Reject filenames with suspicious characters
    if not re.match(r'^[\w.\-]+$', filename):
        return None, "Invalid characters in filename"
    dest = os.path.join(_srv.ZIM_DIR, filename)

    # Detect if this replaces an existing ZIM (update vs fresh download)
    name_prefix = re.sub(r'_\d{4}-\d{2}\.zim$', '', filename)
    is_update = any(
        f != filename and f.endswith('.zim') and re.sub(r'_\d{4}-\d{2}\.zim$', '', f) == name_prefix
        for f in os.listdir(_srv.ZIM_DIR) if os.path.isfile(os.path.join(_srv.ZIM_DIR, f))
    ) if os.path.isdir(_srv.ZIM_DIR) else False

    with _download_lock:
        _download_counter += 1
        dl_id = str(_download_counter)
        dl = {
            "id": dl_id,
            "url": url,
            "mirrors": mirrors,
            "filename": filename,
            "dest": dest,
            "started": time.time(),
            "done": False,
            "error": None,
            "is_update": is_update,
        }
        _active_downloads[dl_id] = dl
        t = threading.Thread(target=_download_thread, args=(dl,), daemon=True)
        t.start()
    log.info("Download started: %s (%d mirror%s available)", filename, len(mirrors),
             "s" if len(mirrors) != 1 else "")
    return dl_id, None


def _start_import(url):
    """Start a background download from any HTTPS URL. Returns download ID."""
    global _download_counter
    if not url.startswith("https://"):
        return None, "URL must use HTTPS"

    # Strip query string and fragment before extracting filename
    clean_url = url.split("?")[0].split("#")[0]
    filename = clean_url.split("/")[-1]
    filename = os.path.basename(filename)
    if not filename or ".." in filename:
        return None, "Invalid filename in URL"
    if not filename.endswith(".zim"):
        return None, "Only .zim files can be imported"
    if not re.match(r'^[\w.\-]+$', filename):
        return None, "Invalid characters in filename"
    dest = os.path.join(_srv.ZIM_DIR, filename)

    with _download_lock:
        _download_counter += 1
        dl_id = str(_download_counter)
        dl = {
            "id": dl_id,
            "url": url,
            "filename": filename,
            "dest": dest,
            "started": time.time(),
            "done": False,
            "error": None,
            "is_update": False,
        }
        _active_downloads[dl_id] = dl
        t = threading.Thread(target=_download_thread, args=(dl,), daemon=True)
        t.start()
    return dl_id, None


def _get_downloads():
    """Get status of all active/completed downloads."""
    results = []
    with _download_lock:
        to_remove = []
        for dl_id, dl in _active_downloads.items():
            done = dl.get("done", False)
            error = dl.get("error")
            size = 0
            try:
                if os.path.exists(dl["dest"]):
                    size = os.path.getsize(dl["dest"])
            except OSError:
                pass
            total = dl.get("total_bytes", 0)
            downloaded = dl.get("downloaded_bytes", 0)
            pct = min(100.0, round(downloaded / total * 100, 1)) if total > 0 else 0
            mirror_host = urlparse(dl.get("_mirror_url", dl["url"])).hostname or ""
            mirror_count = len(dl.get("mirrors", []))
            results.append({
                "id": dl_id,
                "filename": dl["filename"],
                "url": dl["url"],
                "mirror_host": mirror_host,
                "mirror_count": mirror_count,
                "size_bytes": size,
                "total_bytes": total,
                "downloaded_bytes": downloaded,
                "percent": pct,
                "done": done,
                "error": error,
                "elapsed": round(time.time() - dl["started"], 1),
                "is_update": dl.get("is_update", False),
            })
            # Clean up completed downloads older than 1 hour
            if done and (time.time() - dl["started"]) > 3600:
                to_remove.append(dl_id)
        for dl_id in to_remove:
            del _active_downloads[dl_id]
    return results
