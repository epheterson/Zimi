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

    We also accept the 100.64.0.0/10 CGNAT/overlay range (Tailscale, ZeroTier)
    under the same trust knob as the inbound gate (_is_trusted_net in http.py,
    ZIMI_TRUST_CGNAT): a tailnet peer that Zimi already trusts for
    management must be pullable too, or LAN peer-sharing silently breaks over
    the tailnet. Reusing http's CGNAT_NET + flag (read through the module so
    ZIMI_TRUST_CGNAT / test monkeypatching is honored live, and lazily to avoid
    an import cycle) keeps the outbound pull gate and inbound trust tier
    symmetric. Note this stays stricter than _is_trusted_net, which accepts
    link-local — the SSRF metadata block above must hold on the pull side.
    """
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.is_link_local:
        return False
    if ip.is_private or ip.is_loopback:
        return True
    from zimi import http as _http

    return _http._TRUST_CGNAT and ip in _http.CGNAT_NET


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
        with open(config_path, encoding="utf-8") as f:
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
    torrent URL; the .torrent file itself, when a copy was left in staging,
    is preserved under ZIMI_DATA_DIR/bt/torrents/."""
    manifest_path = _torrents_manifest_path()
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    try:
        with open(manifest_path, encoding="utf-8") as f:
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
    # Preserve any .torrent file left in staging (staging/<name>.torrent)
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
        with open(_torrents_manifest_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


# ── Seed intent ledger ──
# The old sidecar's session resume proved lossy: a restart could silently
# drop a live seed (the session stored a .torrent URL and trusted the sidecar
# to re-materialize it — observed failing in production with no error logged).
# libtorrent's fastresume is sturdier, but Zimi therefore still
# keeps its OWN record of which files it intends to seed, and re-adds any
# that are missing after startup. Intent is added when a seed is created and
# removed by every deliberate stop (policy stop, mirror off, user stop,
# retire of a deleted file) — so a restart can never lose a seed, and a stop
# is never resurrected.


# One coarse lock around every ledger read->mutate->write. Writers live on
# the startup thread, the 30s accounting daemon, settings-change threads,
# the stop-action handler, download completions, and the atexit flush —
# unserialized, two of them doing load/modify/save would silently drop each
# other's updates (a recorded intent vanishing is precisely the failure the
# ledger exists to prevent). Cadence is seconds-scale, so contention is nil.
_seed_ledger_lock = threading.Lock()


def _seed_ledger_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "bt", "seeds.json")


def _seed_ledger():
    try:
        with open(_seed_ledger_path(), encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def record_seed(filename, origin="download"):
    """Note that Zimi intends `filename` to be seeding.

    origin distinguishes mirror-sync seeds from personal post-download
    seeds, so Mirror-off can stop exactly the seeds Mirror created. The
    entry also accumulates uploaded bytes across sessions — Zimi enforces
    the ratio cap itself in the ledger (see apply_seed_policy), the sole
    cap authority now that seeds run uncapped at the engine layer."""
    try:
        with _seed_ledger_lock:
            ledger = _seed_ledger()
            if filename not in ledger:
                ledger[filename] = {
                    "added": time.time(),
                    "origin": origin,
                    "uploaded": 0,
                }
                os.makedirs(os.path.dirname(_seed_ledger_path()), exist_ok=True)
                _srv._atomic_write_json(_seed_ledger_path(), ledger)
    except Exception as e:
        log.debug("seed ledger record failed for %s: %s", filename, e)


def seed_ledger_snapshot():
    """Read-only copy of the seed intent ledger: {filename: entry}. Entries
    carry cumulative cross-session upload in ``uploaded`` and ``origin``
    (``mirror``|``download``). Used by /manage/seeding to show lifetime
    uploaded bytes rather than just this session's."""
    with _seed_ledger_lock:
        return {k: dict(v) for k, v in _seed_ledger().items()}


def unrecord_seed(filename):
    """A deliberate stop: this file should NOT come back at startup."""
    try:
        with _seed_ledger_lock:
            ledger = _seed_ledger()
            if filename in ledger:
                del ledger[filename]
                _srv._atomic_write_json(_seed_ledger_path(), ledger)
    except Exception as e:
        log.debug("seed ledger unrecord failed for %s: %s", filename, e)


def reseed_from_ledger():
    """Re-add any intended seed that isn't live — run after startup.

    Sources resolve exactly like _seed_after_http_download: the preserved
    local .torrent first, then the recorded URL. Entries whose ZIM is gone
    are dropped (the delete already happened; intent follows the file).
    Returns how many seeds were re-added."""
    from zimi import p2p as _p2p

    backend = _p2p.peek_backend()
    if backend is None:
        return 0
    if not _p2p.is_seeding_enabled():
        return 0
    mirror = _p2p.is_mirror_enabled()
    cap = _p2p.get_seed_ratio_cap()
    if not mirror and cap <= 0:
        return 0
    ledger = _seed_ledger()
    if not ledger:
        return 0
    try:
        managed = set()
        for raw in backend.list_managed():
            for f in raw.get("files", []):
                if f.get("path"):
                    managed.add(os.path.basename(f["path"]))
    except Exception:
        return 0
    meta_all = _get_torrent_metadata()
    readded = 0
    for filename in list(ledger):
        if filename in managed:
            continue
        if not os.path.exists(os.path.join(_srv.ZIM_DIR, filename)):
            unrecord_seed(filename)
            continue
        meta = meta_all.get(filename) or {}
        source = meta.get("torrent_file")
        if not (source and os.path.isfile(source)):
            source = meta.get("torrent_url")
        if not source:
            log.debug("reseed: no torrent source recorded for %s", filename)
            continue
        try:
            # Verify the file we already have, then seed — never fetch.
            # That's libtorrent's native behavior when save_path points at
            # the existing file; Zimi enforces the ratio cap in the ledger.
            backend.add_torrent(source, dest_dir=_srv.ZIM_DIR, options=None)
            readded += 1
        except Exception as e:
            log.debug("reseed of %s failed: %s", filename, e)
    if readded:
        log.info("Restored %d seed(s) from the intent ledger", readded)
    return readded


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
        with open(path, encoding="utf-8") as f:
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
                with open(path, encoding="utf-8") as f:
                    current = json.load(f).get("pending", [])
            except (OSError, ValueError):
                current = []
            have = {c.get("filename") for c in current}
            current.extend(k for k in kept if k.get("filename") not in have)
            _srv._atomic_write_json(path, {"pending": current})
    if resumed:
        log.info("Resumed %d pending download(s) from the previous run", resumed)
    return resumed


def _pending_download_filenames():
    """Filenames recorded in downloads.json — these resume on next start, so
    their partials are still wanted even before the resume actually fires."""
    try:
        with open(_pending_downloads_path(), encoding="utf-8") as f:
            return {
                it.get("filename")
                for it in json.load(f).get("pending", [])
                if it.get("filename")
            }
    except (OSError, ValueError):
        return set()


def classify_partials():
    """Split ZIM_DIR's ``*.zim.tmp`` partials into ``(protected, orphaned)``.

    Protection is *state-based*, never based on a file's age or size: a partial
    ``<name>.zim.tmp`` is protected only when a download record still wants it —
    an entry in the active table (including a failed-but-retryable one that the
    UI still shows a Retry button for; Retry resumes it from the partial via
    Range), a queued entry, or a pending entry that resumes on next start. A
    cancelled download is not protected — its partial was already removed. A
    bare ``.zim.tmp`` with no matching download record is *orphaned* — the only
    thing cleanup targets — regardless of how recent it is. Each list holds
    ``{filename, size_bytes, age_hours}`` dicts.
    """
    with _download_lock:
        # Include done-with-error entries: those are the "Download failed /
        # Retry" state, still tracked and resumable, so their partials stay
        # wanted. Only a cancelled download disowns its partial.
        wanted = {
            d["filename"]
            for d in _active_downloads.values()
            if not d.get("cancelled") and d.get("filename")
        }
        wanted |= {q["filename"] for q in _download_queue if q.get("filename")}
    wanted |= _pending_download_filenames()

    protected, orphaned = [], []
    try:
        names = os.listdir(_srv.ZIM_DIR)
    except OSError:
        return protected, orphaned
    now = time.time()
    for f in names:
        if not f.endswith(".zim.tmp"):
            continue
        fpath = os.path.join(_srv.ZIM_DIR, f)
        try:
            size = os.path.getsize(fpath)
            age_hours = (now - os.path.getmtime(fpath)) / 3600
        except OSError:
            continue
        info = {"filename": f, "size_bytes": size, "age_hours": round(age_hours, 1)}
        base = f[: -len(".tmp")]  # "<name>.zim.tmp" → "<name>.zim"
        if base in wanted:
            protected.append(info)
        else:
            orphaned.append(info)
    return protected, orphaned


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


def _switch_to_direct(dl_id):
    """Abandon the BitTorrent transfer for an active download and pull it
    over HTTP instead. Returns (status, code).

    status: "switching" | "not_found" | "already_done" | "not_bt"

    Cooperative, like _cancel_download: sets a flag the BT poll loop observes
    and then bails to the HTTP mirror loop. A no-op for downloads that aren't
    currently on the BT transport.
    """
    with _download_lock:
        dl = _active_downloads.get(dl_id)
        if not dl:
            return "not_found", 404
        if dl.get("done"):
            return "already_done", 400
        if dl.get("_source") != "bt":
            return "not_bt", 400
        dl["switch_direct"] = True
    return "switching", 200


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

# Stale-while-revalidate: cache keys with a background refresh in flight, so
# concurrent requests for the same stale page share one Kiwix round trip
# instead of stampeding it. `_OPDS_BG_REFRESH` is a test seam — set False to
# keep the stale-serve path fully synchronous (no threads spawned).
_opds_refreshing = set()
_OPDS_BG_REFRESH = True


def _catalog_cache_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "catalog_cache.json")


def _load_opds_disk_cache():
    """Merge the persisted catalog into the in-memory cache once."""
    global _opds_disk_loaded
    if _opds_disk_loaded:
        return
    _opds_disk_loaded = True
    try:
        with open(_catalog_cache_path(), encoding="utf-8") as f:
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
        with open(meta_path, encoding="utf-8") as f:
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
        with open(meta_path, "w", encoding="utf-8") as f:
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


def _kick_catalog_refresh(query, lang, count, start):
    """Spawn at most one background thread per cache key to revalidate a stale
    catalog page against Kiwix. Concurrent callers hitting the same stale page
    share the single in-flight refresh — no thundering herd on Kiwix. No-op
    when background refresh is disabled."""
    if not _OPDS_BG_REFRESH:
        return
    cache_key = f"{query}|{lang}|{count}|{start}"
    with _opds_lock:
        if cache_key in _opds_refreshing:
            return
        _opds_refreshing.add(cache_key)

    def _run():
        try:
            _fetch_kiwix_catalog(query, lang, count, start, _background=True)
        except Exception as e:
            log.debug("background catalog refresh failed: %s", e)
        finally:
            with _opds_lock:
                _opds_refreshing.discard(cache_key)

    threading.Thread(target=_run, name="catalog-refresh", daemon=True).start()


def _fetch_kiwix_catalog(query="", lang="eng", count=20, start=0, _background=False):
    """Fetch and parse the Kiwix OPDS catalog. Returns (total, items, error).
    Results are cached server-side (24h TTL) to avoid hammering Kiwix.

    Stale-while-revalidate: when a cached copy exists but has expired, the
    stale copy is returned *immediately* (marked stale for the client) and a
    single background thread revalidates it against Kiwix, so the catalog UI
    never blocks on a NAS→Kiwix round trip. A cold cache (no copy at all) still
    fetches synchronously. Background refreshes pass `_background=True` to skip
    the stale-serve shortcut and actually hit the network."""
    global _catalog_stale_ts
    _load_opds_disk_cache()
    cache_key = f"{query}|{lang}|{count}|{start}"
    serve_stale = None
    with _opds_lock:
        cached = _opds_cache.get(cache_key)
        if cached:
            ts, total, items = cached
            if time.time() - ts < _OPDS_CACHE_TTL:
                _catalog_stale_ts = None
                return total, items, None
            # Expired but present. Foreground callers get it instantly
            # (stale-while-revalidate); a background refresh falls through to
            # actually re-fetch. Expired entries are kept as the offline
            # fallback — deleted only once a fresh fetch replaces them.
            if not _background:
                _catalog_stale_ts = ts
                serve_stale = (total, items)
        # Cap: evict only one-off search keys. Browse pages are the
        # offline catalog and must survive any amount of searching.
        if len(_opds_cache) > 100:
            for k in [k for k in _opds_cache if not _is_browse_key(k)]:
                del _opds_cache[k]

    if serve_stale is not None:
        # Hand back the stale copy now; revalidate in the background.
        _kick_catalog_refresh(query, lang, count, start)
        return serve_stale[0], serve_stale[1], None

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
    file. The engine hash-checks the existing file and seeds without
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
            # Verify the existing file, then seed it — never fetch. That's
            # libtorrent's native behavior when save_path points at the
            # installed file; mirrors seed without a cap.
            backend.add_torrent(source, dest_dir=_srv.ZIM_DIR, options=None)
            added += 1
            record_seed(filename, origin="mirror")
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

    # Full catalog, all pages (English slice, as before).
    urls = {}
    catalog = _full_catalog("eng")
    if not catalog:
        _catalog_torrents_archived = False  # retry next run
        return 0
    for it in catalog:
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


def apply_seed_policy():
    """Make the CURRENT seed settings govern every live library seed — and
    enforce the ratio cap in the ledger, the sole cap authority.

    Seeds run uncapped at the engine layer (a re-seed's engine-side ratio
    would measure upload against THIS SESSION's download, which is zero
    for a hash-checked library file — so any positive engine cap stopped
    the seed the moment a real peer took a piece). This function — at
    startup, on settings changes, and every maintenance pass — does the
    honest bookkeeping instead:

    - adopts live library seeds the ledger doesn't know (pre-ledger
      installs) so they gain intent + accounting;
    - accumulates uploaded bytes per file across sessions in the ledger;
    - stops seeds once cumulative upload >= cap x file size (unless
      Mirror is on — mirrors seed without a cap), removing their intent;
    - with seeding off entirely, stops all library seeds (files stay).

    Returns how many seeds were updated or stopped."""
    from zimi import p2p as _p2p

    backend = _p2p.peek_backend()
    if backend is None:
        return 0
    mirror = _p2p.is_mirror_enabled()
    cap = _p2p.get_seed_ratio_cap()
    seeding = _p2p.is_seeding_enabled() and (mirror or cap > 0)
    try:
        entries = backend.list_managed()
    except Exception:
        return 0
    zim_root = os.path.normpath(_srv.ZIM_DIR)
    with _seed_ledger_lock:
        ledger = _seed_ledger()
        ledger_dirty = False
        changed = 0
        for raw in entries:
            if raw.get("status") not in (None, "active", "waiting", "paused"):
                continue
            for f in raw.get("files", []):
                path = f.get("path", "")
                if not path or os.path.normpath(os.path.dirname(path)) != zim_root:
                    continue
                if not path.endswith(".zim"):
                    continue
                gid = raw.get("gid", "")
                fname = os.path.basename(path)
                try:
                    if not seeding:
                        backend.remove(gid, delete_files=True)
                        if fname in ledger:
                            del ledger[fname]
                            ledger_dirty = True
                        changed += 1
                        break

                    # Adopt seeds the ledger doesn't know, then account upload.
                    entry = ledger.get(fname)
                    if entry is None:
                        entry = {
                            "added": time.time(),
                            "origin": "mirror" if mirror else "download",
                            "uploaded": 0,
                        }
                        ledger[fname] = entry
                        ledger_dirty = True
                    up_now = int(raw.get("uploadLength", 0) or 0)
                    total = int(raw.get("totalLength", 0) or 0)
                    if entry.get("last_gid") == gid:
                        delta = up_now - int(entry.get("last_up", 0) or 0)
                    else:
                        delta = up_now  # new engine session for this file
                    if delta > 0:
                        entry["uploaded"] = int(entry.get("uploaded", 0) or 0) + delta
                        ledger_dirty = True
                    if entry.get("last_gid") != gid or entry.get("last_up") != up_now:
                        entry["last_gid"] = gid
                        entry["last_up"] = up_now
                        ledger_dirty = True

                    # The cap, in bytes uploaded over the file's lifetime.
                    if not mirror and total > 0 and entry["uploaded"] >= cap * total:
                        backend.remove(gid, delete_files=True)
                        del ledger[fname]
                        ledger_dirty = True
                        changed += 1
                        log.info(
                            "Seed cap reached for %s (%.1fx of %d bytes) — stopped",
                            fname,
                            entry["uploaded"] / total,
                            total,
                        )
                except Exception:
                    pass
                break
        if ledger_dirty:
            try:
                os.makedirs(os.path.dirname(_seed_ledger_path()), exist_ok=True)
                _srv._atomic_write_json(_seed_ledger_path(), ledger)
            except Exception as e:
                log.debug("seed ledger save failed: %s", e)
    if changed:
        log.info(
            "Seed policy pass: %d seed(s) %s",
            changed,
            "stopped" if not seeding else "updated/stopped",
        )
    return changed


# Upload accounting cadence. The engine only counts upload per session, so
# the ledger must sample often to stay truthful: a 12h-only sample lost up to
# 12h of upload at every restart (undercount -> the cap overshoots). At 30s
# the books are near-continuous, cap enforcement reacts within half a
# minute, and a clean shutdown flushes the tail — worst case after a power
# cut is ~30s of unaccounted upload.
_SEED_ACCOUNTING_INTERVAL = 30.0


def seed_accounting_loop():
    """Daemon loop: account upload + enforce the cap every 30s."""
    while True:
        time.sleep(_SEED_ACCOUNTING_INTERVAL)
        try:
            apply_seed_policy()
        except Exception as e:
            log.debug("seed accounting tick failed: %s", e)


def flush_seed_accounting():
    """Final accounting pass before the engine goes down, so a clean
    shutdown loses none of the session's upload. Skips straight out when
    the engine is already dead."""
    from zimi import p2p as _p2p

    backend = _p2p.peek_backend()
    if backend is None or not backend.is_alive():
        return
    try:
        apply_seed_policy()
    except Exception:
        pass


def stop_mirror_seeds():
    """Mirror off: stop the MIRROR seeds, keep everything else.

    Seeds are told apart by their recorded ledger origin, not by any
    engine-side option (every seed runs uncapped now). Regular
    ratio-capped seeding continues untouched, and the ZIMs + torrent
    archive stay on disk — flipping Mirror back on re-seeds instantly.
    Turning a toggle off never deletes a backup."""
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
    # Every seed runs uncapped now (Zimi enforces caps in the ledger), so
    # the old "uncapped = mirror" option test can't discriminate. The
    # ledger's recorded origin can: stop what Mirror created, keep personal.
    ledger = _seed_ledger()
    for raw in entries:
        for f in raw.get("files", []):
            path = f.get("path", "")
            if path and os.path.normpath(os.path.dirname(path)) == zim_root:
                fname = os.path.basename(path)
                if ledger.get(fname, {}).get("origin") == "mirror":
                    try:
                        backend.remove(raw.get("gid", ""), delete_files=True)
                        removed += 1
                        unrecord_seed(fname)
                    except Exception:
                        pass
                break
    if removed:
        log.info("Mirror off: stopped %d mirror seed(s); archive kept", removed)
    return removed


def retire_stale_seeds():
    """Drop sidecar torrents whose library file is gone — an update
    replaced it, or the user deleted the ZIM. Without this, the engine keeps
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
                    unrecord_seed(os.path.basename(path))
                    log.info("Retired stale seed: %s", os.path.basename(path))
                except Exception:
                    pass
                break
    return removed


def _find_previous_version(filename):
    """Return the newest already-installed version of the same ZIM as
    `filename` (matching base name, different date stamp), or None.

    Uses the same base-name derivation as the update detector in
    _enqueue_zim_download so "is an update" and "which old file to reuse"
    can never disagree. Date-stamped names sort lexically by date, so the
    max is the most recent — the best delta source (closest content).
    """
    name_prefix = re.sub(r"_\d{4}-\d{2}\.zim$", "", filename)
    if name_prefix == filename or not os.path.isdir(_srv.ZIM_DIR):
        return None  # not a date-stamped name → no versioned predecessor
    candidates = [
        f
        for f in os.listdir(_srv.ZIM_DIR)
        if f != filename
        and f.endswith(".zim")
        and re.sub(r"_\d{4}-\d{2}\.zim$", "", f) == name_prefix
        and os.path.isfile(os.path.join(_srv.ZIM_DIR, f))
    ]
    return max(candidates) if candidates else None


def _prepare_delta_staging(dl, staging_dir):
    """Delta update via BitTorrent piece reuse.

    When updating a ZIM, copy the previous version into the staging dir under
    the NEW filename before the torrent is added. libtorrent then hash-checks
    that pre-seeded file and salvages every piece the two versions share —
    Wikipedia monthlies overlap heavily, so only the changed pieces download.
    Zero new infra: the honest-seeding path already relies on libtorrent
    hash-checking an existing file, so this just points that mechanism at the
    old version.

    Fail-soft by construction: not an update, no predecessor, no disk space,
    an existing staging partial (a resume — never clobber it), or any copy
    error all leave staging untouched, and the caller does a normal full
    download. Sets dl['delta_from'] only when a copy actually happened.
    """
    if not dl.get("is_update"):
        return
    old = _find_previous_version(dl["filename"])
    if not old:
        return
    staged = os.path.join(staging_dir, dl["filename"])
    if os.path.exists(staged):
        return  # a resume already has staged data — don't overwrite it
    old_path = os.path.join(_srv.ZIM_DIR, old)
    try:
        old_size = os.path.getsize(old_path)
    except OSError:
        return
    # A delta copy needs room for a full second copy of the old file in
    # staging (staging may sit on a different filesystem than ZIM_DIR, so
    # measure the staging target, not ZIM_DIR).
    try:
        os.makedirs(staging_dir, exist_ok=True)
        free = shutil.disk_usage(staging_dir).free
    except OSError:
        return
    if free < old_size + _DISK_FLOOR_BYTES:
        log.info(
            "delta-update: not enough staging space to pre-seed %s from %s "
            "(%s free, %s needed) — full download",
            dl["filename"],
            old,
            _fmt_gb(free),
            _fmt_gb(old_size + _DISK_FLOOR_BYTES),
        )
        return
    try:
        # v1: plain copy. A reflink (cp --reflink / clonefile) would make this
        # near-instant and space-free on APFS/btrfs, but shutil.copyfile is
        # portable and correct; reflink is a later optimization.
        shutil.copyfile(old_path, staged)
    except Exception as e:
        log.info(
            "delta-update: pre-seed copy of %s failed (%s) — full download",
            dl["filename"],
            e,
        )
        try:
            os.remove(staged)
        except OSError:
            pass
        return
    dl["delta_from"] = old
    log.info(
        "delta-update: pre-seeded staging for %s from %s (%s) — libtorrent "
        "will salvage unchanged pieces",
        dl["filename"],
        old,
        _fmt_gb(old_size),
    )


def _try_bt_download(
    backend,
    dl,
    *,
    torrent_url,
    staging_dir,
    poll_interval=2.0,
    no_peers_timeout=60.0,
    no_progress_timeout=180.0,
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

    # Delta update: seed the staging file from the previous version so the
    # hash check below salvages every unchanged piece. Fail-soft — a no-op on
    # anything but a genuine update with room to copy.
    try:
        _prepare_delta_staging(dl, staging_dir)
    except Exception as e:
        log.debug("delta-update pre-seed skipped for %s: %s", dl["filename"], e)

    # Seeding after completion is handled below (re-add against the library
    # path); the download itself needs no per-torrent options — the global
    # rate caps govern bandwidth and the ledger governs the ratio cap.
    try:
        tid = backend.add_torrent(torrent_url, dest_dir=staging_dir, options=None)
    except Exception as e:
        log.warning(
            "BT add_torrent failed for %s: %s — falling back to HTTP", dl["filename"], e
        )
        return "fallback"

    started = time.time()
    was_paused = False
    last_bytes = 0
    last_progress_t = started
    while True:
        if dl.get("cancelled"):
            try:
                backend.remove(tid, delete_files=True)
            except Exception:
                pass
            return "cancelled"

        # User bailed on the swarm — hand off to the HTTP mirror loop. The
        # BT partial lives in the staging dir and can't feed the HTTP resume,
        # so drop it; the caller re-downloads over HTTP into its own .tmp.
        if dl.get("switch_direct"):
            try:
                backend.remove(tid, delete_files=True)
            except Exception:
                pass
            log.info(
                "Switch-to-direct requested for %s — falling back to HTTP",
                dl["filename"],
            )
            return "fallback"

        # Propagate UI pause/resume to the engine — without this, "paused" is a
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

        # Surface progress to the existing UI.
        dl["downloaded_bytes"] = status.get("completed_bytes", 0)
        dl["total_bytes"] = status.get("total_bytes", 0)
        dl["bt_peers"] = status.get("peers", 0)
        dl["bt_info_hash"] = status.get("info_hash", "")
        dl["_source"] = "bt"

        # Delta salvage: once the hash check finishes, completed_bytes is the
        # fraction libtorrent reused from the pre-seeded old version. Snapshot
        # it once so the UI can show "reused N GB from the previous version".
        if (
            dl.get("delta_from")
            and "reused_bytes" not in dl
            and not status.get("checking")
        ):
            dl["reused_bytes"] = status.get("completed_bytes", 0)
            _total = status.get("total_bytes", 0) or 1
            log.info(
                "delta-update: hash check salvaged %s (%.1f%%) for %s from %s",
                _fmt_gb(dl["reused_bytes"]),
                100.0 * dl["reused_bytes"] / _total,
                dl["filename"],
                dl["delta_from"],
            )

        state = status.get("state")
        if state == "complete":
            staged = os.path.join(staging_dir, dl["filename"])
            if not os.path.exists(staged):
                log.warning(
                    "BT reported complete but staged file missing: %s"
                    " — falling back",
                    staged,
                )
                try:
                    backend.remove(tid, delete_files=True)
                except Exception:
                    pass
                return "fallback"
            # Never install a structurally invalid file. Existence and size
            # prove nothing on their own — the corrupt-ZIM class of bug (the
            # old two-phase metadata GID) installed full-size garbage ZIMs
            # before release, so libzim must validate the file first.
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
            # No re-hash needed: libtorrent seeds the existing file when
            # save_path points at it, and libzim just validated it.
            _cap = _p2p.get_seed_ratio_cap()
            # Zimi's "ratio 0" means never seed; the engine seeds without a
            # cap and the ledger enforces the user's. Only mirror mode or a
            # positive cap re-adds the library seed.
            if _p2p.is_seeding_enabled() and (_cap > 0 or _p2p.is_mirror_enabled()):
                # Remove the staging torrent FIRST. It still holds this
                # info-hash as an active seeder (now pointing at the moved-away
                # staging path), so adding the library-path torrent before
                # removing it makes the engine reject the add as a duplicate
                # info-hash — the seed was silently never created and the
                # staging torrent snagged "file missing". Remove-then-add.
                try:
                    backend.remove(tid, delete_files=True)
                except Exception as e:
                    log.debug("pre-reseed staging remove failed: %s", e)
                try:
                    _meta = _get_torrent_metadata().get(dl["filename"]) or {}
                    _src = _meta.get("torrent_file") or torrent_url
                    # No per-torrent options: the engine seeds the existing
                    # file uncapped and Zimi enforces the user's cap in
                    # apply_seed_policy (a positive engine cap would measure
                    # this session's DOWNLOAD — zero for a re-seed — and kill
                    # the seed on its first uploaded piece).
                    seed_gid = backend.add_torrent(
                        _src,
                        dest_dir=os.path.dirname(dl["dest"]),
                        options=None,
                    )
                    if seed_gid:
                        tid = seed_gid  # track the library seed, not staging
                        record_seed(dl["filename"])
                except Exception as e:
                    log.debug("library re-seed failed (%s): %s", dl["filename"], e)
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

        # Stall detection. Track byte progress so a swarm that connects but
        # never sends data can't hang forever.
        now_t = time.time()
        elapsed = now_t - started
        cb = status.get("completed_bytes", 0)
        total = status.get("total_bytes", 0) or 1
        pct = cb / total
        if was_paused:
            last_progress_t = now_t  # don't count paused time toward a stall
        elif cb > last_bytes:
            last_bytes = cb
            last_progress_t = now_t

        # (a) 0 peers AND <1% progress past the no-peers timeout.
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

        # (b) Peers present but no bytes for no_progress_timeout — a choked or
        # seedless-but-peered swarm dodges the 0-peers check above and would
        # otherwise loop forever showing an honest-looking "0% · 0.0 MB/s".
        if (
            not was_paused
            and pct < 0.999
            and (now_t - last_progress_t) >= no_progress_timeout
        ):
            log.info(
                "BT made no progress for %s in %.0fs (%.1f%%, %d peers) — "
                "falling back",
                dl["filename"],
                now_t - last_progress_t,
                pct * 100,
                status.get("peers", 0),
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
    # Zimi's ratio 0 means "never seed" (the engine itself seeds uncapped).
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
    try:
        # No per-torrent options: libtorrent verifies then seeds the file we
        # already have when save_path points at it — never fetches. Zimi
        # enforces the user's cap in the ledger (a positive engine cap would
        # count this session's download = 0 and stop the seed immediately).
        backend.add_torrent(source, dest_dir=_srv.ZIM_DIR, options=None)
        record_seed(dl["filename"])
        log.info(
            "Seeding HTTP-downloaded %s (cap %sx, Zimi-enforced)",
            dl["filename"],
            _p2p.get_seed_ratio_cap(),
        )
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


# Bound on simultaneous Kiwix round trips when a cold _full_catalog() has to
# fetch every page itself. The real catalog has grown past 3,600 entries (8
# pages at count=500) since the ~1,072-entry / 3-page figure the cache-reuse
# fix was measured against — fetching pages one at a time (~2s/page against
# the real Kiwix OPDS endpoint) turned a warm-cache non-issue back into a
# 15s+ "Loading..." on every cold check.
_FULL_CATALOG_MAX_PARALLEL = 6
# Page size for the full-catalog fan-out. The request count and the offset
# stride must stay the same number: if they diverge the pages either overlap or
# leave gaps, and a gap means installed ZIMs silently never get offered an
# update.
_FULL_CATALOG_PAGE_SIZE = 500

# Hard ceiling on the concurrent page-fetch phase. Every page fetch already
# carries its own socket timeout, but a connection whose timeout never fires
# (observed only inside the frozen desktop app) would otherwise wedge a worker
# thread and block the join forever — the "check for updates" flow that never
# finishes. Past this deadline we return whatever pages completed; the workers
# are daemon threads, so an abandoned one can't hold up the process.
_FULL_CATALOG_TOTAL_TIMEOUT = 90.0


def _full_catalog(lang=""):
    """Every catalog entry across all pages, served from the SWR cache when warm.

    Defaults to the SAME (query, lang, count) the browse UI warms — empty lang,
    count 500 — so a manual update check reuses the already-cached catalog and
    makes ZERO network round trips on the common path (the browse view, or a
    prior check, has populated the cache). A warm cache still resolves every
    page from the in-memory dict, so the concurrency below only matters when
    genuinely cold.

    Empty lang (not "eng") also matters for correctness: an eng-filtered catalog
    omits non-English installs (wikipedia_de, wikipedia_he, ...), which would
    then silently never be offered an update. Callers that deliberately want the
    English slice pass lang="eng".

    Pages after the first are fetched concurrently (bounded by
    _FULL_CATALOG_MAX_PARALLEL in-flight requests), not one-at-a-time — on a
    cold cache this turns N sequential Kiwix round trips into ~N/parallelism,
    matching how the browse UI's client-side fetch already parallelizes pages
    (see _fetchCatalogItems in app.js). A page that errors is simply omitted
    rather than truncating the rest of an otherwise-successful fetch.
    """
    total, items, err = _fetch_kiwix_catalog(
        query="", lang=lang, count=_FULL_CATALOG_PAGE_SIZE, start=0
    )
    if err:
        return []
    all_items = list(items or [])
    starts = list(range(len(all_items), total, _FULL_CATALOG_PAGE_SIZE))
    if not starts:
        return all_items

    pages = {}
    sem = threading.Semaphore(_FULL_CATALOG_MAX_PARALLEL)

    def _fetch_page(start):
        try:
            with sem:
                _t, more, page_err = _fetch_kiwix_catalog(
                    query="", lang=lang, count=_FULL_CATALOG_PAGE_SIZE, start=start
                )
            pages[start] = None if page_err else (more or None)
        except Exception as e:
            # A page that raises is a failed page, not a crashed worker: record
            # the miss and let the rest of the fetch complete.
            log.debug("catalog page fetch raised (start=%d): %s", start, e)
            pages[start] = None

    threads = [
        threading.Thread(target=_fetch_page, args=(start,), daemon=True)
        for start in starts
    ]
    for th in threads:
        th.start()
    # Bounded join: never wait past the overall deadline, so a single wedged
    # page fetch can't hang the whole update check. Threads still running at
    # the deadline are abandoned (daemon) and their pages simply omitted.
    deadline = time.monotonic() + _FULL_CATALOG_TOTAL_TIMEOUT
    for th in threads:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        th.join(timeout=remaining)

    for start in starts:
        page = pages.get(start)
        if page:
            all_items.extend(page)
    return all_items


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

    # Full catalog across all pages — reuses the browse UI's warm SWR cache
    # (empty lang, count 500), so the common path makes no extra Kiwix requests.
    all_items = _full_catalog()
    if not all_items:
        return []

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
        # Resume sanity: the partial on disk was written toward a known total.
        # If this mirror reports a different total, the remote file changed (or
        # the mirror serves a different build) and appending would splice two
        # files into a corrupt ZIM. Discard the partial and restart this mirror
        # clean rather than resume onto a mismatched file.
        expected = dl.get("size_bytes") or 0
        if expected and total and total != expected:
            resp.close()
            log.warning(
                "Resume size mismatch for %s (partial expected %d, %s has %d) "
                "— discarding partial and restarting clean",
                dl["filename"],
                expected,
                urlparse(url).hostname,
                total,
            )
            try:
                os.remove(tmp_dest)
            except OSError as e:
                # The retry below only works because the partial is gone — with
                # it still on disk we would send Range again, get the same
                # mismatched 206, and recurse until the stack blew.
                log.error("Cannot remove stale partial %s: %s", tmp_dest, e)
                return False, "could not discard mismatched partial download"
            # Re-enter with no partial present → plain GET (200/wb) from zero.
            return _download_from_url(dl, url, tmp_dest)
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
            # Otherwise fall through to HTTP — nothing else to do here.
            # A BT attempt left _source="bt" and stale peer counts on the dl;
            # reset them so the UI reflects the HTTP transport it's now on
            # (matters most for a user-triggered switch-to-direct).
            dl["_source"] = "http"
            dl["bt_peers"] = 0
            dl["switch_direct"] = False

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
                    "switching_direct": bool(dl.get("switch_direct", False)),
                    "reused_bytes": dl.get("reused_bytes", 0),
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
