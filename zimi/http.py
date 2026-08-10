"""HTTP request handler for Zimi.

Rate limiting, metrics, usage tracking, template loading, and the ZimHandler
class. Public API routes (search, read, suggest, list, random, resolve, etc.)
and static/ZIM content serving. Manage routes delegate to zimi.manage.
"""

import base64
import gzip
import hashlib
import ipaddress
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
from urllib.parse import urlparse, parse_qs, unquote, quote

import zimi.server as _srv
from zimi import users as _users
from zimi.manage import (
    _manage_auth_challenge,
    handle_manage_get,
    handle_manage_post,
)

log = logging.getLogger("zimi")

# A client that hangs up mid-response surfaces as one of these when the
# handler writes to the dead socket. That is the CLIENT's doing, not a server
# error — under load (e.g. every UI poller timing out at once, #51) treating
# it as an error printed an interleaved traceback storm plus bogus 500s that
# read like a crash. Every dispatch backstop routes these to one debug line.
_DISCONNECT_ERRS = (BrokenPipeError, ConnectionResetError)

# ============================================================================
# Rate Limiting
# ============================================================================


# Reverse-proxy hops whose forwarded client-IP headers we trust. Optional
# operator override (comma-separated CIDRs); empty default = trust any private/
# loopback/link-local hop. The origin is never directly WAN-reachable — a
# forwarding hop is always private — so the default is safe, and an operator on
# an unusual topology can still pin it explicitly.
def _load_trusted_proxy_cidrs():
    raw = os.environ.get("ZIMI_TRUSTED_PROXIES", "").strip()
    if not raw:
        return None  # sentinel: use the "any private hop" heuristic
    nets = []
    for tok in raw.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            nets.append(ipaddress.ip_network(tok, strict=False))
        except ValueError:
            pass
    return nets or None


_TRUSTED_PROXY_CIDRS = _load_trusted_proxy_cidrs()

# Carrier-grade NAT / overlay-network shared address space (RFC 6598). Tailscale
# hands every node a 100.64.0.0/10 address (and ZeroTier-style overlays live in
# comparable private-by-convention ranges); the block is deliberately excluded
# from the public routing table. Python's ipaddress.is_private is False for it,
# so without this Zimi classifies Tailscale peers as PUBLIC and locks management
# on them (#36 — the lock "came and went" as the reporter switched between LAN
# and Tailscale).
CGNAT_NET = ipaddress.ip_network("100.64.0.0/10")

# Default on. An inbound TCP connection with a 100.64/10 source cannot complete a
# handshake from the public internet — the return path to that range is
# unroutable — so such a connection means genuine membership in a shared/overlay
# network (Tailscale, ZeroTier), which is a private-tier peer. Residual risk: a
# host whose OWN uplink sits inside a carrier's CGNAT could in theory see other
# subscribers of that carrier in the same range; operators in that situation set
# a management password (and ZIMI_TRUST_CGNAT=0) to opt out.
_TRUST_CGNAT = os.environ.get("ZIMI_TRUST_CGNAT", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
    "",
)


def _is_trusted_net(ip):
    """True when an ipaddress object is on a private-tier network: RFC1918/ULA
    private, loopback, link-local, or (unless ZIMI_TRUST_CGNAT=0) the
    100.64.0.0/10 CGNAT/overlay range Tailscale and similar mesh VPNs use.

    This is the single source of truth for "trusted tier" so the direct-client
    check, the proxy-hop check, and the forwarded-claim refusal stay symmetric:
    any address this trusts as a direct peer is equally refused when merely
    *claimed* in a forwarded header from a trusted hop.
    """
    if ip.is_private or ip.is_loopback or ip.is_link_local:
        return True
    if _TRUST_CGNAT and ip in CGNAT_NET:
        return True
    return False


RATE_LIMIT = int(
    os.environ.get("ZIMI_RATE_LIMIT", "60")
)  # API requests per minute per IP (0 = disabled)
RATE_LIMIT_CONTENT = (
    RATE_LIMIT * 20
)  # /w/ sub-resources: icons, CSS, images (1200/min default)
# Trusted clients (valid manage credential, or any private-network client on
# a passwordless instance) get 10x headroom: the manage UI polls downloads/
# peers/BT status every couple of seconds and was 429-ing itself off the
# base budget (#30). Anonymous public traffic keeps the base limit.
RATE_LIMIT_TRUSTED = int(
    os.environ.get("ZIMI_RATE_LIMIT_TRUSTED", str(RATE_LIMIT * 10))
)
# Credential checks get their own much tighter budget. /login is the one
# unauthenticated endpoint that runs PBKDF2 (600k iterations), so the same cap
# defends against both password guessing and CPU exhaustion.
RATE_LIMIT_LOGIN = int(os.environ.get("ZIMI_RATE_LIMIT_LOGIN", "10"))
_rate_buckets = {}  # {ip: [timestamps]} — API endpoints
_rate_buckets_content = {}  # {ip: [timestamps]} — /w/ content
_rate_buckets_login = {}  # {ip: [timestamps]} — POST /login
_rate_lock = threading.Lock()

# Verified Bearer credentials, keyed by digest so the PBKDF2 check runs once
# per credential per TTL — not on every polled request.
_authed_cache = {}  # {sha256(bearer): expiry_ts}
_AUTHED_CACHE_TTL = 300.0

# "Remember me" user-session cookie lifetime (seconds). 30 days — long enough
# for a kid's device to stay logged in, short enough to age out abandoned tokens.
SESSION_COOKIE_MAX_AGE = 30 * 24 * 3600


# Snippets ride the content bucket: one search fans out to ~10 snippet
# fetches, which burned the whole API budget in a few searches (#30's
# cousin). Pinned by tests — moving /snippet back to the API bucket is a
# regression, not a cleanup.
_RATE_LIMITED_API_PATHS = (
    "/search",
    "/read",
    "/suggest",
    "/random",
    "/chunks",
    "/openapi.json",
    "/almanac-links",
)

# High-frequency read-only manage polls. While a download runs the manage UI
# keeps three independent timers alive — downloads+seeding every 2s, activity
# every 5s, BT status in bursts — which together demand ~72 req/min, over the
# 60/min base API budget. The v1.7.2 fix leaned on the 10x "trusted" tier, but
# that only applies to a valid Bearer credential or a private-IP passwordless
# instance; behind a reverse proxy (non-private client IP) or with a manage
# password set, the client drops to the base budget and the panel 429s itself
# blank (#30, reopened). These are cheap local JSON reads, so they ride the
# generous content bucket (1200/min) — trust-independent — instead. Still
# capped, so it's not an abuse hole; just not on the strict search/read budget.
_POLL_PATHS = frozenset(
    (
        "/manage/downloads",
        "/manage/seeding",
        "/manage/activity",
        "/manage/bt-status",
        "/manage/status",
        "/manage/mirror",
        "/manage/health",
        "/manage/export-bookmarks",
        # /metrics is the same shape of traffic from a different client: a
        # Prometheus scraper polling on a fixed interval (15s is the stock
        # default, and several replicas may scrape the same target). It is a
        # cheap in-memory read, so it belongs on the generous content bucket
        # rather than competing with search for the 60/min API budget. It must
        # be rate-limited AT ALL, though: it is admin-gated, and that gate can
        # run PBKDF2 on an attacker-supplied Bearer, so leaving it unlimited
        # would hand out a CPU-exhaustion oracle that every /manage/ path
        # already denies.
        "/metrics",
    )
)

# The ONLY paths an anonymous visitor may reach when the public-access policy is
# ``private``. Everything else 401s until they log in. The set is deliberately
# minimal — enough to render the login screen and authenticate, nothing that
# reveals library contents:
#   /                     the SPA shell (static HTML, no data)
#   /whoami               so the client learns it must show the login screen
#   /health               aggregate status; already allow-filtered (→ 0 zims)
#   /login /logout        the auth transitions themselves
#   favicons / touch icon chrome the shell references
# Prefixes: /static/ (app.js, app.css, i18n, sw.js, pdfjs, manifest) and
# /manage/ (self-gated — its own admin challenge blocks non-admins, while the
# pre-auth has-password/has-token the login modal needs stay reachable).
_PRIVATE_LOGIN_SURFACE_EXACT = frozenset(
    (
        "/",
        "/whoami",
        "/health",
        "/login",
        "/logout",
        "/favicon.ico",
        "/favicon.png",
        "/favicon-64.png",
        "/apple-touch-icon.png",
    )
)
_PRIVATE_LOGIN_SURFACE_PREFIX = ("/static/", "/manage/")


def _rate_class(path):
    """(is_rate_limited, uses_content_bucket) for a GET path."""
    is_content = path.startswith("/w/") or path == "/snippet" or path in _POLL_PATHS
    limited = (
        is_content or path in _RATE_LIMITED_API_PATHS or path.startswith("/manage/")
    )
    return limited, is_content


def _check_rate_limit(ip, content=False, limit=None, buckets=None):
    """Check if IP has exceeded rate limit. Returns seconds to wait, or 0 if OK."""
    if limit is None:
        limit = RATE_LIMIT_CONTENT if content else RATE_LIMIT
    if limit <= 0:
        return 0
    if buckets is None:
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


def _almanac_links_response(handler, qids, langs, titles=None):
    """Shared GET/POST handler body for /almanac-links.

    Validates the batch shape/size, then batch-resolves the closed set of
    Wikidata Q-IDs to installed articles (hits only). Q-ID format validation
    lives in resolve_almanac_qids, so a malformed token is silently skipped,
    not an error. `titles` is an optional {qid: english_title} map (POST only)
    powering the exact-title fallback for ZIMs without a prebuilt Q-ID index.
    Returns {"links": {qid: {zim, path, title}}}.
    """
    if not isinstance(qids, list):
        return handler._json(400, {"error": "'qids' must be a list"})
    if len(qids) > _srv.ALMANAC_QID_BATCH_MAX:
        return handler._json(
            400,
            {"error": f"too many qids (max {_srv.ALMANAC_QID_BATCH_MAX})"},
        )
    if langs is not None and not isinstance(langs, list):
        return handler._json(400, {"error": "'langs' must be a list"})
    if titles is not None and not isinstance(titles, dict):
        return handler._json(400, {"error": "'titles' must be an object"})
    links = _srv.resolve_almanac_qids(qids, langs, titles)
    return handler._json(200, {"links": links})


# ============================================================================
# Metrics
# ============================================================================

_metrics = {
    "start_time": time.time(),
    "requests": {},  # {endpoint: count}
    "latency_sum": {},  # {endpoint: total_seconds}
    "errors": 0,
    "rate_limited": 0,
}
_metrics_lock = threading.Lock()

# The endpoint keys in _metrics are a CLOSED SET of source literals — every
# _record_metric call site passes a hardcoded string ("/search", "/read",
# "/chunks", "/suggest", "/snippet", "/random"). That invariant is what makes
# it safe to publish them as a Prometheus label: label cardinality is bounded
# by the number of call sites, not by traffic.
#
# NEVER pass a request-derived value here (parsed.path, a ZIM name, a query, a
# user agent). A crawler walking /w/<zim>/<anything> would mint a new time
# series per URL, and an unbounded label is how you take down the scraper's
# TSDB from the outside. The cap below is the belt to that suspenders: once we
# hold this many distinct endpoints, new keys stop being created (existing ones
# keep counting), the same bounding _SEARCH_QUERY_CAP applies to query stats.
# It cannot trigger today; it exists so a future careless call site degrades
# into a missing series instead of a cardinality explosion.
_METRIC_ENDPOINT_CAP = 64


def _record_metric(endpoint, latency, error=False):
    """Record a request metric."""
    with _metrics_lock:
        known = endpoint in _metrics["requests"]
        if known or len(_metrics["requests"]) < _METRIC_ENDPOINT_CAP:
            _metrics["requests"][endpoint] = _metrics["requests"].get(endpoint, 0) + 1
            _metrics["latency_sum"][endpoint] = (
                _metrics["latency_sum"].get(endpoint, 0) + latency
            )
        if error:
            _metrics["errors"] += 1


def _metrics_snapshot():
    """A consistent copy of the RAW counters, taken under one lock acquisition.

    Both renderers (the JSON at /manage/stats and the Prometheus exposition at
    /metrics) build from this, so they can never disagree about what a request
    count was, and neither holds the lock while formatting strings. Raw means
    raw: the latency SUM, not a derived average — Prometheus needs the sum and
    the count separately, and the JSON does its own rounding.
    """
    with _metrics_lock:
        return {
            "start_time": _metrics["start_time"],
            "requests": dict(_metrics["requests"]),
            "latency_sum": dict(_metrics["latency_sum"]),
            "errors": _metrics["errors"],
            "rate_limited": _metrics["rate_limited"],
        }


def _get_metrics():
    """Get current metrics snapshot.

    This shape is consumed by the admin UI (via /manage/stats) and is frozen —
    /metrics adds a second rendering of the same counters, it does not replace
    this one.
    """
    snap = _metrics_snapshot()
    uptime = time.time() - snap["start_time"]
    total_reqs = sum(snap["requests"].values())
    endpoints = {}
    for ep, count in snap["requests"].items():
        avg_latency = snap["latency_sum"].get(ep, 0) / count if count > 0 else 0
        endpoints[ep] = {
            "count": count,
            "avg_latency_ms": round(avg_latency * 1000, 1),
        }
    return {
        "uptime_seconds": round(uptime),
        "total_requests": total_reqs,
        "errors": snap["errors"],
        "rate_limited": snap["rate_limited"],
        "endpoints": endpoints,
    }


# ── Prometheus text exposition (GET /metrics) ────────────────────────────────
#
# Why a SEPARATE PATH rather than ?format=prometheus or Accept negotiation on
# the existing JSON:
#
#   * There is no JSON caller at /metrics to keep compatible. The snapshot has
#     never had a URL of its own — it is one field of the admin-only
#     /manage/stats payload the SPA reads. So "add a format, don't replace one"
#     is satisfied by construction: /manage/stats is not touched.
#   * `metrics_path` in a Prometheus scrape_config already defaults to
#     /metrics. A separate path means an operator writes a target and nothing
#     else. A query parameter would work (`params: {format: [prometheus]}`) but
#     it is a stanza every operator has to know about and every copy-pasted
#     config has to carry — a contortion for zero gain.
#   * Accept negotiation is the worst of the three: the scraper sends its own
#     Accept header (an OpenMetrics/text preference list), so we would be
#     negotiating against a header we do not control, and per-scrape request
#     headers are a recent and unevenly available Prometheus feature.
#
# The exposition follows text format version 0.0.4: HELP and TYPE exactly once
# per family, counters suffixed _total, latency published as a summary's _sum
# and _count pair. We deliberately do NOT publish a precomputed average — an
# average is not aggregatable across instances or over time, which is the whole
# reason the format wants sum and count. The JSON keeps its avg_latency_ms
# because the admin UI displays exactly one instance.
#
# Not a histogram: a histogram would need bucket boundaries chosen up front and
# a per-bucket counter recorded at request time, i.e. a change to what
# _record_metric stores. That is a real upgrade (it buys you quantiles and
# proper SLO math) and a real cost (more series, and a choice of buckets that is
# wrong for somebody). It is a deliberate follow-up, not a silent one; today's
# data is a sum and a count and a summary is its exact, honest mapping.

_PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

# Label-value escaping per the exposition format. Backslash MUST be replaced
# first, or the backslashes introduced by the quote/newline escapes would
# themselves be doubled on a later pass.
_PROM_LABEL_ESCAPES = (("\\", "\\\\"), ('"', '\\"'), ("\n", "\\n"))


def _prom_escape(value):
    """Escape a label value: backslash, double quote, newline."""
    text = str(value)
    for raw, escaped in _PROM_LABEL_ESCAPES:
        text = text.replace(raw, escaped)
    return text


def _prom_labels(labels):
    """Render ``{k="v",...}`` for a label mapping, or ``""`` when empty."""
    if not labels:
        return ""
    return "{" + ",".join(f'{k}="{_prom_escape(v)}"' for k, v in labels.items()) + "}"


def _prom_value(value):
    """Format a sample value.

    Integers stay exact. Floats get fixed six-decimal notation rather than
    repr(): exponent form ("1e-05") is legal in the spec but trips naive
    parsers and is harder to eyeball, and microsecond resolution is more than
    enough for a latency sum measured in seconds.
    """
    if isinstance(value, bool) or isinstance(value, int):
        return str(int(value))
    return f"{float(value):.6f}"


def _prom_family(lines, name, help_text, metric_type, samples):
    """Append one metric family to ``lines``: its HELP/TYPE header, then its
    samples.

    ``samples`` is an iterable of ``(name_suffix, labels, value)``. The suffix
    exists for summaries, whose samples are ``<name>_sum`` and ``<name>_count``
    while HELP and TYPE are declared once, on the base name. Emitting the
    header exactly once per family is not cosmetic — a second HELP or TYPE for
    a name already seen is a hard parse error at the scraper, which drops the
    whole scrape, not just the offending line.
    """
    lines.append(f"# HELP {name} {help_text}")
    lines.append(f"# TYPE {name} {metric_type}")
    for suffix, labels, value in samples:
        lines.append(f"{name}{suffix}{_prom_labels(labels)} {_prom_value(value)}")


def _prometheus_metrics(zim_count=0, version=None):
    """Render the current counters as Prometheus text exposition (a str ending
    in a newline — the format requires a trailing newline).

    Takes ``zim_count``/``version`` as arguments rather than reading server
    state so the renderer stays a pure function of its inputs and can be tested
    without a ZIM library on disk.
    """
    snap = _metrics_snapshot()
    lines = []

    # The conventional way to expose a version: a constant-1 gauge carrying the
    # version as a label, so a dashboard can join on it and an upgrade shows up
    # as a label change rather than an unhelpful numeric series.
    _prom_family(
        lines,
        "zimi_build_info",
        "Zimi build information; always 1, the version lives in the label.",
        "gauge",
        [("", {"version": version or _srv.ZIMI_VERSION}, 1)],
    )
    _prom_family(
        lines,
        "zimi_uptime_seconds",
        "Seconds since this Zimi process started.",
        "gauge",
        [("", None, int(round(time.time() - snap["start_time"])))],
    )
    _prom_family(
        lines,
        "zimi_zim_files",
        "ZIM files currently visible to this instance.",
        "gauge",
        [("", None, int(zim_count))],
    )

    # Sorted so the output is stable between scrapes. Prometheus does not care
    # about ordering, but a stable byte layout makes diffs and tests readable.
    endpoints = sorted(snap["requests"])
    _prom_family(
        lines,
        "zimi_http_requests_total",
        "Instrumented HTTP requests handled, by endpoint.",
        "counter",
        [("", {"endpoint": ep}, snap["requests"][ep]) for ep in endpoints],
    )
    _prom_family(
        lines,
        "zimi_http_request_duration_seconds",
        "Instrumented HTTP request latency, by endpoint.",
        "summary",
        [
            sample
            for ep in endpoints
            for sample in (
                ("_sum", {"endpoint": ep}, float(snap["latency_sum"].get(ep, 0.0))),
                ("_count", {"endpoint": ep}, snap["requests"][ep]),
            )
        ],
    )
    _prom_family(
        lines,
        "zimi_http_errors_total",
        "Instrumented requests that ended in a handler error.",
        "counter",
        [("", None, snap["errors"])],
    )
    _prom_family(
        lines,
        "zimi_http_rate_limited_total",
        "Requests rejected with 429 by the rate limiter.",
        "counter",
        [("", None, snap["rate_limited"])],
    )

    return "\n".join(lines) + "\n"


# ============================================================================
# Usage Stats
# ============================================================================

# Bound the search-query counter so it can't grow unbounded under attack
# or simply many distinct queries. Once we hit the cap we stop adding new
# keys; existing keys keep counting.
_SEARCH_QUERY_CAP = 5000
_TOP_SEARCHES_LIMIT = 10

_usage_stats = {
    "searches": 0,
    "article_reads": 0,
    "by_zim": {},  # {zim_name: {"reads": N, "searches": N}}
    "by_query": {},  # {normalized_query: count}
}
_usage_lock = threading.Lock()


def _normalize_query(q):
    """Lowercase + collapse whitespace so 'Paris' and 'paris  ' bucket together."""
    return " ".join((q or "").lower().split())


def _record_usage(event_type, zim_name=None, query=None):
    """Record a usage event. Thread-safe.

    For searches, also buckets the normalized query string (capped at
    _SEARCH_QUERY_CAP keys to bound memory). Per-ZIM stats are only kept
    for known ZIM names, so deleted ZIMs stop accumulating.
    """
    with _usage_lock:
        if event_type == "search":
            _usage_stats["searches"] += 1
            norm = _normalize_query(query)
            if norm:
                if norm in _usage_stats["by_query"]:
                    _usage_stats["by_query"][norm] += 1
                elif len(_usage_stats["by_query"]) < _SEARCH_QUERY_CAP:
                    _usage_stats["by_query"][norm] = 1
                # Otherwise: bucket cap reached, drop silently rather than
                # evict so the established top-N stays stable.
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
    """Return usage snapshot: top ZIMs, totals, top search queries."""
    with _usage_lock:
        by_zim = dict(_usage_stats["by_zim"])
        top = sorted(
            by_zim.items(),
            key=lambda x: x[1]["reads"] + x[1]["searches"],
            reverse=True,
        )[:10]
        top_queries = sorted(
            _usage_stats["by_query"].items(), key=lambda x: x[1], reverse=True
        )[:_TOP_SEARCHES_LIMIT]
        return {
            "searches": _usage_stats["searches"],
            "article_reads": _usage_stats["article_reads"],
            "top_zims": [{"name": n, **v} for n, v in top],
            "top_searches": [{"query": q, "count": c} for q, c in top_queries],
            "tracked_queries": len(_usage_stats["by_query"]),
        }


def _get_disk_usage():
    """Get disk usage info for ZIM directory. Works on all platforms."""
    try:
        usage = shutil.disk_usage(_srv.ZIM_DIR)
        total = usage.total
        free = usage.free
        used = usage.used
        zim_size = sum(
            os.path.getsize(os.path.join(_srv.ZIM_DIR, f))
            for f in os.listdir(_srv.ZIM_DIR)
            if f.endswith(".zim")
        )
        # Only surface genuinely orphaned partials for cleanup — an active,
        # queued, or resumable-with-progress .zim.tmp is still wanted and must
        # never be offered for deletion.
        from zimi import library as _lib

        _protected, tmp_files = _lib.classify_partials()
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
COMPRESSIBLE_TYPES = {
    "text/",
    "application/javascript",
    "application/json",
    "application/xml",
    "image/svg+xml",
}

_TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
try:
    with open(os.path.join(_TEMPLATE_DIR, "index.html"), encoding="utf-8") as f:
        SEARCH_UI_HTML = f.read()
except FileNotFoundError:
    SEARCH_UI_HTML = "<html><body><h1>Zimi</h1><p>UI template not found. API endpoints are still available.</p></body></html>"

# Auto-version static assets: replace ?v=N with content-hash so deploys bust caches.
# This eliminates manual version bumping — any file change gets a new URL automatically.
_STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
_ASSET_BUNDLE_HASH = "dev"  # overridden below when the static dir is present
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

    # Same rewrite for inline ?v=N refs inside app.js (e.g. almanac.js loader).
    # Cached in memory so we don't write to a possibly-read-only filesystem;
    # the static-asset handler serves APP_JS_REWRITTEN when set.
    _app_js_path = os.path.join(_STATIC_DIR, "app.js")
    APP_JS_REWRITTEN = None
    if os.path.exists(_app_js_path):
        with open(_app_js_path, "r", encoding="utf-8") as _f:
            _app_js_src = _f.read()
        _rewritten = re.sub(
            r"/static/([\w./-]+)\?v=\d+", _replace_static_ver, _app_js_src
        )
        if _rewritten != _app_js_src:
            APP_JS_REWRITTEN = _rewritten

            # app.js must be versioned by what we actually SERVE (the
            # rewritten text), not the on-disk source. Otherwise a deploy
            # that only changes a lazy-loaded asset (e.g. almanac.js) keeps
            # app.js's URL identical while its embedded asset hash changed —
            # immutable-cached clients would never see the new asset.
            _app_js_served_hash = hashlib.md5(APP_JS_REWRITTEN.encode()).hexdigest()[:8]
            _orig_static_hash = _static_hash

            def _static_hash(fname):
                if fname == "app.js":
                    return _app_js_served_hash
                return _orig_static_hash(fname)

    # index.html references app.js — rewrite AFTER the served-hash override
    # above so app.js's URL reflects the rewritten content.
    SEARCH_UI_HTML = re.sub(
        r"/static/([\w./-]+)\?v=\d+", _replace_static_ver, SEARCH_UI_HTML
    )
    # Inject build config into inline script so app.js can read versioned values.
    # Template has: var __ZIMI_CONFIG = {discoverStamp:'disc6',i18nHash:'0'};
    _build_stamp = _static_hash("app.js")[:6]
    _i18n_hash = (
        hashlib.md5(
            b"".join(
                open(os.path.join(_STATIC_DIR, "i18n", f), "rb").read()
                for f in sorted(os.listdir(os.path.join(_STATIC_DIR, "i18n")))
                if f.endswith(".json")
            )
        ).hexdigest()[:8]
        if os.path.isdir(os.path.join(_STATIC_DIR, "i18n"))
        else "0"
    )
    SEARCH_UI_HTML = SEARCH_UI_HTML.replace(
        "discoverStamp:'disc6'", f"discoverStamp:'d{_build_stamp}'"
    ).replace("i18nHash:'0'", f"i18nHash:'{_i18n_hash}'")

    # Content token for the service worker's cache key (and /health). It
    # changes whenever ANY app asset changes, so every deploy — even within
    # a single version like 1.7.2 — produces different sw.js bytes. That is
    # what makes the browser install a fresh SW whose activate wipes the old
    # cache. The old scheme keyed the cache on the version string alone, so
    # same-version deploys never busted the SW cache and served stale JS.
    _ASSET_BUNDLE_HASH = hashlib.md5(
        (
            _static_hash("app.js")
            + _static_hash("app.css")
            + _static_hash("almanac.js")
            # Almanac was split into sibling modules; all of them must feed the
            # bundle hash or a change to one ships behind a stale SW cache.
            + _static_hash("almanac-orrery.js")
            + _static_hash("almanac-sky.js")
            + _i18n_hash
        ).encode()
    ).hexdigest()[:8]


def _asset_version():
    """Cache-busting token: version + a hash of the app bundle. Serves as the
    service-worker cache key and is exposed at /health so the SW can detect a
    changed deploy and drop its stale cache."""
    return f"zimi-v{_srv.ZIMI_VERSION}-{_ASSET_BUNDLE_HASH}"


# ============================================================================
# HTTP Request Handler
# ============================================================================


class ZimHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30  # seconds — prevents slow-client DoS on POST bodies

    def handle_one_request(self):
        """Backstop for disconnects escaping ANY write path (rate-limit
        responses, HEAD, auth denials…). Without this they reach
        socketserver.handle_error, which prints a full unlocked traceback per
        request — many threads at once interleave into unreadable noise."""
        try:
            super().handle_one_request()
        except _DISCONNECT_ERRS:
            # The connection is unusable; make the keep-alive loop stop.
            self.close_connection = True
            log.debug("client disconnected: %s", getattr(self, "path", "?"))

    def _dispatch_error(self, e):
        """Terminal `except` for the do_* dispatchers. Disconnects get one
        debug line and NO 500 — the socket is dead and writing to it would
        just raise again. Real failures keep the traceback + generic 500."""
        if isinstance(e, _DISCONNECT_ERRS):
            log.debug(
                "client disconnected mid-response: %s %s", self.command, self.path
            )
            return
        traceback.print_exc()
        try:
            return self._json(500, {"error": "Internal server error"})
        except _DISCONNECT_ERRS:
            # Client vanished between the failure and the error reply.
            log.debug(
                "client disconnected before error reply: %s %s",
                self.command,
                self.path,
            )

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

    def _client_ip(self):
        """Resolve the real client IP. Drives /dl/ whole-ZIM serving and the
        trusted rate tier, so a spoofable answer here opens both to the internet.

        Rules, in order:

        1. A forwarded header counts only from a trusted proxy hop — the
           ZIMI_TRUSTED_PROXIES CIDR allowlist if set, else any trusted-tier
           address (private/loopback/link-local + CGNAT/overlay). The origin is
           never directly WAN-reachable, so a forwarding hop is always one of
           those; the heuristic covers a docker bridge gateway on any subnet
           without hardcoding one.
        2. Prefer CF-Connecting-IP over X-Forwarded-For's leftmost value:
           Cloudflare strips any client-supplied copy at its edge, so it can't
           be forged through the tunnel, whereas XFF's leftmost can.
        3. Reject a forwarded value that itself claims a trusted-tier address,
           so a permitted forwarder (or a LAN client) can't spoof one to borrow
           that trust.
        4. With no usable forwarded value, fail closed to public when an
           explicit allowlist marks the hop as only-ever-a-proxy. In heuristic
           mode keep the direct peer — it can't distinguish a direct LAN client
           from a header-stripping proxy."""
        direct_ip = self.client_address[0]
        try:
            dip = ipaddress.ip_address(direct_ip)
        except ValueError:
            return direct_ip
        if _TRUSTED_PROXY_CIDRS is not None:
            hop_trusted = any(dip in net for net in _TRUSTED_PROXY_CIDRS)
        else:
            hop_trusted = _is_trusted_net(dip)
        if not hop_trusted:
            return direct_ip
        fwd = self.headers.get("CF-Connecting-IP")
        if not fwd:
            xff = self.headers.get("X-Forwarded-For", "")
            fwd = xff.split(",")[0].strip() or None
        if fwd:
            try:
                fip = ipaddress.ip_address(fwd)
                # A real forwarded external client is public. Refuse a claim of
                # ANY trusted-tier address (private/loopback/link-local + CGNAT/
                # overlay — the same set _is_private_client trusts via
                # _is_trusted_net) so a spoofed header can't borrow that trust; a
                # genuine internal client still falls back to the (private,
                # trusted) direct hop below.
                if not _is_trusted_net(fip):
                    return fwd
            except ValueError:
                pass
        # No usable forwarded client IP. With an explicit ZIMI_TRUSTED_PROXIES
        # allowlist the hop is *only* ever a proxy, never an end client, so a
        # missing/rejected client means we can't identify the caller: fail
        # closed to public rather than trust the proxy's own private address
        # (an unparseable value → _is_private_client False). Without an
        # allowlist we can't tell a real direct LAN client from a
        # header-stripping proxy, so keep the direct peer as before.
        if _TRUSTED_PROXY_CIDRS is not None:
            return "proxy-unknown"
        return direct_ip

    def _private_access_block(self, parsed):
        """Enforce ``private`` public-access mode. Returns True (and sends a 401)
        when an ANONYMOUS request targets anything outside the login surface;
        False to proceed. Admins and logged-in users always proceed.

        Checks the cheap static path allowlist BEFORE probing identity, so
        serving the login shell + assets costs no session/admin file reads.
        """
        mode, _ = _users.get_public_access()
        if mode != "private":
            return False
        path = parsed.path
        if path in _PRIVATE_LOGIN_SURFACE_EXACT or path.startswith(
            _PRIVATE_LOGIN_SURFACE_PREFIX
        ):
            return False
        if _users.resolve_request_user(self) or _users._request_is_admin(self):
            return False
        self._json(401, {"error": "authentication required", "login_required": True})
        return True

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        def param(key, default=None):
            return params.get(key, [default])[0]

        # Multi-user: restrict this request's ZIM view to the logged-in user's
        # allowlist (None = admin/anonymous/all-access). Set FIRST so a kept-alive
        # connection re-sets it per request; cleared in the finally for hygiene.
        _srv.set_request_allow(_users.request_allow(self))

        # Private mode: block anonymous reads before any handler runs. The
        # finally below still clears the request-allow context.
        try:
            if self._private_access_block(parsed):
                return
        except Exception:
            # Fail closed: if the policy can't be evaluated, deny rather than
            # risk serving content an intended-private instance meant to hide.
            self._json(401, {"error": "authentication required"})
            return

        # Rate limit: API endpoints at RATE_LIMIT (10x for trusted clients),
        # /w/ content and /snippet at 20x.
        limited, is_w_content = _rate_class(parsed.path)
        if limited:
            limit = None if is_w_content else self._rate_limit_for_request()
            retry_after = _check_rate_limit(
                self._client_ip(), content=is_w_content, limit=limit
            )
            if retry_after > 0:
                with _metrics_lock:
                    _metrics["rate_limited"] += 1
                self.send_response(429)
                self.send_header("Retry-After", str(retry_after))
                self.send_header("Content-Type", "application/json")
                msg = json.dumps(
                    {"error": "rate limited", "retry_after": retry_after}
                ).encode()
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
                        return self._json(
                            400, {"error": f"Collection '{collection}' not found"}
                        )
                    filter_zim = coll.get("zims", []) or None
                elif zim_param:
                    filter_zim = [z.strip() for z in zim_param.split(",") if z.strip()]
                    if len(filter_zim) == 1:
                        filter_zim = filter_zim[0]
                else:
                    filter_zim = None
                # Apply language filter: restrict to ZIMs matching the given language
                if lang_filter:
                    lang_zims = [
                        z["name"]
                        for z in (_srv._zim_list_cache or [])
                        if z.get("language", "") == lang_filter
                        and _srv.zim_allowed(z["name"])
                    ]
                    if not lang_zims:
                        return self._json(
                            200,
                            {
                                "results": [],
                                "by_source": {},
                                "by_language": {},
                                "total": 0,
                                "elapsed": 0,
                                "partial": False,
                            },
                        )
                    if filter_zim is None:
                        filter_zim = lang_zims
                    else:
                        # Intersect with existing filter
                        allowed = set(lang_zims)
                        filter_zim = [
                            z
                            for z in (
                                filter_zim
                                if isinstance(filter_zim, list)
                                else [filter_zim]
                            )
                            if z in allowed
                        ]
                        if not filter_zim:
                            return self._json(
                                200,
                                {
                                    "results": [],
                                    "by_source": {},
                                    "by_language": {},
                                    "total": 0,
                                    "elapsed": 0,
                                    "partial": False,
                                },
                            )
                fast = param("fast") == "1"
                zim_scope_str = (
                    ",".join(sorted(filter_zim))
                    if isinstance(filter_zim, list)
                    else (filter_zim or "")
                )
                # Key includes the request's allowlist identity (see
                # _search_cache_key) so a restricted user never receives another
                # session's broader results.
                cache_key = _srv._search_cache_key(q, zim_scope_str, limit, fast)
                cached = _srv._search_cache_get(cache_key)
                if cached is not None:
                    _record_metric("/search", 0)
                    _record_usage("search", query=q)
                    return self._json(200, cached)
                t0 = time.time()
                if fast:
                    # Fast path uses _suggest_pool internally, no _zim_lock needed
                    result = _srv.search_all(
                        q, limit=limit, filter_zim=filter_zim, fast=True
                    )
                else:
                    # FTS path uses _fts_pool (per-ZIM locks), no _zim_lock needed
                    result = _srv.search_all(q, limit=limit, filter_zim=filter_zim)
                dt = time.time() - t0
                _srv._search_cache_put(cache_key, result)
                _record_metric("/search", dt)
                _record_usage("search", query=q)
                zim_label = (
                    ",".join(filter_zim)
                    if isinstance(filter_zim, list)
                    else (filter_zim or "all")
                )
                log.info(
                    "search q=%r limit=%d zim=%s fast=%s %.1fs",
                    q,
                    limit,
                    zim_label,
                    fast,
                    dt,
                )
                return self._json(200, result)

            elif parsed.path == "/read":
                zim = param("zim")
                path = param("path")
                if not zim or not path:
                    return self._json(
                        400, {"error": "missing ?zim= and ?path= parameters"}
                    )
                try:
                    max_len = min(
                        int(param("max_length", str(_srv.MAX_CONTENT_LENGTH))),
                        _srv.READ_MAX_LENGTH,
                    )
                except ValueError:
                    max_len = _srv.MAX_CONTENT_LENGTH
                t0 = time.time()
                with _srv._zim_lock:
                    result = _srv.read_article(zim, path, max_length=max_len)
                _record_metric("/read", time.time() - t0)
                _record_usage("read", zim)
                return self._json(200, result)

            elif parsed.path == "/chunks":
                zim = param("zim")
                path = param("path")
                if not zim or not path:
                    return self._json(
                        400, {"error": "missing ?zim= and ?path= parameters"}
                    )
                # Out-of-range size/overlap are clamped in chunk_article, not
                # rejected; only unparseable values fall back to the defaults.
                try:
                    size = int(param("size", str(_srv.CHUNK_SIZE_DEFAULT)))
                except (ValueError, TypeError):
                    size = _srv.CHUNK_SIZE_DEFAULT
                try:
                    overlap = int(param("overlap", str(_srv.CHUNK_OVERLAP_DEFAULT)))
                except (ValueError, TypeError):
                    overlap = _srv.CHUNK_OVERLAP_DEFAULT
                t0 = time.time()
                with _srv._zim_lock:
                    result = _srv.chunk_article(zim, path, size=size, overlap=overlap)
                _record_metric("/chunks", time.time() - t0)
                if result.get("error") == "not_found":
                    return self._json(404, {"error": "not found"})
                _record_usage("read", zim)
                return self._json(200, result)

            elif parsed.path == "/suggest":
                q = param("q")
                if not q:
                    return self._json(400, {"error": "missing ?q= parameter"})
                try:
                    limit = max(
                        1, min(int(param("limit", "10")), _srv.MAX_SEARCH_LIMIT)
                    )
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
                search_result = _srv.search_all(
                    q, fast=True, limit=limit, filter_zim=filter_zim
                )
                result = {}
                for r in search_result.get("results", []):
                    zn = r["zim"]
                    if zn not in result:
                        result[zn] = []
                    result[zn].append({"path": r["path"], "title": r["title"]})
                _record_metric("/suggest", time.time() - t0)
                return self._json(200, result)

            elif parsed.path == "/almanac-links":
                # Closed-set Q-ID → installed-article batch resolution for the
                # almanac. GET form: ?qids=Q1,Q2,...&langs=en,fr (POST carries
                # the same shape as JSON, for large batches).
                qids = [q for q in (param("qids") or "").split(",") if q]
                langs = [x for x in (param("langs") or "").split(",") if x]
                return _almanac_links_response(self, qids, langs)

            elif parsed.path == "/list":
                result = _srv.list_zims()
                # Per-ZIM category overrides win over the _categorize_zim
                # heuristic (#37). Applied here, not baked into the disk cache,
                # so clearing an override instantly reverts to the heuristic.
                layout = _srv._load_library_layout()
                overrides = layout.get("overrides", {})
                if overrides:
                    result = [
                        {**z, "category": overrides.get(z["name"], z.get("category"))}
                        for z in result
                    ]
                # Additive envelope: ?layout=1 carries the top-level section_order
                # alongside the ZIMs. The bare array shape stays the default so
                # existing API consumers are unaffected.
                if param("layout"):
                    return self._json(
                        200,
                        {
                            "zims": result,
                            "section_order": layout.get("section_order", []),
                            "sections": layout.get("sections", []),
                        },
                    )
                return self._json(200, result)

            elif parsed.path == "/whoami":
                return self._handle_whoami()

            elif parsed.path == "/userdata":
                return self._handle_userdata_get()

            elif parsed.path == "/languages":
                # Installed language summary with native names and ZIM counts
                lang_zims = {}  # {lang_code: [zim_name, ...]}
                for z in _srv._zim_list_cache or []:
                    lang = z.get("language", "")
                    if lang and _srv.zim_allowed(z["name"]):
                        lang_zims.setdefault(lang, []).append(z["name"])
                result = []
                for lang, zim_names in sorted(lang_zims.items()):
                    result.append(
                        {
                            "code": lang,
                            "name": _srv._LANG_NATIVE_NAMES.get(lang, lang),
                            "zim_count": len(zim_names),
                            "zims": zim_names,
                        }
                    )
                return self._json(200, result)

            elif parsed.path == "/article-languages":
                zim = param("zim")
                path = param("path")
                if not zim or not path:
                    return self._json(
                        400, {"error": "missing ?zim= and ?path= parameters"}
                    )
                with _srv._zim_lock:
                    if _srv.get_archive(zim) is None:
                        return self._json(404, {"error": f"ZIM '{zim}' not found"})
                    result = _srv.get_article_languages(zim, path)
                    log.info(
                        "article-languages %s/%s: %d results",
                        zim,
                        path,
                        len(result.get("languages", [])),
                    )
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
                    return self._json(
                        400, {"error": "missing ?zim= and ?path= parameters"}
                    )
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
                        # Prefer the page's own summary, then meta description,
                        # then body prose — skipping boilerplate some ZIMs bake
                        # into every page (iFixit device pages, #snippet QA).
                        snippet = _srv.extract_snippet(text, zim)
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
                                if not src.startswith(
                                    ("http", "//", "data:")
                                ) and not src.lower().endswith(".svg"):
                                    resolved = _srv._resolve_img_path(
                                        archive, path, src
                                    )
                                    if resolved:
                                        thumbnail = f"/w/{zim}/{resolved}"
                                        break
                        # Fallback: best <img> in content — skip icons/badges, prefer larger images
                        if not thumbnail:
                            _skip_img = re.compile(
                                r"icon|badge|logo|arrow|button|sprite|spacer|1x1|pixel|emoji|flag.*\.svg",
                                re.IGNORECASE,
                            )
                            best_img = None
                            best_area = 0
                            for img_m2 in re.finditer(
                                r"<img\b([^>]*)>", text[:15000], re.IGNORECASE
                            ):
                                attrs = img_m2.group(1)
                                src_m = re.search(r'src=["\']([^"\']+)["\']', attrs)
                                if not src_m:
                                    continue
                                src = src_m.group(1)
                                if src.startswith(
                                    ("data:", "http", "//")
                                ) or src.lower().endswith(".svg"):
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
                                    resolved = _srv._resolve_img_path(
                                        archive, path, src
                                    )
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

            elif parsed.path == "/openapi.json":
                from zimi.openapi import build_openapi

                return self._json(200, build_openapi())

            elif parsed.path == "/health":
                zim_count = len(_srv.get_zim_files())
                return self._json(
                    200,
                    {
                        "status": "ok",
                        "version": _srv.ZIMI_VERSION,
                        "asset_version": _asset_version(),
                        "zim_count": zim_count,
                        "pdf_support": _srv.HAS_PYMUPDF,
                    },
                )

            elif parsed.path == "/metrics":
                # Gated by the SAME admin challenge as /manage/stats, which is
                # where these counters have always been readable. Request
                # volumes and endpoint mix are operational intelligence about a
                # private library; nothing here becomes public. Concretely:
                # passwordless + private client → allowed (unchanged legacy
                # open-admin rule); passwordless + non-private client → 403
                # public_locked; password set → Bearer (admin password or API
                # token) or an admin session cookie.
                #
                # A scraper cannot carry a session cookie, so the API token is
                # the supported path: Prometheus `authorization: {credentials:
                # <token>}` sends exactly the Bearer header _primary_admin_
                # authorized already accepts. No new credential type, no
                # metrics-only bypass — one more way in is one more thing to
                # get wrong.
                from zimi import manage as _manage

                challenge = _manage._manage_auth_challenge(self)
                if challenge:
                    return self._json(*challenge)
                body = _prometheus_metrics(
                    zim_count=len(_srv.get_zim_files()),
                    version=_srv.ZIMI_VERSION,
                )
                # no-store: a cached scrape is a lying scrape.
                return self._send(
                    200,
                    body.encode("utf-8"),
                    _PROM_CONTENT_TYPE,
                    cache="no-store",
                )

            elif parsed.path == "/random":
                zim = param("zim")  # optional: scope to specific ZIM
                if zim:
                    if zim not in _srv.get_zim_files():
                        return self._json(404, {"error": f"ZIM '{zim}' not found"})
                    pick_names = [zim]
                else:
                    eligible = [
                        z
                        for z in (_srv._zim_list_cache or [])
                        if isinstance(z.get("entries"), int)
                        and z["entries"] > 100
                        and _srv.zim_allowed(z["name"])
                    ]
                    if not eligible:
                        return self._json(200, {"error": "no ZIMs available"})
                    # One unlucky ZIM (unopenable archive, all picks non-HTML)
                    # must not turn the dice into a no-op — try a few.
                    pick_names = [
                        z["name"]
                        for z in _random.sample(eligible, min(3, len(eligible)))
                    ]
                want_thumb = param("thumb") == "1"
                require_thumb = param("require_thumb") == "1"
                date_param = param("date")  # MMDD format
                seed_param = param("seed")  # For deterministic daily picks
                t0 = time.time()
                candidates = []
                archive = None
                pick_name = pick_names[0]
                is_wiktionary = is_gutenberg = is_wikiquote = False
                for pick_name in pick_names:
                    is_wiktionary = "wiktionary" in pick_name.lower()
                    is_gutenberg = "gutenberg" in pick_name.lower()
                    is_wikipedia = "wikipedia" in pick_name.lower()
                    is_wikiquote = "wikiquote" in pick_name.lower()
                    max_tries = (
                        50
                        if is_wiktionary
                        else (
                            30
                            if (is_gutenberg or is_wikiquote)
                            else (
                                5
                                if (require_thumb or (is_wikipedia and date_param))
                                else 1
                            )
                        )
                    )
                    with _srv._zim_lock:
                        archive = _srv.get_archive(pick_name)
                    if archive is None:
                        continue
                    rng = None
                    if seed_param:
                        seed_val = int(
                            hashlib.md5((pick_name + seed_param).encode()).hexdigest()[
                                :8
                            ],
                            16,
                        )
                        rng = _random.Random(seed_val)
                    # Batch all ZIM reads under a single lock acquisition
                    candidates = []
                    with _srv._zim_lock:
                        for _try in range(max_tries):
                            result = None
                            if date_param and len(date_param) == 4 and _try == 0:
                                result = _srv._get_dated_entry(
                                    archive, pick_name, date_param, rng=rng
                                )
                            if not result:
                                result = _srv.random_entry(archive, rng=rng)
                            if not result:
                                continue
                            preview = None
                            if want_thumb:
                                preview = _srv._extract_preview(
                                    archive, pick_name, result["path"]
                                )
                            candidates.append((result, preview))
                    if candidates:
                        break
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
                    if (
                        is_wiktionary
                        and preview
                        and (preview.get("non_english") or preview.get("boring"))
                    ):
                        if best_result is None:
                            best_result = result
                            best_preview = preview
                        continue
                    # Wiktionary: accept interesting English entry
                    if (
                        is_wiktionary
                        and preview
                        and not preview.get("non_english")
                        and not preview.get("boring")
                    ):
                        best_result = result
                        best_preview = preview
                        break
                    # Wikiquote: require an actual quote
                    if is_wikiquote and preview:
                        blurb = preview.get("blurb") or ""
                        if blurb and blurb[0] in ("\u201c", '"'):
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
                chosen = {
                    "zim": pick_name,
                    "path": best_result["path"],
                    "title": best_result["title"],
                }
                # On-this-day: carry the date-anchored event context to the card
                # so it can show "July 27, 1777 — <event>" even when the target
                # article never restates the date.
                if best_result.get("event_year"):
                    chosen["event_year"] = best_result["event_year"]
                if best_result.get("event_text"):
                    chosen["event_text"] = best_result["event_text"]
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
                log.info(
                    "random zim=%s title=%r %.1fs", pick_name, best_result["title"], dt
                )
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

            elif parsed.path.startswith("/dl/"):
                # /dl/<zim_name_or_file> — serve the whole raw .zim file to a
                # LAN peer over HTTP+Range. This is the peer-to-peer sharing
                # transport: another Zimi instance pulls a ZIM directly from
                # us, no internet/Kiwix needed. Gated to private clients by
                # default (see _serve_zim_file).
                return self._serve_zim_file(unquote(parsed.path[4:]))

            elif parsed.path.startswith("/w/"):
                # /w/<zim_name>/<entry_path> — serve raw ZIM content
                rest = parsed.path[3:]  # strip "/w/"
                slash = rest.find("/")
                if slash == -1:
                    zim_name, entry_path = unquote(rest), ""
                else:
                    zim_name = unquote(rest[:slash])
                    entry_path = unquote(rest[slash + 1 :])
                # Top-level browser navigation (reload/bookmark) → serve SPA shell
                # so client-side router can handle the deep link.
                # ?raw=1 bypasses SPA shell (used for PDF new-tab opening).
                # ?view=1 forces SPA shell (used in pushState URLs for PDFs so CDN
                # caching of the raw PDF doesn't break reload).
                qs = parse_qs(parsed.query)
                is_raw = "raw" in qs
                is_view = "view" in qs
                fetch_dest = self.headers.get("Sec-Fetch-Dest", "")
                if is_view or (
                    (fetch_dest == "document" or not entry_path)
                    and not is_raw
                    and not entry_path.lower().endswith(".epub")
                ):
                    return self._serve_index(vary="Sec-Fetch-Dest")
                # Track iframe article loads + passively cache Q-ID
                if fetch_dest == "iframe":
                    _record_usage("iframe", zim_name)
                    # Background Q-ID extraction builds the cache over time
                    if entry_path and _srv._qid_passive_cache:
                        import threading

                        threading.Thread(
                            target=_srv._qid_passive_extract,
                            args=(zim_name, entry_path),
                            daemon=True,
                        ).start()
                a11y_on = "a11y" in qs and (qs.get("a11y", [""])[0] == "1")
                return self._serve_zim_content(zim_name, entry_path, a11y=a11y_on)

            else:
                return self._json(
                    404,
                    {
                        "error": "not found",
                        "endpoints": [
                            "/search",
                            "/read",
                            "/chunks",
                            "/suggest",
                            "/list",
                            "/catalog",
                            "/health",
                            "/metrics",
                            "/w/",
                        ],
                    },
                )

        except Exception as e:
            return self._dispatch_error(e)
        finally:
            _srv.clear_request_allow()

    def do_POST(self):
        parsed = urlparse(self.path)
        _srv.set_request_allow(_users.request_allow(self))
        try:
            if self._private_access_block(parsed):
                return
        except Exception:
            self._json(401, {"error": "authentication required"})
            return
        try:
            content_len = int(self.headers.get("Content-Length", "0"))
            # Backup import + per-user data save legitimately run large (a full
            # server bundle carries users/history/every per-user blob); every
            # other endpoint stays under the tight default cap.
            body_cap = (
                _srv.MAX_BACKUP_BODY
                if parsed.path in ("/manage/backup", "/userdata")
                else _srv.MAX_POST_BODY
            )
            if content_len > body_cap:
                return self._json(
                    413,
                    {"error": f"Request body too large (max {body_cap} bytes)"},
                )
            body = self.rfile.read(content_len) if content_len > 0 else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {}

            if parsed.path.startswith("/manage/"):
                return handle_manage_post(self, parsed, data)

            if parsed.path == "/login":
                retry_after = _check_rate_limit(
                    self._client_ip(),
                    limit=RATE_LIMIT_LOGIN,
                    buckets=_rate_buckets_login,
                )
                if retry_after > 0:
                    return self._json_rate_limited(retry_after)
                return self._handle_login(data)

            if parsed.path == "/logout":
                return self._handle_logout()

            if parsed.path == "/userdata":
                return self._handle_userdata_post(data)

            if parsed.path == "/resolve":
                retry_after = _check_rate_limit(
                    self._client_ip(), limit=self._rate_limit_for_request()
                )
                if retry_after > 0:
                    return self._json_rate_limited(retry_after)
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
                        results[url_str] = {
                            "found": True,
                            "zim": resolved["zim"],
                            "path": resolved["path"],
                        }
                    else:
                        results[url_str] = {"found": False}
                return self._json(200, {"results": results})

            elif parsed.path == "/almanac-links":
                # Batch Q-ID resolution (closed set) — same public, rate-limited
                # read as /suggest; the almanac POSTs its full ~250-Q-ID set.
                retry_after = _check_rate_limit(
                    self._client_ip(), limit=self._rate_limit_for_request()
                )
                if retry_after > 0:
                    return self._json_rate_limited(retry_after)
                return _almanac_links_response(
                    self,
                    data.get("qids", []),
                    data.get("langs"),
                    data.get("titles"),
                )

            elif parsed.path == "/collections":
                # Auth: only enforce password when manage mode is on (collections are
                # user-facing features that work without manage mode enabled)
                challenge = _manage_auth_challenge(self) if _srv.ZIMI_MANAGE else None
                if challenge:
                    return self._json(*challenge)
                name = data.get("name", "").strip()[:64]
                label = data.get("label", "").strip()[:128]
                # Auto-generate name from label if not provided
                if not name and label:
                    name = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:64]
                if not name:
                    return self._json(400, {"error": "missing 'name' or 'label' field"})
                if not label:
                    label = name
                zim_list = data.get("zims", [])
                if not isinstance(zim_list, list) or len(zim_list) > 200:
                    return self._json(
                        400, {"error": "'zims' must be a list (max 200 items)"}
                    )
                with _srv._collections_lock:
                    cdata = _srv._load_collections()
                    cdata["collections"][name] = {
                        "label": label or name,
                        "zims": zim_list,
                    }
                    _srv._save_collections(cdata)
                return self._json(200, {"status": "ok", "collection": name})

            elif parsed.path == "/favorites":
                # Auth: same as collections — only when manage mode is on
                challenge = _manage_auth_challenge(self) if _srv.ZIMI_MANAGE else None
                if challenge:
                    return self._json(*challenge)
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
                        return self._json(
                            400, {"error": "Favorites list is full (max 100)"}
                        )
                    else:
                        favs.append(zim_name)
                        action = "added"
                    cdata["favorites"] = favs
                    _srv._save_collections(cdata)
                return self._json(
                    200,
                    {
                        "status": action,
                        "zim": zim_name,
                        "favorites": cdata["favorites"],
                    },
                )

            else:
                return self._json(404, {"error": "not found"})

        except Exception as e:
            return self._dispatch_error(e)
        finally:
            _srv.clear_request_allow()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        # Rate limit write endpoints
        retry_after = _check_rate_limit(
            self._client_ip(), limit=self._rate_limit_for_request()
        )
        if retry_after > 0:
            return self._json_rate_limited(retry_after)
        try:
            if parsed.path == "/collections":
                name = params.get("name", [None])[0]
                if not name:
                    return self._json(400, {"error": "missing ?name= parameter"})
                challenge = _manage_auth_challenge(self) if _srv.ZIMI_MANAGE else None
                if challenge:
                    return self._json(*challenge)
                with _srv._collections_lock:
                    cdata = _srv._load_collections()
                    if name not in cdata.get("collections", {}):
                        return self._json(
                            404, {"error": f"Collection '{name}' not found"}
                        )
                    del cdata["collections"][name]
                    _srv._save_collections(cdata)
                return self._json(200, {"status": "deleted", "collection": name})
            else:
                return self._json(404, {"error": "not found"})
        except Exception as e:
            return self._dispatch_error(e)

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

    def _send_entry_too_large(self, total_size):
        """413 for an entry Zimi refuses to materialize. Used by every /w/
        branch that can't be answered with a bounded window."""
        self.send_response(413)
        self.send_header("Content-Type", "text/plain")
        msg = f"Entry too large ({total_size // (1024*1024)} MB). Max: {_srv.MAX_SERVE_BYTES // (1024*1024)} MB.".encode()
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        self.wfile.write(msg)

    def _serve_zim_content(self, zim_name, entry_path, *, a11y=False):
        """Serve raw ZIM content with correct MIME type for the /w/ endpoint.

        Manages _zim_lock internally — holds lock only during libzim reads,
        releases before writing to the socket (important for large video streams).

        When a11y=True, HTML responses are passed through the
        accessibility rewriter (zimi.a11y) before sending. The rewriter
        adds missing alt="" on images, ensures one <h1>, and fills in
        <html lang> from the ZIM's language metadata. Activated via the
        ?a11y=1 query parameter on /w/ URLs.
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
                # Single-page docs (devdocs): 'index#backslash' is entry 'index'
                # plus an in-page fragment. If the base entry exists, redirect so
                # the browser keeps the raw '#fragment' and scrolls to the section.
                base_path, fragment = _srv.split_entry_fragment(entry_path)
                if fragment:
                    try:
                        archive.get_entry_by_path(base_path)
                    except KeyError:
                        base_path = None
                    if base_path is not None:
                        quoted = "/".join(quote(seg) for seg in base_path.split("/"))
                        self.send_response(302)
                        self.send_header(
                            "Location", f"/w/{quote(zim_name)}/{quoted}#{fragment}"
                        )
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                return self._json(
                    404, {"error": f"Entry '{entry_path}' not found in {zim_name}"}
                )

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
            is_epub = entry_path.lower().endswith(".epub") or mimetype in (
                "application/epub+zip",
                "application/epub",
            )
            epub_filename = None
            # Bound before the branch: the EPUB path returns without touching
            # them, and the response phase below reads them unconditionally.
            is_streamable = False
            etag = ""
            range_start = range_end = None
            if is_epub:
                mimetype = "application/epub+zip"
                epub_filename = os.path.basename(entry_path)
                if not epub_filename.endswith(".epub"):
                    epub_filename += ".epub"
                # Size check BEFORE materializing: reading first and refusing
                # afterwards is the OOM this cap exists to prevent.
                if total_size > _srv.MAX_SERVE_BYTES:
                    return self._send_entry_too_large(total_size)
                content = bytes(item.content)
            else:
                # ETag check BEFORE reading content — avoids materializing large
                # blobs when client already has a cached copy
                is_streamable = any(
                    mimetype.startswith(t)
                    for t in ("video/", "audio/", "application/ogg")
                )
                etag = (
                    '"'
                    + hashlib.md5(
                        f"{zim_name}/{entry_path}/{_srv._cache_generation}".encode()
                    ).hexdigest()[:16]
                    + '"'
                )
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.end_headers()
                    return

                if is_streamable:
                    # Every served window is capped at MAX_SERVE_BYTES, whether
                    # or not the client asked for one. A media entry fetched
                    # without a Range — curl, <a download>, a chat app's link
                    # fetcher — used to copy the WHOLE item into a bytes object
                    # while holding _zim_lock; on a ZIM carrying a few hundred
                    # MB of video that is an OOM kill on a small box, with
                    # every other libzim request blocked behind it. Answering
                    # the first window as 206 + Accept-Ranges costs a real
                    # player nothing: it range-requests onward immediately.
                    range_header = self.headers.get("Range")
                    if range_header:
                        range_start, range_end = self._parse_range(
                            range_header, total_size
                        )
                    if range_start is None or range_end is None:
                        # No Range, or one too malformed to honour.
                        range_start = range_end = None
                        if total_size > _srv.MAX_SERVE_BYTES:
                            range_start, range_end = 0, _srv.MAX_SERVE_BYTES - 1
                    else:
                        # A satisfiable range still gets clamped — bytes=0- is
                        # a request for the whole item through the ranged door.
                        range_end = min(
                            range_end, range_start + _srv.MAX_SERVE_BYTES - 1
                        )
                    if range_start is not None and range_end is not None:
                        content = bytes(item.content[range_start : range_end + 1])
                    else:
                        content = bytes(item.content)
                else:
                    if total_size > _srv.MAX_SERVE_BYTES:
                        return self._send_entry_too_large(total_size)
                    content = bytes(item.content)
        # Lock released — safe to do slow I/O

        # EPUB: write download response outside lock
        if epub_filename:
            self.send_response(200)
            self.send_header("Content-Type", mimetype)
            self.send_header("Content-Length", str(len(content)))
            self.send_header(
                "Content-Disposition", f'attachment; filename="{epub_filename}"'
            )
            self.end_headers()
            self.wfile.write(content)
            return

        # Strip <base> tags from HTML
        if mimetype.startswith("text/html"):
            text = content.decode("UTF-8", errors="replace")
            text = re.sub(r"<base\s[^>]*>", "", text, flags=re.IGNORECASE)
            if a11y:
                from zimi import a11y as _a11y

                # Use the ZIM's language metadata as the lang hint when
                # the article doesn't carry its own <html lang>.
                lang_hint = ""
                try:
                    z_meta = next(
                        (
                            z
                            for z in (_srv._zim_list_cache or [])
                            if z.get("name") == zim_name
                        ),
                        None,
                    )
                    if z_meta:
                        lang_hint = (z_meta.get("language") or "")[:8]
                except Exception:
                    lang_hint = ""
                text = _a11y.rewrite_html(text, lang_hint=lang_hint)
            content = text.encode("UTF-8")

        if range_start is not None and range_end is not None:
            self.send_response(206)
            self.send_header(
                "Content-Range", f"bytes {range_start}-{range_end}/{total_size}"
            )
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
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; "
                "frame-ancestors 'self'",
            )

        # Gzip text-based content only (images/PDFs are already compressed)
        compressible = any(
            mimetype.startswith(t) or mimetype == t for t in COMPRESSIBLE_TYPES
        )
        if compressible and self._accepts_gzip() and len(content) > 256:
            content = gzip.compress(content, compresslevel=4)
            self.send_header("Content-Encoding", "gzip")

        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _is_private_client(self):
        """True when _client_ip() is on a private-tier network (private/
        loopback/link-local, plus CGNAT/overlay per _is_trusted_net)."""
        try:
            ip = ipaddress.ip_address(self._client_ip())
        except ValueError:
            return False
        return _is_trusted_net(ip)

    def _peer_share_allowed(self):
        """True if this client may pull whole ZIMs from /dl/.

        Sharing must be enabled (ZIMI_PEER_SHARE) and the client must be
        on a private/loopback/link-local network — unless the operator
        opted into public sharing (ZIMI_PEER_SHARE_PUBLIC=1). Uses
        _client_ip() so it sees the real peer behind a trusted proxy
        rather than the proxy itself.
        """
        from zimi import p2p_discovery as _disc

        if not _disc.is_share_enabled():
            return False
        if _disc.is_public_share_enabled():
            return True
        return self._is_private_client()

    def _rate_limit_for_request(self):
        """Per-minute budget for this request: RATE_LIMIT_TRUSTED for a
        valid manage credential or a private-network client on a
        passwordless instance; RATE_LIMIT otherwise. Credential checks
        are cached by digest so PBKDF2 runs once per TTL, not per poll."""
        from zimi import manage as _manage

        stored_pw = _manage._get_manage_password_hash()
        if not stored_pw:
            return RATE_LIMIT_TRUSTED if self._is_private_client() else RATE_LIMIT
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return RATE_LIMIT
        digest = hashlib.sha256(auth[7:].encode()).hexdigest()
        now = time.time()
        with _rate_lock:
            exp = _authed_cache.get(digest)
            if exp and exp > now:
                return RATE_LIMIT_TRUSTED
        if _manage._check_manage_auth(self) is None:
            with _rate_lock:
                _authed_cache[digest] = now + _AUTHED_CACHE_TTL
                if len(_authed_cache) > 100:
                    for k in [k for k, v in _authed_cache.items() if v <= now]:
                        del _authed_cache[k]
            return RATE_LIMIT_TRUSTED
        return RATE_LIMIT

    def _serve_zim_file(self, name):
        """Stream a whole local .zim file to a LAN peer with Range support.

        Resolves `name` strictly against the known ZIM set (by ZIM name or
        file basename) so a request can never escape ZIM_DIR — there is no
        user-controlled path here. Streams from disk in chunks; never loads
        a multi-GB file into memory.
        """
        if not self._peer_share_allowed():
            return self._json(403, {"error": "peer sharing not available"})

        zims = _srv.get_zim_files()  # {name: path}
        path = zims.get(name)
        if path is None:
            for p in zims.values():
                if os.path.basename(p) == name:
                    path = p
                    break
        if path is None or not os.path.isfile(path):
            return self._json(404, {"error": "ZIM not found"})

        try:
            total_size = os.path.getsize(path)
        except OSError:
            return self._json(404, {"error": "ZIM not found"})

        range_start = range_end = None
        range_header = self.headers.get("Range")
        if range_header:
            range_start, range_end = self._parse_range(range_header, total_size)

        if range_start is not None and range_end is not None:
            send_len = range_end - range_start + 1
            self.send_response(206)
            self.send_header(
                "Content-Range", f"bytes {range_start}-{range_end}/{total_size}"
            )
        else:
            range_start, send_len = 0, total_size
            self.send_response(200)

        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(send_len))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{os.path.basename(path)}"',
        )
        self.end_headers()

        # Stream in 1 MB chunks. A peer disconnecting mid-pull (BrokenPipe)
        # is normal — swallow it rather than logging a stack trace.
        chunk_size = 1024 * 1024
        remaining = send_len
        try:
            with open(path, "rb") as f:
                f.seek(range_start)
                while remaining > 0:
                    chunk = f.read(min(chunk_size, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return
        except OSError as e:
            log.warning("peer file stream failed for %s: %s", name, e)

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
        # Malformed ranges (bytes=abc-, bytes=-, bytes=1-x) must degrade to
        # "no range" (200 full body), not raise ValueError up through the /dl/
        # and content-serving paths and 500 / drop the connection.
        try:
            if range_spec.startswith("-"):
                # Suffix range: last N bytes
                suffix = int(range_spec[1:])
                start = max(0, total_size - suffix)
                return start, total_size - 1
            parts = range_spec.split("-", 1)
            start = int(parts[0])
            end = int(parts[1]) if parts[1] else total_size - 1
        except ValueError:
            return None, None
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
            (
                os.path.join(getattr(sys, "_MEIPASS", ""), "static")
                if getattr(sys, "_MEIPASS", None)
                else ""
            ),
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

        # app.js gets the in-memory rewrite when present (auto-versioned ?v=
        # references inside the file). Avoids touching the read-only filesystem.
        if rel_path == "app.js" and APP_JS_REWRITTEN is not None:
            body = APP_JS_REWRITTEN.encode("utf-8")
            content_type = "application/javascript"
        else:
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
                if not file_path.startswith(
                    os.path.normpath(base) + os.sep
                ) and file_path != os.path.normpath(base):
                    return self._json(403, {"error": "forbidden"})
                if not os.path.isfile(file_path):
                    return self._json(404, {"error": "not found"})
                ext = os.path.splitext(file_path)[1].lower()
                content_type = _srv.MIME_FALLBACK.get(ext, "application/octet-stream")
                with open(file_path, "rb") as f:
                    body = f.read()
                # sw.js pins CACHE_VERSION to the running server version at
                # serve time — the hardcoded constant went stale for a whole
                # release cycle once and silently disabled the PWA.
                if rel_path == "sw.js":
                    # Key the cache on version + content hash so same-version
                    # deploys still produce new sw.js bytes → the browser
                    # installs a fresh SW that wipes the stale cache.
                    body = re.sub(
                        rb"const CACHE_VERSION = '[^']*'",
                        b"const CACHE_VERSION = '" + _asset_version().encode() + b"'",
                        body,
                    )
                # Cache in memory (vendor files are immutable, ~8MB total for pdf.js)
                with ZimHandler._static_cache_lock:
                    ZimHandler._static_cache[rel_path] = (body, content_type)

        # Compress text-based static files (viewer.mjs, viewer.css, etc.)
        ct_base = content_type.split(";")[0]
        compressible = any(
            ct_base.startswith(t) or ct_base == t for t in COMPRESSIBLE_TYPES
        )
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
                (
                    os.path.join(getattr(sys, "_MEIPASS", ""), "assets", filename)
                    if getattr(sys, "_MEIPASS", None)
                    else ""
                ),
                os.path.join(assets_dir, "assets", "icon.png"),
                (
                    os.path.join(getattr(sys, "_MEIPASS", ""), "assets", "icon.png")
                    if getattr(sys, "_MEIPASS", None)
                    else ""
                ),
            ]
            for p in icon_paths:
                if p and os.path.exists(p):
                    with open(p, "rb") as f:
                        ZimHandler._favicon_cache[filename] = f.read()
                    break
            if filename not in ZimHandler._favicon_cache:
                # Fallback: extract from HTML template's base64 data URI
                m = re.search(
                    r"data:image/png;base64,([A-Za-z0-9+/=]+)", SEARCH_UI_HTML
                )
                ZimHandler._favicon_cache[filename] = (
                    base64.b64decode(m.group(1)) if m else b""
                )
        data = ZimHandler._favicon_cache.get(filename, b"")
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
                os.path.join(
                    os.path.dirname(os.path.abspath(__file__)),
                    "assets",
                    "apple-touch-icon.png",
                ),
                (
                    os.path.join(
                        getattr(sys, "_MEIPASS", ""), "assets", "apple-touch-icon.png"
                    )
                    if getattr(sys, "_MEIPASS", None)
                    else ""
                ),
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
            self.send_header(
                "Cache-Control", "public, max-age=0, must-revalidate, s-maxage=3600"
            )
            self.end_headers()
            return
        # Cache strategy:
        #   max-age=0, must-revalidate — browser always revalidates (Safari-safe)
        #   s-maxage=3600 — Cloudflare edge caches 1 hour (fast for users worldwide)
        #   ETag — efficient revalidation (304 = no body, instant response)
        #   deploy.sh purges Cloudflare edge after each deploy.
        return self._html(
            200,
            SEARCH_UI_HTML,
            vary=vary,
            cache="public, max-age=0, must-revalidate, s-maxage=3600",
            etag=ZimHandler._index_etag,
        )

    def _html(self, code, content, vary=None, cache=None, etag=None):
        self._send(
            code,
            content.encode(),
            "text/html; charset=utf-8",
            vary=vary,
            cache=cache,
            etag=etag,
        )

    def _json(self, code, data):
        self._send(
            code,
            json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(),
            "application/json",
        )

    def _json_rate_limited(self, retry_after):
        """429 body for the POST/DELETE write paths."""
        with _metrics_lock:
            _metrics["rate_limited"] += 1
        return self._json(429, {"error": "rate limited", "retry_after": retry_after})

    # ── Multi-user login / logout / whoami ──────────────────────────────────
    def _json_cookie(self, code, data, set_cookie):
        """Send a small JSON auth response carrying a Set-Cookie header. Kept
        separate from _send (no gzip, always no-store) so the ~200 _json call
        sites stay untouched. Auth responses must never be cached."""
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _session_cookie(self, token, remember):
        """Build the zimi_session cookie. HttpOnly + SameSite=Lax always;
        Secure only behind an HTTPS proxy (so plain-http LAN keeps working);
        Max-Age only when 'remember' (else a session cookie, cleared on close)."""
        parts = ["zimi_session=" + token, "Path=/", "HttpOnly", "SameSite=Lax"]
        if remember:
            parts.append("Max-Age=" + str(SESSION_COOKIE_MAX_AGE))
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            parts.append("Secure")
        return "; ".join(parts)

    def _expire_cookie(self):
        return "zimi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    def _handle_login(self, data):
        """POST /login — username + password. A named user gets a session
        (cookie + Bearer token); admin credentials return role=admin (the
        client keeps using the header token). Failures are generic: the same
        401 whether the username or the password is wrong (no enumeration)."""
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        remember = bool(data.get("remember"))
        if not username or not password:
            return self._json(400, {"error": "username and password required"})
        # Named user first.
        name = _users.authenticate(username, password)
        if name:
            _users.record_login(name)
            token = _users.create_session(name)
            rec = _users.get_user(name)
            allowlist = rec.get("allowlist") if rec else None
            # A SECONDARY admin (role=admin) logs in through the same modal but
            # gets the admin chrome + manage powers: their session token is what
            # _check_manage_auth accepts, so hand it back as role=admin so the
            # client uses it as the manage Bearer token (never hides the gear).
            if _users.is_admin_user(name):
                log.info("Secondary-admin login: %s", name)
                return self._json_cookie(
                    200,
                    {"role": "admin", "name": name, "token": token, "secondary": True},
                    self._session_cookie(token, remember),
                )
            log.info("User login: %s", name)
            return self._json_cookie(
                200,
                {
                    "role": "user",
                    "name": name,
                    "token": token,
                    "restricted": isinstance(allowlist, list),
                    "allowlist": allowlist if isinstance(allowlist, list) else [],
                },
                self._session_cookie(token, remember),
            )
        # Admin account (the existing password account). Mint an HttpOnly admin
        # session cookie IN ADDITION to the client's password Bearer, so the
        # header-less transports (reader iframe, plain-fetch data endpoints) carry
        # admin identity — otherwise a private/limited-mode admin sees an empty
        # library and blank article iframes. The client still keeps using the
        # password as its manage Bearer token (unchanged).
        from zimi import manage as _manage

        if _manage.verify_admin_credentials(username, password):
            token = _users.create_admin_session()
            log.info("Admin login (password account)")
            return self._json_cookie(
                200, {"role": "admin"}, self._session_cookie(token, remember)
            )
        return self._json(401, {"error": "invalid credentials"})

    def _handle_logout(self):
        """POST /logout — drop the current session(s) + expire the cookie. Drops
        BOTH the Bearer and cookie tokens: an admin's Bearer is the password (a
        no-op drop) while its session rides the cookie, so dropping only the
        first-present token could leave the admin session alive server-side."""
        _users.drop_session(_users._bearer_token(self))
        _users.drop_session(_users._cookie_token(self))
        return self._json_cookie(200, {"status": "ok"}, self._expire_cookie())

    def _handle_whoami(self):
        """GET /whoami — the current identity for the client to shape its UI.
        role ∈ {user, admin, anonymous}. Server-side filtering is independent
        of this — it keys off the cookie/token, not the client's belief."""
        from zimi import manage as _manage

        name = _users.resolve_request_user(self)
        if name:
            # A SECONDARY admin keeps the admin chrome on reload (their session
            # token is restored from storage as the manage Bearer token).
            if _users.is_admin_user(name):
                return self._json(
                    200, {"role": "admin", "name": name, "secondary": True}
                )
            rec = _users.get_user(name)
            allowlist = rec.get("allowlist") if rec else None
            return self._json(
                200,
                {
                    "role": "user",
                    "name": name,
                    "restricted": isinstance(allowlist, list),
                },
            )

        if (
            _srv.ZIMI_MANAGE
            and _manage._get_manage_password_hash()
            and _manage._check_manage_auth(self) is None
        ):
            resp: dict[str, object] = {
                "role": "admin",
                "name": _manage._get_manage_user() or "admin",
            }
            # Ensure the header-less transports (reader iframe, plain-fetch data
            # endpoints) carry admin identity. If this admin was recognised by the
            # password Bearer but has no live admin session cookie yet — first boot
            # after a remembered login, or the cookie expired — mint one now. Boot
            # awaits /whoami before the first /list, so the cookie lands in time. A
            # session-scoped cookie (no Max-Age) keeps the "remember" contract: a
            # non-remembered admin loses it on tab close (its stored Bearer is gone
            # too), while a remembered admin re-mints from the Bearer each boot.
            if not _users.is_admin_session(_users._cookie_token(self)):
                token = _users.create_admin_session()
                return self._json_cookie(200, resp, self._session_cookie(token, False))
            return self._json(200, resp)
        # Anonymous. Expose a first-login hint ONLY when the default username
        # applies — no custom username AND no named users configured. This is
        # not an info leak: "the default username is admin" is in the docs.
        resp = {"role": "anonymous"}
        if not _manage._get_manage_user() and not _users.list_users():
            resp["default_username"] = "admin"
        # Tell the SPA how the public-access policy shapes its view: ``private``
        # forces the login screen (login_required); ``limited`` just means the
        # library it receives is already filtered server-side (no client action
        # needed, but surfaced for messaging). ``open`` omits the field.
        mode, _ = _users.get_public_access()
        if mode != "open":
            resp["public_access"] = mode
            if mode == "private":
                resp["login_required"] = True
        return self._json(200, resp)

    def _handle_userdata_get(self):
        """GET /userdata — the signed-in user's own server-stored My-data blob
        (bookmarks/history/preferences). Only a NAMED user resolves here; an
        admin-without-a-user or an anonymous visitor gets 401 and keeps their
        data in the browser."""
        name = _users.resolve_request_user(self)
        if not name:
            return self._json(401, {"error": "sign in required"})
        return self._json(200, _users.load_user_data(name))

    def _handle_userdata_post(self, data):
        """POST /userdata — save the signed-in user's own My-data blob. A user
        can only ever touch their OWN data: the target is the session identity,
        never a name from the body, so there is no cross-user write path."""
        name = _users.resolve_request_user(self)
        if not name:
            return self._json(401, {"error": "sign in required"})
        ok, err = _users.save_user_data(name, data if isinstance(data, dict) else {})
        if not ok:
            return self._json(400, {"error": err})
        return self._json(200, {"status": "ok"})

    def log_message(self, format, *args):
        # Light logging: errors + slow requests. Suppress 200/304 noise.
        if len(args) >= 2 and str(args[1]) in ("200", "304"):
            return
        # Idle keep-alive reaping: stdlib logs "Request timed out: ..." at INFO
        # every time a parked HTTP/1.1 connection (reverse proxy, uptime
        # monitor) hits ZimHandler.timeout. Routine, not an error — drop to
        # debug so it doesn't spam the log every ~30s.
        if isinstance(format, str) and format.startswith("Request timed out"):
            log.debug(format, *args)
            return
        log.info(format, *args)
