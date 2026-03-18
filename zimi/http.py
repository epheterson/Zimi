"""HTTP request handler for Zimi.

Rate limiting, metrics, usage tracking, template loading, and the ZimHandler
class. Public API routes (search, read, suggest, list, random, resolve, etc.)
and static/ZIM content serving. Manage routes delegate to zimi.manage.
"""

import base64
import gzip
import hashlib
import json
import logging
import os
import random as _random
import re
import shutil
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

import zimi.server as _srv
from zimi.manage import (
    _check_manage_auth, handle_manage_get, handle_manage_post,
    handle_manage_delete,
)

log = logging.getLogger("zimi")

# ============================================================================
# Rate Limiting
# ============================================================================

RATE_LIMIT = int(os.environ.get("ZIMI_RATE_LIMIT", "60"))  # API requests per minute per IP (0 = disabled)
RATE_LIMIT_CONTENT = RATE_LIMIT * 20  # /w/ sub-resources: icons, CSS, images (1200/min default)
_rate_buckets = {}       # {ip: [timestamps]} — API endpoints
_rate_buckets_content = {}  # {ip: [timestamps]} — /w/ content
_rate_lock = threading.Lock()


def _check_rate_limit(ip, content=False):
    """Check if IP has exceeded rate limit. Returns seconds to wait, or 0 if OK."""
    limit = RATE_LIMIT_CONTENT if content else RATE_LIMIT
    if limit <= 0:
        return 0
    buckets = _rate_buckets_content if content else _rate_buckets
    now = time.time()
    window = 60.0  # 1 minute window
    with _rate_lock:
        timestamps = buckets.get(ip, [])
        # Prune old entries
        timestamps = [t for t in timestamps if now - t < window]
        if len(timestamps) >= limit:
            retry_after = max(1, int(timestamps[0] + window - now) + 1)
            buckets[ip] = timestamps
            return retry_after
        timestamps.append(now)
        buckets[ip] = timestamps
        # Periodic cleanup of stale IPs
        if len(buckets) > 1000:
            stale = [k for k, v in buckets.items() if not v or now - v[-1] > window]
            for k in stale:
                del buckets[k]
        # Hard cap: prevent unbounded memory growth from IP spoofing
        if len(buckets) > 10000:
            buckets.clear()
    return 0


# ============================================================================
# Metrics
# ============================================================================

_metrics = {
    "start_time": time.time(),
    "requests": {},       # {endpoint: count}
    "latency_sum": {},    # {endpoint: total_seconds}
    "errors": 0,
    "rate_limited": 0,
}
_metrics_lock = threading.Lock()


def _record_metric(endpoint, latency, error=False):
    """Record a request metric."""
    with _metrics_lock:
        _metrics["requests"][endpoint] = _metrics["requests"].get(endpoint, 0) + 1
        _metrics["latency_sum"][endpoint] = _metrics["latency_sum"].get(endpoint, 0) + latency
        if error:
            _metrics["errors"] += 1


def _get_metrics():
    """Get current metrics snapshot."""
    with _metrics_lock:
        uptime = time.time() - _metrics["start_time"]
        total_reqs = sum(_metrics["requests"].values())
        endpoints = {}
        for ep, count in _metrics["requests"].items():
            avg_latency = _metrics["latency_sum"].get(ep, 0) / count if count > 0 else 0
            endpoints[ep] = {"count": count, "avg_latency_ms": round(avg_latency * 1000, 1)}
        return {
            "uptime_seconds": round(uptime),
            "total_requests": total_reqs,
            "errors": _metrics["errors"],
            "rate_limited": _metrics["rate_limited"],
            "endpoints": endpoints,
        }


# ============================================================================
# Usage Stats
# ============================================================================

_usage_stats = {
    "searches": 0,
    "article_reads": 0,
    "by_zim": {},  # {zim_name: {"reads": N, "searches": N}}
}
_usage_lock = threading.Lock()


def _record_usage(event_type, zim_name=None):
    """Record a usage event. Thread-safe. Only tracks known ZIM names."""
    with _usage_lock:
        if event_type == "search":
            _usage_stats["searches"] += 1
        elif event_type in ("read", "iframe"):
            _usage_stats["article_reads"] += 1
        if zim_name and zim_name in _srv.get_zim_files():
            if zim_name not in _usage_stats["by_zim"]:
                _usage_stats["by_zim"][zim_name] = {"reads": 0, "searches": 0}
            bucket = _usage_stats["by_zim"][zim_name]
            if event_type == "search":
                bucket["searches"] += 1
            else:
                bucket["reads"] += 1


def _get_usage_stats():
    """Return usage snapshot: top ZIMs, totals."""
    with _usage_lock:
        by_zim = dict(_usage_stats["by_zim"])
        top = sorted(by_zim.items(), key=lambda x: x[1]["reads"] + x[1]["searches"], reverse=True)[:10]
        return {
            "searches": _usage_stats["searches"],
            "article_reads": _usage_stats["article_reads"],
            "top_zims": [{"name": n, **v} for n, v in top],
        }


def _get_disk_usage():
    """Get disk usage info for ZIM directory. Works on all platforms."""
    try:
        usage = shutil.disk_usage(_srv.ZIM_DIR)
        total = usage.total
        free = usage.free
        used = usage.used
        zim_size = sum(os.path.getsize(os.path.join(_srv.ZIM_DIR, f))
                       for f in os.listdir(_srv.ZIM_DIR) if f.endswith(".zim"))
        # List partial (.tmp) downloads
        tmp_files = []
        for f in os.listdir(_srv.ZIM_DIR):
            if f.endswith(".zim.tmp"):
                try:
                    fpath = os.path.join(_srv.ZIM_DIR, f)
                    tmp_files.append({
                        "filename": f,
                        "size_bytes": os.path.getsize(fpath),
                        "age_hours": round((time.time() - os.path.getmtime(fpath)) / 3600, 1),
                    })
                except OSError:
                    pass
        return {
            "zim_dir": _srv.ZIM_DIR,
            "data_dir": _srv.ZIMI_DATA_DIR,
            "disk_total_gb": round(total / _srv._BYTES_PER_GB, 1),
            "disk_free_gb": round(free / _srv._BYTES_PER_GB, 1),
            "disk_used_gb": round(used / _srv._BYTES_PER_GB, 1),
            "disk_pct": round(used / total * 100, 1) if total > 0 else 0,
            "zim_size_gb": round(zim_size / _srv._BYTES_PER_GB, 1),
            "tmp_files": tmp_files,
        }
    except (OSError, AttributeError):
        return {}


# ============================================================================
# UI Templates
# ============================================================================

# MIME types that benefit from gzip (text-based, not already compressed)
COMPRESSIBLE_TYPES = {"text/", "application/javascript", "application/json", "application/xml", "image/svg+xml"}

_TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
try:
    with open(os.path.join(_TEMPLATE_DIR, "index.html")) as f:
        SEARCH_UI_HTML = f.read()
except FileNotFoundError:
    SEARCH_UI_HTML = "<html><body><h1>Zimi</h1><p>UI template not found. API endpoints are still available.</p></body></html>"

# Auto-version static assets: replace ?v=N with content-hash so deploys bust caches.
# This eliminates manual version bumping — any file change gets a new URL automatically.
_STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if os.path.isdir(_STATIC_DIR):
    def _static_hash(fname):
        """Short content hash for a static file."""
        p = os.path.join(_STATIC_DIR, fname)
        if os.path.exists(p):
            return hashlib.md5(open(p, "rb").read()).hexdigest()[:8]
        return "0"
    # Replace versioned references: /static/foo.js?v=39 → /static/foo.js?v=a1b2c3d4
    def _replace_static_ver(m):
        fname = m.group(1)
        return f"/static/{fname}?v={_static_hash(fname)}"
    SEARCH_UI_HTML = re.sub(
        r'/static/([\w./-]+)\?v=\d+',
        _replace_static_ver,
        SEARCH_UI_HTML
    )
    # Inject build config into inline script so app.js can read versioned values.
    # Template has: var __ZIMI_CONFIG = {discoverStamp:'disc6',i18nHash:'0'};
    _build_stamp = _static_hash("app.js")[:6]
    _i18n_hash = hashlib.md5(
        b"".join(open(os.path.join(_STATIC_DIR, "i18n", f), "rb").read()
                 for f in sorted(os.listdir(os.path.join(_STATIC_DIR, "i18n")))
                 if f.endswith(".json"))
    ).hexdigest()[:8] if os.path.isdir(os.path.join(_STATIC_DIR, "i18n")) else "0"
    SEARCH_UI_HTML = SEARCH_UI_HTML.replace(
        "discoverStamp:'disc6'", f"discoverStamp:'d{_build_stamp}'"
    ).replace(
        "i18nHash:'0'", f"i18nHash:'{_i18n_hash}'"
    )


# ============================================================================
# HTTP Request Handler
# ============================================================================

class ZimHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30  # seconds — prevents slow-client DoS on POST bodies

    def do_HEAD(self):
        """Handle HEAD requests (Traefik health checks, uptime monitors)."""
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
        self.end_headers()

    # IPs allowed to set X-Forwarded-For (reverse proxies)
    _TRUSTED_PROXIES = {"127.0.0.1", "::1", "172.17.0.1", "172.18.0.1"}

    def _client_ip(self):
        """Get client IP, respecting X-Forwarded-For only from trusted proxies."""
        direct_ip = self.client_address[0]
        if direct_ip in self._TRUSTED_PROXIES:
            xff = self.headers.get("X-Forwarded-For")
            if xff:
                return xff.split(",")[0].strip()
        return direct_ip

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        def param(key, default=None):
            return params.get(key, [default])[0]

        # Rate limit: API endpoints at RATE_LIMIT, /w/ content at 20x, /manage/ at base rate
        rate_limited_paths = ("/search", "/read", "/suggest", "/snippet", "/random")
        is_w_content = parsed.path.startswith("/w/")
        is_manage = parsed.path.startswith("/manage/")
        if parsed.path in rate_limited_paths or is_w_content or is_manage:
            retry_after = _check_rate_limit(self._client_ip(), content=is_w_content)
            if retry_after > 0:
                with _metrics_lock:
                    _metrics["rate_limited"] += 1
                self.send_response(429)
                self.send_header("Retry-After", str(retry_after))
                self.send_header("Content-Type", "application/json")
                msg = json.dumps({"error": "rate limited", "retry_after": retry_after}).encode()
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return

        try:
            if parsed.path == "/search":
                q = param("q")
                if not q:
                    return self._json(400, {"error": "missing ?q= parameter"})
                try:
                    limit = max(1, min(int(param("limit", "5")), _srv.MAX_SEARCH_LIMIT))
                except (ValueError, TypeError):
                    limit = 5
                zim_param = param("zim")
                collection = param("collection")
                lang_filter = param("lang", "")
                # Resolve collection → zim list
                if collection:
                    cdata = _srv._load_collections()
                    coll = cdata.get("collections", {}).get(collection)
                    if not coll:
                        return self._json(400, {"error": f"Collection '{collection}' not found"})
                    filter_zim = coll.get("zims", []) or None
                elif zim_param:
                    filter_zim = [z.strip() for z in zim_param.split(",") if z.strip()]
                    if len(filter_zim) == 1:
                        filter_zim = filter_zim[0]
                else:
                    filter_zim = None
                # Apply language filter: restrict to ZIMs matching the given language
                if lang_filter:
                    lang_zims = [z["name"] for z in (_srv._zim_list_cache or []) if z.get("language", "") == lang_filter]
                    if not lang_zims:
                        return self._json(200, {"results": [], "by_source": {}, "by_language": {}, "total": 0, "elapsed": 0, "partial": False})
                    if filter_zim is None:
                        filter_zim = lang_zims
                    else:
                        # Intersect with existing filter
                        allowed = set(lang_zims)
                        filter_zim = [z for z in (filter_zim if isinstance(filter_zim, list) else [filter_zim]) if z in allowed]
                        if not filter_zim:
                            return self._json(200, {"results": [], "by_source": {}, "by_language": {}, "total": 0, "elapsed": 0, "partial": False})
                fast = param("fast") == "1"
                zim_scope_str = ",".join(sorted(filter_zim)) if isinstance(filter_zim, list) else (filter_zim or "")
                cache_key = (q.lower().strip(), zim_scope_str, limit, fast)
                cached = _srv._search_cache_get(cache_key)
                if cached is not None:
                    _record_metric("/search", 0)
                    _record_usage("search")
                    return self._json(200, cached)
                t0 = time.time()
                if fast:
                    # Fast path uses _suggest_pool internally, no _zim_lock needed
                    result = _srv.search_all(q, limit=limit, filter_zim=filter_zim, fast=True)
                else:
                    # FTS path uses _fts_pool (per-ZIM locks), no _zim_lock needed
                    result = _srv.search_all(q, limit=limit, filter_zim=filter_zim)
                dt = time.time() - t0
                _srv._search_cache_put(cache_key, result)
                _record_metric("/search", dt)
                _record_usage("search")
                zim_label = ",".join(filter_zim) if isinstance(filter_zim, list) else (filter_zim or "all")
                log.info("search q=%r limit=%d zim=%s fast=%s %.1fs", q, limit, zim_label, fast, dt)
                return self._json(200, result)

            elif parsed.path == "/read":
                zim = param("zim")
                path = param("path")
                if not zim or not path:
                    return self._json(400, {"error": "missing ?zim= and ?path= parameters"})
                try:
                    max_len = min(int(param("max_length", str(_srv.MAX_CONTENT_LENGTH))), _srv.READ_MAX_LENGTH)
                except ValueError:
                    max_len = _srv.MAX_CONTENT_LENGTH
                t0 = time.time()
                with _srv._zim_lock:
                    result = _srv.read_article(zim, path, max_length=max_len)
                _record_metric("/read", time.time() - t0)
                _record_usage("read", zim)
                return self._json(200, result)

            elif parsed.path == "/suggest":
                q = param("q")
                if not q:
                    return self._json(400, {"error": "missing ?q= parameter"})
                try:
                    limit = max(1, min(int(param("limit", "10")), _srv.MAX_SEARCH_LIMIT))
                except (ValueError, TypeError):
                    limit = 10
                zim_param = param("zim")
                collection = param("collection")
                # Resolve collection → zim list
                if collection:
                    cdata = _srv._load_collections()
                    coll = cdata.get("collections", {}).get(collection)
                    zim_names = coll.get("zims", []) if coll else None
                elif zim_param:
                    zim_names = [z.strip() for z in zim_param.split(",") if z.strip()]
                else:
                    zim_names = None
                t0 = time.time()
                # Use the fast search path (parallel, FTS5 title indexes)
                # then reformat to suggest's {zim: [{path, title}, ...]} shape
                filter_zim = ",".join(zim_names) if zim_names else None
                search_result = _srv.search_all(q, fast=True, limit=limit, filter_zim=filter_zim)
                result = {}
                for r in search_result.get("results", []):
                    zn = r["zim"]
                    if zn not in result:
                        result[zn] = []
                    result[zn].append({"path": r["path"], "title": r["title"]})
                _record_metric("/suggest", time.time() - t0)
                return self._json(200, result)

            elif parsed.path == "/list":
                result = _srv.list_zims()
                return self._json(200, result)

            elif parsed.path == "/languages":
                # Installed language summary with native names and ZIM counts
                lang_zims = {}  # {lang_code: [zim_name, ...]}
                for z in (_srv._zim_list_cache or []):
                    lang = z.get("language", "")
                    if lang:
                        lang_zims.setdefault(lang, []).append(z["name"])
                result = []
                for lang, zim_names in sorted(lang_zims.items()):
                    result.append({
                        "code": lang,
                        "name": _srv._LANG_NATIVE_NAMES.get(lang, lang),
                        "zim_count": len(zim_names),
                        "zims": zim_names,
                    })
                return self._json(200, result)

            elif parsed.path == "/article-languages":
                zim = param("zim")
                path = param("path")
                if not zim or not path:
                    return self._json(400, {"error": "missing ?zim= and ?path= parameters"})
                with _srv._zim_lock:
                    if _srv.get_archive(zim) is None:
                        return self._json(404, {"error": f"ZIM '{zim}' not found"})
                    result = _srv.get_article_languages(zim, path)
                return self._json(200, result)

            elif parsed.path == "/catalog":
                zim = param("zim")
                if not zim:
                    return self._json(400, {"error": "missing ?zim= parameter"})
                with _srv._zim_lock:
                    result = _srv.get_catalog(zim)
                return self._json(200, result)

            elif parsed.path == "/snippet":
                zim = param("zim")
                path = param("path")
                if not zim or not path:
                    return self._json(400, {"error": "missing ?zim= and ?path= parameters"})
                t0 = time.time()
                snippet = ""
                thumbnail = None
                with _srv._zim_lock:
                    archive = _srv.get_archive(zim)
                    if archive is None:
                        return self._json(404, {"error": f"ZIM '{zim}' not found"})
                    try:
                        entry = archive.get_entry_by_path(path)
                        item = entry.get_item()
                        if item.size > _srv.MAX_CONTENT_BYTES:
                            _record_metric("/snippet", time.time() - t0)
                            return self._json(200, {"snippet": ""})
                        # Read first 15KB — enough for <head> meta tags + initial content
                        raw = bytes(item.content)[:15360]
                        text = raw.decode("UTF-8", errors="replace")
                        # Prefer meta description (skips nav/header boilerplate)
                        for desc_pat in [
                            r'<meta\s+(?:name|property)=["\'](?:og:)?description["\']\s+content=["\']([^"\']{20,})["\']',
                            r'<meta\s+content=["\']([^"\']{20,})["\']\s+(?:name|property)=["\'](?:og:)?description["\']',
                        ]:
                            desc_m = re.search(desc_pat, text[:8000], re.IGNORECASE)
                            if desc_m:
                                snippet = _srv.strip_html(desc_m.group(1))[:300].strip()
                                break
                        # Fallback: extract from <main> or <article> body (skip nav boilerplate)
                        if not snippet:
                            for tag in ['main', 'article']:
                                tag_m = re.search(r'<' + tag + r'[\s>]', text, re.IGNORECASE)
                                if tag_m:
                                    plain = _srv.strip_html(text[tag_m.start():])
                                    snippet = plain[:300].strip()
                                    break
                        # Last resort: full page text
                        if not snippet:
                            snippet = _srv.strip_html(text)[:300].strip()
                        # Lightweight thumbnail: og:image / twitter:image from <head>
                        for img_pat in [
                            r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']',
                            r'<meta\s+content=["\']([^"\']+)["\']\s+property=["\']og:image["\']',
                            r'<meta\s+name=["\']twitter:image["\']\s+content=["\']([^"\']+)["\']',
                            r'<meta\s+content=["\']([^"\']+)["\']\s+name=["\']twitter:image["\']',
                        ]:
                            img_m = re.search(img_pat, text[:8000], re.IGNORECASE)
                            if img_m:
                                src = img_m.group(1)
                                if not src.startswith(("http", "//", "data:")) and not src.lower().endswith(".svg"):
                                    resolved = _srv._resolve_img_path(archive, path, src)
                                    if resolved:
                                        thumbnail = f"/w/{zim}/{resolved}"
                                        break
                        # Fallback: best <img> in content — skip icons/badges, prefer larger images
                        if not thumbnail:
                            _skip_img = re.compile(r'icon|badge|logo|arrow|button|sprite|spacer|1x1|pixel|emoji|flag.*\.svg', re.IGNORECASE)
                            best_img = None
                            best_area = 0
                            for img_m2 in re.finditer(r'<img\b([^>]*)>', text[:15000], re.IGNORECASE):
                                attrs = img_m2.group(1)
                                src_m = re.search(r'src=["\']([^"\']+)["\']', attrs)
                                if not src_m:
                                    continue
                                src = src_m.group(1)
                                if src.startswith(("data:", "http", "//")) or src.lower().endswith(".svg"):
                                    continue
                                if _skip_img.search(src) or _skip_img.search(attrs):
                                    continue
                                w_m = re.search(r'width=["\']?(\d+)', attrs)
                                h_m = re.search(r'height=["\']?(\d+)', attrs)
                                w = int(w_m.group(1)) if w_m else 0
                                h = int(h_m.group(1)) if h_m else 0
                                # Skip explicitly tiny images
                                if (w > 0 and w < 60) or (h > 0 and h < 40):
                                    continue
                                area = (w or 200) * (h or 150)
                                if area > best_area:
                                    resolved = _srv._resolve_img_path(archive, path, src)
                                    if resolved:
                                        best_img = f"/w/{zim}/{resolved}"
                                        best_area = area
                                        if area >= 200 * 150:
                                            break  # Good enough — stop scanning
                            if best_img:
                                thumbnail = best_img
                    except (KeyError, Exception):
                        pass
                _record_metric("/snippet", time.time() - t0)
                result = {"snippet": snippet}
                if thumbnail:
                    result["thumbnail"] = thumbnail
                return self._json(200, result)

            elif parsed.path == "/collections":
                data = _srv._load_collections()
                return self._json(200, data)

            elif parsed.path == "/health":
                zim_count = len(_srv.get_zim_files())
                return self._json(200, {"status": "ok", "version": _srv.ZIMI_VERSION, "zim_count": zim_count, "pdf_support": _srv.HAS_PYMUPDF})

            elif parsed.path == "/random":
                zim = param("zim")  # optional: scope to specific ZIM
                if zim:
                    if zim not in _srv.get_zim_files():
                        return self._json(404, {"error": f"ZIM '{zim}' not found"})
                    pick_name = zim
                else:
                    eligible = [z for z in (_srv._zim_list_cache or []) if isinstance(z.get("entries"), int) and z["entries"] > 100]
                    if not eligible:
                        return self._json(200, {"error": "no ZIMs available"})
                    pick_name = _random.choice(eligible)["name"]
                want_thumb = param("thumb") == "1"
                require_thumb = param("require_thumb") == "1"
                is_wiktionary = "wiktionary" in pick_name.lower()
                is_gutenberg = "gutenberg" in pick_name.lower()
                is_wikipedia = "wikipedia" in pick_name.lower()
                date_param = param("date")  # MMDD format
                is_wikiquote = "wikiquote" in pick_name.lower()
                max_tries = 50 if is_wiktionary else (30 if (is_gutenberg or is_wikiquote) else (5 if (require_thumb or (is_wikipedia and date_param)) else 1))
                t0 = time.time()
                with _srv._zim_lock:
                    archive = _srv.get_archive(pick_name)
                    if archive is None:
                        return self._json(200, {"error": "archive not available"})
                seed_param = param("seed")  # For deterministic daily picks
                rng = None
                if seed_param:
                    seed_val = int(hashlib.md5((pick_name + seed_param).encode()).hexdigest()[:8], 16)
                    rng = _random.Random(seed_val)
                # Batch all ZIM reads under a single lock acquisition
                candidates = []
                with _srv._zim_lock:
                    for _try in range(max_tries):
                        result = None
                        if date_param and len(date_param) == 4 and _try == 0:
                            result = _srv._get_dated_entry(archive, pick_name, date_param, rng=rng)
                        if not result:
                            result = _srv.random_entry(archive, rng=rng)
                        if not result:
                            continue
                        preview = None
                        if want_thumb:
                            preview = _srv._extract_preview(archive, pick_name, result["path"])
                        candidates.append((result, preview))
                # Filter candidates outside the lock
                best_result = None
                best_preview = None
                for result, preview in candidates:
                    # Gutenberg: prefer cover pages
                    if is_gutenberg and "_cover" not in result.get("path", ""):
                        if best_result is None:
                            best_result = result
                            best_preview = preview
                        continue
                    # Skip non-English or boring wiktionary entries
                    if is_wiktionary and preview and (preview.get("non_english") or preview.get("boring")):
                        if best_result is None:
                            best_result = result
                            best_preview = preview
                        continue
                    # Wiktionary: accept interesting English entry
                    if is_wiktionary and preview and not preview.get("non_english") and not preview.get("boring"):
                        best_result = result
                        best_preview = preview
                        break
                    # Wikiquote: require an actual quote
                    if is_wikiquote and preview:
                        blurb = preview.get("blurb") or ""
                        if blurb and blurb[0] in ('\u201c', '"'):
                            best_result = result
                            best_preview = preview
                            break
                        if best_result is None:
                            best_result = result
                            best_preview = preview
                        continue
                    if not require_thumb or (preview and preview["thumbnail"]):
                        best_result = result
                        best_preview = preview
                        break
                    if best_result is None:
                        best_result = result
                        best_preview = preview
                if not best_result:
                    return self._json(200, {"error": "no articles found"})
                dt = time.time() - t0
                chosen = {"zim": pick_name, "path": best_result["path"], "title": best_result["title"]}
                if best_preview:
                    # Use extracted title if the entry title looks like a slug
                    if best_preview.get("title"):
                        chosen["title"] = best_preview["title"]
                    if best_preview["thumbnail"]:
                        chosen["thumbnail"] = best_preview["thumbnail"]
                    if best_preview["blurb"]:
                        chosen["blurb"] = best_preview["blurb"]
                    if best_preview.get("attribution"):
                        chosen["attribution"] = best_preview["attribution"]
                    if best_preview.get("speaker"):
                        chosen["speaker"] = best_preview["speaker"]
                    if best_preview.get("author"):
                        chosen["author"] = best_preview["author"]
                    if best_preview.get("part_of_speech"):
                        chosen["part_of_speech"] = best_preview["part_of_speech"]
                # XKCD date lookup from archive page (available for clients that want it)
                # Must hold _zim_lock — _xkcd_date_lookup reads ZIM entries via libzim C API
                if "xkcd" in pick_name.lower() and param("with_date") == "1":
                    with _srv._zim_lock:
                        xkcd_date = _srv._xkcd_date_lookup(archive, best_result["path"])
                    if xkcd_date:
                        chosen["date"] = xkcd_date
                _record_metric("/random", dt)
                log.info("random zim=%s title=%r %.1fs", pick_name, best_result["title"], dt)
                return self._json(200, chosen)

            elif parsed.path == "/resolve":
                # Cross-ZIM URL resolution: given an external URL, find matching ZIM + path
                # Also serves the domain map when ?domains=1 is set
                if param("domains") == "1":
                    return self._json(200, _srv._domain_zim_map)
                url_param = param("url")
                if not url_param:
                    return self._json(400, {"error": "missing ?url= parameter"})
                with _srv._zim_lock:
                    result = _srv._resolve_url_to_zim(url_param)
                if result:
                    # Track cross-ZIM reference if source ZIM provided
                    from_zim = param("from")
                    if from_zim and from_zim != result["zim"]:
                        key = (from_zim, result["zim"])
                        with _srv._xzim_refs_lock:
                            _srv._xzim_refs[key] = _srv._xzim_refs.get(key, 0) + 1
                    return self._json(200, {"found": True, **result})
                return self._json(200, {"found": False})

            elif parsed.path.startswith("/manage/"):
                return handle_manage_get(self, parsed, params)

            elif parsed.path.startswith("/static/"):
                return self._serve_static(parsed.path[8:])  # strip "/static/"

            elif parsed.path in ("/favicon.ico", "/favicon.png", "/favicon-64.png"):
                return self._serve_favicon(parsed.path)

            elif parsed.path == "/apple-touch-icon.png":
                return self._serve_apple_touch_icon()

            elif parsed.path == "/":
                return self._serve_index()

            elif parsed.path.startswith("/w/"):
                # /w/<zim_name>/<entry_path> — serve raw ZIM content
                rest = parsed.path[3:]  # strip "/w/"
                slash = rest.find("/")
                if slash == -1:
                    zim_name, entry_path = unquote(rest), ""
                else:
                    zim_name = unquote(rest[:slash])
                    entry_path = unquote(rest[slash + 1:])
                # Top-level browser navigation (reload/bookmark) → serve SPA shell
                # so client-side router can handle the deep link.
                # ?raw=1 bypasses SPA shell (used for PDF new-tab opening).
                # ?view=1 forces SPA shell (used in pushState URLs for PDFs so CDN
                # caching of the raw PDF doesn't break reload).
                qs = parse_qs(parsed.query)
                is_raw = "raw" in qs
                is_view = "view" in qs
                fetch_dest = self.headers.get("Sec-Fetch-Dest", "")
                if is_view or ((fetch_dest == "document" or not entry_path) and not is_raw and not entry_path.lower().endswith(".epub")):
                    return self._serve_index(vary="Sec-Fetch-Dest")
                # Track iframe article loads
                if fetch_dest == "iframe":
                    _record_usage("iframe", zim_name)
                return self._serve_zim_content(zim_name, entry_path)

            else:
                return self._json(404, {"error": "not found", "endpoints": ["/search", "/read", "/suggest", "/list", "/catalog", "/health", "/w/"]})

        except Exception as e:
            traceback.print_exc()
            return self._json(500, {"error": "Internal server error"})

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            content_len = int(self.headers.get("Content-Length", "0"))
            if content_len > _srv.MAX_POST_BODY:
                return self._json(413, {"error": f"Request body too large (max {_srv.MAX_POST_BODY} bytes)"})
            body = self.rfile.read(content_len) if content_len > 0 else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {}

            if parsed.path.startswith("/manage/"):
                return handle_manage_post(self, parsed, data)

            if parsed.path == "/resolve":
                retry_after = _check_rate_limit(self._client_ip())
                if retry_after > 0:
                    with _metrics_lock:
                        _metrics["rate_limited"] += 1
                    return self._json(429, {"error": "rate limited", "retry_after": retry_after})
                # Batch cross-ZIM URL resolution: POST {"urls": [...]} → {"results": {...}}
                urls = data.get("urls", [])
                if not isinstance(urls, list) or len(urls) > 100:
                    return self._json(400, {"error": "'urls' must be a list (max 100)"})
                results = {}
                for url_str in urls:
                    if not isinstance(url_str, str):
                        continue
                    with _srv._zim_lock:
                        resolved = _srv._resolve_url_to_zim(url_str)
                    if resolved:
                        results[url_str] = {"found": True, "zim": resolved["zim"], "path": resolved["path"]}
                    else:
                        results[url_str] = {"found": False}
                return self._json(200, {"results": results})

            elif parsed.path == "/collections":
                # Auth: only enforce password when manage mode is on (collections are
                # user-facing features that work without manage mode enabled)
                if _srv.ZIMI_MANAGE and _check_manage_auth(self):
                    return self._json(401, {"error": "unauthorized", "needs_password": True})
                name = data.get("name", "").strip()[:64]
                label = data.get("label", "").strip()[:128]
                # Auto-generate name from label if not provided
                if not name and label:
                    name = re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')[:64]
                if not name:
                    return self._json(400, {"error": "missing 'name' or 'label' field"})
                if not label:
                    label = name
                zim_list = data.get("zims", [])
                if not isinstance(zim_list, list) or len(zim_list) > 200:
                    return self._json(400, {"error": "'zims' must be a list (max 200 items)"})
                with _srv._collections_lock:
                    cdata = _srv._load_collections()
                    cdata["collections"][name] = {"label": label or name, "zims": zim_list}
                    _srv._save_collections(cdata)
                return self._json(200, {"status": "ok", "collection": name})

            elif parsed.path == "/favorites":
                # Auth: same as collections — only when manage mode is on
                if _srv.ZIMI_MANAGE and _check_manage_auth(self):
                    return self._json(401, {"error": "unauthorized", "needs_password": True})
                zim_name = data.get("zim", "").strip()
                if not zim_name:
                    return self._json(400, {"error": "missing 'zim' field"})
                if zim_name not in _srv.get_zim_files():
                    return self._json(400, {"error": f"ZIM '{zim_name}' not found"})
                with _srv._collections_lock:
                    cdata = _srv._load_collections()
                    favs = cdata.get("favorites", [])
                    if zim_name in favs:
                        favs.remove(zim_name)
                        action = "removed"
                    elif len(favs) >= 100:
                        return self._json(400, {"error": "Favorites list is full (max 100)"})
                    else:
                        favs.append(zim_name)
                        action = "added"
                    cdata["favorites"] = favs
                    _srv._save_collections(cdata)
                return self._json(200, {"status": action, "zim": zim_name, "favorites": cdata["favorites"]})

            else:
                return self._json(404, {"error": "not found"})

        except Exception as e:
            traceback.print_exc()
            return self._json(500, {"error": "Internal server error"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        # Rate limit write endpoints
        retry_after = _check_rate_limit(self._client_ip())
        if retry_after > 0:
            with _metrics_lock:
                _metrics["rate_limited"] += 1
            return self._json(429, {"error": "rate limited", "retry_after": retry_after})
        try:
            if parsed.path == "/collections":
                name = params.get("name", [None])[0]
                if not name:
                    return self._json(400, {"error": "missing ?name= parameter"})
                if _srv.ZIMI_MANAGE and _check_manage_auth(self):
                    return self._json(401, {"error": "unauthorized", "needs_password": True})
                with _srv._collections_lock:
                    cdata = _srv._load_collections()
                    if name not in cdata.get("collections", {}):
                        return self._json(404, {"error": f"Collection '{name}' not found"})
                    del cdata["collections"][name]
                    _srv._save_collections(cdata)
                return self._json(200, {"status": "deleted", "collection": name})
            else:
                return self._json(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            return self._json(500, {"error": "Internal server error"})

    def _serve_zim_icon(self, zim_name, archive):
        """Serve the ZIM's 48x48 illustration as a PNG."""
        try:
            icon_data = bytes(archive.get_metadata("Illustration_48x48@1"))
        except Exception as e:
            log.debug("No icon metadata for %s: %s", zim_name, e)
            self.send_response(404)
            self.end_headers()
            return
        etag = f'"icon-{zim_name}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "public, max-age=604800, immutable")
        self.send_header("ETag", etag)
        self.send_header("Content-Length", str(len(icon_data)))
        self.end_headers()
        self.wfile.write(icon_data)

    def _serve_zim_content(self, zim_name, entry_path):
        """Serve raw ZIM content with correct MIME type for the /w/ endpoint.

        Manages _zim_lock internally — holds lock only during libzim reads,
        releases before writing to the socket (important for large video streams).
        """
        # Phase 1: Read from ZIM under lock
        with _srv._zim_lock:
            archive = _srv.get_archive(zim_name)
            if archive is None:
                return self._json(404, {"error": f"ZIM '{zim_name}' not found"})

            # Serve ZIM icon from metadata
            if entry_path == "-/icon":
                return self._serve_zim_icon(zim_name, archive)

            try:
                entry = archive.get_entry_by_path(entry_path)
            except KeyError:
                entry = None
            if entry is None:
                # Old namespace fallback: try stripping or adding A/, I/, C/, -/ prefixes
                for alt in _srv._namespace_fallbacks(entry_path):
                    try:
                        entry = archive.get_entry_by_path(alt)
                        break
                    except KeyError:
                        continue
            if entry is None:
                return self._json(404, {"error": f"Entry '{entry_path}' not found in {zim_name}"})

            # ZIM redirects → HTTP 302 so browser URL updates to canonical path
            if entry.is_redirect:
                target = entry.get_redirect_entry()
                target_path = target.path
                self.send_response(302)
                self.send_header("Location", f"/w/{zim_name}/{target_path}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            item = entry.get_item()
            total_size = item.size
            mimetype = item.mimetype or ""

            ext = os.path.splitext(entry_path)[1].lower()
            if not mimetype:
                mimetype = _srv.MIME_FALLBACK.get(ext, "application/octet-stream")
            # Bare MIME fix: some ZIMs store "mp4" instead of "video/mp4"
            if mimetype and "/" not in mimetype:
                guessed = _srv.MIME_FALLBACK.get("." + mimetype.lower())
                mimetype = guessed if guessed else "application/octet-stream"
            # Fix ZIM packaging bugs: media files stored with wrong mimetype (e.g. text/html)
            # Trust the file extension for known media/binary types over the ZIM metadata
            ext_mime = _srv.MIME_FALLBACK.get(ext)
            if ext_mime and mimetype == "text/html" and ext not in (".html", ".htm"):
                mimetype = ext_mime
            # Force EPUB download (browsers can't render EPUB inline)
            is_epub = entry_path.lower().endswith(".epub") or mimetype in ("application/epub+zip", "application/epub")
            epub_filename = None
            if is_epub:
                mimetype = "application/epub+zip"
                epub_filename = os.path.basename(entry_path)
                if not epub_filename.endswith(".epub"):
                    epub_filename += ".epub"
                content = bytes(item.content)
            else:
                # ETag check BEFORE reading content — avoids materializing large
                # blobs when client already has a cached copy
                is_streamable = any(mimetype.startswith(t) for t in ("video/", "audio/", "application/ogg"))
                etag = '"' + hashlib.md5(f"{zim_name}/{entry_path}/{_srv._cache_generation}".encode()).hexdigest()[:16] + '"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.end_headers()
                    return

                range_start = range_end = None
                if is_streamable:
                    range_header = self.headers.get("Range")
                    if range_header:
                        range_start, range_end = self._parse_range(range_header, total_size)
                    if range_start is not None and range_end is not None:
                        content = bytes(item.content[range_start:range_end + 1])
                    else:
                        content = bytes(item.content)
                else:
                    if total_size > _srv.MAX_SERVE_BYTES:
                        self.send_response(413)
                        self.send_header("Content-Type", "text/plain")
                        msg = f"Entry too large ({total_size // (1024*1024)} MB). Max: {_srv.MAX_SERVE_BYTES // (1024*1024)} MB.".encode()
                        self.send_header("Content-Length", str(len(msg)))
                        self.end_headers()
                        self.wfile.write(msg)
                        return
                    content = bytes(item.content)
        # Lock released — safe to do slow I/O

        # EPUB: write download response outside lock
        if epub_filename:
            self.send_response(200)
            self.send_header("Content-Type", mimetype)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Content-Disposition", f'attachment; filename="{epub_filename}"')
            self.end_headers()
            self.wfile.write(content)
            return

        # Strip <base> tags from HTML
        if mimetype.startswith("text/html"):
            text = content.decode("UTF-8", errors="replace")
            text = re.sub(r'<base\s[^>]*>', '', text, flags=re.IGNORECASE)
            content = text.encode("UTF-8")

        if range_start is not None and range_end is not None:
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {range_start}-{range_end}/{total_size}")
        else:
            self.send_response(200)

        self.send_header("Content-Type", mimetype)
        self.send_header("Cache-Control", "public, max-age=86400, immutable")
        self.send_header("Vary", "Sec-Fetch-Dest")
        self.send_header("ETag", etag)

        if is_streamable:
            self.send_header("Accept-Ranges", "bytes")

        # Sandbox ZIM HTML: allow inline styles/scripts (ZIM content uses them)
        # but block external requests and prevent framing outside Zimi
        if mimetype.startswith("text/html"):
            self.send_header("Content-Security-Policy",
                "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; "
                "frame-ancestors 'self'")

        # Gzip text-based content only (images/PDFs are already compressed)
        compressible = any(mimetype.startswith(t) or mimetype == t for t in COMPRESSIBLE_TYPES)
        if compressible and self._accepts_gzip() and len(content) > 256:
            content = gzip.compress(content, compresslevel=4)
            self.send_header("Content-Encoding", "gzip")

        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _accepts_gzip(self):
        return "gzip" in self.headers.get("Accept-Encoding", "")

    @staticmethod
    def _parse_range(header, total_size):
        """Parse HTTP Range header. Returns (start, end) or (None, None)."""
        if not header or not header.startswith("bytes="):
            return None, None
        range_spec = header[6:].strip()
        if "," in range_spec:
            return None, None  # multi-range not supported
        if range_spec.startswith("-"):
            # Suffix range: last N bytes
            suffix = int(range_spec[1:])
            start = max(0, total_size - suffix)
            return start, total_size - 1
        parts = range_spec.split("-", 1)
        start = int(parts[0])
        end = int(parts[1]) if parts[1] else total_size - 1
        end = min(end, total_size - 1)
        if start > end or start >= total_size:
            return None, None
        return start, end

    def _send(self, code, body_bytes, content_type, vary=None, cache=None, etag=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if cache:
            self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        if vary:
            self.send_header("Vary", vary)
        if self._accepts_gzip() and len(body_bytes) > 256:
            body_bytes = gzip.compress(body_bytes, compresslevel=4)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    # ── Static file serving ──
    # In-memory cache for static files (vendor files like pdf.js are immutable)
    _static_cache = {}
    _static_cache_lock = threading.Lock()

    @staticmethod
    def _static_base_dir():
        """Resolve the static/ directory, checking PyInstaller bundle first."""
        candidates = [
            os.path.join(getattr(sys, '_MEIPASS', ''), "static") if getattr(sys, '_MEIPASS', None) else "",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"),
        ]
        for d in candidates:
            if d and os.path.isdir(d):
                return d
        return None

    def _serve_static(self, rel_path):
        """Serve a file from the static/ directory with caching and security."""
        # Path traversal protection
        if not rel_path or ".." in rel_path.split("/"):
            return self._json(400, {"error": "invalid path"})
        # Normalize and reject absolute paths
        rel_path = rel_path.lstrip("/")
        if os.path.isabs(rel_path):
            return self._json(400, {"error": "invalid path"})

        # Check cache first, then read from disk
        with ZimHandler._static_cache_lock:
            cached = ZimHandler._static_cache.get(rel_path)
        if cached:
            body, content_type = cached
        else:
            base = ZimHandler._static_base_dir()
            if not base:
                return self._json(404, {"error": "static directory not found"})
            file_path = os.path.normpath(os.path.join(base, rel_path))
            # Ensure resolved path is still inside the static dir
            if not file_path.startswith(os.path.normpath(base) + os.sep) and file_path != os.path.normpath(base):
                return self._json(403, {"error": "forbidden"})
            if not os.path.isfile(file_path):
                return self._json(404, {"error": "not found"})
            ext = os.path.splitext(file_path)[1].lower()
            content_type = _srv.MIME_FALLBACK.get(ext, "application/octet-stream")
            with open(file_path, "rb") as f:
                body = f.read()
            # Cache in memory (vendor files are immutable, ~8MB total for pdf.js)
            with ZimHandler._static_cache_lock:
                ZimHandler._static_cache[rel_path] = (body, content_type)

        # Compress text-based static files (viewer.mjs, viewer.css, etc.)
        ct_base = content_type.split(";")[0]
        compressible = any(ct_base.startswith(t) or ct_base == t for t in COMPRESSIBLE_TYPES)
        if self._accepts_gzip() and compressible and len(body) > 256:
            body = gzip.compress(body, compresslevel=4)
            is_gzipped = True
        else:
            is_gzipped = False
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Service worker needs scope override; i18n files change between versions
        if rel_path == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
            self.send_header("Cache-Control", "no-cache")
        elif rel_path.startswith("i18n/"):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("Access-Control-Allow-Origin", "*")
        if is_gzipped:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)

    _favicon_cache = {}

    def _serve_favicon(self, path="/favicon.png"):
        filename = "favicon-64.png" if "64" in path else "favicon.png"
        if filename not in ZimHandler._favicon_cache:
            assets_dir = os.path.dirname(os.path.abspath(__file__))
            icon_paths = [
                os.path.join(assets_dir, "assets", filename),
                os.path.join(getattr(sys, '_MEIPASS', ''), "assets", filename) if getattr(sys, '_MEIPASS', None) else "",
                os.path.join(assets_dir, "assets", "icon.png"),
                os.path.join(getattr(sys, '_MEIPASS', ''), "assets", "icon.png") if getattr(sys, '_MEIPASS', None) else "",
            ]
            for p in icon_paths:
                if p and os.path.exists(p):
                    with open(p, "rb") as f:
                        ZimHandler._favicon_cache[filename] = f.read()
                    break
            if filename not in ZimHandler._favicon_cache:
                # Fallback: extract from HTML template's base64 data URI
                m = re.search(r'data:image/png;base64,([A-Za-z0-9+/=]+)', SEARCH_UI_HTML)
                ZimHandler._favicon_cache[filename] = base64.b64decode(m.group(1)) if m else b''
        data = ZimHandler._favicon_cache.get(filename, b'')
        if not data:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    _apple_touch_icon_data = None

    def _serve_apple_touch_icon(self):
        if ZimHandler._apple_touch_icon_data is None:
            icon_paths = [
                os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "apple-touch-icon.png"),
                os.path.join(getattr(sys, '_MEIPASS', ''), "assets", "apple-touch-icon.png") if getattr(sys, '_MEIPASS', None) else "",
            ]
            for p in icon_paths:
                if p and os.path.exists(p):
                    with open(p, "rb") as f:
                        ZimHandler._apple_touch_icon_data = f.read()
                    break
            if not ZimHandler._apple_touch_icon_data:
                return self._serve_favicon()  # fallback to regular favicon
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(ZimHandler._apple_touch_icon_data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(ZimHandler._apple_touch_icon_data)

    # ETag for the HTML page — computed once at startup from content hash.
    # Changes on every deploy (new content = new hash = new ETag).
    _index_etag = '"z-' + hashlib.md5(SEARCH_UI_HTML.encode()).hexdigest()[:12] + '"'

    def _serve_index(self, vary=None):
        # ETag revalidation: if browser has current version, return 304 (no body).
        # This is what makes Safari work — must-revalidate forces the check.
        if self.headers.get("If-None-Match") == ZimHandler._index_etag:
            self.send_response(304)
            self.send_header("ETag", ZimHandler._index_etag)
            self.send_header("Cache-Control", "public, max-age=0, must-revalidate, s-maxage=3600")
            self.end_headers()
            return
        # Cache strategy:
        #   max-age=0, must-revalidate — browser always revalidates (Safari-safe)
        #   s-maxage=3600 — Cloudflare edge caches 1 hour (fast for users worldwide)
        #   ETag — efficient revalidation (304 = no body, instant response)
        #   deploy.sh purges Cloudflare edge after each deploy.
        return self._html(200, SEARCH_UI_HTML, vary=vary,
                          cache="public, max-age=0, must-revalidate, s-maxage=3600",
                          etag=ZimHandler._index_etag)

    def _html(self, code, content, vary=None, cache=None, etag=None):
        self._send(code, content.encode(), "text/html; charset=utf-8", vary=vary, cache=cache, etag=etag)

    def _json(self, code, data):
        self._send(code, json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(), "application/json")

    def log_message(self, format, *args):
        # Light logging: errors + slow requests. Suppress 200/304 noise.
        if len(args) >= 2 and str(args[1]) in ("200", "304"):
            return
        log.info(format, *args)
