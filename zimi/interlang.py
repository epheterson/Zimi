"""Interlanguage & cross-ZIM resolution for Zimi.

Wikidata Q-ID matching, domain→ZIM mapping, article language discovery,
and cross-ZIM URL resolution. Extracted from server.py.

Dependencies: imports from zimi.server for core state (locks, pools, config).
"""

import hashlib
import json
import logging
import os
import random as _random
import re
import sqlite3
import threading
import time
from urllib.parse import urlparse, parse_qs, quote, unquote

import zimi.server as _srv
from zimi.search import _loadavg_throttle

log = logging.getLogger("zimi")

# ---------------------------------------------------------------------------
# Native language names for display
# ---------------------------------------------------------------------------

_LANG_NATIVE_NAMES = {
    "en": "English",
    "fr": "Français",
    "de": "Deutsch",
    "es": "Español",
    "pt": "Português",
    "ru": "Русский",
    "zh": "中文",
    "ja": "日本語",
    "ko": "한국어",
    "ar": "العربية",
    "hi": "हिन्दी",
    "it": "Italiano",
    "nl": "Nederlands",
    "pl": "Polski",
    "tr": "Türkçe",
    "vi": "Tiếng Việt",
    "th": "ไทย",
    "sv": "Svenska",
    "no": "Norsk",
    "da": "Dansk",
    "fi": "Suomi",
    "cs": "Čeština",
    "ro": "Română",
    "hu": "Magyar",
    "el": "Ελληνικά",
    "he": "עברית",
    "uk": "Українська",
    "ca": "Català",
    "id": "Bahasa Indonesia",
    "ms": "Bahasa Melayu",
    "fa": "فارسی",
    "bn": "বাংলা",
    "ta": "தமிழ்",
    "te": "తెలుగు",
    "ur": "اردو",
    "mul": "Multiple",
}

# ---------------------------------------------------------------------------
# Script ranges and stopwords for language detection
# ---------------------------------------------------------------------------

_SCRIPT_RANGES = [
    # (start, end, lang_code)
    (0x4E00, 0x9FFF, "zh"),  # CJK Unified Ideographs
    (0x3400, 0x4DBF, "zh"),  # CJK Extension A
    (0x3040, 0x309F, "ja"),  # Hiragana
    (0x30A0, 0x30FF, "ja"),  # Katakana
    (0xAC00, 0xD7AF, "ko"),  # Hangul Syllables
    (0x0400, 0x04FF, "ru"),  # Cyrillic (default to Russian — most content)
    (0x0600, 0x06FF, "ar"),  # Arabic
    (0x0900, 0x097F, "hi"),  # Devanagari
    (0x0980, 0x09FF, "bn"),  # Bengali
    (0x0A80, 0x0AFF, "gu"),  # Gujarati
    (0x0B80, 0x0BFF, "ta"),  # Tamil
    (0x0C00, 0x0C7F, "te"),  # Telugu
]

_STOPWORDS = {
    "en": {"the", "is", "in", "at", "of", "and", "to", "a", "for", "on"},
    "fr": {"le", "la", "les", "de", "des", "un", "une", "du", "est", "et"},
    "de": {"der", "die", "das", "und", "ist", "ein", "eine", "von", "den", "zu"},
    "es": {"el", "la", "los", "las", "de", "en", "un", "una", "del", "es"},
    "pt": {"o", "a", "os", "as", "de", "do", "da", "em", "um", "uma"},
    "it": {"il", "la", "le", "di", "un", "una", "del", "che", "in", "per"},
    "nl": {"de", "het", "een", "van", "en", "is", "in", "op", "dat", "voor"},
    "ru": {"и", "в", "на", "не", "что", "он", "это", "как", "по", "с"},
    "ar": {"في", "من", "على", "إلى", "هذا", "أن", "هو", "ما", "مع", "لا"},
    "hi": {"है", "के", "में", "का", "की", "और", "को", "से", "एक", "पर"},
}


def _detect_query_language(query):
    """Detect the language of a search query. Returns ISO 639-1 code or empty string.

    Two-tier detection:
    1. Script detection (instant): non-Latin scripts → language
    2. Stopword scoring (Latin scripts): match against common words
    """
    # Tier 1: Script detection
    script_hits = {}
    for ch in query:
        cp = ord(ch)
        for start, end, lang in _SCRIPT_RANGES:
            if start <= cp <= end:
                script_hits[lang] = script_hits.get(lang, 0) + 1
                break
    if script_hits:
        return max(script_hits, key=script_hits.get)

    # Tier 2: Stopword scoring for Latin-script languages
    words = set(query.lower().split())
    if not words:
        return ""
    best_lang = ""
    best_score = 0
    for lang, stops in _STOPWORDS.items():
        hits = len(words & stops)
        score = hits / len(words)
        if score > best_score and score > 0.3:
            best_score = score
            best_lang = lang
    return best_lang


# ============================================================================
# Wikidata Q-ID Matching
# ============================================================================
# This avoids a 24-hour upfront scan of the 115GB English Wikipedia while
# still providing authoritative Q-ID matching on first use.

_QID_INDEX_VERSION = "3"
_QID_RE = re.compile(rb"wikidata\.org/wiki/(Q\d+)")
# Authority control Q-ID pattern (article's own Q-ID, not cited references)
_QID_AUTH_RE = re.compile(rb"wikidata\.org/wiki/(Q\d+)#identifiers")
_QID_FULL_SCAN_MAX_ENTRIES = 6_000_000  # Full-scan all Wikipedia ZIMs up to ~6M entries
_qid_passive_cache = True  # passively extract Q-IDs from every article viewed


def _qid_passive_extract(zim_name, article_path):
    """Extract and cache Q-ID from an article viewed in the reader.
    Called in a background thread on every iframe article load.
    Builds the Q-ID cache passively over time — especially valuable for
    large ZIMs like English Wikipedia where full indexing is impractical."""
    try:
        # Skip if already cached
        existing = _qid_lookup(zim_name, article_path)
        if existing is not None:
            return
        # CRITICAL: this runs on a daemon thread on every article load. It must
        # NOT touch the SHARED pooled Archive (_srv.get_archive) — libzim is not
        # thread-safe, and the same request reads that handle under _zim_lock
        # concurrently, so a shared read here is a silent segfault. Open our own
        # dedicated handle instead, exactly as _build_qid_index does.
        zims = _srv.get_zim_files()
        path = zims.get(zim_name)
        if not path:
            return
        archive = _srv.open_archive(path)
        try:
            qid = _qid_extract_from_html(archive, article_path)
        finally:
            del archive  # drop our handle promptly; don't pool it
        if qid is not None:
            _qid_cache_store(zim_name, article_path, qid)
    except Exception:
        pass  # background task, never fail visibly


# Connection pool for Q-ID databases
_qid_db_pool = {}  # {zim_name: sqlite3.Connection}
_qid_db_pool_lock = threading.Lock()


def _qid_index_dir():
    """Where Q-ID indexes live. A function, not a constant: ZIMI_DATA_DIR can be
    repointed after import (CLI flag, desktop settings), and a frozen value
    would leave these indexes behind in the old data dir."""
    return os.path.join(_srv.ZIMI_DATA_DIR, "qids")


def _qid_index_path(zim_name):
    return os.path.join(_qid_index_dir(), f"{zim_name}.qid.db")


def _qid_cache_path():
    return os.path.join(_qid_index_dir(), "_qid_cache.db")


def _get_qid_db(zim_name):
    """Get a pooled SQLite connection for a Q-ID index, or None if no index."""
    return _srv._get_pooled_db(
        zim_name, _qid_db_pool, _qid_db_pool_lock, _qid_index_path
    )


def _close_qid_db(zim_name):
    """Close and remove a pooled Q-ID index connection."""
    _srv._close_pooled_db(zim_name, _qid_db_pool, _qid_db_pool_lock)


def _qid_index_is_current(zim_name, zim_path):
    """Check if Q-ID index exists and matches ZIM mtime."""
    return _srv._index_is_current(
        _qid_index_path(zim_name), zim_path, _QID_INDEX_VERSION
    )


def _build_qid_index(zim_name, zim_path):
    """Scan a ZIM file and extract Wikidata Q-IDs from article HTML.

    Opens a dedicated Archive handle (not from the pool) so this is safe
    to run without _zim_lock. Only used for small ZIMs (< 200K entries).
    """
    os.makedirs(_qid_index_dir(), exist_ok=True)
    db_path = _qid_index_path(zim_name)
    tmp_path = db_path + ".tmp"
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(tmp_path + suffix)
        except OSError:
            pass
    t0 = time.time()
    count = 0
    scanned = 0

    archive = _srv.open_archive(zim_path)
    conn = sqlite3.connect(tmp_path)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute("CREATE TABLE qids (path TEXT PRIMARY KEY, qid INTEGER)")
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")

        batch = []
        total_entries = archive.all_entry_count
        log_interval = min(max(total_entries // 20, 5000), 25000)

        for i in range(total_entries):
            try:
                entry = archive._get_entry_by_id(i)
                if entry.is_redirect:
                    continue
                path = entry.path
                dot = path.rfind(".")
                if dot != -1 and path[dot:].lower() in _srv._ASSET_EXTS:
                    continue
                item = entry.get_item()
                mimetype = item.mimetype or ""
                if (
                    not mimetype.startswith("text/html")
                    and mimetype != "application/xhtml+xml"
                ):
                    continue
                if item.size < 2000:
                    continue
                scanned += 1
                content = item.content
                # Prefer authority control Q-ID (#identifiers) over cited references
                m = _QID_AUTH_RE.search(content) or _QID_RE.search(content)
                if m:
                    qid_int = int(m.group(1).decode()[1:])
                    batch.append((path, qid_int))

                if len(batch) >= 5000:
                    conn.executemany("INSERT OR IGNORE INTO qids VALUES (?,?)", batch)
                    conn.commit()
                    count += len(batch)
                    batch.clear()

                if scanned % log_interval == 0:
                    pct = round(100 * i / total_entries)
                    rate = scanned / max(time.time() - t0, 0.1)
                    log.info(
                        "Q-ID index: %s %d%% (%d scanned, %d found, %.0f/s)",
                        zim_name,
                        pct,
                        scanned,
                        count + len(batch),
                        rate,
                    )
            except Exception as e:
                log.debug("Q-ID scan: skipping entry %d in %s: %s", i, zim_name, e)
                continue

        if batch:
            conn.executemany("INSERT OR IGNORE INTO qids VALUES (?,?)", batch)
            count += len(batch)

        conn.execute("CREATE INDEX idx_qid ON qids(qid)")

        zim_mtime = str(os.path.getmtime(zim_path))
        zim_uuid = ""
        try:
            zim_uuid = str(archive.uuid)
        except Exception as e:
            log.debug("UUID read during Q-ID build failed for %s: %s", zim_name, e)
        conn.execute(
            "INSERT INTO meta VALUES ('schema_version', ?)", (_QID_INDEX_VERSION,)
        )
        conn.execute("INSERT INTO meta VALUES ('zim_mtime', ?)", (zim_mtime,))
        if zim_uuid:
            conn.execute("INSERT INTO meta VALUES ('zim_uuid', ?)", (zim_uuid,))
        conn.execute("INSERT INTO meta VALUES ('built_at', ?)", (str(time.time()),))
        conn.execute("INSERT INTO meta VALUES ('entry_count', ?)", (str(count),))
        conn.commit()
    except Exception:
        conn.close()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    else:
        conn.close()
        _close_qid_db(zim_name)
        os.replace(tmp_path, db_path)
        dt = time.time() - t0
        log.info(
            "Q-ID index: built %s (%d Q-IDs from %d articles, %.1fs)",
            zim_name,
            count,
            scanned,
            dt,
        )


_qid_cache_conn = None
_qid_cache_lock = threading.Lock()


def _get_qid_cache():
    """Get or create the shared Q-ID cache database."""
    global _qid_cache_conn
    if _qid_cache_conn is not None:
        return _qid_cache_conn
    with _qid_cache_lock:
        if _qid_cache_conn is not None:
            return _qid_cache_conn
        os.makedirs(_qid_index_dir(), exist_ok=True)
        conn = sqlite3.connect(_qid_cache_path(), timeout=5, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS qid_cache (zim TEXT, path TEXT, qid INTEGER, PRIMARY KEY(zim, path))"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cache_qid ON qid_cache(qid)")
        _qid_cache_conn = conn
        return conn


def _qid_extract_from_html(archive, article_path):
    """Extract Q-ID from a single article's HTML. Returns int or None.

    Reads the article content and searches for the Wikidata Q-ID pattern.
    Fast for a single article (~10-50ms depending on article size and I/O).
    """
    try:
        entry = archive.get_entry_by_path(article_path)
        item = entry.get_item()
        if item.size < 2000:
            return None
        content = item.content
        # Prefer authority control Q-ID (#identifiers) — that's the article's own ID.
        # Fall back to first wikidata link (may be a cited reference in some ZIMs).
        m = _QID_AUTH_RE.search(content) or _QID_RE.search(content)
        if m:
            return int(m.group(1).decode()[1:])
    except Exception as e:
        log.debug("Q-ID extract failed for %s: %s", article_path, e)
    return None


_qid_cache_op_lock = (
    threading.Lock()
)  # protects execute+commit on shared _qid_cache_conn


def _qid_cache_store(zim_name, path, qid):
    """Store a Q-ID mapping in the on-demand cache."""
    try:
        conn = _get_qid_cache()
        with _qid_cache_op_lock:
            conn.execute(
                "INSERT OR REPLACE INTO qid_cache VALUES (?,?,?)", (zim_name, path, qid)
            )
            conn.commit()
    except Exception as e:
        log.warning("Q-ID cache store failed for %s/%s Q%s: %s", zim_name, path, qid, e)


def _qid_cache_lookup(zim_name, path):
    """Look up Q-ID from the on-demand cache. Returns int or None."""
    try:
        conn = _get_qid_cache()
        with _qid_cache_op_lock:
            row = conn.execute(
                "SELECT qid FROM qid_cache WHERE zim=? AND path=?", (zim_name, path)
            ).fetchone()
        return row[0] if row else None
    except Exception as e:
        log.debug("Q-ID cache lookup failed for %s/%s: %s", zim_name, path, e)
        return None


def _qid_cache_find(zim_name, qid):
    """Find article path by Q-ID in the on-demand cache. Returns path or None."""
    try:
        conn = _get_qid_cache()
        with _qid_cache_op_lock:
            row = conn.execute(
                "SELECT path FROM qid_cache WHERE zim=? AND qid=?", (zim_name, qid)
            ).fetchone()
        return row[0] if row else None
    except Exception as e:
        log.debug("Q-ID cache find failed for %s/Q%s: %s", zim_name, qid, e)
        return None


def _qid_lookup(zim_name, article_path):
    """Look up the Q-ID for an article. Checks full index first, then cache."""
    # Check full index (for small ZIMs that were fully scanned)
    conn = _get_qid_db(zim_name)
    if conn is not None:
        try:
            row = conn.execute(
                "SELECT qid FROM qids WHERE path=?", (article_path,)
            ).fetchone()
            if row:
                return row[0]
        except Exception as e:
            log.debug(
                "Q-ID index lookup failed for %s/%s: %s", zim_name, article_path, e
            )
    # Check on-demand cache (for large ZIMs)
    return _qid_cache_lookup(zim_name, article_path)


def _qid_find_in_zim(zim_name, qid_int):
    """Find an article path by Q-ID in a specific ZIM. Checks index AND cache."""
    # Check full index
    conn = _get_qid_db(zim_name)
    if conn is not None:
        try:
            row = conn.execute(
                "SELECT path FROM qids WHERE qid=?", (qid_int,)
            ).fetchone()
            if row:
                return row[0]
        except Exception as e:
            log.debug("Q-ID index find failed for %s/Q%s: %s", zim_name, qid_int, e)
    # Always check on-demand cache too (cross-cached entries from other lookups)
    return _qid_cache_find(zim_name, qid_int)


def _qid_has_index(zim_name):
    """Check if a ZIM has a full Q-ID index (was fully scanned)."""
    return _get_qid_db(zim_name) is not None


# ---------------------------------------------------------------------------
# Almanac deep-links: batch Q-ID → installed-article resolution
# ---------------------------------------------------------------------------
#
# The almanac ships a curated, CLOSED SET of Wikidata Q-IDs (see
# static/almanac-links.js). On open it asks the server, in one batch, which of
# those Q-IDs resolve to an article in the user's installed encyclopedia ZIMs.
# Resolution is authoritative: a Q-ID either maps to a real article (direct
# link) or it doesn't (plain text).
#
# Resolution order per Q-ID:
#   (a) Q-ID index / on-demand cache of a preferred-language ZIM — authoritative
#       and instant when a built index exists (pure SQLite, no libzim).
#   (b) EXACT-TITLE fallback — the curated map carries each entity's English
#       article title, and in a Wikipedia ZIM a title maps deterministically to
#       the entry path (Title_With_Underscores + redirect resolution). This
#       rescues libraries whose only encyclopedia is a huge full Wikipedia with
#       no prebuilt Q-ID index (a full scan is ~tens of hours). English-family
#       candidates only — the strict-language rule stays. Exact title only:
#       never fuzzy, never a title SEARCH — a wrong link is worse than no link.
#   (c) miss → absent (the entity renders as plain text).
#
# The whole resolved batch is memoized server-side keyed by (batch signature,
# langs, library generation), so a repeat almanac open is a single dict hit and
# any library change transparently invalidates it.

# Valid Wikidata Q-ID token (e.g. "Q42").
_ALMANAC_QID_RE = re.compile(r"^Q\d+$")

# Hard cap on a single batch. The curated set is ~250 entries; this bounds
# work (and memory) if a client sends a padded or hostile list.
ALMANAC_QID_BATCH_MAX = 400

# Only wikipedia/vikidia-family archives carry the encyclopedia articles the
# almanac's entity Q-IDs point at. Mirrors _ENC_RE in almanac-links.js.
_ALMANAC_ENC_RE = re.compile(r"^(wikipedia|vikidia)", re.IGNORECASE)

# Server-side memo of resolved almanac batches. Keyed by (batch signature, langs,
# library generation) so a repeat almanac open with an unchanged library + query
# is a single dict hit ("one time and quick"), and any library change (load_cache
# force → _cache_generation bump) transparently invalidates every entry. Bounded:
# only a handful of (langs, library-state) combinations ever coexist.
_almanac_resolve_cache = {}  # {key: {qid: {"zim", "path", "title"}}}
_almanac_resolve_cache_lock = threading.Lock()
_ALMANAC_RESOLVE_CACHE_MAX = 32


def _almanac_cache_key(qids, langs, titles):
    """Stable key for the resolved-batch memo: (payload hash, langs, gen).

    Order-independent in the Q-IDs (the result is a dict, so a reordered but
    equivalent request is the same answer). Returns None if the library
    generation can't be read — then the caller skips caching rather than risk a
    stale hit.
    """
    try:
        gen = _srv._cache_generation
    except Exception:
        return None
    h = hashlib.sha1()
    items = sorted(
        (q, (titles.get(q) if titles else None)) for q in qids if isinstance(q, str)
    )
    for q, t in items:
        h.update(q.encode("utf-8", "replace"))
        h.update(b"\x00")
        if isinstance(t, str):
            h.update(t.encode("utf-8", "replace"))
        h.update(b"\x01")
    return (h.hexdigest(), ",".join(langs) if langs else "", gen)


def _almanac_cache_get(key):
    """Return a COPY of the cached batch for `key`, or None."""
    if key is None:
        return None
    with _almanac_resolve_cache_lock:
        hit = _almanac_resolve_cache.get(key)
        return dict(hit) if hit is not None else None


def _almanac_cache_store(key, result):
    """Memoize a resolved batch under `key` (stores a copy)."""
    if key is None:
        return
    with _almanac_resolve_cache_lock:
        # Simple bound: clear wholesale when it grows past the cap. The key
        # already encodes library generation, so entries only accumulate across
        # distinct language sets — a clear is cheap and rare.
        if len(_almanac_resolve_cache) >= _ALMANAC_RESOLVE_CACHE_MAX:
            _almanac_resolve_cache.clear()
        _almanac_resolve_cache[key] = dict(result)


def _almanac_title_from_path(path):
    """Derive a human title from a ZIM article path.

    Strips the 'A/' namespace, percent-decodes, and turns underscores into
    spaces (e.g. 'A/Mercury_(planet)' → 'Mercury (planet)'). Purely lexical so
    it never touches libzim — the reader only needs a header label, and the
    real title is embedded in the article anyway.
    """
    p = path[2:] if path.startswith("A/") else path
    return unquote(p).replace("_", " ")


def _almanac_candidate_zims(langs):
    """Ordered encyclopedia ZIMs for almanac Q-ID resolution.

    Preference order: the user's languages (in the order given) → English →
    everything else. Within a language the best-quality / largest archive wins
    (reuses _zim_quality_score). Only wikipedia/vikidia-family archives take
    part. Computed once per batch, not per Q-ID.
    """
    order = []
    for lang in langs or []:
        if lang and lang != "multi" and lang not in order:
            order.append(lang)
    if "en" not in order:
        order.append("en")

    def sort_key(z):
        lang = z.get("language", "")
        rank = order.index(lang) if lang in order else len(order)
        count = z.get("entry_count") or z.get("article_count") or 0
        return (rank, -_zim_quality_score(z.get("name", "")), -count)

    # Strictly the user's languages + English — never "any installed
    # wikipedia". A Hebrew article behind an English UI's Jupiter link is
    # worse than no link (Eric's spec: match the right language; no match →
    # plain text). Libraries whose preferred-language wikipedia lacks a
    # built Q-ID index simply get fewer links.
    enc = [
        z
        for z in (_srv._zim_list_cache or [])
        if _ALMANAC_ENC_RE.match(z.get("name", ""))
        and z.get("language", "") in order
        and _srv.zim_allowed(z.get("name", ""))
    ]
    enc.sort(key=sort_key)
    return enc


def resolve_almanac_qids(qids, langs=None, titles=None):
    """Batch-resolve a closed set of Wikidata Q-IDs to installed articles.

    Per Q-ID, in order:
      (a) Q-ID index / on-demand cache of a candidate ZIM, in language-preference
          order — pure SQLite (both are sqlite tables with check_same_thread=False
          connections and SQLite serializes internally), so it needs neither
          libzim nor _zim_lock and stays fast for a ~250-Q-ID batch.
      (b) EXACT-TITLE fallback for Q-IDs (a) missed, using the curated English
          title supplied in `titles`: in a Wikipedia ZIM a title maps
          deterministically to the entry path, so a direct get_entry_by_path
          (with redirect resolution) resolves it with no index. English-family
          candidates only — the strict-language rule stays. This touches libzim,
          so the whole fallback batch runs under a single _zim_lock hold.
      (c) miss → absent (rendered as plain text; a wrong link is worse than none).

    The whole resolved batch is memoized keyed by (payload hash, langs, library
    generation), so a repeat open is one dict hit and any library change
    invalidates it. Exact title only — never fuzzy, never a title SEARCH.

    Args:
        qids: iterable of Q-ID strings (e.g. ["Q308", "Q2"]). Malformed or
            duplicate entries are skipped.
        langs: preferred language codes, most-preferred first.
        titles: optional {qid: english_title} for the exact-title fallback.

    Returns:
        {qid: {"zim", "path", "title"}} for HITS ONLY. Unmatched Q-IDs are
        simply absent — the caller renders those entities as plain text.
    """
    out = {}
    if not qids:
        return out
    cache_key = _almanac_cache_key(qids, langs, titles)
    cached = _almanac_cache_get(cache_key)
    if cached is not None:
        return cached
    cands = _almanac_candidate_zims(langs)
    if not cands:
        _almanac_cache_store(cache_key, out)
        return out
    seen = set()
    misses = []  # [(qid_str, english_title)] deferred to the title fallback
    for q in qids:
        if not isinstance(q, str):
            continue
        q = q.strip()
        if q in seen or not _ALMANAC_QID_RE.match(q):
            continue
        seen.add(q)
        qid_int = int(q[1:])
        found = False
        for z in cands:
            name = z.get("name", "")
            path = _qid_find_in_zim(name, qid_int)
            if path:
                out[q] = {
                    "zim": name,
                    "path": path,
                    "title": _almanac_title_from_path(path),
                }
                found = True
                break
        if not found and titles:
            t = titles.get(q)
            if isinstance(t, str) and t.strip():
                misses.append((q, t.strip()))
    if misses:
        _resolve_almanac_titles(misses, cands, out)
    _almanac_cache_store(cache_key, out)
    return out


def _resolve_almanac_titles(misses, cands, out):
    """Exact-title fallback for Q-IDs no index resolved (mutates `out`).

    English-family candidate ZIMs only: the curated title we carry is the English
    article title, and matching it against a non-English ZIM would risk the wrong
    article behind an English label (Eric's strict-language rule). For each miss,
    try the ZIM's namespace path variants for Title_With_Underscores, following a
    single redirect hop to the canonical entry; first hit wins.

    Touches libzim (get_entry_by_path / get_redirect_entry), which is NOT
    thread-safe, so the ENTIRE batch of ≤400 direct lookups runs under one
    _zim_lock hold on the open pooled archives (each lookup is a memory-mapped
    B-tree probe — microseconds).
    """
    en_zims = [z.get("name", "") for z in cands if z.get("language") == "en"]
    en_zims = [n for n in en_zims if n]
    if not en_zims:
        return
    with _srv._zim_lock:
        for q, title in misses:
            for name in en_zims:
                resolved = _almanac_title_entry_path(name, title)
                if resolved:
                    out[q] = {
                        "zim": name,
                        "path": resolved,
                        "title": _almanac_title_from_path(resolved),
                    }
                    break


def _almanac_title_entry_path(zim_name, title):
    """Exact-title → canonical entry path in one ZIM, or None. _zim_lock HELD.

    Tries the ZIM's path-namespace variants (bare and 'A/'-prefixed) for the
    title with spaces turned to underscores — Wikipedia's on-disk path form —
    following a single redirect hop to the canonical article. A KeyError just
    means 'no such article' (a miss); this never searches or guesses.
    """
    archive = _srv.get_archive(zim_name)
    if archive is None:
        return None
    underscored = title.replace(" ", "_")
    for try_path in (underscored, "A/" + underscored):
        try:
            entry = archive.get_entry_by_path(try_path)
        except KeyError:
            continue
        except Exception as e:
            log.debug("almanac title lookup %r in %s: %s", try_path, zim_name, e)
            continue
        try:
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            return entry.path
        except Exception as e:
            log.debug("almanac redirect follow %r in %s: %s", try_path, zim_name, e)
            return try_path
    return None


def _check_one_article_for_qid(zim_path):
    """Sample random HTML articles from a ZIM and check for Wikidata Q-IDs.

    Opens a dedicated Archive (not from pool). Tries up to 50 random entries
    looking for HTML articles > 5KB, checks up to 3 for the Q-ID pattern.
    Returns True if any contain Q-IDs, False if none do.
    """
    try:
        archive = _srv.open_archive(zim_path)
        total = archive.all_entry_count
        if total < 10:
            return False
        indices = _random.sample(range(total), min(50, total))
        checked = 0
        for i in indices:
            try:
                entry = archive._get_entry_by_id(i)
                if entry.is_redirect:
                    continue
                path = entry.path
                dot = path.rfind(".")
                if dot != -1 and path[dot:].lower() in _srv._ASSET_EXTS:
                    continue
                item = entry.get_item()
                mimetype = item.mimetype or ""
                if (
                    not mimetype.startswith("text/html")
                    and mimetype != "application/xhtml+xml"
                ):
                    continue
                if item.size < 5000:
                    continue
                content = item.content
                if _QID_RE.search(content):
                    return True
                checked += 1
                if checked >= 3:
                    return False  # 3 valid articles checked, none had Q-IDs
            except Exception as e:
                log.debug("Q-ID probe: skipping entry %d in %s: %s", i, zim_path, e)
                continue
        return False
    except Exception as e:
        log.debug("Q-ID probe failed for %s: %s", zim_path, e)
        return False


def _persist_qid_flags(qid_flags):
    """Persist has_qids flags into the disk cache (cache.json).

    Reads the cache, merges has_qids into each file entry by matching on
    the 'name' field, then saves atomically.
    """
    try:
        with open(_srv._cache_file_path(), encoding="utf-8") as f:
            data = json.load(f)
        files = data.get("files", {})
        for _filename, meta in files.items():
            name = meta.get("name", "")
            if name in qid_flags:
                meta["has_qids"] = qid_flags[name]
        _srv._atomic_write_json(_srv._cache_file_path(), data, indent=2)
    except Exception as e:
        log.warning("Failed to persist Q-ID flags to cache: %s", e)


_build_all_qid_lock = threading.Lock()


def _build_all_qid_indexes():
    """Build Q-ID indexes for small Wikipedia ZIMs and detect has_qids for all ZIMs.

    Serialized via _build_all_qid_lock — startup worker, post-download
    triggers (library.py), and manual rebuilds (manage.py) all funnel
    through here. Late callers wait, then run with a fresh zim list so
    a download that landed during the wait gets picked up.
    """
    with _build_all_qid_lock:
        _build_all_qid_indexes_inner()


def _build_all_qid_indexes_inner():
    """Build Q-ID indexes for small Wikipedia ZIMs and detect has_qids for all ZIMs.

    Phase 1: Full-scan small Wikipedia ZIMs (< 200K entries) to build SQLite indexes.
    Phase 2: For all ZIMs without an index, sample one article to detect Q-ID support.
    Sets has_qids on _zim_list_cache entries and persists to disk cache.
    """
    os.makedirs(_qid_index_dir(), exist_ok=True)
    zims = _srv.get_zim_files()
    zim_info = {
        z.get("name"): z.get("entries", 0) for z in (_srv._zim_list_cache or [])
    }

    wiki_zims = [(n, p) for n, p in zims.items() if _zim_project_name(n) == "wikipedia"]

    need_build = []
    current = 0
    skipped_large = 0
    for name, path in wiki_zims:
        entries = zim_info.get(name, 0) or 0
        if entries > _QID_FULL_SCAN_MAX_ENTRIES:
            skipped_large += 1
            continue
        if _qid_index_is_current(name, path):
            current += 1
        else:
            need_build.append((name, path))

    if need_build:
        need_build.sort(
            key=lambda x: (
                zim_info.get(x[0], 0) if isinstance(zim_info.get(x[0], 0), int) else 0
            )
        )

        for name, path in need_build:
            try:
                _build_qid_index(name, path)
                current += 1
            except Exception as e:
                log.warning("Q-ID index build failed for %s: %s", name, e)
            # Yield to host between ZIMs if loadavg is high.
            _loadavg_throttle()

    # Clean stale indexes + .tmp orphans from interrupted builds (SIGKILL
    # mid-build leaves <name>.qid.db.tmp files that aren't tracked anymore).
    index_dir = _qid_index_dir()
    for f in os.listdir(index_dir):
        full = os.path.join(index_dir, f)
        if (
            f.endswith(".qid.db.tmp")
            or f.endswith(".qid.db.tmp-shm")
            or f.endswith(".qid.db.tmp-wal")
        ):
            try:
                os.remove(full)
                log.info("Removed orphan Q-ID index tmp: %s", f)
            except OSError:
                pass
            continue
        if f.endswith(".qid.db"):
            zn = f[:-7]
            if zn not in zims:
                _close_qid_db(zn)
                try:
                    os.remove(full)
                    log.info("Removed stale Q-ID index: %s", f)
                except OSError:
                    pass

    if current or skipped_large:
        log.info(
            "Q-ID indexes: %d ready, %d large ZIMs use on-demand matching",
            current,
            skipped_large,
        )

    # Phase 2: Detect has_qids for all ZIMs
    # Known Wikimedia projects always embed Q-IDs. For indexed ZIMs we know for sure.
    # For unknown projects, sample a few articles to check.
    indexed_zims = set()
    for name in zims:
        if _qid_has_index(name):
            indexed_zims.add(name)

    qid_flags = {}  # {name: bool}
    sampled = 0
    for name, path in zims.items():
        if name in indexed_zims:
            qid_flags[name] = True
        else:
            # Sample actual content — don't assume based on project name
            has = _check_one_article_for_qid(path)
            qid_flags[name] = has
            sampled += 1

    # Apply to _zim_list_cache and persist
    changed = 0
    for zi in _srv._zim_list_cache or []:
        zname = zi.get("name", "")
        if zname in qid_flags:
            old = zi.get("has_qids")
            zi["has_qids"] = qid_flags[zname]
            if old != qid_flags[zname]:
                changed += 1

    if changed:
        _persist_qid_flags(qid_flags)

    has_count = sum(1 for v in qid_flags.values() if v)
    log.info(
        "Q-ID support: %d/%d ZIMs have Q-IDs (%d sampled)",
        has_count,
        len(qid_flags),
        sampled,
    )


# ============================================================================
# Cross-ZIM Resolution & Language
# ============================================================================

_domain_zim_map = {}  # {domain: zim_name} — only installed ZIMs
_xzim_refs = {}  # {(source_zim, target_zim): count} — cross-ZIM reference tracking
_xzim_refs_lock = threading.Lock()  # protects _xzim_refs read-modify-write


def _build_domain_zim_map():
    """Build domain→ZIM map entirely from ZIM metadata — no hardcoded lists.

    Three auto-discovery methods, in order:
    1. Filename extraction: "stackoverflow.com_en_all_*.zim" → stackoverflow.com
    2. Source metadata: ZIM Source="www.appropedia.org" → appropedia.org
    3. Name-based inference: ZIM name "wikihow" → wikihow.com (try common TLDs)

    For each discovered domain, also registers www. and mobile (en.m.) variants.
    """
    global _domain_zim_map
    zims = _srv.get_zim_files()
    dmap = {}

    def _add_domain(domain, name):
        """Register a domain and its common variants (www., mobile)."""
        domain = domain.lower().strip()
        if not domain or "." not in domain:
            return
        if domain not in dmap:
            dmap[domain] = name
        # www. variant
        if domain.startswith("www."):
            bare = domain[4:]
            if bare not in dmap:
                dmap[bare] = name
        else:
            www = "www." + domain
            if www not in dmap:
                dmap[www] = name
        # Mobile Wikimedia variant: XX.wiki*.org → XX.m.wiki*.org (all languages)
        m = re.match(r"^(\w{2,3})\.(wiki\w+\.org)$", domain)
        if m:
            mobile = f"{m.group(1)}.m.{m.group(2)}"
            if mobile not in dmap:
                dmap[mobile] = name
        # Common mobile variants for non-wiki sites
        if domain in ("stackoverflow.com", "stackexchange.com"):
            mob = "m." + domain
            if mob not in dmap:
                dmap[mob] = name

    # 1. Extract domains from ZIM filenames
    for name, path in zims.items():
        filename = os.path.basename(path)
        base = filename.split(".zim")[0]
        m = re.match(r"^([a-zA-Z0-9.-]+\.[a-z]{2,})_", base)
        if m:
            _add_domain(m.group(1), name)

    # 2. Extract domains from ZIM Source metadata
    mapped_names = set(dmap.values())
    for name, path in zims.items():
        if name in mapped_names:
            continue
        # Note: caller (load_cache) already holds _zim_lock
        archive = _srv.get_archive(name)
        if not archive:
            continue
        try:
            source = (
                bytes(archive.get_metadata("Source")).decode("utf-8", "replace").strip()
            )
        except Exception as e:
            log.debug("Failed to read Source metadata for %s: %s", name, e)
            continue
        if not source:
            continue
        try:
            if "://" in source:
                domain = urlparse(source).hostname or ""
            else:
                domain = source.split("/")[0]
        except Exception as e:
            log.debug(
                "Failed to parse domain from source %r for %s: %s", source, name, e
            )
            continue
        _add_domain(domain, name)

    # 3. Name-based inference for unmapped ZIMs: try <name>.com, .org, .io
    mapped_names = set(dmap.values())
    for name in zims:
        if name in mapped_names:
            continue
        # Skip names that clearly aren't domains (zimgit-, devdocs_, etc.)
        if name.startswith("zimgit") or "_en_" in name:
            continue
        for tld in [".com", ".org", ".io", ".net"]:
            candidate = name + tld
            _add_domain(candidate, name)

    _domain_zim_map = dmap
    log.info("Domain map: %d domains → %d ZIMs", len(dmap), len(set(dmap.values())))


# The URL shapes Zimi knows how to translate between the live web and a ZIM's
# entry paths. Matched as substrings of the host, longest-standing behaviour
# preserved: the first family whose marker appears in the host wins.
_URL_FAMILIES = (
    (
        "wikimedia",
        (
            "wikipedia.org",
            "wiktionary.org",
            "wikivoyage.org",
            "wikibooks.org",
            "wikiversity.org",
            "wikiquote.org",
            "wikinews.org",
        ),
    ),
    (
        "stackexchange",
        (
            "stackexchange.com",
            "stackoverflow.com",
            "serverfault.com",
            "superuser.com",
            "askubuntu.com",
        ),
    ),
    ("mediawiki", ("rationalwiki.org", "appropedia.org")),
    ("explainxkcd", ("explainxkcd.com",)),
    ("wikihow", ("wikihow.com",)),
)

# The TLDs _build_domain_zim_map GUESSES at for a ZIM it could not map from
# evidence. A guess is a fine lookup key but never a canonical answer.
_INFERRED_TLDS = (".com", ".org", ".io", ".net")

# Sub-delimiters and ":@" are legal unencoded in a URL path, and Wikipedia
# titles are full of them — "Chlorine_(disinfectant)" should stay readable.
_URL_PATH_SAFE = "/:@!$&'()*+,;="


def _url_family(host):
    """Which URL family a host belongs to: the shape of its article paths."""
    host = (host or "").lower()
    for family, markers in _URL_FAMILIES:
        if any(marker in host for marker in markers):
            return family
    return "general"


def zim_domain(zim_name):
    """The web domain an installed ZIM was scraped FROM, or None.

    The inverse of the domain map, with two corrections. Only EVIDENCE-backed
    domains count: ``_build_domain_zim_map``'s third discovery method guesses
    ``<name>.com/.org/.io/.net`` for a ZIM it could not map from a filename or
    Source metadata, which is harmless as a lookup key (an incoming URL still
    has to match a real entry path) but must never be handed back as a ZIM's
    home — that would invent a website. And of the variants the map registers
    for one real domain, the BARE one is the answer: ``www.`` and mobile
    (``en.m.``) forms exist only so inbound links resolve.
    """
    candidates = [d for d, n in _domain_zim_map.items() if n == zim_name]
    if not candidates:
        return None
    if sum(1 for tld in _INFERRED_TLDS if zim_name + tld in candidates) >= 2:
        return None  # the TLD-guessing branch produced these, not evidence
    bare = [
        d
        for d in candidates
        if not d.startswith("www.") and "m" not in d.split(".")[:-2]
    ]
    return sorted(bare or candidates, key=lambda d: (len(d), d))[0]


def canonical_url(zim_name, entry_path, domain=None):
    """The live-web URL an entry in an installed ZIM came from, or None.

    The inverse of ``_resolve_url_to_zim``: same host families, same path
    shapes, run backwards. ``None`` when the ZIM has no known domain — there is
    no honest URL to give for a ZIM whose origin Zimi never learned.

    The round trip is the point. A link rewritten to this URL is a genuine
    external link everywhere (so ``zimcheck -U`` passes and any reader reaches
    the live article), and inside Zimi ``_resolve_url_to_zim`` maps it straight
    back into the installed source ZIM.
    """
    domain = domain or zim_domain(zim_name)
    rest = (entry_path or "").lstrip("/")
    if rest.startswith("A/"):
        rest = rest[2:]
    if not domain or not rest:
        return None
    family = _url_family(domain)
    if family in ("wikimedia", "mediawiki"):
        rest = "wiki/" + rest
    elif family == "explainxkcd":
        rest = "wiki/index.php/" + rest
    elif family == "general" and rest.startswith(domain + "/"):
        # Mirrors the map's host-prefixed candidate (apod.nasa.gov/apod/...).
        rest = rest[len(domain) + 1 :]
    return "https://" + domain + "/" + quote(rest, safe=_URL_PATH_SAFE)


def _resolve_url_to_zim(url_str):
    """Resolve an external URL to a ZIM name + entry path, or None.

    Returns {"zim": name, "path": path} if found, else None.
    Must be called with _zim_lock held (uses archive.get_entry_by_path).
    """
    try:
        parsed = urlparse(url_str)
    except Exception as e:
        log.debug("Failed to parse URL %r: %s", url_str, e)
        return None
    host = (parsed.hostname or "").lower()
    if not host:
        return None

    # Look up domain (try exact, then without www.)
    zim_name = _domain_zim_map.get(host)
    if not zim_name:
        bare = re.sub(r"^www\.", "", host)
        zim_name = _domain_zim_map.get(bare)
    if not zim_name:
        return None

    archive = _srv.get_archive(zim_name)
    if archive is None:
        return None

    url_path = unquote(parsed.path).lstrip("/")

    # Build candidate paths based on domain type
    candidates = []
    family = _url_family(host)
    if family == "wikimedia":
        # Wikimedia: /wiki/Article_Name → A/Article_Name
        rest = re.sub(r"^wiki/", "", url_path)
        # Handle ?title=Article&oldid=... style URLs (MediaWiki index.php format)
        qs = parse_qs(parsed.query)
        if qs.get("title") and (
            not rest or rest in ("wiki", "w/index.php", "index.php")
        ):
            rest = qs["title"][0]
        candidates.append("A/" + rest)
        candidates.append(rest)
        # Strip Wikimedia namespaces (Topic:, Category:, Portal:, etc.)
        ns_stripped = re.sub(r"^[A-Z][a-z]+:", "", rest)
        if ns_stripped != rest:
            candidates.append(ns_stripped)
            candidates.append("A/" + ns_stripped)
    elif family == "stackexchange":
        # Stack Exchange: /questions/12345/title → A/questions/12345/title
        candidates.append("A/" + url_path)
        candidates.append(url_path)
    elif family == "mediawiki":
        # MediaWiki sites: /wiki/Article → Article (no A/ prefix)
        rest = re.sub(r"^wiki/", "", url_path)
        # Handle ?title=Article&oldid=... style URLs
        qs = parse_qs(parsed.query)
        if qs.get("title") and (
            not rest or rest in ("wiki", "w/index.php", "index.php")
        ):
            rest = qs["title"][0]
        candidates.append(rest)
        candidates.append("A/" + rest)
    elif family == "explainxkcd":
        # /wiki/index.php/1234 → 1234:_Title (try number prefix match)
        rest = re.sub(r"^wiki/index\.php/", "", url_path)
        candidates.append(rest)
        candidates.append("A/" + rest)
    elif family == "wikihow":
        # WikiHow: /Article-Name → A/Article-Name
        candidates.append("A/" + url_path)
        candidates.append(url_path)
    else:
        # General: try both A/<path> and raw <path>, plus domain-prefixed path
        candidates.append("A/" + url_path)
        candidates.append(url_path)
        # Some ZIMs prefix paths with domain (e.g. apod.nasa.gov/apod/ap...)
        if host:
            candidates.append(host + "/" + url_path)

    # Try each candidate path
    for cpath in candidates:
        if not cpath:
            continue
        try:
            archive.get_entry_by_path(cpath)
            return {"zim": zim_name, "path": cpath}
        except KeyError:
            continue
    return None


# ============================================================================
# Article Language Matching
# ============================================================================


def get_article_languages(zim_name, article_path):
    """Find available translations for an article across all installed ZIMs.

    Uses three strategies (in order):
    0. Wikidata Q-ID matching — checks index/cache, extracts on-demand, verifies candidates
    1. Interlanguage links in HTML (for languages not found via Q-ID)
    2. Title-based heuristic search (fallback for ZIMs without Q-IDs)

    Strategy 0 uses on-demand Q-ID disambiguation for large ZIMs:
    - Extract source Q-ID from HTML (one read, ~50ms)
    - Find candidates via heuristic search
    - Verify candidates by reading their HTML for matching Q-ID
    - Cache verified matches for instant future lookups

    Returns {"languages": [{lang, name, zim, path}]} — only VERIFIED entries.
    Must be called with _zim_lock held.
    """
    archive = _srv.get_archive(zim_name)
    if archive is None:
        return {"languages": []}

    # Single-page docs (devdocs): 'index#anchor' is entry 'index' + a fragment.
    # Drop the fragment so translation lookups target the real base entry.
    base_path, _fragment = _srv.split_entry_fragment(article_path)
    article_path = base_path

    # Get article title from path
    title = article_path
    if title.startswith("A/"):
        title = title[2:]

    try:
        entry = archive.get_entry_by_path(article_path)
        item = entry.get_item()
        if item.mimetype not in ("text/html", "application/xhtml+xml"):
            return {"languages": []}
    except Exception as e:
        log.debug(
            "Failed to read article for language detection in %s path %s: %s",
            zim_name,
            article_path,
            e,
        )
        return {"languages": []}

    # Determine the source ZIM's project type and language
    src_info = next(
        (z for z in (_srv._zim_list_cache or []) if z.get("name") == zim_name), None
    )
    src_lang = src_info.get("language", "en") if src_info else "en"

    zim_list = _srv._zim_list_cache or []
    src_project = _zim_project_name(zim_name)

    installed = []
    seen_langs = {src_lang}

    # Strategy 0: Wikidata Q-ID matching (authoritative)
    # Step 0a: Get source article's Q-ID (from index, cache, or on-demand extraction)
    qid = _qid_lookup(zim_name, article_path)
    if qid is None and article_path != title:
        qid = _qid_lookup(zim_name, title)
    if qid is None:
        # On-demand: extract Q-ID from this article's HTML
        qid = _qid_extract_from_html(archive, article_path)
        if qid is not None:
            _qid_cache_store(zim_name, article_path, qid)

    log.debug(
        "interlang %s/%s: qid=%s src_project=%s",
        zim_name,
        article_path,
        qid,
        src_project,
    )

    # Step 0b: Check all target ZIMs for this Q-ID
    if qid is not None:
        for zi in zim_list:
            lang = zi.get("language", "")
            if lang in seen_langs or not lang:
                continue
            n = zi.get("name", "")
            if n == zim_name:
                continue
            # This strategy answers purely from the Q-ID SQLite index, never
            # through get_archive(), so it has to consult the allowlist itself
            # or a restricted user learns the names and article paths of ZIMs
            # they can't open.
            if not _srv.zim_allowed(n):
                continue
            if src_project and _zim_project_name(n) != src_project:
                continue
            # Check full index (small ZIMs) or on-demand cache (large ZIMs)
            matched_path = _qid_find_in_zim(n, qid)
            if matched_path:
                # Cache bidirectionally so the reverse hop works too
                _qid_cache_store(n, matched_path, qid)
                seen_langs.add(lang)
                installed.append(
                    {
                        "lang": lang,
                        "name": _LANG_NATIVE_NAMES.get(lang, lang),
                        "zim": n,
                        "path": matched_path,
                    }
                )
            if len(seen_langs) >= 30:
                break

    # Strategy 1: Interlanguage links from HTML
    # Skip if Q-ID was found (modern Wikipedia ZIMs don't embed interlang links)
    if qid is None:
        try:
            content = bytes(item.content).decode("utf-8", errors="replace")
            pattern = re.compile(
                r'href="https?://([a-z]{2,3})(?:\.m)?'
                r"\.(wikipedia|wiktionary|wikivoyage|wikibooks|wikiquote|wikinews|wikiversity|wikisource)"
                r'\.org/wiki/([^"#]+)"'
            )
            for m in pattern.finditer(content):
                lang = m.group(1)
                lang = _srv._ISO639_3_TO_1.get(lang, lang)
                if lang in seen_langs:
                    continue
                wiki_path = unquote(m.group(3))
                match = _find_article_in_lang_zims(
                    lang, src_project, wiki_path, zim_name, zim_list
                )
                if match:
                    seen_langs.add(lang)
                    installed.append(match)
                if len(seen_langs) >= 30:
                    break
        except Exception as e:
            log.debug("Interlanguage link extraction failed for %s: %s", zim_name, e)

    # Strategy 2: Exact title match with Q-ID verification
    # Try the same path in other language ZIMs (works for "Pizza", "Albert Einstein", etc.)
    for zi in zim_list:
        lang = zi.get("language", "")
        if lang in seen_langs or not lang:
            continue
        n = zi.get("name", "")
        if n == zim_name or (src_project and _zim_project_name(n) != src_project):
            continue
        if not src_project:
            continue
        cand_archive = _srv.get_archive(n)
        if not cand_archive:
            continue
        for try_path in [f"A/{title}", title]:
            try:
                cand_entry = cand_archive.get_entry_by_path(try_path)
                resolved_path = try_path
                if cand_entry.is_redirect:
                    resolved_path = cand_entry.get_redirect_entry().path
                # Q-ID verification: reject same-title different-article
                if qid is not None:
                    cand_qid = _qid_extract_from_html(cand_archive, resolved_path)
                    if cand_qid is not None:
                        _qid_cache_store(n, resolved_path, cand_qid)
                    if cand_qid is not None and cand_qid != qid:
                        continue
                seen_langs.add(lang)
                installed.append(
                    {
                        "lang": lang,
                        "name": _LANG_NATIVE_NAMES.get(lang, lang),
                        "zim": n,
                        "path": resolved_path,
                    }
                )
                break
            except KeyError:
                continue
        if len(seen_langs) >= 30:
            break

    # Cross-cache: store the Q-ID for ALL found matches so any→any direction works.
    # Without this, hopping English→Hebrew caches Q-ID for Hebrew, but Hebrew→German
    # fails because German's sparse nopic index doesn't have the Q-ID.
    if qid is not None and len(installed) > 0:
        all_paths = [(zim_name, article_path)] + [
            (m["zim"], m["path"]) for m in installed
        ]
        for z, p in all_paths:
            _qid_cache_store(z, p, qid)

    installed.sort(key=lambda x: x["name"])
    return {"languages": installed[:20]}


def _zim_project_name(zim_name):
    """Extract project name from ZIM name for cross-language matching."""
    n = zim_name.lower()
    for proj in (
        "wikipedia",
        "wiktionary",
        "wikivoyage",
        "wikibooks",
        "wikiquote",
        "wikiversity",
    ):
        if n.startswith(proj) or proj in n:
            return proj
    return ""


def _find_article_in_lang_zims(lang, src_project, wiki_path, exclude_zim, zim_list):
    """Find an article across all installed ZIMs for a given language+project.

    Prefers _all variants over subsets, and higher quality (maxi > nopic > mini).
    Returns dict with {lang, name, zim, path} or None.
    """
    candidates = []
    # Domain map entry
    domain = f"{lang}.{src_project}.org" if src_project else ""
    if domain:
        domain_zim = _domain_zim_map.get(domain)
        if domain_zim and domain_zim != exclude_zim:
            candidates.append(domain_zim)
    # All ZIMs matching language + project
    for zi in zim_list:
        n = zi.get("name", "")
        if n == exclude_zim or n in candidates:
            continue
        if zi.get("language") == lang and src_project and src_project in n.lower():
            candidates.append(n)

    best = None
    for cand_name in candidates:
        cand_archive = _srv.get_archive(cand_name)
        if not cand_archive:
            continue
        resolved = None
        for try_path in [f"A/{wiki_path}", wiki_path]:
            try:
                cand_entry = cand_archive.get_entry_by_path(try_path)
                # Follow redirects to get actual content path
                resolved = (
                    cand_entry.get_redirect_entry().path
                    if cand_entry.is_redirect
                    else try_path
                )
                break
            except KeyError:
                continue
        if resolved:
            quality = _zim_quality_score(cand_name)
            zi_info = next((z for z in zim_list if z.get("name") == cand_name), None)
            entry_count = zi_info.get("entry_count", 0) if zi_info else 0
            if (
                best is None
                or quality > best[2]
                or (quality == best[2] and entry_count > best[3])
            ):
                best = (cand_name, resolved, quality, entry_count)

    if best:
        return {
            "lang": lang,
            "name": _LANG_NATIVE_NAMES.get(lang, lang),
            "zim": best[0],
            "path": best[1],
        }
    return None


def _zim_quality_score(name):
    """Score a ZIM by quality for preferring _all over subsets, full over mini."""
    n = name.lower()
    score = 0
    if "_all" in n:
        score += 100
    if "maxi" in n:
        score += 30
    elif "nopic" in n:
        score += 20
    elif "mini" in n:
        score += 10
    else:
        score += 25
    return score
