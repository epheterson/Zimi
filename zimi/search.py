"""Search, suggest, and content reading for ZIM files.

Handles search caching, SQLite title indexes, full-text search via Xapian,
suggestion search, and article content reading.
"""

import json
import logging
import math
import os
import re
import sqlite3
import threading
import time

from libzim.search import Query, Searcher
from libzim.suggestion import SuggestionSearcher

from zimi.previews import strip_html

log = logging.getLogger("zimi")


# ---------------------------------------------------------------------------
# Imports from server.py (core state)
# ---------------------------------------------------------------------------
# These are imported at module scope. Because server.py is always imported
# first (via __init__.py proxy), these names are available by the time any
# search function is called.  We import the *module* for mutable globals
# that we need to read (like _zim_list_cache) so we always see current values.

import zimi.server as _srv

# Functions/objects we call frequently — bind once for readability.
_zim_lock = None          # bound lazily (see _ensure_server_refs)
_archive_lock = None
_archive_pool = None
_suggest_pool = None
_suggest_pool_lock = None
_suggest_zim_locks = None
_fts_pool = None
_fts_pool_lock = None
_fts_zim_locks = None
_refs_bound = False


def _ensure_server_refs():
    """Lazily bind references to server.py's mutable globals.

    We can't do this at import time because server.py may still be executing
    when search.py is first imported (re-exports at the bottom of server.py).
    """
    global _zim_lock, _archive_lock, _archive_pool, _refs_bound
    global _suggest_pool, _suggest_pool_lock, _suggest_zim_locks
    global _fts_pool, _fts_pool_lock, _fts_zim_locks
    if _refs_bound:
        return
    _zim_lock = _srv._zim_lock
    _archive_lock = _srv._archive_lock
    _archive_pool = _srv._archive_pool
    _suggest_pool = _srv._suggest_pool
    _suggest_pool_lock = _srv._suggest_pool_lock
    _suggest_zim_locks = _srv._suggest_zim_locks
    _fts_pool = _srv._fts_pool
    _fts_pool_lock = _srv._fts_pool_lock
    _fts_zim_locks = _srv._fts_zim_locks
    _refs_bound = True


# ---------------------------------------------------------------------------
# Search & Suggest Caches (was section 5)
# ---------------------------------------------------------------------------

_search_cache = {}       # {key: {"result": ..., "created": float, "accesses": int}}
_search_cache_lock = threading.Lock()
SEARCH_CACHE_MAX = 100
SEARCH_CACHE_TTL = 900          # 15 minutes base
SEARCH_CACHE_TTL_ACTIVE = 1800  # 30 minutes if re-accessed


def _search_cache_get(key):
    """Get cached search result if still valid. Re-accessed entries get extended TTL."""
    with _search_cache_lock:
        entry = _search_cache.get(key)
        if not entry:
            return None
        ttl = SEARCH_CACHE_TTL_ACTIVE if entry["accesses"] > 0 else SEARCH_CACHE_TTL
        if time.time() - entry["created"] < ttl:
            entry["accesses"] += 1
            return entry["result"]
        del _search_cache[key]
    return None


def _search_cache_put(key, result):
    """Store search result in cache, evicting oldest if full."""
    now = time.time()
    with _search_cache_lock:
        if len(_search_cache) >= SEARCH_CACHE_MAX:
            oldest_key = min(_search_cache, key=lambda k: _search_cache[k]["created"])
            del _search_cache[oldest_key]
        _search_cache[key] = {"result": result, "created": now, "accesses": 0}


def _search_cache_clear():
    """Clear all cached search results (e.g. after library changes)."""
    with _search_cache_lock:
        _search_cache.clear()


_suggest_cache = {}       # {(query_lower, zim_name): {"results": [...], "ts": float}}
_suggest_cache_lock = threading.Lock()
_SUGGEST_CACHE_TTL = 900   # 15 minutes
_SUGGEST_CACHE_MAX = 500


def _suggest_cache_get(query_lower, zim_name):
    key = (query_lower, zim_name)
    with _suggest_cache_lock:
        entry = _suggest_cache.get(key)
        if not entry:
            return None
        if time.time() - entry["ts"] < _SUGGEST_CACHE_TTL:
            return entry["results"]
        del _suggest_cache[key]
    return None


_suggest_cache_puts = 0  # count puts since last persist


def _suggest_cache_put(query_lower, zim_name, results):
    global _suggest_cache_puts
    with _suggest_cache_lock:
        if len(_suggest_cache) >= _SUGGEST_CACHE_MAX:
            oldest = min(_suggest_cache, key=lambda k: _suggest_cache[k]["ts"])
            del _suggest_cache[oldest]
        _suggest_cache[(query_lower, zim_name)] = {"results": results, "ts": time.time()}
        _suggest_cache_puts += 1
        should_persist = (_suggest_cache_puts % 50 == 0)
    if should_persist:
        threading.Thread(target=_suggest_cache_persist, daemon=True).start()


def _suggest_cache_clear():
    global _factbook_countries_cache, _xkcd_date_cache_built
    _ensure_server_refs()
    with _suggest_cache_lock:
        _suggest_cache.clear()
    _suggest_cache_persist()
    with _suggest_pool_lock:
        _suggest_pool.clear()
        _suggest_zim_locks.clear()
    with _fts_pool_lock:
        _fts_pool.clear()
        _fts_zim_locks.clear()
    with _archive_lock:
        _archive_pool.clear()
    # Invalidate content-specific caches that depend on ZIM file contents
    _factbook_countries_cache = None
    _xkcd_date_cache_built = False
    # Clear OPDS catalog cache (forces re-fetch from Kiwix)
    # Import here to avoid circular import at module load time.
    # Guard with try/except: library.py may not exist yet during extraction.
    try:
        from zimi.library import _opds_cache, _clear_thumb_cache
        _opds_cache.clear()
        _clear_thumb_cache()
    except ImportError:
        pass


def _suggest_cache_persist():
    """Save suggest cache to disk so it survives restarts."""
    _SUGGEST_CACHE_PATH = os.path.join(_srv.ZIMI_DATA_DIR, "suggest_cache.json")
    try:
        with _suggest_cache_lock:
            data = {}
            for (q, zim), entry in _suggest_cache.items():
                data[f"{q}\t{zim}"] = entry
        if not data:
            # Nothing to save — remove stale file if it exists
            if os.path.exists(_SUGGEST_CACHE_PATH):
                os.remove(_SUGGEST_CACHE_PATH)
            return
        _srv._atomic_write_json(_SUGGEST_CACHE_PATH, data)
        log.debug("Suggest cache persisted: %d entries", len(data))
    except Exception as e:
        log.debug("Suggest cache persist failed: %s", e)


def _suggest_cache_restore():
    """Load suggest cache from disk on startup."""
    _SUGGEST_CACHE_PATH = os.path.join(_srv.ZIMI_DATA_DIR, "suggest_cache.json")
    try:
        if not os.path.exists(_SUGGEST_CACHE_PATH):
            return 0
        with open(_SUGGEST_CACHE_PATH) as f:
            data = json.load(f)
        now = time.time()
        loaded = 0
        with _suggest_cache_lock:
            for key_str, entry in data.items():
                # Skip expired entries
                if now - entry.get("ts", 0) > _SUGGEST_CACHE_TTL:
                    continue
                parts = key_str.split("\t", 1)
                if len(parts) == 2:
                    _suggest_cache[(parts[0], parts[1])] = entry
                    loaded += 1
        return loaded
    except Exception as e:
        log.debug("Failed to restore suggest cache: %s", e)
        return 0


# ---------------------------------------------------------------------------
# Title Index (was section 7)
# ---------------------------------------------------------------------------

_TITLE_INDEX_DIR = os.path.join(_srv.ZIMI_DATA_DIR, "titles")
_TITLE_INDEX_VERSION = "4"  # bump to force rebuild (v4: add FTS5 for multi-word search)
_FTS5_ENTRY_THRESHOLD = 2_000_000  # skip FTS5 build for ZIMs above this (can be triggered manually)
_FTS5_AUTO_BUILD_MAX_MB = 2500  # Max title-index size (MB) for auto FTS build at startup

# Connection pool: keep SQLite connections open to avoid per-query disk seeks.
_title_db_pool = {}       # {zim_name: sqlite3.Connection}
_title_db_pool_lock = threading.Lock()


def _get_pooled_db(zim_name, pool, pool_lock, path_fn):
    """Get a pooled SQLite connection, or None if no DB at path_fn(zim_name)."""
    with pool_lock:
        conn = pool.get(zim_name)
        if conn is not None:
            return conn
    db_path = path_fn(zim_name)
    if not os.path.exists(db_path):
        return None
    try:
        conn = sqlite3.connect(db_path, timeout=5, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA mmap_size=67108864")  # 64MB mmap for read perf
        with pool_lock:
            # Another thread may have raced us — use theirs, close ours
            if zim_name in pool:
                conn.close()
                return pool[zim_name]
            pool[zim_name] = conn
        return conn
    except Exception as e:
        log.debug("Failed to open pooled DB for %s: %s", zim_name, e)
        return None


def _close_pooled_db(zim_name, pool, pool_lock):
    """Close and remove a pooled connection (e.g. when index is rebuilt or ZIM deleted)."""
    with pool_lock:
        conn = pool.pop(zim_name, None)
    if conn:
        try:
            conn.close()
        except Exception as e:
            log.debug("Failed to close pooled DB for %s: %s", zim_name, e)
            pass


def _get_title_db(zim_name):
    """Get a pooled SQLite connection for a title index, or None if no index."""
    # Look up path_fn through _srv so test monkey-patches on server.py propagate
    path_fn = getattr(_srv, '_title_index_path', _title_index_path)
    return _get_pooled_db(zim_name, _title_db_pool, _title_db_pool_lock, path_fn)


def _close_title_db(zim_name):
    """Close and remove a pooled title index connection."""
    _close_pooled_db(zim_name, _title_db_pool, _title_db_pool_lock)


def _title_index_path(zim_name):
    return os.path.join(_TITLE_INDEX_DIR, f"{zim_name}.db")


def _index_is_current(db_path, zim_path, schema_version):
    """Check if a SQLite index exists, matches ZIM mtime, and is current schema version."""
    if not os.path.exists(db_path):
        return False
    try:
        zim_mtime = str(os.path.getmtime(zim_path))
        conn = sqlite3.connect(db_path, timeout=5)
        try:
            row = conn.execute("SELECT value FROM meta WHERE key='zim_mtime'").fetchone()
            ver = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            return (row is not None and row[0] == zim_mtime
                    and ver is not None and ver[0] == schema_version)
        finally:
            conn.close()
    except Exception as e:
        log.debug("Index currency check failed for %s: %s", db_path, e)
        return False


def _title_index_is_current(zim_name, zim_path):
    """Check if title index exists, matches ZIM mtime, and is current schema version."""
    path_fn = getattr(_srv, '_title_index_path', _title_index_path)
    return _index_is_current(path_fn(zim_name), zim_path, _TITLE_INDEX_VERSION)


def _build_title_index(zim_name, zim_path):
    """Build SQLite title index for a ZIM file.

    Opens a dedicated Archive handle (not from _archive_pool) so this is safe
    to run without _zim_lock. Commits in batches to keep memory low.
    """
    os.makedirs(_TITLE_INDEX_DIR, exist_ok=True)
    path_fn = getattr(_srv, '_title_index_path', _title_index_path)
    db_path = path_fn(zim_name)
    tmp_path = db_path + ".tmp"
    t0 = time.time()
    count = 0

    # Open dedicated archive handle — never touches shared pool
    archive = _srv.open_archive(zim_path)
    conn = sqlite3.connect(tmp_path)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=OFF")  # safe: tmp file, rebuilt on failure
        conn.execute("CREATE TABLE titles (path TEXT PRIMARY KEY, title TEXT, title_lower TEXT)")
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")

        batch = []
        total_entries = archive.all_entry_count
        for i in range(total_entries):
            try:
                entry = archive._get_entry_by_id(i)
                if entry.is_redirect:
                    continue
                path = entry.path
                # Skip asset paths by extension
                dot = path.rfind('.')
                if dot != -1 and path[dot:].lower() in _srv._ASSET_EXTS:
                    continue
                title = entry.title
                if not title:
                    continue
                batch.append((path, title, title.lower()))
                if len(batch) >= 10000:
                    conn.executemany("INSERT OR IGNORE INTO titles VALUES (?,?,?)", batch)
                    conn.commit()
                    count += len(batch)
                    batch.clear()
            except Exception as e:
                log.debug("Skipping entry %d in %s: %s", i, zim_name, e)
                continue

        if batch:
            conn.executemany("INSERT OR IGNORE INTO titles VALUES (?,?,?)", batch)
            count += len(batch)

        if count == 0:
            conn.close()
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            log.warning("Title index: %s has 0 indexable entries, skipping", zim_name)
            return

        conn.execute("CREATE INDEX idx_prefix ON titles(title_lower)")
        # FTS5 inverted index for multi-word search (finds words anywhere in title)
        # Skip for very large ZIMs — user can trigger manually from UI
        has_fts = "0"
        if count <= _FTS5_ENTRY_THRESHOLD:
            conn.execute("CREATE VIRTUAL TABLE titles_fts USING fts5(path UNINDEXED, title, tokenize='unicode61')")
            conn.execute("INSERT INTO titles_fts(path, title) SELECT path, title FROM titles")
            has_fts = "1"
        else:
            log.info("Title index: %s has %d entries, skipping FTS5 (above %d threshold)", zim_name, count, _FTS5_ENTRY_THRESHOLD)
        zim_mtime = str(os.path.getmtime(zim_path))
        conn.execute("INSERT INTO meta VALUES ('schema_version', ?)", (_TITLE_INDEX_VERSION,))
        conn.execute("INSERT INTO meta VALUES ('zim_mtime', ?)", (zim_mtime,))
        conn.execute("INSERT INTO meta VALUES ('built_at', ?)", (str(time.time()),))
        conn.execute("INSERT INTO meta VALUES ('entry_count', ?)", (str(count),))
        conn.execute("INSERT INTO meta VALUES ('has_fts', ?)", (has_fts,))
        conn.commit()
    except Exception:
        conn.close()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    else:
        conn.close()
        # Evict stale pooled connection before atomic replace
        _close_title_db(zim_name)
        # Atomic replace (os.replace is atomic on POSIX, avoids remove+rename race)
        os.replace(tmp_path, db_path)
        dt = time.time() - t0
        log.info("Title index: built %s (%d entries%s, %.1fs)", zim_name, count,
                 "" if has_fts == "1" else ", no FTS5", dt)


def _build_fts_for_index(zim_name):
    """Add FTS5 table to an existing title index that was built without one.
    This avoids re-scanning the ZIM file — just reads from the titles table."""
    close_fn = getattr(_srv, '_close_title_db', _close_title_db)
    path_fn = getattr(_srv, '_title_index_path', _title_index_path)
    close_fn(zim_name)
    db_path = path_fn(zim_name)
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"No title index for {zim_name}")
    t0 = time.time()
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        # Check if FTS5 already exists
        existing = conn.execute("SELECT name FROM sqlite_master WHERE name='titles_fts'").fetchone()
        if existing:
            conn.close()
            return {"status": "already_exists"}
        count = conn.execute("SELECT COUNT(*) FROM titles").fetchone()[0]
        conn.execute("CREATE VIRTUAL TABLE titles_fts USING fts5(path UNINDEXED, title, tokenize='unicode61')")
        conn.execute("INSERT INTO titles_fts(path, title) SELECT path, title FROM titles")
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('has_fts', '1')")
        conn.commit()
        conn.close()
        close_fn(zim_name)  # evict stale pooled connection
        dt = time.time() - t0
        log.info("Title index: built FTS5 for %s (%d entries, %.1fs)", zim_name, count, dt)
        return {"status": "built", "entries": count, "elapsed": round(dt, 1)}
    except Exception:
        conn.close()
        raise


def _title_index_search(zim_name, query, limit=10):
    """Search title index. Returns list or None if no index.

    For single-word queries: B-tree prefix range scan (instant, <1ms).
    For multi-word queries: FTS5 inverted index search — finds titles
    containing ALL query words regardless of position.

    Uses pooled connections to avoid per-query sqlite3.connect() overhead.
    """
    conn = _get_title_db(zim_name)
    if conn is None:
        return None  # no index or DB error → fallback to SuggestionSearcher
    q = query.lower().strip()
    if not q:
        return []
    words = q.split()
    try:
        if len(words) == 1:
            # Single word: B-tree prefix range scan
            q_upper = q[:-1] + chr(ord(q[-1]) + 1)
            rows = conn.execute(
                "SELECT path, title FROM titles WHERE title_lower >= ? AND title_lower < ? LIMIT ?",
                (q, q_upper, limit)
            ).fetchall()
            return [{"path": r[0], "title": r[1], "snippet": ""} for r in rows]
        else:
            # Multi-word: B-tree prefix on first word, then filter in Python.
            first_word = words[0]
            other_words = [w for w in words[1:]]
            first_upper = first_word[:-1] + chr(ord(first_word[-1]) + 1)
            # Fetch more candidates (10x limit) to filter down
            fetch_limit = limit * 20
            rows = conn.execute(
                "SELECT path, title FROM titles WHERE title_lower >= ? AND title_lower < ? LIMIT ?",
                (first_word, first_upper, fetch_limit)
            ).fetchall()
            # Filter: title must contain all other words
            results = []
            for path, title in rows:
                tl = title.lower()
                if all(w in tl for w in other_words):
                    results.append({"path": path, "title": title, "snippet": ""})
                    if len(results) >= limit:
                        break
            if results:
                return results
            # Prefix on first word found nothing — skip to SuggestionSearcher fallback
            return None
    except Exception as e:
        # Connection may be stale (e.g. DB was rebuilt) — evict and retry once
        log.debug("Title index search failed for %s query %r: %s", zim_name, query, e)
        getattr(_srv, '_close_title_db', _close_title_db)(zim_name)
        return None  # fallback on DB error


_title_index_status = {
    "state": "idle",       # idle | building | ready
    "building_now": None,  # zim name currently being built
    "built": 0,            # count built this session
    "total": 0,            # total ZIMs to index
    "ready": 0,            # indexes currently available
    "started_at": None,
    "finished_at": None,
    "errors": [],          # [(name, error_str)]
}
_title_index_status_lock = threading.Lock()


def _get_title_index_stats():
    """Return title index status + per-ZIM details for the stats API."""
    with _title_index_status_lock:
        status = dict(_title_index_status)
        status["errors"] = list(status["errors"])  # copy

    # Gather per-index file sizes and entry counts
    total_size = 0
    indexes = []
    if os.path.exists(_TITLE_INDEX_DIR):
        for f in sorted(os.listdir(_TITLE_INDEX_DIR)):
            if not f.endswith(".db"):
                continue
            db_path = os.path.join(_TITLE_INDEX_DIR, f)
            size = os.path.getsize(db_path)
            total_size += size
            name = f[:-3]
            # Read entry count and FTS5 status from meta (uses pool if available)
            entry_count = 0
            has_fts = False
            try:
                c = _get_title_db(name)
                if c:
                    row = c.execute("SELECT value FROM meta WHERE key='entry_count'").fetchone()
                    if row:
                        entry_count = int(row[0])
                    fts_row = c.execute("SELECT value FROM meta WHERE key='has_fts'").fetchone()
                    if fts_row:
                        has_fts = fts_row[0] == "1"
                    else:
                        # Legacy v4 indexes don't have has_fts key — check for table
                        tbl = c.execute("SELECT name FROM sqlite_master WHERE name='titles_fts'").fetchone()
                        has_fts = tbl is not None
            except Exception as e:
                log.debug("Failed to read title index stats for %s: %s", name, e)
                pass
            indexes.append({"name": name, "size_mb": round(size / (1024 * 1024), 1), "entries": entry_count, "has_fts": has_fts})

    status["total_size_gb"] = round(total_size / (1024 ** 3), 1)
    status["index_count"] = len(indexes)
    # Use live counts: ready = indexes on disk, total = ZIM files
    status["ready"] = len(indexes)
    status["total"] = len(_srv.get_zim_files())
    status["indexes"] = sorted(indexes, key=lambda x: -x["size_mb"])
    return status


def _build_all_title_indexes():
    """Build missing/stale title indexes for all ZIM files (background task)."""
    os.makedirs(_TITLE_INDEX_DIR, exist_ok=True)
    zims = _srv.get_zim_files()

    # Count how many are already current
    need_build = []
    current = 0
    for name, path in zims.items():
        if _title_index_is_current(name, path):
            current += 1
        else:
            need_build.append((name, path))

    with _title_index_status_lock:
        _title_index_status["total"] = len(zims)
        _title_index_status["ready"] = current
        if not need_build:
            _title_index_status["state"] = "ready"
            return
        _title_index_status["state"] = "building"
        _title_index_status["started_at"] = time.time()

    built = 0
    for name, path in need_build:
        with _title_index_status_lock:
            _title_index_status["building_now"] = name
        try:
            _build_title_index(name, path)
            built += 1
            with _title_index_status_lock:
                _title_index_status["ready"] += 1
                _title_index_status["built"] += 1
        except Exception as e:
            log.warning("Title index build failed for %s: %s", name, e)
            with _title_index_status_lock:
                _title_index_status["errors"].append((name, str(e)))

    with _title_index_status_lock:
        _title_index_status["state"] = "ready"
        _title_index_status["building_now"] = None
        _title_index_status["finished_at"] = time.time()

    if built:
        log.info("Title index: built %d new indexes", built)
    # Clean up indexes for ZIMs that no longer exist
    _clean_stale_title_indexes()
    # Pre-warm connection pool: open all DBs and touch B-tree root pages
    # so first search doesn't pay ~20s of cold disk seeks across 54 ZIMs
    t0 = time.time()
    warmed = 0
    for name in zims:
        conn = _get_title_db(name)
        if conn:
            try:
                conn.execute("SELECT 1 FROM titles LIMIT 1").fetchone()
                warmed += 1
            except Exception as e:
                log.debug("Failed to warm title index for %s: %s", name, e)
                pass
    log.info("Title index pool warmed: %d connections (%.1fs)", warmed, time.time() - t0)

    # Auto-build FTS5 for ZIMs where estimated build time < 5 minutes.
    # Index DB size < 2.5 GB correlates with ~5 min on spinning disk.
    auto_fts = 0
    for name in zims:
        conn = _get_title_db(name)
        if not conn:
            continue
        try:
            fts_row = conn.execute("SELECT value FROM meta WHERE key='has_fts'").fetchone()
        except Exception as e:
            log.debug("Failed to read FTS status for %s: %s", name, e)
            continue
        if fts_row and fts_row[0] == "1":
            continue
        db_path = _title_index_path(name)
        try:
            size_mb = os.path.getsize(db_path) / (1024 * 1024)
        except OSError:
            continue
        if size_mb < _FTS5_AUTO_BUILD_MAX_MB:
            try:
                with _title_index_status_lock:
                    _title_index_status["building_now"] = name
                    _title_index_status["state"] = "building"
                _build_fts_for_index(name)
                auto_fts += 1
            except Exception as e:
                log.warning("Auto FTS5 build failed for %s: %s", name, e)
    if auto_fts:
        log.info("Auto-built FTS5 for %d indexes", auto_fts)
    with _title_index_status_lock:
        _title_index_status["state"] = "ready"
        _title_index_status["building_now"] = None
        _title_index_status["finished_at"] = time.time()


def _clean_stale_title_indexes():
    """Remove title index DBs for ZIM files that no longer exist."""
    if not os.path.exists(_TITLE_INDEX_DIR):
        return
    zims = _srv.get_zim_files()
    for f in os.listdir(_TITLE_INDEX_DIR):
        if f.endswith(".db"):
            name = f[:-3]  # strip .db
            if name not in zims:
                _close_title_db(name)
                try:
                    os.remove(os.path.join(_TITLE_INDEX_DIR, f))
                    log.info("Removed stale title index: %s", f)
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# Content Reading & Search (was section 12)
# ---------------------------------------------------------------------------

def extract_pdf_text(pdf_bytes, max_length=None):
    """Extract text from a PDF byte stream using PyMuPDF."""
    if max_length is None:
        max_length = _srv.MAX_CONTENT_LENGTH
    if not _srv.HAS_PYMUPDF:
        return "[PDF content — install PyMuPDF to extract text]"
    try:
        import fitz
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        text = ""
        for page in doc:
            text += page.get_text()
            if len(text) >= max_length:
                break
        doc.close()
        text = re.sub(r"\s+", " ", text).strip()
        return text[:max_length]
    except Exception as e:
        log.warning("PDF extraction failed: %s", e)
        return "[PDF content could not be extracted]"


def parse_catalog(archive):
    """Parse database.js from zimgit-style ZIMs to get PDF metadata catalog."""
    import ast
    try:
        entry = archive.get_entry_by_path("database.js")
        content = bytes(entry.get_item().content).decode("UTF-8", errors="replace")
        # database.js uses Python-style dicts with single quotes
        content = content.replace("var DATABASE = ", "").strip().rstrip(";")
        # ast.literal_eval handles Python-style single-quoted dicts safely
        items = ast.literal_eval(content)
        return items
    except Exception as e:
        log.debug("Failed to parse zimgit catalog (database.js): %s", e)
        return None


def _get_pooled_archive(name, pool, pool_lock, zim_locks, pool_label):
    """Get a dedicated Archive handle and per-ZIM lock from a named pool.

    Each ZIM gets its own Archive + Lock, allowing parallel operations
    across different ZIMs while keeping each ZIM's C++ object single-threaded.
    """
    if name in pool:
        return pool[name], zim_locks[name]
    zims = _srv.get_zim_files()
    if name in zims:
        with pool_lock:
            if name in pool:
                return pool[name], zim_locks[name]
            try:
                archive = _srv.open_archive(zims[name])
            except (RuntimeError, Exception) as e:
                log.warning(f"{pool_label} pool: skipping corrupt ZIM '{name}': {e}")
                return None, None
            pool[name] = archive
            zim_locks[name] = threading.Lock()
            return archive, zim_locks[name]
    return None, None


def _get_suggest_archive(name):
    """Get a suggestion-dedicated Archive handle and per-ZIM lock."""
    _ensure_server_refs()
    return _get_pooled_archive(name, _suggest_pool, _suggest_pool_lock, _suggest_zim_locks, "Suggest")


def _get_fts_archive(name):
    """Get an FTS-dedicated Archive handle and per-ZIM lock."""
    _ensure_server_refs()
    return _get_pooled_archive(name, _fts_pool, _fts_pool_lock, _fts_zim_locks, "FTS")


def suggest_search_zim(archive, query_str, limit=5):
    """Fast title search via SuggestionSearcher (B-tree, ~10-50ms any ZIM size)."""
    results = []
    try:
        ss = SuggestionSearcher(archive)
        suggestion = ss.suggest(query_str)
        count = min(suggestion.getEstimatedMatches(), limit)
        for path in suggestion.getResults(0, count):
            try:
                entry = archive.get_entry_by_path(path)
                results.append({"path": path, "title": entry.title, "snippet": ""})
            except Exception as e:
                log.debug("Failed to read suggestion entry %s: %s", path, e)
                results.append({"path": path, "title": path, "snippet": ""})
    except Exception as e:
        log.debug("SuggestionSearcher failed for query %r: %s", query_str, e)
        pass
    return results


def search_zim(archive, query_str, limit=10, snippets=True):
    """Full-text search within a ZIM file. Returns list of {path, title, snippet}.

    With snippets=False, skips reading article content — much faster on spinning disks
    since it avoids random seeks for each result's body.
    """
    results = []
    try:
        searcher = Searcher(archive)
        query = Query().set_query(query_str)
        search = searcher.search(query)
        count = min(search.getEstimatedMatches(), limit)
        for path in search.getResults(0, count):
            try:
                entry = archive.get_entry_by_path(path)
                if not snippets:
                    results.append({"path": path, "title": entry.title, "snippet": ""})
                    continue
                item = entry.get_item()
                content_size = item.size
                if content_size > _srv.MAX_CONTENT_BYTES:
                    results.append({
                        "path": path,
                        "title": entry.title,
                        "snippet": f"[Large entry: {content_size // 1024}KB]",
                    })
                    continue
                content = bytes(item.content).decode("UTF-8", errors="replace")
                plain = strip_html(content)
                snippet = plain[:300] + "..." if len(plain) > 300 else plain
                results.append({
                    "path": path,
                    "title": entry.title,
                    "snippet": snippet,
                })
            except Exception as e:
                log.debug("Failed to read search result entry %s: %s", path, e)
                results.append({"path": path, "title": path, "snippet": ""})
    except Exception as e:
        log.warning("search_zim failed for %r: %s", query_str, e)
        results.append({"error": "Search failed"})
    return results


_meta_title_re = re.compile(r'^(Portal:|Category:|Wikipedia:|Template:|Help:|File:|Special:|List of |Index of |Outline of )', re.IGNORECASE)
_junk_re = re.compile(r'questions/tagged/|/tags$|/tags/page')  # SE tag index pages

# Import _STOPWORDS directly from interlang (not through _srv) to avoid
# circular import: server.py → search.py (module-level) → _srv._STOPWORDS
# would fail because interlang re-export hasn't run yet.
from zimi.interlang import _STOPWORDS as _interlang_stopwords
STOP_WORDS = _interlang_stopwords.get("en", set()) | {
    "an", "are", "as", "be", "by", "from", "has", "have", "how", "i",
    "it", "its", "my", "not", "on", "or", "so", "that", "this", "was",
    "we", "what", "when", "where", "which", "who", "will", "with", "you",
}


def _clean_query(q):
    """Strip stop words for better Xapian matching. Keep quoted phrases intact."""
    phrases = re.findall(r'"[^"]*"', q)
    rest = re.sub(r'"[^"]*"', '', q)
    words = [w for w in rest.split() if w.lower() not in STOP_WORDS]
    return ' '.join(phrases + words).strip() or q


def _score_result(title, query_words, rank, entry_count, lang_match=False):
    """Score a search result for cross-ZIM ranking."""
    tl = title.lower()
    hits = sum(1 for w in query_words if w in tl)
    if hits == len(query_words):
        title_score = 80
    elif hits > 0:
        title_score = 50 * (hits / len(query_words))
    else:
        title_score = 0
    # Exact phrase match bonus
    if ' '.join(query_words) in tl:
        title_score = 100
    # Position within source (rank 0 = 20, rank 5 = 3.3, capped at 5 if no title match)
    rank_score = 20 / (rank + 1)
    if title_score == 0:
        rank_score = min(rank_score, 5)
    # Source authority: slight boost for larger ZIMs (log scale)
    auth_score = min(5, math.log10(max(entry_count, 1)) / 2)
    # Language match: boost results from ZIMs matching detected query language
    lang_score = 10 if lang_match else 0
    return title_score + rank_score + auth_score + lang_score


def search_all(query_str, limit=5, filter_zim=None, fast=False):
    """Search across all ZIM files, a specific one, or a list.

    filter_zim can be None (all), a string (single ZIM), or a list of strings.
    fast=True: title-only search via SuggestionSearcher (~10-50ms), returns partial=True.

    Returns unified ranked format:
    {
      "results": [{"zim": ..., "path": ..., "title": ..., "snippet": ..., "score": ...}],
      "by_source": {"zim_name": count, ...},
      "total": N,
      "elapsed": seconds,
      "partial": bool  (True when fast=True, False otherwise)
    }

    Searches smallest ZIMs first. No time budgets or skipping — every ZIM is
    searched fully. Use fast=True for instant title matches, then full FTS for
    complete results (progressive two-phase pattern).
    """
    zims = _srv.get_zim_files()
    cache_meta = {z["name"]: (z.get("entries") if isinstance(z.get("entries"), int) else 0) for z in (_srv._zim_list_cache or [])}
    cache_lang = {z["name"]: z.get("language", "") for z in (_srv._zim_list_cache or [])}
    cache_qids = {z["name"]: z.get("has_qids", False) for z in (_srv._zim_list_cache or [])}

    # Detect query language for scoring boost
    detected_lang = _srv._detect_query_language(query_str)

    # Normalize filter_zim to None or list
    if isinstance(filter_zim, str):
        filter_zim = [filter_zim]
    scoped = bool(filter_zim)
    single_zim = scoped and len(filter_zim) == 1  # single-ZIM: no time limits

    if filter_zim:
        missing = [z for z in filter_zim if z not in zims]
        if missing:
            return {"results": [], "by_source": {}, "total": 0, "elapsed": 0,
                    "partial": fast, "error": f"ZIM(s) not found: {', '.join(missing)}"}
        # Sort multi-ZIM scopes smallest-first (like global) for speed
        if single_zim:
            target_names = filter_zim
        else:
            target_names = sorted(filter_zim, key=lambda n: cache_meta.get(n, 0))
    else:
        target_names = sorted(zims.keys(), key=lambda n: cache_meta.get(n, 0))

    # Clean query for Xapian (only pass raw query for single-ZIM scope)
    cleaned = _clean_query(query_str) if not single_zim else query_str
    query_words = [w.lower() for w in cleaned.split() if w.lower() not in STOP_WORDS] or [w.lower() for w in query_str.split()]

    raw_results = []
    by_source = {}
    timings = []
    search_start = time.time()

    if fast:
        # ── Fast path: title-only via SuggestionSearcher ──
        q_lower = query_str.lower().strip()
        thread_results = {}  # {name: [results]}

        def _search_one_zim(name):
            try:
                cached_suggest = _suggest_cache_get(q_lower, name)
                if cached_suggest is not None:
                    thread_results[name] = cached_suggest
                    return
                # Try SQLite title index first (instant, <10ms)
                idx_results = _title_index_search(name, query_str, limit=limit)
                if idx_results is not None:
                    _suggest_cache_put(q_lower, name, idx_results)
                    thread_results[name] = idx_results
                    return
                # Fallback: SuggestionSearcher (slow for large ZIMs on spinning disk)
                archive, lock = _get_suggest_archive(name)
                if archive is None or lock is None:
                    return
                with lock:
                    results = suggest_search_zim(archive, query_str, limit=limit)
                _suggest_cache_put(q_lower, name, results)
                thread_results[name] = results
            except Exception as e:
                log.debug("Suggest search failed for %s query %r: %s", name, query_str, e)
                pass

        if len(target_names) == 1:
            _search_one_zim(target_names[0])
        else:
            threads = [threading.Thread(target=_search_one_zim, args=(n,), daemon=True) for n in target_names]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        for name, results in thread_results.items():
            valid = [r for r in results if not _junk_re.search(r.get("path", ""))]
            if valid:
                entry_count = cache_meta.get(name, 1)
                for rank, r in enumerate(valid):
                    lm = bool(detected_lang and cache_lang.get(name) == detected_lang)
                    score = _score_result(r["title"], query_words, rank, entry_count, lang_match=lm)
                    raw_results.append({
                        "zim": name, "path": r["path"], "title": r["title"],
                        "snippet": "", "score": round(score, 1),
                        "language": cache_lang.get(name, ""),
                        "has_qids": cache_qids.get(name, False),
                    })
                by_source[name] = len(valid)
    else:
        # ── Full path: Xapian FTS — search every ZIM in parallel ──
        fts_results = {}  # {name: (results_list, dt)}

        def _fts_one_zim(name):
            try:
                archive, lock = _get_fts_archive(name)
                if archive is None or lock is None:
                    return
                t0 = time.time()
                with lock:
                    results = search_zim(archive, cleaned, limit=limit, snippets=False)
                dt = time.time() - t0
                fts_results[name] = (results, dt)
            except Exception as e:
                log.debug("FTS search failed for %s query %r: %s", name, cleaned, e)
                pass

        threads = [threading.Thread(target=_fts_one_zim, args=(n,), daemon=True) for n in target_names]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)  # Don't wait forever for a single ZIM

        for name, (results, dt) in fts_results.items():
            if dt > 0.3:
                timings.append(f"{name}={dt:.1f}s")
            valid = [r for r in results if "error" not in r and not _junk_re.search(r.get("path", ""))]
            if valid:
                entry_count = cache_meta.get(name, 1)
                for rank, r in enumerate(valid):
                    lm = bool(detected_lang and cache_lang.get(name) == detected_lang)
                    score = _score_result(r["title"], query_words, rank, entry_count, lang_match=lm)
                    raw_results.append({
                        "zim": name, "path": r["path"], "title": r["title"],
                        "snippet": r.get("snippet", ""), "score": round(score, 1),
                        "language": cache_lang.get(name, ""),
                        "has_qids": cache_qids.get(name, False),
                    })
                by_source[name] = len(valid)

    if timings:
        log.info("  slow zims: %s", ", ".join(timings))

    # Sort by score descending
    raw_results.sort(key=lambda r: r["score"], reverse=True)

    # Deduplicate by title (keep highest-scored)
    seen_titles = set()
    deduped = []
    for r in raw_results:
        key = r["title"].lower().strip()
        if key not in seen_titles:
            seen_titles.add(key)
            deduped.append(r)

    # Build by_language counts from result ZIM names
    cache_lang = {z["name"]: z.get("language", "") for z in (_srv._zim_list_cache or [])}
    by_language = {}
    for r in deduped:
        lang = cache_lang.get(r["zim"], "")
        if lang:
            by_language[lang] = by_language.get(lang, 0) + 1

    elapsed = round(time.time() - search_start, 2)
    result = {
        "results": deduped,
        "by_source": by_source,
        "by_language": by_language,
        "total": len(deduped),
        "elapsed": elapsed,
        "partial": fast,
    }
    if detected_lang:
        result["detected_language"] = detected_lang
    return result


def read_article(zim_name, article_path, max_length=None):
    """Read a specific article from a ZIM file. Returns plain text. Handles HTML and PDF."""
    if max_length is None:
        max_length = _srv.MAX_CONTENT_LENGTH
    zims = _srv.get_zim_files()
    if zim_name not in zims:
        return {"error": f"ZIM '{zim_name}' not found. Available: {list(zims.keys())}"}

    archive = _srv.get_archive(zim_name) or _srv.open_archive(zims[zim_name])
    try:
        entry = archive.get_entry_by_path(article_path)
        item = entry.get_item()
        raw = bytes(item.content)

        title = entry.title
        if item.mimetype == "application/pdf":
            # Extract text from embedded PDF
            plain = extract_pdf_text(raw, max_length=max_length)
            # Try to find a better title from the catalog
            catalog = parse_catalog(archive)
            if catalog:
                for doc in catalog:
                    fps = doc.get("fp", [])
                    if any(article_path.endswith(fp) for fp in fps):
                        title = doc.get("ti", title)
                        break
        else:
            content = raw.decode("UTF-8", errors="replace")
            plain = strip_html(content)

        truncated = len(plain) > max_length
        return {
            "zim": zim_name,
            "path": article_path,
            "title": title,
            "content": plain[:max_length],
            "truncated": truncated,
            "full_length": len(plain),
            "mimetype": item.mimetype,
        }
    except KeyError:
        return {"error": f"Article '{article_path}' not found in {zim_name}"}


def get_catalog(zim_name):
    """Get the document catalog for zimgit-style ZIMs (PDF collections with metadata)."""
    zims = _srv.get_zim_files()
    if zim_name not in zims:
        return {"error": f"ZIM '{zim_name}' not found. Available: {list(zims.keys())}"}

    archive = _srv.get_archive(zim_name) or _srv.open_archive(zims[zim_name])
    catalog = parse_catalog(archive)
    if not catalog:
        return {"error": f"No catalog (database.js) found in {zim_name} — not a zimgit-style PDF collection"}

    docs = []
    for doc in catalog:
        fps = doc.get("fp", [])
        docs.append({
            "title": doc.get("ti", "?"),
            "description": doc.get("dsc", ""),
            "author": doc.get("aut", ""),
            "path": f"files/{fps[0]}" if fps else None,
        })
    return {"zim": zim_name, "documents": docs, "count": len(docs)}


def suggest(query_str, zim_name=None, limit=10):
    """Title-based autocomplete suggestions."""
    zims = _srv.get_zim_files()
    target_names = [zim_name] if zim_name and zim_name in zims else list(zims.keys())
    all_suggestions = {}

    for name in target_names:
        try:
            archive = _srv.get_archive(name) or _srv.open_archive(zims[name])
            ss = SuggestionSearcher(archive)
            suggestion = ss.suggest(query_str)
            count = min(suggestion.getEstimatedMatches(), limit)
            results = []
            for s_path in suggestion.getResults(0, count):
                try:
                    entry = archive.get_entry_by_path(s_path)
                    results.append({"path": s_path, "title": entry.title})
                except Exception as e:
                    log.debug("Failed to read suggest entry %s: %s", s_path, e)
                    results.append({"path": s_path, "title": s_path})
            if results:
                all_suggestions[name] = results
        except Exception as e:
            log.warning("Suggest failed for %s: %s", name, e)
            all_suggestions[name] = []

    return all_suggestions


# Content serving helpers also used by handler.py
import random as _random

_factbook_countries_cache = None  # list of (path, title) sorted alphabetically


def _get_factbook_countries(archive):
    """Build sorted list of country pages from World Factbook ZIM. Cached."""
    global _factbook_countries_cache
    if _factbook_countries_cache is not None:
        return _factbook_countries_cache
    countries = []
    # Try common path patterns: "countries/XX.html" or "geos/XX.html"
    for pattern_prefix in ("countries", "geos"):
        for i in range(archive.entry_count):
            try:
                entry = archive._get_entry_by_id(i)
                p = entry.path
                if p.startswith(pattern_prefix + "/") and p.endswith(".html") \
                        and len(p) == len(pattern_prefix) + 8:  # e.g. "geos/xx.html"
                    countries.append((p, entry.title))
            except Exception as e:
                log.debug("Factbook entry scan error at index %d: %s", i, e)
                continue
        if countries:
            break
    if not countries:
        # Fallback: collect any HTML pages that look like country pages
        for i in range(archive.entry_count):
            try:
                entry = archive._get_entry_by_id(i)
                p = entry.path
                if p.endswith(".html") and "/" in p and len(p.split("/")) == 2 \
                        and not p.startswith("fields/") and p != "index.html" \
                        and not p.startswith("print_"):
                    countries.append((p, entry.title))
            except Exception as e:
                log.debug("Factbook fallback entry scan error at index %d: %s", i, e)
                continue
    countries.sort(key=lambda x: x[1])
    _factbook_countries_cache = countries
    log.info("factbook countries: %d entries", len(countries))
    return countries


def random_entry(archive, max_attempts=8, rng=None):
    """Pick a random article using random entry index (fast, no seed lists).

    Primary: pick random indices from the archive's entry range.
    Fallback: SuggestionSearcher with random 2-char prefixes.
    If rng is provided, use it for deterministic picks (daily persistence).
    """
    if rng is None:
        rng = _random
    # Phase 1: Random entry by index (O(1) per attempt, works on all ZIMs)
    total = archive.entry_count
    if total > 0:
        for _ in range(max_attempts):
            idx = rng.randint(0, total - 1)
            try:
                entry = archive._get_entry_by_id(idx)
                if entry.is_redirect:
                    entry = entry.get_redirect_entry()
                item = entry.get_item()
                mt = item.mimetype or ""
                if not mt.startswith("text/html") and mt != "application/pdf":
                    continue
                # Skip non-article entries (metadata, assets, etc.)
                if entry.path.startswith("_") or entry.path.startswith("-/"):
                    continue
                # Skip meta/portal pages — not interesting for "random article"
                title = entry.title or ""
                if _meta_title_re.search(title):
                    continue
                return {"path": entry.path, "title": title}
            except Exception as e:
                log.debug("Random entry pick failed at index %d: %s", idx, e)
                continue

    # Phase 2: SuggestionSearcher fallback
    chars = "abcdefghijklmnopqrstuvwxyz"
    for _ in range(max_attempts):
        prefix = rng.choice(chars) + rng.choice(chars)
        try:
            ss = SuggestionSearcher(archive)
            suggestion = ss.suggest(prefix)
            count = suggestion.getEstimatedMatches()
            if count == 0:
                continue
            paths = list(suggestion.getResults(0, min(count, 30)))
            result = _pick_html_entry(archive, paths)
            if result:
                return result
        except Exception as e:
            log.debug("SuggestionSearcher random fallback failed for prefix %r: %s", prefix, e)
            continue
    return None


def _pick_html_entry(archive, paths):
    """From a list of entry paths, return the first valid HTML/PDF article."""
    _random.shuffle(paths)
    for path in paths:
        try:
            entry = archive.get_entry_by_path(path)
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            item = entry.get_item()
            mt = item.mimetype or ""
            if mt and not mt.startswith("text/html") and mt != "application/pdf":
                continue
            return {"path": entry.path, "title": entry.title}
        except Exception as e:
            log.debug("Failed to read entry at path %s: %s", path, e)
            continue
    return None


def _get_dated_entry(archive, zim_name, mmdd, rng=None):
    """Try to find an article for today's date in date-based or content ZIMs.

    Strategies:
    1. APOD: construct path directly (apYYMMDD)
    2. Wikipedia: look for "On this day" style pages (month+day events)
    3. Any ZIM with FTS: search for "month day" to find date-relevant content

    Must be called with _zim_lock held.
    """
    from urllib.parse import unquote
    mm, dd = mmdd[:2], mmdd[2:]
    months = ["January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November", "December"]
    month_name = months[int(mm) - 1]
    day_num = str(int(dd))  # strip leading zero

    # APOD: try paths like apod.nasa.gov/apod/ap{YY}{MM}{DD}.html for recent years
    if "apod" in zim_name.lower():
        now = time.localtime()
        for year_offset in range(0, 30):
            yr = now.tm_year - year_offset
            yy = str(yr)[-2:]
            path = f"apod.nasa.gov/apod/ap{yy}{mm}{dd}.html"
            try:
                entry = archive.get_entry_by_path(path)
                return {"path": path, "title": entry.title}
            except KeyError:
                continue

    # Wikipedia: load the "Month_Day" article and follow a random internal link
    if "wikipedia" in zim_name.lower():
        date_page_html = None
        for prefix in ["A/", ""]:
            dpath = f"{prefix}{month_name}_{day_num}"
            try:
                entry = archive.get_entry_by_path(dpath)
                if entry.is_redirect:
                    entry = entry.get_redirect_entry()
                raw = bytes(entry.get_item().content)
                date_page_html = raw.decode("utf-8", errors="replace")[:100000]
                break
            except KeyError:
                continue
        if date_page_html:
            # Extract article links from the date page
            links = re.findall(r'href=["\'](?:\./|A/)?([^"\'#/][^"\'#]*)["\']', date_page_html)
            # Filter out year pages, meta pages, resources, and duplicates
            seen = set()
            candidates = []
            for link in links:
                clean = unquote(link).replace("_", " ")
                if clean in seen or re.match(r'^\d+$', clean):
                    continue
                if any(clean.startswith(ns) for ns in ["Category:", "Wikipedia:", "Template:", "Help:", "Portal:", "File:", "Special:", "_"]):
                    continue
                if re.search(r'\.(css|js|png|jpg|gif|svg|ico)$', link, re.IGNORECASE) or link.startswith(("http", "//")):
                    continue
                if clean in ("January", "February", "March", "April", "May", "June",
                             "July", "August", "September", "October", "November", "December",
                             "Gregorian calendar", "Leap year"):
                    continue
                if re.match(r'^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}$', clean):
                    continue
                seen.add(clean)
                candidates.append(link)
            _rng = rng or _random
            _rng.shuffle(candidates)
            # First pass: find an article with substance
            best_with_thumb = None
            best_fallback = None
            for link in candidates[:30]:
                for prefix in ["A/", ""]:
                    try:
                        entry = archive.get_entry_by_path(prefix + link)
                        if entry.is_redirect:
                            entry = entry.get_redirect_entry()
                        item = entry.get_item()
                        if not (item.mimetype or "").startswith("text/html"):
                            continue
                        title = entry.title or ""
                        if _meta_title_re.search(title) or len(title) < 3:
                            continue
                        result = {"path": entry.path, "title": title}
                        if best_fallback is None:
                            best_fallback = result
                        content_len = item.size
                        if content_len > 5000 and not best_with_thumb:
                            best_with_thumb = result
                            break
                    except (KeyError, Exception):
                        continue
                if best_with_thumb:
                    break
            return best_with_thumb or best_fallback

    # World Factbook: pick a country page by day-of-year index
    if "theworldfactbook" in zim_name.lower():
        countries = _get_factbook_countries(archive)
        if countries:
            now = time.localtime()
            doy = now.tm_yday
            path, title = countries[doy % len(countries)]
            # Clean factbook titles
            title = re.sub(r'\s*[\u2014\u2013\u2014]\s*The World Factbook.*$', '', title)
            title = re.sub(r'^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*::\s*', '', title)
            return {"path": path, "title": title.strip()}

    # FTS search: look for "month day" in article titles
    try:
        searcher = Searcher(archive)
        query = Query().set_query(f"{month_name} {day_num}")
        search = searcher.search(query)
        count = search.getEstimatedMatches()
        if count > 0:
            paths = list(search.getResults(0, min(count, 10)))
            result = _pick_html_entry(archive, paths)
            if result:
                return result
    except Exception as e:
        log.debug("Dated entry FTS search failed for '%s %s': %s", month_name, day_num, e)
        pass

    return None


# XKCD comic date lookup — parsed from the archive page (cached per ZIM)
_xkcd_date_cache = {}  # comic_number → "YYYY-MM-DD"
_xkcd_date_cache_built = False


def _xkcd_date_lookup(archive, path):
    """Look up publication date for an XKCD comic from the archive page.

    Parses xkcd.com/archive/ once and caches the number→date mapping.
    Must be called with _zim_lock held.
    """
    global _xkcd_date_cache_built
    if not _xkcd_date_cache_built:
        _xkcd_date_cache_built = True
        try:
            entry = archive.get_entry_by_path("xkcd.com/archive/")
            raw = bytes(entry.get_item().content)
            html_str = raw.decode("utf-8", errors="replace")
            for m in re.finditer(r'href="[^"]*?/(\d+)/?"[^>]*?title="(\d{4}-\d{1,2}-\d{1,2})"', html_str):
                num, date_str = m.group(1), m.group(2)
                # Normalize to YYYY-MM-DD with zero-padding
                parts = date_str.split("-")
                normalized = f"{parts[0]}-{int(parts[1]):02d}-{int(parts[2]):02d}"
                _xkcd_date_cache[num] = normalized
            log.info("xkcd date cache: %d comics", len(_xkcd_date_cache))
        except Exception as e:
            log.warning("xkcd date cache failed: %s", e)
    # Extract comic number from path like "xkcd.com/2607/"
    m = re.search(r'/(\d+)/?$', path)
    if m:
        return _xkcd_date_cache.get(m.group(1))
    return None
