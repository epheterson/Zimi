"""Library management for Zimi — auto-update, downloads, catalog, and thumb proxy.

Extracted from server.py to keep the main module focused on core ZIM operations.
All server state (ZIM_DIR, locks, caches) is accessed via ``zimi.server`` to
maintain a single source of truth.
"""

import glob
import ipaddress
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
from urllib.parse import urlparse, urlencode, quote

import zimi.server as _srv

log = logging.getLogger("zimi")


# Hosts we trust to serve ZIM and .torrent companion URLs. Kiwix runs
# multiple origins (`download.kiwix.org` for direct, `lbo.download.kiwix.org`
# load-balanced, plus the Wikimedia dumps mirror for Wikimedia ZIMs). We
# accept ANY subdomain of `kiwix.org`, plus the Wikimedia kiwix path on
# `dumps.wikimedia.org`. Everything else is rejected so an attacker can't
# inject metadata via a third-party URL.
_TRUSTED_KIWIX_HOST_SUFFIXES = (".kiwix.org",)
_TRUSTED_KIWIX_EXACT_HOSTS = ("kiwix.org",)
_TRUSTED_MIRROR_PREFIXES = ("https://dumps.wikimedia.org/kiwix/",)


def _is_lan_host(host):
    """True if `host` is an IP literal safe to pull a peer ZIM from.

    Peers advertise IP literals via mDNS (unauthenticated multicast), so a
    malicious responder could name any address. We allow only private
    (RFC1918) and loopback IPs and explicitly reject link-local — that blocks
    the cloud-metadata endpoint (169.254.169.254) and any public host, so a
    pill click can't be turned into an SSRF against off-LAN targets. A
    hostname (non-literal) is rejected outright so nothing re-resolves later.
    """
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.is_link_local:
        return False
    return ip.is_private or ip.is_loopback


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse HTTP redirects. Used wherever following one would be an SSRF
    risk: Kiwix thumbnail fetches and LAN peer pulls. A peer that passed the
    LAN-host check can't 302 us to an off-LAN target after the fact — the
    redirect surfaces as a normal HTTPError the caller treats as a failure."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url, code, "Redirect blocked", headers, fp
        )


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler)


class _KiwixRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to trusted Kiwix hosts. Used for thumbnail
    fetches: Kiwix redirects library.kiwix.org → opds.library.kiwix.org, so a
    blanket no-redirect policy breaks every catalog thumbnail. We follow the
    redirect when it stays on *.kiwix.org and block it otherwise, so a
    redirect to an arbitrary/internal host still can't be used for SSRF."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        host = (urlparse(newurl).hostname or "").lower()
        if host == "kiwix.org" or host.endswith(".kiwix.org"):
            return super().redirect_request(req, fp, code, msg, headers, newurl)
        raise urllib.error.HTTPError(
            req.full_url, code, "Redirect blocked (non-Kiwix host)", headers, fp
        )


_KIWIX_REDIRECT_OPENER = urllib.request.build_opener(_KiwixRedirectHandler)


def _is_trusted_kiwix_url(url):
    """Return True if `url` points to a known-good Kiwix-controlled host.

    Requires https — http URLs are rejected even on trusted hosts so a
    network-level attacker can't downgrade and inject metadata.
    """
    if not url:
        return False
    for prefix in _TRUSTED_MIRROR_PREFIXES:
        if url.startswith(prefix):
            return True
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    host = parsed.hostname
    if not host:
        return False
    host = host.lower()
    if host in _TRUSTED_KIWIX_EXACT_HOSTS:
        return True
    return any(host.endswith(suffix) for suffix in _TRUSTED_KIWIX_HOST_SUFFIXES)


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
    locked = getattr(_srv, "_auto_update_env_locked", _auto_update_env_locked)
    config_path = getattr(_srv, "_AUTO_UPDATE_CONFIG", _AUTO_UPDATE_CONFIG)
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
    config_path = getattr(_srv, "_AUTO_UPDATE_CONFIG", _AUTO_UPDATE_CONFIG)
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
            if not getattr(_srv, "_auto_update_enabled", _auto_update_enabled):
                return
            time.sleep(1)
    log.info(
        "Auto-update enabled: checking every %s",
        getattr(_srv, "_auto_update_freq", _auto_update_freq),
    )
    while getattr(_srv, "_auto_update_enabled", _auto_update_enabled):
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
                        raw_name = raw_name[: -len(".meta4")]
                    filename = raw_name
                    # Skip if already downloading this file
                    with _download_lock:
                        already = any(
                            d["filename"] == filename and not d.get("done")
                            for d in _active_downloads.values()
                        )
                    if already:
                        log.info(
                            "Auto-update: skipping %s (already downloading)", filename
                        )
                        continue
                    # Skip if file already exists on disk (prevents infinite re-download loop)
                    if os.path.exists(os.path.join(_srv.ZIM_DIR, filename)):
                        log.info("Auto-update: skipping %s (already on disk)", filename)
                        continue
                    dl_id, err = _start_download(url)
                    if err:
                        log.warning(
                            "Auto-update download failed for %s: %s",
                            upd.get("name", "?"),
                            err,
                        )
                    else:
                        log.info(
                            "Auto-update started download: %s (id=%s)",
                            upd.get("name", "?"),
                            dl_id,
                        )
            else:
                log.info("Auto-update: all ZIMs up to date")
        except Exception as e:
            log.warning("Auto-update check failed: %s", e)
        # Sleep in 60s chunks so we can exit cleanly; re-read frequency each cycle
        freq = getattr(_srv, "_auto_update_freq", _auto_update_freq)
        interval = _FREQ_SECONDS.get(freq, 604800)
        for _ in range(max(interval // 60, 1)):
            if not getattr(_srv, "_auto_update_enabled", _auto_update_enabled):
                break
            time.sleep(60)


# ============================================================================
# Library Management
# ============================================================================

_active_downloads = (
    {}
)  # {id: {"url": ..., "filename": ..., "pid": ..., "started": ...}}
_download_counter = 0
_download_lock = threading.Lock()

# Concurrent-download cap. Default 3; overridable via ZIMI_MAX_CONCURRENT_DOWNLOADS.
# Items beyond the cap are queued in _download_queue, smallest-first.
_MAX_CONCURRENT_DEFAULT = 3
_download_queue = []  # [dl, ...] sorted: known sizes ascending, unknown sizes last


def _max_concurrent():
    """Concurrent-download cap, read from env each call so tests can flip it.

    Invalid values (non-integer, negative, zero) clamp to safe defaults.
    """
    raw = os.environ.get("ZIMI_MAX_CONCURRENT_DOWNLOADS")
    if raw is None:
        return _MAX_CONCURRENT_DEFAULT
    try:
        n = int(raw)
    except (ValueError, TypeError):
        return _MAX_CONCURRENT_DEFAULT
    return max(1, n)


def _active_count():
    """Number of in-flight downloads (not done). Hold _download_lock when calling."""
    return sum(1 for d in _active_downloads.values() if not d.get("done"))


def _enqueue_or_start(dl):
    """Either start the download immediately or place it in the queue.

    Returns True if queued, False if started. Caller must hold _download_lock.
    """
    if _active_count() < _max_concurrent():
        _active_downloads[dl["id"]] = dl
        threading.Thread(target=_download_thread, args=(dl,), daemon=True).start()
        _persist_pending_downloads()
        return False
    # Queue: known sizes ascending; unknown (None) sizes go to the end.
    sz = dl.get("size_bytes")
    pos = len(_download_queue)
    if sz is not None:
        for i, q in enumerate(_download_queue):
            qsz = q.get("size_bytes")
            if qsz is None or sz < qsz:
                pos = i
                break
    _download_queue.insert(pos, dl)
    _persist_pending_downloads()
    return True


def _drain_queue():
    """Promote queued downloads into active slots while there's room.

    Caller must hold _download_lock.
    """
    while _download_queue and _active_count() < _max_concurrent():
        dl = _download_queue.pop(0)
        _active_downloads[dl["id"]] = dl
        threading.Thread(target=_download_thread, args=(dl,), daemon=True).start()


# Refuse downloads that would obviously fill the disk: the expected size
# plus a safety floor must fit in free space. The floor is shared with
# the seeding pause in p2p (canonical definition lives there).
from zimi.p2p import DISK_FLOOR_BYTES as _DISK_FLOOR_BYTES


def _refuse_for_disk_space(size_bytes, dest=None):
    """Return an error string when there's no room, else None.

    A resumable partial (.tmp) already occupies its bytes — count only
    what's left to fetch, or a 90%-done resume gets refused for the
    space it has already used."""
    from zimi import p2p as _p2p

    try:
        usage = shutil.disk_usage(_srv.ZIM_DIR)
    except OSError:
        return None  # can't tell — don't block
    needed = int(size_bytes or 0)
    if needed and dest:
        try:
            needed = max(0, needed - os.path.getsize(dest + ".tmp"))
        except OSError:
            pass
    if needed and usage.free < needed + _DISK_FLOOR_BYTES:
        return "Not enough disk space (%s free, %s needed)" % (
            _fmt_gb(usage.free),
            _fmt_gb(needed + _DISK_FLOOR_BYTES),
        )
    # Absolute floor for unknown sizes. The percent-based seeding
    # threshold is wrong here: 5% of a big drive is 100+ GB of free
    # space, which refused perfectly safe downloads (found when the
    # suite ran on a nearly-full Mac).
    if usage.free < _DISK_FLOOR_BYTES:
        return "Disk space is critically low"
    return None


def _fmt_gb(n):
    return f"{n / 1024**3:.1f} GB"


def _torrent_info_hash(data):
    """Infohash (hex sha1 of the bencoded info dict) from raw .torrent
    bytes. Minimal bencode scanner — no external deps. Returns None on
    malformed input."""
    import hashlib as _hl

    def _span(i):
        """End index of the bencoded element starting at i."""
        c = data[i : i + 1]
        if c == b"i":
            return data.index(b"e", i) + 1
        if c in (b"l", b"d"):
            i += 1
            while data[i : i + 1] != b"e":
                i = _span(i)
            return i + 1
        if c.isdigit():
            colon = data.index(b":", i)
            return colon + 1 + int(data[i:colon])
        raise ValueError("bad bencode")

    try:
        if data[:1] != b"d":
            return None
        i = 1
        while data[i : i + 1] != b"e":
            key_end = _span(i)
            key = data[i:key_end]
            val_end = _span(key_end)
            if key == b"4:info":
                return _hl.sha1(data[key_end:val_end]).hexdigest()
            i = val_end
        return None
    except (ValueError, IndexError, RecursionError):
        # RecursionError: absurdly nested (hostile) input — skip this file
        return None


_magnets_ensured = False


def ensure_magnets_for_installed(spacing=0.4):
    """Every user keeps the catalog + a magnet per installed ZIM; only
    mirrors keep the .torrent files themselves (Eric's split). For
    installed ZIMs with no recorded infohash, fetch the matching catalog
    .torrent, extract the infohash, store filename -> magnet in the
    manifest — and keep the torrent bytes on disk only in mirror mode.
    Once per run, politely paced."""
    global _magnets_ensured
    from zimi import p2p as _p2p

    if _magnets_ensured or not _p2p.is_torrent_enabled():
        return 0
    _magnets_ensured = True

    manifest_path = _torrents_manifest_path()
    manifest = _get_torrent_metadata()
    installed = {
        os.path.basename(path)
        for path in glob.glob(os.path.join(_srv.ZIM_DIR, "*.zim"))
    }
    missing = [
        f for f in sorted(installed) if not (manifest.get(f) or {}).get("info_hash")
    ]
    if not missing:
        return 0

    # Exact-filename matches from the catalog (stale copy works offline)
    catalog_urls = {}
    try:
        _total, items, _err = _fetch_kiwix_catalog("", "eng", 500, 0)
        if _err:
            raise RuntimeError(_err)
        for it in items or []:
            u = (it.get("download_url") or "").split("?")[0]
            if u.endswith(".meta4"):
                u = u[: -len(".meta4")]
            if u.endswith(".zim"):
                catalog_urls[os.path.basename(u)] = u + ".torrent"
    except Exception as e:
        # Archived .torrent files still work offline — process those now,
        # and retry the catalog-dependent rest on the next maintenance
        # pass instead of silently never building the manifest.
        log.info(
            "Magnet manifest: catalog unavailable (%s) — using archived torrents only",
            e,
        )
        catalog_urls = {}
        _magnets_ensured = False

    keep_files = _p2p.is_mirror_enabled()
    tdir = os.path.join(_srv.ZIMI_DATA_DIR, "bt", "torrents")
    updated = 0
    for filename in missing:
        data = None
        archived = os.path.join(tdir, filename + ".torrent")
        if os.path.isfile(archived):
            try:
                with open(archived, "rb") as f:
                    data = f.read()
            except OSError:
                data = None
        elif filename in catalog_urls:
            try:
                req = urllib.request.Request(
                    catalog_urls[filename], headers={"User-Agent": "Zimi/1.0"}
                )
                with urllib.request.urlopen(
                    req, timeout=20, context=_srv.SSL_CTX
                ) as resp:
                    data = resp.read(8 * 1024 * 1024)
            except Exception:
                data = None
            time.sleep(spacing)
        if not data:
            continue
        info_hash = _torrent_info_hash(data)
        if not info_hash:
            continue
        entry = dict(manifest.get(filename) or {})
        entry["info_hash"] = info_hash
        entry["magnet"] = "magnet:?xt=urn:btih:" + info_hash
        entry.setdefault("torrent_url", catalog_urls.get(filename, ""))
        entry.setdefault("added", time.time())
        if keep_files and not os.path.isfile(archived):
            try:
                os.makedirs(tdir, exist_ok=True)
                with open(archived + ".tmp", "wb") as f:
                    f.write(data)
                os.replace(archived + ".tmp", archived)
                entry["torrent_file"] = archived
            except OSError:
                pass
        manifest[filename] = entry
        updated += 1
    if updated:
        os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
        _srv._atomic_write_json(manifest_path, manifest)
        log.info("Magnet manifest: %d installed ZIM(s) added", updated)
    return updated


def _torrents_manifest_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "bt", "torrents.json")


def _record_torrent_metadata(filename, *, info_hash, torrent_url, staging_dir):
    """Post-world resilience: keep everything needed to re-seed or share a
    ZIM without internet. The manifest maps filename -> infohash/magnet +
    torrent URL; the .torrent file itself (which aria2 fetched into
    staging) is preserved under ZIMI_DATA_DIR/bt/torrents/."""
    manifest_path = _torrents_manifest_path()
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        manifest = {}
    entry = {
        "info_hash": info_hash or "",
        "torrent_url": torrent_url or "",
        "added": time.time(),
    }
    if info_hash:
        entry["magnet"] = "magnet:?xt=urn:btih:" + info_hash
    # Preserve the .torrent file aria2 downloaded (staging/<name>.torrent)
    tdir = os.path.join(_srv.ZIMI_DATA_DIR, "bt", "torrents")
    for cand in (
        os.path.join(staging_dir, filename + ".torrent"),
        os.path.join(staging_dir, os.path.splitext(filename)[0] + ".torrent"),
    ):
        if os.path.isfile(cand):
            os.makedirs(tdir, exist_ok=True)
            kept = os.path.join(tdir, filename + ".torrent")
            try:
                shutil.copyfile(cand, kept)
                entry["torrent_file"] = kept
            except OSError:
                pass
            break
    manifest[filename] = entry
    _srv._atomic_write_json(manifest_path, manifest)


def _get_torrent_metadata():
    """The saved filename -> {info_hash, magnet, torrent_url, ...} map."""
    try:
        with open(_torrents_manifest_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _pending_downloads_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "downloads.json")


def _persist_pending_downloads():
    """Snapshot every not-yet-finished download so a restart can resume
    them (queue and active slots are otherwise memory-only). Callers hold
    _download_lock; the write is atomic and tiny."""
    items = []
    for dl in list(_active_downloads.values()) + list(_download_queue):
        if dl.get("done") or dl.get("cancelled"):
            continue
        items.append(
            {
                # The .meta4 URL re-resolves fresh mirrors on resume
                "url": dl.get("_meta4") or dl["url"],
                "filename": dl["filename"],
                "size_bytes": dl.get("size_bytes"),
                "source": dl.get("_source", ""),
                "peer_name": dl.get("peer_name", ""),
            }
        )
    _srv._atomic_write_json(_pending_downloads_path(), {"pending": items})


def resume_pending_downloads():
    """Re-submit downloads that were pending when the server stopped.

    Each entry goes back through its own validated entry point (catalog /
    peer / import), so trust checks re-run and .zim.tmp partials resume
    via the normal range machinery. Returns how many were resubmitted.
    """
    path = _pending_downloads_path()
    try:
        with open(path) as f:
            items = json.load(f).get("pending", [])
    except (OSError, ValueError):
        return 0

    # The manifest is NOT deleted up front: a crash during the resume
    # window must not lose every pending transfer. The single rewrite at
    # the end (under the lock) is the source of truth.
    def _already_pending(filename):
        with _download_lock:
            if any(
                d.get("filename") == filename and not d.get("done")
                for d in _active_downloads.values()
            ):
                return True
            return any(q.get("filename") == filename for q in _download_queue)

    # Peer entries need mDNS to have found the peer again — discovery
    # starts in the same breath as this call, so give it a moment rather
    # than dropping the transfer (resume runs on a background thread).
    from zimi import p2p_discovery as _disc

    if any(it.get("source") == "peer" for it in items) and _disc.is_share_enabled():
        wanted = {it.get("peer_name") for it in items if it.get("source") == "peer"}
        deadline = time.time() + 30
        while time.time() < deadline:
            present = {p.get("name") for p in (_disc.get_peers() or [])}
            if wanted <= present:
                break
            time.sleep(2)

    resumed = 0
    kept = []
    for it in items:
        try:
            filename = it.get("filename", "?")
            if _already_pending(filename):
                continue
            if it.get("source") == "peer" and it.get("peer_name"):
                dl_id, err = _start_peer_download(
                    it["peer_name"], filename, it.get("size_bytes")
                )
                if not dl_id:
                    # Peer not back yet — keep the entry for the next
                    # restart instead of silently discarding the transfer.
                    kept.append(it)
                    log.info("Peer resume deferred for %s: %s", filename, err)
                    continue
            elif _is_trusted_kiwix_url(it.get("url", "")):
                dl_id, err = _start_download(it["url"], it.get("size_bytes"))
            else:
                dl_id, err = _start_import(it["url"], it.get("size_bytes"))
            if dl_id:
                resumed += 1
            elif err:
                log.info("Not resuming %s: %s", filename, err)
        except Exception as e:
            log.warning("Resume failed for %s: %s", it.get("filename"), e)
    # Single atomic rewrite, entirely under the lock: active/queued
    # entries from the resubmissions plus the deferred (kept) ones. A
    # download completing concurrently can't be resurrected as pending,
    # because nothing here reads the file back outside the lock.
    with _download_lock:
        _persist_pending_downloads()
        if kept:
            try:
                with open(path) as f:
                    current = json.load(f).get("pending", [])
            except (OSError, ValueError):
                current = []
            have = {c.get("filename") for c in current}
            current.extend(k for k in kept if k.get("filename") not in have)
            _srv._atomic_write_json(path, {"pending": current})
    if resumed:
        log.info("Resumed %d pending download(s) from the previous run", resumed)
    return resumed


def _cancel_download(dl_id):
    """Cancel an active or queued download. Returns (status, code).

    status: "cancelling" | "removed" | "not_found" | "already_done"
    """
    with _download_lock:
        # Queued items: just drop
        for i, q in enumerate(_download_queue):
            if q["id"] == dl_id:
                del _download_queue[i]
                _persist_pending_downloads()
                return "removed", 200
        dl = _active_downloads.get(dl_id)
        if not dl:
            return "not_found", 404
        if dl.get("done"):
            return "already_done", 400
        dl["cancelled"] = True
        _persist_pending_downloads()
    return "cancelling", 200


KIWIX_OPDS_BASE = "https://library.kiwix.org/catalog/search"

# Server-side catalog cache: {cache_key: (timestamp, total, items)}
_opds_cache = {}
_opds_lock = threading.Lock()
_OPDS_CACHE_TTL = 86400  # 24 hours — catalog changes rarely
_OPDS_DISK_KEYS_MAX = 40  # main browse pages; enough for full offline browse

# Post-world resilience: the last good catalog persists to disk and is
# served (marked stale) when Kiwix is unreachable — the library must stay
# browsable with zero internet. When a stale copy was served, this holds
# its fetch timestamp for the API response.
_catalog_stale_ts = None
_opds_disk_loaded = False


def _catalog_cache_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "catalog_cache.json")


def _load_opds_disk_cache():
    """Merge the persisted catalog into the in-memory cache once."""
    global _opds_disk_loaded
    if _opds_disk_loaded:
        return
    _opds_disk_loaded = True
    try:
        with open(_catalog_cache_path()) as f:
            data = json.load(f)
        with _opds_lock:
            for key, (ts, total, items) in data.items():
                _opds_cache.setdefault(key, (ts, total, items))
        if data:
            log.info("Catalog cache loaded from disk (%d queries)", len(data))
    except (OSError, ValueError):
        pass


def _is_browse_key(key):
    """Main catalog browse pages (empty query) — the offline backbone."""
    return key.startswith("|")


def _persist_opds_cache():
    """Write cache entries to disk (atomic, size-capped). Browse pages are
    the offline catalog backbone — they persist ahead of one-off search
    keys regardless of freshness, or heavy searching would quietly evict
    the post-world copy."""
    try:
        with _opds_lock:
            entries = list(_opds_cache.items())
        entries.sort(key=lambda kv: (not _is_browse_key(kv[0]), -kv[1][0]))
        _srv._atomic_write_json(
            _catalog_cache_path(), dict(entries[:_OPDS_DISK_KEYS_MAX])
        )
    except OSError as e:
        log.debug("catalog cache persist failed: %s", e)


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
    # Fetch from Kiwix. Follow redirects only within *.kiwix.org (Kiwix
    # redirects library → opds); a redirect off-Kiwix is blocked (SSRF).
    try:
        opener = _KIWIX_REDIRECT_OPENER
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
    global _catalog_stale_ts
    _load_opds_disk_cache()
    cache_key = f"{query}|{lang}|{count}|{start}"
    with _opds_lock:
        cached = _opds_cache.get(cache_key)
        if cached:
            ts, total, items = cached
            if time.time() - ts < _OPDS_CACHE_TTL:
                _catalog_stale_ts = None
                return total, items, None
            # Expired entries are kept as the offline fallback — deleted
            # only once a fresh fetch replaces them.
        # Cap: evict only one-off search keys. Browse pages are the
        # offline catalog and must survive any amount of searching.
        if len(_opds_cache) > 100:
            for k in [k for k in _opds_cache if not _is_browse_key(k)]:
                del _opds_cache[k]
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
        if cached:
            # Offline: a day-old catalog beats an error page (post-world:
            # this is how the library stays browsable with no internet).
            ts, total, items = cached
            _catalog_stale_ts = ts
            log.info("Serving stale catalog from %s", time.ctime(ts))
            return total, items, None
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
            if (
                rel == "http://opds-spec.org/acquisition/open-access"
                and ltype == "application/x-zim"
            ):
                download_url = href
                try:
                    size_bytes = int(link.get("length", "0"))
                except (ValueError, TypeError):
                    pass
            elif rel == "http://opds-spec.org/image/thumbnail":
                icon_url = (
                    "https://library.kiwix.org" + href if href.startswith("/") else href
                )

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
        items.append(
            {
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
            }
        )

    with _opds_lock:
        _opds_cache[cache_key] = (time.time(), total, items)
    _catalog_stale_ts = None
    _persist_opds_cache()
    _prefetch_thumbs(items)
    return total, items, None


_thumb_prefetch_started = False


def _prefetch_thumbs(items, limit=200, spacing=0.15):
    """Warm the thumbnail disk cache in the background so catalog browsing
    doesn't trickle images in one at a time. Once per server run, gently
    paced (~7/s), capped, and skips everything already cached."""
    global _thumb_prefetch_started
    if _thumb_prefetch_started:
        return
    _thumb_prefetch_started = True
    urls = []
    for it in items or []:
        u = it.get("icon_url")
        if u:
            urls.append(u)
        if len(urls) >= limit:
            break
    if not urls:
        return

    def _run():
        import hashlib as _hl

        fetched = 0
        for u in urls:
            key = _hl.md5(u.encode()).hexdigest()
            if os.path.exists(os.path.join(_thumb_dir(), key)):
                continue
            data, _ct = _fetch_thumb(u)
            if data:
                fetched += 1
            time.sleep(spacing)
        if fetched:
            log.info("Thumbnail prefetch: %d cached", fetched)

    threading.Thread(target=_run, daemon=True, name="thumb-prefetch").start()


_mirror_sync_lock = threading.Lock()
# Live progress for the settings UI: {"phase": "seeding"|"archiving"|None,
# "done": int, "total": int}
_mirror_progress = {"phase": None, "done": 0, "total": 0}


def _set_mirror_progress(phase, done=0, total=0):
    _mirror_progress["phase"] = phase
    _mirror_progress["done"] = done
    _mirror_progress["total"] = total


def mirror_sync():
    """True mirror mode: seed every installed ZIM, not just ones we
    downloaded over BT. Sources, in order: the saved .torrent files from
    past downloads (works fully offline), then <download_url>.torrent for
    catalog entries whose dated filename exactly matches an installed
    file. aria2 hash-checks the existing file and seeds without
    re-downloading. Returns how many torrents were added."""
    from zimi import p2p as _p2p

    if not (_p2p.is_torrent_enabled() and _p2p.is_mirror_enabled()):
        return 0
    if not _mirror_sync_lock.acquire(blocking=False):
        return 0  # already running (startup + toggle + maintenance overlap)
    try:
        return _mirror_sync_locked(_p2p)
    finally:
        _mirror_sync_lock.release()


def _mirror_sync_locked(_p2p):
    if _p2p.should_pause_for_disk_pressure(_srv.ZIM_DIR):
        log.info("Mirror sync skipped: disk pressure")
        return 0
    backend = _p2p.get_backend(data_dir=_srv.ZIMI_DATA_DIR)
    if backend is None:
        return 0

    # What the sidecar already manages, by target file basename
    managed = set()
    try:
        for raw in backend.list_managed():
            for f in raw.get("files", []):
                managed.add(os.path.basename(f.get("path", "")))
    except Exception as e:
        log.debug("mirror: list_managed failed: %s", e)
        return 0

    installed = {
        os.path.basename(path)
        for path in glob.glob(os.path.join(_srv.ZIM_DIR, "*.zim"))
    }
    saved = _get_torrent_metadata()

    # Catalog lookup (stale copy is fine — that's the post-world path)
    catalog_urls = {}
    try:
        _total, items, _err = _fetch_kiwix_catalog("", "eng", 500, 0)
        for it in items or []:
            url = (it.get("download_url") or "").split("?")[0]
            if url.endswith(".meta4"):
                url = url[: -len(".meta4")]
            if url.endswith(".zim"):
                catalog_urls[os.path.basename(url)] = url
    except Exception:
        pass

    added = 0
    todo = sorted(installed - managed)
    _set_mirror_progress("seeding", 0, len(todo))
    for _mi, filename in enumerate(todo):
        _set_mirror_progress("seeding", _mi + 1, len(todo))
        source = None
        meta = saved.get(filename) or {}
        tfile = meta.get("torrent_file")
        if tfile and os.path.isfile(tfile):
            source = tfile
        elif meta.get("torrent_url"):
            source = meta["torrent_url"]
        elif filename in catalog_urls:
            source = catalog_urls[filename] + ".torrent"
        if not source:
            continue
        try:
            backend.add_torrent(
                source,
                dest_dir=_srv.ZIM_DIR,
                options={
                    # Verify the existing file, then seed it — never fetch
                    "check-integrity": "true",
                    "bt-hash-check-seed": "true",
                    "seed-ratio": "0",  # mirrors seed without a cap
                    "allow-overwrite": "true",
                },
            )
            added += 1
        except Exception as e:
            log.debug("mirror: add %s failed: %s", filename, e)
    _set_mirror_progress(None)
    if added:
        log.info("Mirror mode: seeding %d installed ZIM(s)", added)
    return added


_catalog_torrents_archived = False


def archive_catalog_torrents(spacing=0.4, _max_bytes=5 * 1024 * 1024):
    """Mirror-mode duty: hold the .torrent for EVERY catalog item, not just
    installed ones — ~40-80 MB total for the full Kiwix catalog (measured
    avg ~34 KB each). With the persisted catalog and DHT this makes a
    mirror node a complete post-world index: any ZIM can be fetched,
    verified, and re-seeded with zero internet. Paced politely, skips
    files already archived (dated names make this incremental), runs once
    per server run and only when mirror mode is on."""
    global _catalog_torrents_archived
    from zimi import p2p as _p2p

    if _catalog_torrents_archived:
        return 0
    if not (_p2p.is_torrent_enabled() and _p2p.is_mirror_enabled()):
        return 0
    _catalog_torrents_archived = True

    tdir = os.path.join(_srv.ZIMI_DATA_DIR, "bt", "torrents")
    os.makedirs(tdir, exist_ok=True)

    # Full catalog, all pages
    urls = {}
    total, items, err = _fetch_kiwix_catalog("", "eng", 500, 0)
    if err:
        _catalog_torrents_archived = False  # retry next run
        return 0
    pages = [items]
    for start in range(500, total, 500):
        _t, more, _e = _fetch_kiwix_catalog("", "eng", 500, start)
        if more:
            pages.append(more)
    for page in pages:
        for it in page or []:
            u = (it.get("download_url") or "").split("?")[0]
            if u.endswith(".meta4"):
                u = u[: -len(".meta4")]
            if u.endswith(".zim"):
                urls[os.path.basename(u)] = u + ".torrent"

    fetched = 0
    fetched_bytes = 0
    _todo = sorted(urls.items())
    _set_mirror_progress("archiving", 0, len(_todo))
    for _ai, (filename, turl) in enumerate(_todo):
        _set_mirror_progress("archiving", _ai + 1, len(_todo))
        dest = os.path.join(tdir, filename + ".torrent")
        if os.path.exists(dest):
            continue
        try:
            req = urllib.request.Request(turl, headers={"User-Agent": "Zimi/1.0"})
            with urllib.request.urlopen(req, timeout=20, context=_srv.SSL_CTX) as resp:
                data = resp.read(_max_bytes + 1)
            # bencoded dict or it isn't a torrent (error pages, redirects)
            if not data.startswith(b"d") or len(data) > _max_bytes:
                continue
            tmp = dest + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
            fetched += 1
            fetched_bytes += len(data)
        except Exception as e:
            log.debug("torrent archive: %s failed: %s", filename, e)
        time.sleep(spacing)
    _set_mirror_progress(None)
    if fetched:
        log.info(
            "Catalog torrent archive: %d fetched (%.1f MB), %d total held",
            fetched,
            fetched_bytes / 1024 / 1024,
            len(os.listdir(tdir)),
        )
    return fetched


def stop_mirror_seeds():
    """Mirror off: stop the MIRROR seeds, keep everything else.

    Mirror-class seeds are the uncapped ones (seed-ratio 0 — mirror_sync
    and mirror-mode re-seeds both use it; ordinary post-download seeds
    always carry a positive cap, since cap 0 means leech-only and never
    re-adds). Regular ratio-capped seeding continues untouched, and the
    ZIMs + torrent archive stay on disk — flipping Mirror back on
    re-seeds instantly. Turning a toggle off never deletes a backup."""
    from zimi import p2p as _p2p

    backend = _p2p.peek_backend()
    if backend is None:
        return 0
    removed = 0
    try:
        entries = backend.list_managed()
    except Exception:
        return 0
    zim_root = os.path.normpath(_srv.ZIM_DIR)
    get_opts = getattr(backend, "get_options", lambda tid: {})
    for raw in entries:
        for f in raw.get("files", []):
            path = f.get("path", "")
            if path and os.path.normpath(os.path.dirname(path)) == zim_root:
                ratio = str(get_opts(raw.get("gid", "")).get("seed-ratio", ""))
                try:
                    uncapped = float(ratio) == 0.0
                except (ValueError, TypeError):
                    uncapped = False
                if uncapped:
                    try:
                        backend.remove(raw.get("gid", ""), delete_files=True)
                        removed += 1
                    except Exception:
                        pass
                break
    if removed:
        log.info("Mirror off: stopped %d mirror seed(s); archive kept", removed)
    return removed


def retire_stale_seeds():
    """Drop sidecar torrents whose library file is gone — an update
    replaced it, or the user deleted the ZIM. Without this, aria2 keeps
    advertising (and hash-check failing) old versions forever. Only
    torrents targeting ZIM_DIR are touched; staging transfers belong to
    the download machinery. Returns how many were removed."""
    from zimi import p2p as _p2p

    backend = _p2p.peek_backend()
    if backend is None:
        return 0
    removed = 0
    try:
        entries = backend.list_managed()
    except Exception:
        return 0
    zim_root = os.path.normpath(_srv.ZIM_DIR)
    for raw in entries:
        for f in raw.get("files", []):
            path = f.get("path", "")
            if not path:
                continue
            if os.path.normpath(os.path.dirname(path)) != zim_root:
                continue
            if not os.path.exists(path):
                try:
                    backend.remove(raw.get("gid", ""), delete_files=True)
                    removed += 1
                    log.info("Retired stale seed: %s", os.path.basename(path))
                except Exception:
                    pass
                break
    return removed


def _try_bt_download(
    backend,
    dl,
    *,
    torrent_url,
    staging_dir,
    poll_interval=2.0,
    no_peers_timeout=60.0,
):
    """Attempt to download via the BT backend, with explicit fallback.

    Returns one of:
      "success"   — file written to dl['dest']; caller is done
      "fallback"  — BT didn't pan out; caller should run the HTTP path
      "cancelled" — user cancelled; backend cleaned up; caller stops
      "error"     — terminal (rare); caller should report

    On every poll we update dl with downloaded_bytes / total_bytes /
    bt_peers / bt_info_hash so the existing /manage/downloads UI surfaces
    BT progress without further wiring.
    """
    from zimi import p2p as _p2p

    if _p2p.is_seeding_enabled():
        # effective_seed_options picks mirror caps when ZIMI_MIRROR=1,
        # otherwise the user's personal cap (default 2× ratio).
        seed_opts = _p2p.effective_seed_options()
    else:
        seed_opts = _p2p.seed_options(ratio_cap=0, max_upload_kb=0)
    try:
        tid = backend.add_torrent(torrent_url, dest_dir=staging_dir, options=seed_opts)
    except Exception as e:
        log.warning(
            "BT add_torrent failed for %s: %s — falling back to HTTP", dl["filename"], e
        )
        return "fallback"

    started = time.time()
    was_paused = False
    while True:
        if dl.get("cancelled"):
            try:
                backend.remove(tid, delete_files=True)
            except Exception:
                pass
            return "cancelled"

        # Propagate UI pause/resume to aria2 — without this, "paused" is a
        # lie: the flag flips in the dl dict while bytes keep flowing.
        if bool(dl.get("paused")) != was_paused:
            was_paused = bool(dl.get("paused"))
            try:
                (backend.pause if was_paused else backend.resume)(tid)
            except Exception as e:
                log.debug("BT pause/resume propagate failed: %s", e)

        try:
            status = backend.status(tid)
        except Exception as e:
            log.warning(
                "BT status poll failed for %s: %s — falling back", dl["filename"], e
            )
            try:
                backend.remove(tid, delete_files=True)
            except Exception:
                pass
            return "fallback"

        # Rebind to the followed content GID (see Aria2Backend.status): a
        # .torrent URL's original GID is just the metadata fetch, and
        # pause/cancel/remove must act on the real transfer.
        tid = status.get("gid") or tid

        # Surface progress to the existing UI.
        dl["downloaded_bytes"] = status.get("completed_bytes", 0)
        dl["total_bytes"] = status.get("total_bytes", 0)
        dl["bt_peers"] = status.get("peers", 0)
        dl["bt_info_hash"] = status.get("info_hash", "")
        dl["_source"] = "bt"

        state = status.get("state")
        if state == "complete":
            staged = os.path.join(staging_dir, dl["filename"])
            # aria2 keeps a .aria2 control file beside every unfinished
            # download — if one exists, this "complete" is not our transfer.
            if not os.path.exists(staged) or os.path.exists(staged + ".aria2"):
                log.warning(
                    "BT reported complete but staged file missing/unfinished: %s"
                    " — falling back",
                    staged,
                )
                try:
                    backend.remove(tid, delete_files=True)
                except Exception:
                    pass
                return "fallback"
            # Never install a structurally invalid file. aria2 preallocates
            # the full file size, so existence and size prove nothing — the
            # two-phase GID confusion this guards installed full-size
            # garbage ZIMs before release.
            try:
                _srv.open_archive(staged)
            except Exception as e:
                log.warning(
                    "BT staged file failed libzim validation (%s): %s — falling back",
                    dl["filename"],
                    e,
                )
                try:
                    backend.remove(tid, delete_files=True)
                except Exception:
                    pass
                return "fallback"
            try:
                os.makedirs(os.path.dirname(dl["dest"]), exist_ok=True)
                os.replace(staged, dl["dest"])
            except OSError as e:
                # Cross-filesystem rename — fall back to copy + remove
                try:
                    import shutil as _shutil

                    _shutil.copyfile(staged, dl["dest"])
                    os.remove(staged)
                except Exception as e2:
                    log.warning("BT staging→dest failed: %s / %s", e, e2)
                    return "fallback"
            # Post-world resilience: remember how to seed this file with
            # zero internet — infohash + .torrent survive in ZIMI_DATA_DIR
            # even after the sidecar forgets the download.
            try:
                _record_torrent_metadata(
                    dl["filename"],
                    info_hash=status.get("info_hash", ""),
                    torrent_url=torrent_url,
                    staging_dir=staging_dir,
                )
            except Exception as e:
                log.debug("torrent metadata save failed: %s", e)
            # Honest seeding: re-add the torrent pointing at the LIBRARY
            # file. The old in-place seed rode an open file handle to a
            # renamed path — it died silently on restart or cross-fs moves.
            # bt-seed-unverified skips a re-hash (aria2 verified every
            # piece during the download; libzim just validated the file).
            _cap = _p2p.get_seed_ratio_cap()
            # Zimi's "ratio 0" means never seed; aria2's means seed
            # forever. Only mirror mode gets the uncapped value.
            if _p2p.is_seeding_enabled() and (_cap > 0 or _p2p.is_mirror_enabled()):
                try:
                    _meta = _get_torrent_metadata().get(dl["filename"]) or {}
                    _src = _meta.get("torrent_file") or torrent_url
                    _ratio = "0" if _p2p.is_mirror_enabled() else str(_cap)
                    backend.add_torrent(
                        _src,
                        dest_dir=os.path.dirname(dl["dest"]),
                        options={
                            "bt-seed-unverified": "true",
                            "seed-ratio": _ratio,
                            "allow-overwrite": "true",
                        },
                    )
                    backend.remove(tid, delete_files=True)
                except Exception as e:
                    log.debug(
                        "library re-seed failed (%s); in-session seed kept: %s",
                        dl["filename"],
                        e,
                    )
            elif _p2p.is_seeding_enabled():
                # Seeding on but cap 0: leech-only by policy
                try:
                    backend.remove(tid, delete_files=True)
                except Exception:
                    pass
            # Leech-only (seeding disabled): drop the finished torrent.
            if not _p2p.is_seeding_enabled():
                try:
                    backend.remove(tid)
                except Exception:
                    pass
            else:
                dl["bt_gid"] = tid  # keep so /manage/seeding can find it
                log.info(
                    "Seeding %s up to %.1fx ratio",
                    dl["filename"],
                    _p2p.get_seed_ratio_cap(),
                )
            return "success"

        if state == "error":
            log.warning(
                "BT reported error for %s: %s — falling back",
                dl["filename"],
                status.get("error_message", ""),
            )
            try:
                backend.remove(tid, delete_files=True)
            except Exception:
                pass
            return "fallback"

        # Stall detection: 0 peers AND <1% progress past the timeout.
        elapsed = time.time() - started
        total = status.get("total_bytes", 0) or 1
        pct = status.get("completed_bytes", 0) / total
        if (
            not was_paused
            and elapsed >= no_peers_timeout
            and status.get("peers", 0) == 0
            and pct < 0.01
        ):
            log.info(
                "BT stalled for %s after %.0fs (0 peers, %.1f%%) — falling back",
                dl["filename"],
                elapsed,
                pct * 100,
            )
            try:
                backend.remove(tid, delete_files=True)
            except Exception:
                pass
            return "fallback"

        time.sleep(poll_interval)


def _seed_after_http_download(dl):
    """Seed a file that completed over HTTP, so the BitTorrent toggle keeps
    its promise ("Download AND seed") even when the transport fell back.

    The BT path seeds inline on completion; the HTTP path historically did
    not, so any ZIM whose .torrent had no live seeders (common for niche or
    freshly-updated files — BT stalls after no_peers_timeout and falls back)
    silently never seeded. Best-effort: needs seeding on, a running backend,
    and a resolvable .torrent companion. Hash-checks the finished library
    file, then seeds it — never re-fetches. No-op on any missing piece.
    """
    from zimi import p2p as _p2p

    if not (_p2p.is_torrent_enabled() and _p2p.is_seeding_enabled()):
        return
    cap = _p2p.get_seed_ratio_cap()
    # Zimi's ratio 0 means "never seed" (aria2's means "seed forever").
    if cap <= 0 and not _p2p.is_mirror_enabled():
        return
    try:
        backend = _p2p.get_backend(data_dir=_srv.ZIMI_DATA_DIR)
    except Exception:
        backend = None
    if not backend:
        return
    # Torrent source: saved metadata first, then the Kiwix companion URL.
    meta = _get_torrent_metadata().get(dl["filename"]) or {}
    source = meta.get("torrent_file") or meta.get("torrent_url")
    if not source:
        source = _resolve_torrent_url(dl["url"])
    if not source:
        return
    ratio = "0" if _p2p.is_mirror_enabled() else str(cap)
    try:
        backend.add_torrent(
            source,
            dest_dir=_srv.ZIM_DIR,
            options={
                # Verify the file we already have, then seed it — never fetch.
                "check-integrity": "true",
                "bt-hash-check-seed": "true",
                "seed-ratio": ratio,
                "allow-overwrite": "true",
            },
        )
        log.info("Seeding HTTP-downloaded %s up to %sx ratio", dl["filename"], ratio)
    except Exception as e:
        log.debug("post-HTTP seed of %s failed: %s", dl["filename"], e)


def _resolve_torrent_url(url):
    """Return the Kiwix `.torrent` companion URL for a given download URL,
    or None if no plausible companion exists.

    Kiwix publishes `<file>.zim.torrent` next to every `<file>.zim`. We
    trust only Kiwix-controlled hosts to avoid attacker-controlled metadata
    being injected via a third-party URL.
    """
    if not _is_trusted_kiwix_url(url):
        return None
    if url.endswith(".torrent"):
        return url
    if url.endswith(".meta4"):
        url = url[: -len(".meta4")]
    if not url.endswith(".zim"):
        return None
    return url + ".torrent"


def _detect_flavor(filename_or_base):
    """Return 'maxi' / 'nopic' / 'mini' / None for a ZIM file basename.

    Used by _check_updates to constrain matches to the same flavor — never
    propose a mini as the update for an installed maxi (#16).
    """
    if not filename_or_base:
        return None
    s = filename_or_base.lower()
    if "_maxi_" in s or s.endswith("_maxi"):
        return "maxi"
    if "_nopic_" in s or s.endswith("_nopic"):
        return "nopic"
    if "_mini_" in s or s.endswith("_mini"):
        return "mini"
    return None


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
            installed_files.append(
                {
                    "name": name,
                    "date": date,
                    "filename": filename,
                    "filebase": filename.replace(".zim", ""),
                }
            )

    if not installed_files:
        return []

    # Fetch full catalog to check all installed ZIMs (paginated)
    all_items = []
    total, items, err = _fetch_kiwix_catalog(query="", lang="eng", count=500, start=0)
    if err:
        return []
    all_items.extend(items)
    while len(all_items) < total:
        _, more, err = _fetch_kiwix_catalog(
            query="", lang="eng", count=500, start=len(all_items)
        )
        if err or not more:
            break
        all_items.extend(more)

    # Build index: for each catalog item, gather candidate prefixes to match
    # installed filenames against. OPDS `name` field can be truncated/
    # inconsistent (e.g. "canadian_prep_winterprepping" for a file actually
    # named "canadian_prepper_winterprepping_en_2026-02.zim"). Falling back to
    # the prefix derived from download_url recovers those cases.
    #
    # Each catalog entry also carries its detected flavor (maxi/nopic/mini/None)
    # so we only suggest same-flavor updates. Crossing flavors would replace a
    # maxi (with images) install with a mini (text-only) — issue #16.
    catalog_index = []
    for item in all_items:
        dl_url = item.get("download_url", "")
        if not dl_url:
            continue
        cat_name = item.get("name", "")
        cat_date = item.get("date", "")[:7] if item.get("date") else ""
        if not cat_date or not cat_name:
            continue
        url_fname = dl_url.rsplit("/", 1)[-1]
        url_fname = re.sub(r"\.meta4$", "", url_fname)
        url_fname = re.sub(r"\.zim$", "", url_fname)
        url_prefix = re.sub(r"_\d{4}-\d{2}$", "", url_fname)
        prefixes = [cat_name]
        if url_prefix and url_prefix != cat_name:
            prefixes.append(url_prefix)
        cat_flavor = _detect_flavor(url_fname)
        catalog_index.append((prefixes, cat_date, cat_flavor, item))

    # For each installed ZIM, find the best catalog match. Match flavor
    # first (only same-flavor updates considered), then longest prefix.
    updates = []
    for inst in installed_files:
        inst_flavor = _detect_flavor(inst["filebase"])
        best = None
        best_len = 0
        for prefixes, cat_date, cat_flavor, item in catalog_index:
            if cat_date <= inst["date"]:
                continue
            if cat_flavor != inst_flavor:
                continue
            for p in prefixes:
                if inst["filebase"].startswith(p + "_") and len(p) > best_len:
                    best = (p, cat_date, item)
                    best_len = len(p)
        if best:
            _, cat_date, item = best
            updates.append(
                {
                    "name": inst["name"],
                    "installed_file": inst["filename"],
                    "installed_date": inst["date"],
                    "latest_date": cat_date,
                    "download_url": item.get("download_url", ""),
                    "title": item.get("title", ""),
                    "size_bytes": item.get("size_bytes", 0),
                }
            )

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
        log.info(
            "Resuming download of %s from %d bytes via %s",
            dl["filename"],
            existing_size,
            urlparse(url).hostname,
        )
    else:
        log.info("Downloading %s from %s", dl["filename"], urlparse(url).hostname)
    try:
        if dl.get("_source") == "peer":
            # Peer pulls are plain HTTP to a LAN IP literal; refuse redirects
            # so a peer can't bounce us off-LAN. No SSL context needed.
            resp = _NO_REDIRECT_OPENER.open(req, timeout=600)
        else:
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
                # Pause = freeze the read loop without releasing the slot. The
                # user can pause some active downloads to give bandwidth to
                # another. The HTTP connection may idle-timeout while paused;
                # if so, the next read fails and the mirror loop retries.
                while dl.get("paused") and not dl.get("cancelled"):
                    time.sleep(1)
                if dl.get("cancelled"):
                    break
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
            return (
                False,
                f"Size mismatch from {urlparse(url).hostname}: expected {total}, got {actual}",
            )
    return True, None


def _title_from_filename(filename):
    """Extract a readable title from a ZIM filename for history events."""
    name = re.sub(r"_\d{4}-\d{2}\.zim$", "", filename).replace(".zim", "")
    # Try OPDS cache for a proper title
    for _ts, _total, items in _opds_cache.values():
        for it in items:
            dl_fn = (it.get("download_url") or "").split("/")[-1]
            if dl_fn == filename:
                return {"title": it.get("title", ""), "name": it.get("name", name)}
    # Fallback: humanize filename
    return {"title": name.replace("_", " ").title(), "name": name}


def _post_download_finalize(dl):
    """Bookkeeping shared by both the HTTP-mirror and BT success paths.

    Removes older versions of the same ZIM, refreshes server caches,
    appends to history. Idempotent — safe if dl['dest'] already exists.
    """
    # Remove older versions of the same ZIM
    base = re.match(r"^(.+?)_\d{4}-\d{2}\.zim$", dl["filename"])
    if base:
        prefix = base.group(1)
        try:
            for f in os.listdir(_srv.ZIM_DIR):
                if (
                    f.startswith(prefix + "_")
                    and f.endswith(".zim")
                    and f != dl["filename"]
                ):
                    try:
                        os.remove(os.path.join(_srv.ZIM_DIR, f))
                        log.info("Removed old version: %s", f)
                    except OSError:
                        pass
        except OSError:
            pass
    with _srv._zim_lock:
        _srv.load_cache(force=True)
    _srv._search_cache_clear()
    _srv._suggest_cache_clear()
    _srv._clean_stale_title_indexes()
    threading.Thread(target=_srv._build_all_qid_indexes, daemon=True).start()
    zim_info = {}
    try:
        for z in _srv._zim_list_cache or []:
            if z.get("file") == dl["filename"]:
                zim_info = {
                    "title": z.get("title", ""),
                    "name": z.get("name", ""),
                    "has_icon": z.get("has_icon", False),
                }
                break
    except Exception as e:
        log.debug("Failed to cache ZIM metadata for download history: %s", e)
    event_type = "updated" if dl.get("is_update") else "download"
    _srv._append_history(
        {
            "event": event_type,
            "ts": time.time(),
            "filename": dl["filename"],
            "size_bytes": dl.get("total_bytes", 0),
            **zim_info,
        }
    )


def _download_thread(dl):
    """Background thread that downloads a file with mirror rotation.

    Tries mirrors in random order for load distribution. On failure, rotates
    to the next mirror. Downloads to a .zim.tmp file first, then atomically
    renames on completion. The .tmp file is preserved across mirror attempts
    so resume works even when switching mirrors.

    On any exit path the queue drains so a waiting download can take this slot.
    """
    tmp_dest = dl["dest"] + ".tmp"
    mirrors = list(dl.get("mirrors", [dl["url"]]))
    # Resolve the metalink mirror list here, off the request thread (a slow
    # or unreachable meta4 fetch must never stall the /manage/download POST).
    meta4 = dl.get("_meta4")
    if meta4:
        try:
            fetched = _fetch_mirrors(meta4)
            for m in fetched:
                if m not in mirrors:
                    mirrors.append(m)
        except Exception as e:
            log.debug("meta4 mirror fetch failed (%s) — using direct URL", e)
    _random.shuffle(mirrors)
    try:
        # BT-first attempt when a backend is configured AND we can find a
        # plausible torrent companion. Falls through to the HTTP mirror loop
        # on any non-success outcome — never strands the user's download.
        from zimi import p2p as _p2p

        try:
            _backend = _p2p.get_backend(data_dir=_srv.ZIMI_DATA_DIR)
        except Exception:
            _backend = None
        _torrent_url = _resolve_torrent_url(dl["url"]) if _backend else None
        if _backend and _torrent_url:
            try:
                _bt_outcome = _try_bt_download(
                    _backend,
                    dl,
                    torrent_url=_torrent_url,
                    staging_dir=_p2p.get_staging_dir(_srv.ZIMI_DATA_DIR),
                )
            except Exception as e:
                log.warning("BT path raised: %s — falling back to HTTP", e)
                _bt_outcome = "fallback"
            if _bt_outcome == "success":
                dl["done"] = True
                log.info("BT download complete: %s", dl["filename"])
                _post_download_finalize(dl)
                return
            if _bt_outcome == "cancelled":
                dl["done"] = True
                dl["error"] = "Cancelled"
                return
            # Otherwise fall through to HTTP — nothing else to do here

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
            _srv._append_history(
                {
                    "event": "download_failed",
                    "ts": time.time(),
                    "filename": dl["filename"],
                    "error": dl["error"],
                    **_title_from_filename(dl["filename"]),
                }
            )
            return
        # Same libzim gate as the BT path: a complete-but-corrupt file must
        # never be installed, whatever transport delivered it. Raising here
        # lands in the non-transient handler below (tmp removed, error set).
        try:
            _srv.open_archive(tmp_dest)
        except Exception as e:
            log.error(
                "Downloaded file failed libzim validation (%s): %s",
                dl["filename"],
                e,
            )
            raise RuntimeError("downloaded file failed validation") from e
        # Atomic rename: tmp → final
        os.replace(tmp_dest, dl["dest"])
        dl["done"] = True  # Mark done immediately so UI shows completion
        log.info(
            "Download complete: %s via %s, refreshing library",
            dl["filename"],
            urlparse(dl.get("_mirror_url", dl["url"])).hostname,
        )
        _post_download_finalize(dl)
        # The BT toggle promises seeding; an HTTP completion (fresh download
        # or BT fallback) must seed too, or niche/updated ZIMs never share.
        _seed_after_http_download(dl)
    except Exception as e:
        is_transient = isinstance(
            e, (urllib.error.URLError, TimeoutError, ConnectionError, OSError)
        )
        if not is_transient:
            try:
                os.remove(tmp_dest)
            except OSError:
                pass
        dl["done"] = True
        log.error(
            "Download thread exception for %s: %s", dl["filename"], e, exc_info=True
        )
        dl["error"] = "Download failed"
        if not dl.get("cancelled"):
            _srv._append_history(
                {
                    "event": "download_failed",
                    "ts": time.time(),
                    "filename": dl["filename"],
                    "error": "Download failed",
                    **_title_from_filename(dl["filename"]),
                }
            )
    finally:
        # Always promote the next queued download into this freed slot.
        with _download_lock:
            _drain_queue()
            _persist_pending_downloads()
        # An installed update leaves the old version's seed pointing at a
        # deleted file — retire it (cheap no-op otherwise).
        if dl.get("is_update") and dl.get("done") and not dl.get("error"):
            try:
                retire_stale_seeds()
            except Exception:
                pass


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


def _validate_zim_filename(filename):
    """Validate a .zim filename for safe use as a download destination.

    Returns (clean_basename, None) or (None, error). Strips any directory
    component so a crafted name can never escape ZIM_DIR.
    """
    filename = os.path.basename(filename or "")
    if not filename or ".." in filename:
        return None, "Invalid filename in URL"
    if not filename.endswith(".zim"):
        return None, "Only .zim files can be downloaded"
    if not re.match(r"^[\w.\-]+$", filename):
        return None, "Invalid characters in filename"
    return filename, None


def _enqueue_zim_download(url, mirrors, filename, size_bytes=None, extra=None):
    """Build the download record and enqueue it.

    Shared by the Kiwix-catalog and LAN-peer paths — each validates its own
    source and filename before calling this. `extra` merges extra fields into
    the download record (e.g. _source/peer_name for peer pulls).
    """
    global _download_counter
    dest = os.path.join(_srv.ZIM_DIR, filename)

    space_err = _refuse_for_disk_space(size_bytes, dest=dest)
    if space_err:
        log.info("download rejected: %s (%s)", space_err, filename)
        return None, space_err

    # Detect if this replaces an existing ZIM (update vs fresh download)
    name_prefix = re.sub(r"_\d{4}-\d{2}\.zim$", "", filename)
    is_update = (
        any(
            f != filename
            and f.endswith(".zim")
            and re.sub(r"_\d{4}-\d{2}\.zim$", "", f) == name_prefix
            for f in os.listdir(_srv.ZIM_DIR)
            if os.path.isfile(os.path.join(_srv.ZIM_DIR, f))
        )
        if os.path.isdir(_srv.ZIM_DIR)
        else False
    )

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
            "size_bytes": size_bytes,
        }
        if extra:
            dl.update(extra)
        queued = _enqueue_or_start(dl)
    log.info(
        "Download %s: %s (%d mirror%s available)",
        "queued" if queued else "started",
        filename,
        len(mirrors),
        "s" if len(mirrors) != 1 else "",
    )
    return dl_id, None


def _start_download(url, size_bytes=None):
    """Start a background download via urllib. Returns (download_id, error).

    If the concurrent-download cap is reached, the download is queued.
    `size_bytes` is used to order the queue smallest-first; pass it from the
    catalog when available. Unknown sizes are dispatched after known ones.
    """
    # Validate URL — only allow Kiwix-controlled hosts (download.kiwix.org,
    # lbo.download.kiwix.org load-balanced origin, dumps.wikimedia.org/kiwix
    # mirror, any other *.kiwix.org). Prevents attacker-controlled metadata.
    # Stale clients and old catalog caches sometimes carry http:// URLs;
    # upgrading the scheme for otherwise-trusted hosts beats rejecting.
    if url and url.startswith("http://"):
        candidate = "https://" + url[len("http://") :]
        if _is_trusted_kiwix_url(candidate):
            url = candidate
    if not _is_trusted_kiwix_url(url):
        # The 400 alone is undebuggable from a syslog (issue #26) — say why.
        log.info("download rejected: untrusted URL %.120r", url)
        return None, "URL not from a trusted Kiwix host"

    # OPDS catalog provides .meta4 metalink URLs. Resolving the mirror list
    # requires a network fetch, which used to run right here in the request
    # thread — five parallel update clicks meant five 15-second stalls
    # (issue #26's "Request timed out" spam). The download thread resolves
    # it instead; the direct URL is always a valid fallback.
    meta4_url = None
    if url.endswith(".meta4"):
        meta4_url = url
        url = url[: -len(".meta4")]

    filename, err = _validate_zim_filename(url.split("/")[-1])
    if err:
        log.info("download rejected: %s (url=%.120r)", err, url)
        return None, err
    return _enqueue_zim_download(
        url,
        [url],
        filename,
        size_bytes=size_bytes,
        extra={"_meta4": meta4_url} if meta4_url else None,
    )


def _start_peer_download(peer_name, filename, size_bytes=None):
    """Download a ZIM directly from a discovered LAN peer over HTTP.

    Gated on the share toggle in BOTH directions — with sharing off the
    user has said "internet sources only", so we don't pull from peers
    either. (The /dl serving side checks the same flag.)

    The target URL is built server-side from the *discovered* peer's
    host/port — never from a client-supplied URL — so this can't be coerced
    into fetching an arbitrary host (the peer equivalent of the Kiwix trust
    check). The pull is plain HTTP from the peer's /dl/ endpoint and works
    fully offline; the existing mirror loop handles range/resume and verifies
    the transfer against the peer's Content-Length.
    """
    from zimi import p2p_discovery as _disc

    filename, err = _validate_zim_filename(filename)
    if err:
        return None, err

    if not _disc.is_share_enabled():
        return None, "LAN sharing is turned off"

    peer = next((p for p in _disc.get_peers() if p.get("name") == peer_name), None)
    if peer is None:
        return None, "Peer not found"
    host, port = peer.get("host"), peer.get("port")
    if not host or not port:
        return None, "Peer address unavailable"
    # mDNS is unauthenticated — a hostile responder could advertise a peer at
    # 169.254.169.254 (cloud metadata), a public host, or a localhost-only
    # service. Only pull from LAN/loopback IP literals (see _is_lan_host).
    if not _is_lan_host(host):
        return None, "Peer host not on LAN"

    # Prefer the size the peer advertises (queue ordering + truncation check).
    if size_bytes is None:
        for z in _disc.fetch_peer_list(peer_name) or []:
            if z.get("file") == filename:
                size_bytes = z.get("size_bytes")
                break

    url = f"http://{host}:{int(port)}/dl/{quote(filename)}"
    return _enqueue_zim_download(
        url,
        [url],
        filename,
        size_bytes=size_bytes,
        extra={"_source": "peer", "peer_name": peer_name},
    )


def _start_import(url, size_bytes=None):
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
    if not re.match(r"^[\w.\-]+$", filename):
        return None, "Invalid characters in filename"
    dest = os.path.join(_srv.ZIM_DIR, filename)

    space_err = _refuse_for_disk_space(size_bytes, dest=dest)
    if space_err:
        log.info("import rejected: %s (%s)", space_err, filename)
        return None, space_err

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
            "size_bytes": size_bytes,
        }
        _enqueue_or_start(dl)
    return dl_id, None


def _get_downloads():
    """Get status of all active/queued/completed downloads.

    Queued items get `queued: True` and zero-progress fields so the UI can
    render them as pending. They keep their position in the list (active
    first, queued after — both sorted by id ascending).
    """
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
            results.append(
                {
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
                    "queued": False,
                    "paused": bool(dl.get("paused", False)),
                    "source": dl.get("_source", "http"),
                    "bt_peers": dl.get("bt_peers", 0),
                }
            )
            # Clean up completed downloads older than 1 hour
            if done and (time.time() - dl["started"]) > 3600:
                to_remove.append(dl_id)
        for dl in _download_queue:
            results.append(
                {
                    "id": dl["id"],
                    "filename": dl["filename"],
                    "url": dl["url"],
                    "mirror_host": "",
                    "mirror_count": len(dl.get("mirrors", [])),
                    "size_bytes": 0,
                    "total_bytes": dl.get("size_bytes") or 0,
                    "downloaded_bytes": 0,
                    "percent": 0,
                    "done": False,
                    "error": None,
                    "elapsed": round(time.time() - dl["started"], 1),
                    "is_update": dl.get("is_update", False),
                    "queued": True,
                }
            )
        for dl_id in to_remove:
            del _active_downloads[dl_id]
    return results
