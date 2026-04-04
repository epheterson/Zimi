#!/usr/bin/env python3
"""
Zimi -- Offline Knowledge Viewer & API

Search and read articles from Kiwix ZIM files. Provides both a CLI and an
HTTP server with JSON API + web UI for browsing offline knowledge archives.

Requires: libzim (pip install libzim)
Optional: PyMuPDF (pip install PyMuPDF) for PDF-in-ZIM text extraction

Table of contents (this file: ~980 lines)
-----------------------------------------
  1. Imports & Configuration .............. ~60
  2. Constants & Shared Utilities ......... ~165
  3. History, Favorites & Collections ..... ~260
  4. ZIM File Discovery ................... ~370
  5. ZIM Listing & Metadata Cache ......... ~460
  6. CLI & Entry Points ................... ~710
  7. Re-exports ........................... ~895

  See also:
    zimi/search.py    (~1,400 lines) — search, suggest, title index, content serving
    zimi/interlang.py (~1,000 lines) — Q-ID matching, cross-ZIM resolution, languages
    zimi/library.py   (~730 lines)   — downloads, catalog, auto-update
    zimi/http.py      (~1,220 lines) — rate limiting, metrics, ZimHandler class
    zimi/manage.py    (~450 lines)   — auth, /manage/* route handlers
    zimi/previews.py  (~600 lines)   — content preview extraction

Configuration:
  ZIM_DIR      Path to directory containing *.zim files (default: /zims)
  ZIMI_MANAGE  Enabled by default; set to "0" to disable management endpoints

Usage (CLI):
  zimi search "water purification" --limit 10
  zimi read stackoverflow "Questions/12345"
  zimi list
  zimi suggest "pytho"

Usage (HTTP API):
  zimi serve --port 8899

  GET /search?q=...&limit=5&zim=...   Full-text search (cross-ZIM or scoped)
  GET /read?zim=...&path=...           Read article as plaintext
  GET /w/<zim>/<path>                  Serve raw ZIM content (HTML, images)
  GET /suggest?q=...&limit=10          Title autocomplete
  GET /snippet?zim=...&path=...        Short text snippet
  GET /list                            List all ZIM sources with metadata
  GET /languages                       Installed language summary
  GET /article-languages?zim=...&path=... Available translations for article
  GET /catalog?zim=...                 PDF catalog for zimgit-style ZIMs
  GET /random                          Random article
  GET /resolve?url=...                 Cross-ZIM URL resolution
  GET /resolve?domains=1               Domain→ZIM map for installed sources
  GET /health                          Health check
"""

# ============================================================================
# Imports & Configuration
# ============================================================================

import argparse
import glob
import json
import logging
import os
import re
import shutil
import sys
import threading
import time
from http.server import ThreadingHTTPServer
import ssl

import certifi

from libzim.reader import Archive
from libzim.suggestion import SuggestionSearcher

try:
    import fitz  # PyMuPDF — for reading PDFs embedded in ZIM files
    HAS_PYMUPDF = True
except ImportError:
    HAS_PYMUPDF = False

# SSL context using certifi CA bundle (PyInstaller bundles lack system certs)
SSL_CTX = ssl.create_default_context(cafile=certifi.where())

ZIMI_VERSION = "1.6.2"

log = logging.getLogger("zimi")
logging.basicConfig(format="%(asctime)s %(message)s", datefmt="%H:%M:%S", level=logging.INFO)

ZIM_DIR = os.environ.get("ZIM_DIR", "/zims")
ZIMI_MANAGE = os.environ.get("ZIMI_MANAGE", "1") == "1"
ZIMI_DATA_DIR = os.environ.get("ZIMI_DATA_DIR", os.path.join(ZIM_DIR, ".zimi"))
_initialized = False

def _init():
    """Initialize data directory and run migrations. Called lazily on first use."""
    global _initialized
    if _initialized:
        return
    _initialized = True
    try:
        os.makedirs(ZIMI_DATA_DIR, exist_ok=True)
    except OSError:
        pass  # ZIM_DIR may not exist yet (e.g. during import in tests)
    _migrate_data_files()
    global _auto_update_enabled, _auto_update_freq
    _auto_update_enabled, _auto_update_freq = _load_auto_update_config()

def _migrate_data_files():
    """Migrate data files from old locations into ZIMI_DATA_DIR."""
    # 1. Legacy flat files (v1.3 → v1.4): .zimi_* in ZIM_DIR root
    migrations = [
        (".zimi_password", "password"),
        (".zimi_collections.json", "collections.json"),
        (".zimi_cache.json", "cache.json"),
    ]
    for old_name, new_name in migrations:
        old_path = os.path.join(ZIM_DIR, old_name)
        new_path = os.path.join(ZIMI_DATA_DIR, new_name)
        if os.path.exists(old_path) and not os.path.exists(new_path):
            try:
                os.makedirs(ZIMI_DATA_DIR, exist_ok=True)
                shutil.copy2(old_path, new_path)
                os.remove(old_path)
                log.info("Migrated %s → %s", old_name, new_name)
            except OSError:
                pass

    # 2. Docker /data → /config rename (v1.5 → v1.6)
    #    Users who mounted /data in v1.5 and upgrade to v1.6 (which uses /config)
    if ZIMI_DATA_DIR == "/config" and os.path.isdir("/data") and not os.path.exists("/config/cache.json"):
        data_files = ["cache.json", "collections.json", "history.json",
                      "suggest_cache.json", "auto_update.json", "password"]
        migrated_any = False
        for fname in data_files:
            old = os.path.join("/data", fname)
            if os.path.exists(old) and not os.path.exists(os.path.join("/config", fname)):
                try:
                    os.makedirs("/config", exist_ok=True)
                    shutil.copy2(old, os.path.join("/config", fname))
                    migrated_any = True
                except OSError:
                    pass
        old_titles = "/data/titles"
        if os.path.isdir(old_titles) and not os.path.isdir("/config/titles"):
            try:
                shutil.copytree(old_titles, "/config/titles")
                migrated_any = True
            except OSError:
                pass
        if migrated_any:
            log.info("Migrated config from /data → /config (v1.6 rename)")

    # 3. Cross-directory migration: ZIM_DIR/.zimi → new ZIMI_DATA_DIR
    #    Triggered when ZIMI_DATA_DIR is set to a different path
    old_data_dir = os.path.join(ZIM_DIR, ".zimi")
    if os.path.normpath(ZIMI_DATA_DIR) != os.path.normpath(old_data_dir) and os.path.isdir(old_data_dir):
        # Only migrate if new data dir has no cache yet (fresh destination)
        if not os.path.exists(os.path.join(ZIMI_DATA_DIR, "cache.json")):
            data_files = ["cache.json", "collections.json", "history.json",
                          "suggest_cache.json", "auto_update.json", "password"]
            for fname in data_files:
                old = os.path.join(old_data_dir, fname)
                new = os.path.join(ZIMI_DATA_DIR, fname)
                if os.path.exists(old) and not os.path.exists(new):
                    try:
                        shutil.copy2(old, new)
                        log.info("Migrated %s → %s", old, new)
                    except OSError:
                        pass
            # Migrate titles/ directory (title indexes)
            old_titles = os.path.join(old_data_dir, "titles")
            new_titles = os.path.join(ZIMI_DATA_DIR, "titles")
            if os.path.isdir(old_titles) and not os.path.isdir(new_titles):
                try:
                    shutil.copytree(old_titles, new_titles)
                    log.info("Migrated titles/ → %s", new_titles)
                except OSError:
                    pass

# ============================================================================
# Constants & Shared Utilities
# ============================================================================

# (Password & Authentication → zimi/manage.py)
# (Rate Limiting, Metrics & Usage → zimi/http.py)

MAX_CONTENT_LENGTH = 8000  # chars returned per article, keeps responses manageable for LLMs
READ_MAX_LENGTH = 50000    # longer limit for the web UI reader
MAX_SEARCH_LIMIT = 50      # upper bound for search results per ZIM to prevent resource exhaustion
MAX_CONTENT_BYTES = 10 * 1024 * 1024  # 10 MB — skip snippet extraction for entries larger than this
MAX_SERVE_BYTES = 50 * 1024 * 1024    # 50 MB — refuse to serve entries larger than this (prevents OOM)
MAX_POST_BODY = 65536                 # max bytes accepted in POST requests (64KB — handles ~500 URLs for batch resolve)
_BYTES_PER_GB = 1024 ** 3

def _atomic_write_json(path, data, indent=None):
    """Write JSON data to a file atomically via temp file + os.replace().

    Used for all persistent state files to prevent corruption from
    crashes or concurrent writes. indent=None for compact output.
    """
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent, separators=(",", ":") if indent is None else None)
        os.replace(tmp, path)
    except OSError as e:
        log.warning("Atomic write failed for %s: %s", path, e)
# MIME type fallback for ZIM entries with empty mimetype
MIME_FALLBACK = {
    ".html": "text/html", ".htm": "text/html", ".css": "text/css",
    ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".ico": "image/x-icon", ".pdf": "application/pdf",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject", ".otf": "font/otf",
    ".xml": "application/xml", ".txt": "text/plain",
    ".wasm": "application/wasm", ".bcmap": "application/octet-stream",
    ".properties": "text/plain", ".ftl": "text/plain",
    ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".opus": "audio/opus", ".flac": "audio/flac",
    ".vtt": "text/vtt", ".srt": "text/plain",
}

def _namespace_fallbacks(path):
    """Generate alternative paths for old/new namespace ZIM compatibility.
    Old ZIMs use A/ (articles), I/ (images), C/ (CSS), -/ (metadata) prefixes.
    New ZIMs dropped them. Try stripping or adding prefixes to find the entry."""
    prefixes = ("A/", "I/", "C/", "-/")
    for p in prefixes:
        if path.startswith(p):
            yield path[len(p):]  # strip prefix
            return
    for p in prefixes:
        yield p + path  # add prefix

def _categorize_zim(name):
    """Auto-categorize a ZIM by name pattern. Ordered rules, first match wins. None if unknown."""
    n = name.lower()
    # Medical — before Wikimedia so wikipedia_en_medicine categorizes correctly
    if ("medicine" in n or n == "wikem" or "ready.gov" in n
            or (n.startswith("zimgit-") and any(k in n for k in ("water", "food", "disaster")))):
        return "Medical"
    # Stack Exchange — check before Wikimedia (some SEs have wiki-adjacent names)
    if n in ("stackoverflow", "askubuntu", "superuser", "serverfault") or "stackexchange" in n:
        return "Stack Exchange"
    # Dev Docs
    if n.startswith("devdocs_") or n == "freecodecamp":
        return "Dev Docs"
    # Education
    if (n.startswith("ted_") or n.startswith("phzh_")
            or n in ("crashcourse", "phet", "appropedia", "artofproblemsolving", "edutechwiki", "explainxkcd", "coreeng1")):
        return "Education"
    # How-To — before Wikimedia so wikihow doesn't match wiki*
    if n in ("wikihow", "ifixit") or "off-the-grid" in n or "knots" in n:
        return "How-To"
    # Wikimedia — broad wiki* catch-all (wikt* for wiktionary)
    if n.startswith(("wiki", "wikt")) or n == "openstreetmap-wiki":
        return "Wikimedia"
    # Books
    if n in ("gutenberg", "rationalwiki", "theworldfactbook"):
        return "Books"
    return None


# ============================================================================
# History, Favorites & Collections
# ============================================================================

_history_lock = threading.Lock()
_HISTORY_MAX = 500


def _history_file_path():
    return os.path.join(ZIMI_DATA_DIR, "history.json")


def _load_history():
    """Load event history from disk. Returns list of event dicts, newest first."""
    try:
        with open(_history_file_path()) as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return []


def _append_history(event):
    """Append an event dict to persistent history. Thread-safe."""
    with _history_lock:
        entries = _load_history()
        entries.insert(0, event)
        if len(entries) > _HISTORY_MAX:
            entries = entries[:_HISTORY_MAX]
    # Write outside lock — I/O can be slow on NAS spinning disks
    _atomic_write_json(_history_file_path(), entries)


_collections_lock = threading.Lock()

def _collections_file_path():
    """Path to the collections/favorites JSON file."""
    return os.path.join(ZIMI_DATA_DIR, "collections.json")

def _load_collections():
    """Load collections from disk. Returns default structure if missing."""
    try:
        with open(_collections_file_path()) as f:
            data = json.load(f)
        if data.get("version") != 1:
            return {"version": 1, "favorites": [], "collections": {}}
        return data
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return {"version": 1, "favorites": [], "collections": {}}

def _save_collections(data):
    """Save collections to disk (atomic write via rename)."""
    data["version"] = 1
    _atomic_write_json(_collections_file_path(), data, indent=2)

_ISO639_3_TO_1 = {
    "eng": "en", "fra": "fr", "deu": "de", "spa": "es", "por": "pt",
    "rus": "ru", "zho": "zh", "jpn": "ja", "kor": "ko", "ara": "ar",
    "hin": "hi", "ita": "it", "nld": "nl", "pol": "pl", "tur": "tr",
    "vie": "vi", "tha": "th", "swe": "sv", "nor": "no", "dan": "da",
    "fin": "fi", "ces": "cs", "ron": "ro", "hun": "hu", "ell": "el",
    "heb": "he", "ukr": "uk", "cat": "ca", "ind": "id", "msa": "ms",
    "fas": "fa", "ben": "bn", "tam": "ta", "tel": "te", "urd": "ur",
    "mul": "mul",  # multiple languages (keep as-is)
}

# ============================================================================
# ZIM Loading & Title Index
# ============================================================================

# Opening ZIM archives is expensive (~0.3s each on NAS spinning disks).
# Persistent cache in .zimi_cache.json enables instant startup on subsequent runs.
# Archives are opened lazily (on first search/read) instead of all at once.
_CACHE_VERSION = 2  # bumped for language metadata
_zim_list_cache = None
_zim_files_cache = None  # {name: path} — cached at startup, ZIM dir is read-only
_cache_generation = 0   # incremented on load_cache(force=True) — used in ETags
_archive_pool = {}  # {name: Archive} — kept open for fast search
_archive_lock = threading.Lock()  # protects _archive_pool writes in threaded mode
_zim_lock = threading.Lock()      # serializes all libzim operations (C library is NOT thread-safe)
# Lock ordering: _zim_lock → _archive_lock (never acquire _zim_lock while holding _archive_lock)

# Separate archive handles for suggestion search — allows title lookups to run in
# parallel with Xapian FTS by using independent C++ Archive objects + their own lock.
# Each ZIM gets its own lock so multi-ZIM scoped searches can query in parallel.
_suggest_pool = {}   # {name: Archive} — independent handles for SuggestionSearcher
_suggest_pool_lock = threading.Lock()  # protects _suggest_pool writes
_suggest_zim_locks = {}  # {name: Lock} — per-ZIM lock for suggestion operations

# Separate archive handles for full-text search — allows parallel Xapian FTS across ZIMs.
# Same pattern as _suggest_pool: each ZIM gets its own Archive + Lock.
_fts_pool = {}       # {name: Archive}
_fts_pool_lock = threading.Lock()
_fts_zim_locks = {}  # {name: Lock}

# Asset extensions to skip when indexing — images, fonts, scripts, not articles
_ASSET_EXTS = frozenset((
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif',
    '.css', '.js', '.json', '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.ogg', '.wav', '.webm',
))

# ============================================================================
# Wikidata Q-ID Matching — see zimi/interlang.py


# (Q-ID code extracted to interlang.py)
# (UI Templates extracted to zimi/http.py)

# ============================================================================
# ZIM File Discovery
# ============================================================================


def _zim_short_name(filename):
    """Derive short display name from a ZIM filename.

    English ZIMs strip the language code (backward-compatible):
      stackoverflow.com_en_all_2023-11.zim → stackoverflow
      wikipedia_en_all_maxi_2026-02.zim → wikipedia

    Non-English ZIMs preserve the language suffix:
      wikipedia_fr_all_maxi_2026-02.zim → wikipedia_fr
      stackoverflow.com_es_all_2024-01.zim → stackoverflow_es
    """
    name = filename.split(".zim")[0]
    # Extract language code before stripping (e.g. _fr_, _de_, _es_)
    lang_match = re.search(r'(?:\.com)?_([a-z]{2,3})_(?:all|maxi|2\d{3})', name)
    lang_code = lang_match.group(1) if lang_match else ""
    is_english = lang_code in ("en", "eng", "")
    # Strip domain suffixes
    name = re.sub(r"\.com_[a-z]{2,3}_all.*", "", name)
    name = re.sub(r"\.stackexchange\.com_[a-z]{2,3}_all.*", "", name)
    # Strip language + flavor + date patterns
    # Only strip _XX_ or _XXX_ when followed by all/maxi/nopic/mini/date (not arbitrary words like css/git)
    name = re.sub(r"_[a-z]{2,3}_all_maxi.*", "", name)
    name = re.sub(r"_[a-z]{2,3}_all.*", "", name)
    name = re.sub(r"_[a-z]{2,3}_(?:maxi|nopic|mini).*", "", name)
    name = re.sub(r"_[a-z]{2}_2\d{3}.*", "", name)  # Only 2-letter codes before dates (avoids css/git)
    name = re.sub(r"_maxi_2\d{3}.*", "", name)
    name = re.sub(r"_2\d{3}-\d{2}$", "", name)
    # Append language suffix for non-English ZIMs
    if not is_english and lang_code:
        # Normalize 3-letter to 2-letter
        short_lang = _ISO639_3_TO_1.get(lang_code, lang_code if len(lang_code) == 2 else "")
        if short_lang and short_lang != "en":
            name = name + "_" + short_lang
    return name


def _scan_zim_files():
    """Scan filesystem for ZIM files. Returns {short_name: path} mapping.

    When two files produce the same short name (e.g. maxi vs mini flavors),
    the larger file wins so the richest content is served.
    """
    zims = {}
    for path in sorted(glob.glob(os.path.join(ZIM_DIR, "*.zim"))):
        filename = os.path.basename(path)
        name = _zim_short_name(filename)
        if name in zims:
            existing = zims[name]
            try:
                existing_size = os.path.getsize(existing)
                new_size = os.path.getsize(path)
            except OSError:
                existing_size = new_size = 0
            if new_size > existing_size:
                log.info("ZIM name collision '%s': %s (%.1f GB) replaces %s (%.1f GB)",
                         name, filename, new_size / _BYTES_PER_GB,
                         os.path.basename(existing), existing_size / _BYTES_PER_GB)
                zims[name] = path
            else:
                log.info("ZIM name collision '%s': keeping %s (%.1f GB), skipping %s (%.1f GB)",
                         name, os.path.basename(existing), existing_size / _BYTES_PER_GB,
                         filename, new_size / _BYTES_PER_GB)
        else:
            zims[name] = path
    return zims


def get_zim_files():
    """Get ZIM file mapping. Uses startup cache (ZIM dir is read-only mount)."""
    global _zim_files_cache
    if _zim_files_cache is not None:
        return _zim_files_cache
    _zim_files_cache = _scan_zim_files()
    return _zim_files_cache



def open_archive(path):
    """Open a ZIM archive."""
    return Archive(path)


from zimi.previews import strip_html, _extract_preview, _resolve_img_path  # noqa: E402


# ============================================================================
# ZIM Listing & Metadata Cache
# ============================================================================

def list_zims(use_cache=True):
    """List all available ZIM files with metadata. Uses startup cache when available."""
    global _zim_list_cache
    if use_cache and _zim_list_cache is not None:
        return _zim_list_cache

    zims = get_zim_files()
    info = []
    for name, path in zims.items():
        size_gb = os.path.getsize(path) / (1024 ** 3)
        try:
            archive = open_archive(path)
            entry_count = archive.entry_count
        except Exception as e:
            log.debug("Failed to open archive for listing %s: %s", name, e)
            entry_count = "?"
        info.append({
            "name": name,
            "file": os.path.basename(path),
            "size_gb": round(size_gb, 3),
            "entries": entry_count,
        })
    return info


def get_archive(name):
    """Get a cached archive handle, or open it fresh. Thread-safe."""
    if name in _archive_pool:
        return _archive_pool[name]
    zims = get_zim_files()
    if name in zims:
        with _archive_lock:
            # Double-check after acquiring lock
            if name in _archive_pool:
                return _archive_pool[name]
            try:
                archive = open_archive(zims[name])
            except (RuntimeError, Exception) as e:
                log.warning(f"Skipping corrupt ZIM '{name}': {e}")
                return None
            _archive_pool[name] = archive
            return archive
    return None


def _cache_file_path():
    """Path to the persistent metadata cache file."""
    return os.path.join(ZIMI_DATA_DIR, "cache.json")


def _load_disk_cache():
    """Load persistent metadata cache from disk. Returns {filename: metadata} or None."""
    try:
        with open(_cache_file_path()) as f:
            data = json.load(f)
        if data.get("version") != _CACHE_VERSION:
            return None
        return data.get("files", {})
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def _save_disk_cache(file_cache):
    """Save metadata cache to disk (atomic write via rename)."""
    data = {
        "version": _CACHE_VERSION,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": file_cache,
    }
    _atomic_write_json(_cache_file_path(), data, indent=2)


def _extract_zim_date(filename):
    """Extract the date portion from a ZIM filename. Returns (base_name, date_str) or (base_name, None)."""
    m = re.search(r'_(\d{4}-\d{2})\.zim$', filename)
    if m:
        base = filename[:m.start()]
        return base, m.group(1)
    return filename.replace('.zim', ''), None


def _extract_zim_metadata(name, path):
    """Open a ZIM archive and extract its metadata. Returns (info_dict, archive)."""
    size_gb = os.path.getsize(path) / (1024 ** 3)
    meta_title = name
    meta_desc = ""
    meta_date = ""
    meta_lang = ""
    has_icon = False
    main_path = ""
    archive = None
    try:
        archive = open_archive(path)
        entry_count = archive.entry_count
        for key in archive.metadata_keys:
            try:
                val = bytes(archive.get_metadata(key))
                if key == "Title":
                    meta_title = val.decode("utf-8", errors="replace").strip() or name
                elif key == "Description":
                    meta_desc = val.decode("utf-8", errors="replace").strip()
                elif key == "Date":
                    meta_date = val.decode("utf-8", errors="replace").strip()
                elif key == "Language":
                    raw_lang = val.decode("utf-8", errors="replace").strip().lower()
                    # Handle multilingual ZIMs (comma-separated codes)
                    if "," in raw_lang:
                        parts = [p.strip() for p in raw_lang.split(",") if p.strip()]
                        meta_lang = ",".join(_ISO639_3_TO_1.get(p, p) for p in parts)
                    else:
                        meta_lang = _ISO639_3_TO_1.get(raw_lang, raw_lang)
                elif key.startswith("Illustration_48x48"):
                    has_icon = True
            except Exception as e:
                log.debug("Failed to read metadata key %r for %s: %s", key, name, e)
                pass
        try:
            me = archive.main_entry
            if me.is_redirect:
                me = me.get_redirect_entry()
            main_path = me.path
        except Exception as e:
            log.debug("Failed to read main entry for %s: %s", name, e)
            pass
    except Exception as e:
        log.debug("Failed to open archive for metadata extraction %s: %s", name, e)
        entry_count = "?"
    # Fall back to date from filename if not in metadata
    if not meta_date:
        _, file_date = _extract_zim_date(os.path.basename(path))
        if file_date:
            meta_date = file_date
    # Fall back to language from filename (e.g. wikipedia_fr_all → "fr")
    if not meta_lang:
        m = re.match(r'^[a-zA-Z]+(?:\.\w+)*_([a-z]{2,3})_', os.path.basename(path))
        if m:
            code = m.group(1)
            meta_lang = _ISO639_3_TO_1.get(code, code)
    info = {
        "name": name,
        "file": os.path.basename(path),
        "size_gb": round(size_gb, 3),
        "entries": entry_count,
        "title": meta_title,
        "description": meta_desc,
        "date": meta_date,
        "language": meta_lang,
        "has_icon": has_icon,
        "category": _categorize_zim(name),
        "main_path": main_path,
    }
    return info, archive


def load_cache(force=False):
    """Load ZIM metadata, using persistent disk cache for instant startup.

    On first run: scans all ZIMs (slow), saves cache to .zimi_cache.json.
    On subsequent runs: reads cache, validates mtimes, only re-scans changed files.
    Archives are opened lazily on first access, not at startup.
    """
    _init()
    global _zim_list_cache, _zim_files_cache, _cache_generation
    t0 = time.time()
    _zim_files_cache = _scan_zim_files()
    if force:
        _cache_generation += 1
    zims = _zim_files_cache

    disk_cache = None if force else _load_disk_cache()

    info = []
    scanned = 0
    file_cache = {}  # for saving back to disk

    for name, path in zims.items():
        filename = os.path.basename(path)
        try:
            stat = os.stat(path)
            mtime = stat.st_mtime
            size = stat.st_size
        except OSError:
            continue

        cached = disk_cache.get(filename) if disk_cache else None
        if cached and cached.get("mtime") == mtime and cached.get("size") == size:
            # Cache hit — use stored metadata, skip opening archive
            entry = {
                "name": name,
                "file": filename,
                "size_gb": cached.get("size_gb", round(size / (1024 ** 3), 3)),
                "entries": cached.get("entries", "?"),
                "title": cached.get("title", name),
                "description": cached.get("description", ""),
                "date": cached.get("date", ""),
                "language": cached.get("language", ""),
                "has_icon": cached.get("has_icon", False),
                "category": _categorize_zim(name),
                "main_path": cached.get("main_path", ""),
            }
            if "has_qids" in cached:
                entry["has_qids"] = cached["has_qids"]
            info.append(entry)
            file_cache[filename] = cached
        else:
            # Cache miss — scan this ZIM
            entry, archive = _extract_zim_metadata(name, path)
            if archive and entry.get("entries") != "?":
                _archive_pool[name] = archive
            info.append(entry)
            scanned += 1
            file_cache[filename] = {
                "name": name,
                "mtime": mtime,
                "size": size,
                "size_gb": entry["size_gb"],
                "entries": entry["entries"],
                "title": entry["title"],
                "description": entry["description"],
                "date": entry.get("date", ""),
                "language": entry.get("language", ""),
                "has_icon": entry["has_icon"],
                "main_path": entry["main_path"],
            }

    _zim_list_cache = info
    elapsed = time.time() - t0

    # Persist cache if we scanned anything new
    if scanned > 0 or disk_cache is None:
        _save_disk_cache(file_cache)

    cached_count = len(info) - scanned
    if cached_count > 0 and scanned > 0:
        print(f"  Cache loaded: {len(info)} ZIMs ({cached_count} cached, {scanned} scanned) in {elapsed:.1f}s", flush=True)
    elif scanned > 0:
        print(f"  Cache built: {len(info)} ZIMs scanned in {elapsed:.1f}s", flush=True)
    elif len(info) > 0:
        print(f"  Cache loaded: {len(info)} ZIMs from disk cache in {elapsed:.1f}s", flush=True)
    else:
        print(f"  No ZIM files found in {ZIM_DIR}", flush=True)
        if os.path.isdir(ZIM_DIR):
            # Check if ZIMs are in subdirectories (common mistake)
            import glob as _g
            sub_zims = _g.glob(os.path.join(ZIM_DIR, "**", "*.zim"), recursive=True)
            if sub_zims:
                print(f"  Found {len(sub_zims)} ZIM file(s) in subdirectories — move them to {ZIM_DIR}/ (Zimi doesn't scan subdirectories)", flush=True)
        else:
            print(f"  Directory {ZIM_DIR} does not exist — check your volume mount", flush=True)

    # Rebuild domain map whenever ZIM list changes
    _build_domain_zim_map()


# (HTTP Request Handler extracted to zimi/http.py)


# ============================================================================
# CLI & Entry Points (ZimHandler class → zimi/http.py)
# ============================================================================


def main():
    parser = argparse.ArgumentParser(description="ZIM Knowledge Base Reader")
    sub = parser.add_subparsers(dest="command")

    p_search = sub.add_parser("search", help="Full-text search across ZIM files")
    p_search.add_argument("query", help="Search query")
    p_search.add_argument("--limit", type=int, default=5)
    p_search.add_argument("--zim", help="Search specific ZIM only")

    p_read = sub.add_parser("read", help="Read an article")
    p_read.add_argument("zim", help="ZIM short name")
    p_read.add_argument("path", help="Article path within ZIM")
    p_read.add_argument("--max-length", type=int, default=MAX_CONTENT_LENGTH)

    p_suggest = sub.add_parser("suggest", help="Title autocomplete")
    p_suggest.add_argument("query")
    p_suggest.add_argument("--zim", help="Specific ZIM")
    p_suggest.add_argument("--limit", type=int, default=10)

    sub.add_parser("list", help="List available ZIM files")

    p_serve = sub.add_parser("serve", help="Start HTTP API server")
    p_serve.add_argument("--port", type=int, default=8899)
    p_serve.add_argument("--ui", action="store_true", help="Open in a native desktop window (requires pywebview)")

    sub.add_parser("desktop", help="Start server and open in a native desktop window (requires pywebview)")

    args = parser.parse_args()

    if args.command == "search":
        results = search_all(args.query, limit=args.limit, filter_zim=args.zim)
        print(json.dumps(results, indent=2, ensure_ascii=False))

    elif args.command == "read":
        result = read_article(args.zim, args.path, max_length=args.max_length)
        if "error" in result:
            print(json.dumps(result, indent=2), file=sys.stderr)
            sys.exit(1)
        # Print content directly for LLM consumption
        print(f"# {result['title']}")
        print(f"Source: {result['zim']} / {result['path']}")
        if result["truncated"]:
            print(f"(Showing {args.max_length} of {result['full_length']} chars)")
        print()
        print(result["content"])

    elif args.command == "suggest":
        results = suggest(args.query, zim_name=args.zim, limit=args.limit)
        print(json.dumps(results, indent=2, ensure_ascii=False))

    elif args.command == "list":
        load_cache()
        zims = list_zims()
        for z in zims:
            entries = z['entries'] if isinstance(z['entries'], int) else 0
            print(f"  {z['name']:40s} {z['size_gb']:>8.1f} GB  {entries:>10} entries  ({z['file']})")

    elif args.command == "desktop" or (args.command == "serve" and args.ui):
        try:
            from zimi_desktop import main as desktop_main
        except ImportError:
            print("Desktop mode requires pywebview: pip install pywebview", file=sys.stderr)
            sys.exit(1)
        desktop_main()

    elif args.command == "serve":
        print(f"ZIM Reader API starting on port {args.port}")
        print(f"ZIM directory: {ZIM_DIR}")
        load_cache()
        # Clean up stale partial downloads (>24h old)
        for tmp in glob.glob(os.path.join(ZIM_DIR, "*.zim.tmp")):
            try:
                age = time.time() - os.path.getmtime(tmp)
                if age > 86400:
                    os.remove(tmp)
                    log.info("Cleaned up stale partial download: %s", os.path.basename(tmp))
                else:
                    log.info("Partial download found (resumable): %s", os.path.basename(tmp))
            except OSError:
                pass
        # Pre-warm all archive handles so first search is fast
        zims = get_zim_files()
        log.info("Pre-warming %d archives...", len(zims))
        for name in zims:
            try:
                get_archive(name)
            except Exception as e:
                log.warning("Skipping %s: %s", name, e)
        log.info("All archives ready")
        # Pre-warm suggestion indexes in background (loads B-tree pages into OS cache).
        # Uses throwaway Archive handles so it never holds _suggest_op_lock — user
        # fast searches can proceed immediately even while warm-up is running.
        def _warm_suggest_indexes():
            from concurrent.futures import ThreadPoolExecutor
            zim_files = get_zim_files()
            warmed = [0]
            count_lock = threading.Lock()

            def _warm_one(name, path):
                try:
                    # Pre-open suggest pool handle (fast, no index I/O)
                    _get_suggest_archive(name)
                    # Warm B-tree pages into OS page cache via throwaway handle
                    archive = open_archive(path)
                    ss = SuggestionSearcher(archive)
                    s = ss.suggest("a")
                    s.getResults(0, 1)
                    with count_lock:
                        warmed[0] += 1
                except Exception as e:
                    log.debug("Failed to warm suggest index for %s: %s", name, e)
                    pass

            # Parallel warmup — 4 workers keeps disk busy without
            # overwhelming spinning disk seek capacity
            with ThreadPoolExecutor(max_workers=4) as pool:
                for name, path in zim_files.items():
                    pool.submit(_warm_one, name, path)
            log.info("Suggestion indexes warmed: %d/%d", warmed[0], len(zim_files))
        threading.Thread(target=_warm_suggest_indexes, daemon=True).start()
        # Pre-warm FTS pool in background (opens per-ZIM Archive handles for parallel Xapian search)
        def _warm_fts_pool():
            zim_files = get_zim_files()
            for name in zim_files:
                try:
                    _get_fts_archive(name)
                except Exception as e:
                    log.debug("Failed to warm FTS archive for %s: %s", name, e)
                    pass
            log.info("FTS pool warmed: %d archives", len(_fts_pool))
        threading.Thread(target=_warm_fts_pool, daemon=True).start()
        # Build SQLite title indexes in background (one-time per ZIM, enables <10ms title search)
        threading.Thread(target=_build_all_title_indexes, daemon=True).start()
        # Build Wikidata Q-ID indexes + detect has_qids for all ZIMs (background)
        threading.Thread(target=_build_all_qid_indexes, daemon=True).start()
        # Pre-warm title index B-tree pages for fast first queries
        # For each ZIM, read a few rows at scattered prefixes (a, m, s) to pull
        # B-tree branch pages into OS page cache. Reads ~10-50KB per ZIM total
        # (3 branch paths × a few pages each) — far less than the full indexes.
        def _warm_title_indexes():
            zim_files = get_zim_files()
            opened = 0
            for name in zim_files:
                conn = _get_title_db(name)
                if conn is not None:
                    try:
                        for prefix in ("a", "m", "s"):
                            conn.execute(
                                "SELECT title FROM titles WHERE title_lower >= ? LIMIT 1",
                                (prefix,)
                            ).fetchone()
                    except Exception as e:
                        log.debug("Failed to warm title index B-tree for %s: %s", name, e)
                        pass
                    opened += 1
            log.info("Title indexes warmed: %d/%d", opened, len(zim_files))
        threading.Thread(target=_warm_title_indexes, daemon=True).start()
        # Restore suggest cache from disk (instant warm queries after restart)
        loaded = _suggest_cache_restore()
        if loaded:
            log.info("Suggest cache restored: %d entries", loaded)
        # Start auto-update thread if enabled
        # Use module-level assignment so manage.py can check _srv._auto_update_thread
        global _auto_update_thread
        if _auto_update_enabled:
            _auto_update_thread = threading.Thread(target=_auto_update_loop, daemon=True)
            _auto_update_thread.start()
        print(f"Endpoints: /search, /read, /suggest, /list, /health")
        if ZIMI_MANAGE:
            if _get_manage_password_hash():
                log.info("Library management enabled (password protected)")
            else:
                log.info("Library management enabled (no password — set one in Settings for public servers)")
        server = ThreadingHTTPServer(("0.0.0.0", args.port), ZimHandler)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            _suggest_cache_persist()
            log.info("Suggest cache saved to disk")

    else:
        parser.print_help()


# ============================================================================
# Re-exports from extracted modules
# ============================================================================
# These keep ``zimi.server.search_all`` etc. working so callers (tests,
# mcp_server.py, handler code still in this file) need zero changes.

from zimi.search import (  # noqa: E402, F401
    # Search / suggest caches (dicts + constants + functions)
    _search_cache, SEARCH_CACHE_MAX,
    _search_cache_get, _search_cache_put, _search_cache_clear,
    _suggest_cache,
    _suggest_cache_get, _suggest_cache_put, _suggest_cache_clear,
    _suggest_cache_persist, _suggest_cache_restore,
    # SQLite pooling helpers (used by Q-ID code above)
    _get_pooled_db, _close_pooled_db, _index_is_current,
    # Title index
    _get_title_db, _close_title_db, _title_index_path,
    _title_index_is_current, _build_title_index, _build_fts_for_index,
    _title_index_search, _get_title_index_stats,
    _build_all_title_indexes, _clean_stale_title_indexes,
    # Archive pools for suggest/FTS
    _get_suggest_archive, _get_fts_archive, _get_pooled_archive,
    # Search functions
    suggest_search_zim, search_zim, _score_result, _clean_query,
    search_all, read_article, suggest, extract_pdf_text,
    get_catalog, parse_catalog,
    # Content serving & discover
    random_entry, _get_dated_entry, _xkcd_date_lookup,
    _pick_html_entry, _get_factbook_countries,
    # Constants & compiled patterns (used by tests)
    _meta_title_re, STOP_WORDS,
)

from zimi.interlang import (  # noqa: E402, F401
    # Language data
    _LANG_NATIVE_NAMES, _STOPWORDS, _detect_query_language,
    # Q-ID matching
    _build_all_qid_indexes, _qid_passive_cache, _qid_passive_extract,
    _qid_lookup, _qid_extract_from_html, _qid_cache_store,
    _qid_find_in_zim, _qid_has_index,
    # Cross-ZIM resolution
    _domain_zim_map, _xzim_refs, _xzim_refs_lock,
    _build_domain_zim_map, _resolve_url_to_zim,
    # Article language matching
    get_article_languages, _zim_project_name, _zim_quality_score,
    _find_article_in_lang_zims,
)

from zimi.library import (  # noqa: E402, F401
    # Auto-update
    _AUTO_UPDATE_CONFIG, _auto_update_env_locked,
    _load_auto_update_config, _save_auto_update_config,
    _auto_update_enabled, _auto_update_freq, _auto_update_last_check,
    _auto_update_thread, _auto_update_loop, _FREQ_SECONDS,
    # Downloads & catalog
    _active_downloads, _download_lock, _download_counter,
    _opds_cache, _OPDS_CACHE_TTL,
    _start_download, _start_import, _get_downloads,
    _fetch_kiwix_catalog, _check_updates,
    _fetch_thumb, _clear_thumb_cache, _thumb_dir,
    _download_thread, _fetch_mirrors, _download_from_url,
    _title_from_filename, KIWIX_OPDS_BASE,
)

from zimi.manage import (  # noqa: E402, F401
    # Password & authentication
    _hash_pw, _PW_ITERATIONS,
    _env_pw_hash_cache, _get_manage_password_hash,
    _api_token_file, _get_api_token, _generate_api_token, _revoke_api_token,
    _check_manage_auth,
    # Manage route handlers
    handle_manage_get, handle_manage_post,
)

from zimi.http import (  # noqa: E402, F401
    # Rate limiting
    RATE_LIMIT, RATE_LIMIT_CONTENT,
    _rate_buckets, _rate_buckets_content, _rate_lock,
    _check_rate_limit,
    # Metrics
    _metrics, _metrics_lock, _record_metric, _get_metrics,
    # Usage stats
    _usage_stats, _usage_lock, _record_usage, _get_usage_stats,
    _get_disk_usage,
    # UI templates
    COMPRESSIBLE_TYPES, SEARCH_UI_HTML,
    # HTTP handler
    ZimHandler,
)


if __name__ == "__main__":
    main()
