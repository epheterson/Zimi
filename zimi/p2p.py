"""BitTorrent backend abstraction + bundled aria2c sidecar.

Two backends share the same interface:

  BTBackend (abstract)
    Aria2Backend       — bundled aria2c subprocess via JSON-RPC
    QBittorrentBackend — talks to an existing qBittorrent instance
    TransmissionBackend, DelugeBackend — TBD, same interface

Selected via ZIMI_BT_BACKEND env var; default 'aria2'. BT-first
downloads are ON by default so the install base shares distribution
load with the Kiwix mirrors; ZIMI_TORRENT=0 opts out entirely.

Smart defaults: if aria2c isn't on PATH, we log + skip silently rather
than crashing. The HTTP path keeps working unchanged.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from typing import Any

log = logging.getLogger(__name__)


# ============================================================================
# Configuration knobs
# ============================================================================

DEFAULT_BT_PORT = 6881
DEFAULT_RATIO_CAP = 2.0
DEFAULT_SEED_BANDWIDTH_KB = 2048  # 2 MB/s


def _bool_env(key: str, default: bool = False) -> bool:
    raw = os.environ.get(key, "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


# ============================================================================
# Persisted UI preferences (seed/mirror toggles). An explicitly-set env var
# wins and locks the UI control — same pattern as ZIMI_AUTO_UPDATE — so
# operators who configure via environment keep infra-as-config semantics.
# ============================================================================

_prefs_path: str | None = None
_prefs_lock = threading.Lock()


def set_prefs_path(path: str) -> None:
    """Called once at server startup with a writable prefs file location."""
    global _prefs_path
    _prefs_path = path


def _read_pref(key: str, default):
    if not _prefs_path:
        return default
    try:
        with open(_prefs_path) as f:
            return json.load(f).get(key, default)
    except (OSError, ValueError):
        return default


def set_pref(key: str, value) -> None:
    if not _prefs_path:
        return
    with _prefs_lock:
        prefs = {}
        try:
            with open(_prefs_path) as f:
                prefs = json.load(f)
        except (OSError, ValueError):
            pass
        prefs[key] = value
        os.makedirs(os.path.dirname(_prefs_path), exist_ok=True)
        tmp = _prefs_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(prefs, f)
        os.replace(tmp, _prefs_path)


def _env_explicitly_set(key: str) -> bool:
    raw = os.environ.get(key)
    return raw is not None and raw.strip() != ""


def is_torrent_enabled() -> bool:
    """BT-first downloads are ON by default (v1.7.0) — every Zimi that can
    torrent takes load off the Kiwix mirrors. ZIMI_TORRENT=0 opts out.
    Installs without aria2c silently use HTTP; nothing breaks."""
    return _bool_env("ZIMI_TORRENT", default=True)


def get_bt_port() -> int:
    """Inbound BT port. Default 6881; clamps invalid input."""
    raw = os.environ.get("ZIMI_BT_PORT", str(DEFAULT_BT_PORT))
    try:
        n = int(raw)
        if 1024 <= n <= 65535:
            return n
    except (ValueError, TypeError):
        pass
    log.warning("ZIMI_BT_PORT=%r invalid; using default %d", raw, DEFAULT_BT_PORT)
    return DEFAULT_BT_PORT


def get_staging_dir(data_dir: str) -> str:
    """Where in-progress downloads land before being renamed to ZIM_DIR."""
    explicit = os.environ.get("ZIMI_STAGING_DIR")
    if explicit:
        return explicit
    return os.path.join(data_dir, "staging")


def get_backend_name() -> str:
    """Which BT backend to use. Default 'aria2'."""
    return os.environ.get("ZIMI_BT_BACKEND", "aria2").strip().lower()


# ============================================================================
# Seeding policy
# ============================================================================


def is_seeding_enabled() -> bool:
    """Seed by default when BT is enabled. ZIMI_SEED env var wins when set
    (and locks the UI toggle); otherwise the persisted UI preference."""
    if _env_explicitly_set("ZIMI_SEED"):
        return _bool_env("ZIMI_SEED", True)
    return bool(_read_pref("seed", True))


def is_seed_env_locked() -> bool:
    return _env_explicitly_set("ZIMI_SEED")


def get_seed_ratio_cap() -> float:
    """Stop seeding once we've uploaded N× the file size. Default 2.0."""
    raw = os.environ.get("ZIMI_SEED_RATIO", str(DEFAULT_RATIO_CAP))
    try:
        return max(0.0, float(raw))
    except (ValueError, TypeError):
        return DEFAULT_RATIO_CAP


def get_disk_pressure_pct() -> int:
    """Pause seeding when free disk drops below this percent. Default 5."""
    raw = os.environ.get("ZIMI_SEED_DISK_PCT", "5")
    try:
        return max(1, min(50, int(raw)))
    except (ValueError, TypeError):
        return 5


def seed_options(*, ratio_cap: float, max_upload_kb: int) -> dict:
    """aria2 per-torrent options for seeding behaviour.

    ratio_cap=0 means leech-only (don't seed at all).
    """
    if ratio_cap <= 0:
        return {
            "seed-ratio": "0",
            "seed-time": "0",
            "bt-stop-timeout": "0",
        }
    return {
        "seed-ratio": f"{ratio_cap:.1f}",
        "seed-time": "0",  # cap by ratio, not time
        "max-upload-limit": f"{int(max_upload_kb)}K",
    }


# ============================================================================
# Mirror mode (W3.6) — opt-in "I'm an active mirror" flag that lifts the
# 2× ratio cap and raises upload bandwidth. Personal users keep the
# default conservative caps; people running an actual public mirror
# flip ZIMI_MIRROR=1 and accept they'll seed indefinitely.
# ============================================================================

DEFAULT_MIRROR_RATIO_CAP = 1000.0  # effectively uncapped — 1000× upload
DEFAULT_MIRROR_UPLOAD_KB = 10240  # 10 MB/s


def is_mirror_enabled() -> bool:
    """Mirror mode lifts the seed-ratio cap and raises upload bandwidth.
    ZIMI_MIRROR env var wins when set (and locks the UI toggle); otherwise
    the persisted UI preference. Off by default."""
    if _env_explicitly_set("ZIMI_MIRROR"):
        return _bool_env("ZIMI_MIRROR", False)
    return bool(_read_pref("mirror", False))


def is_mirror_env_locked() -> bool:
    return _env_explicitly_set("ZIMI_MIRROR")


def get_mirror_ratio_cap() -> float:
    """Mirror-mode ratio cap. ZIMI_MIRROR_RATIO override (default 1000)."""
    raw = os.environ.get("ZIMI_MIRROR_RATIO", str(DEFAULT_MIRROR_RATIO_CAP))
    try:
        return max(1.0, float(raw))
    except (ValueError, TypeError):
        return DEFAULT_MIRROR_RATIO_CAP


def get_mirror_upload_kb() -> int:
    """Mirror-mode upload bandwidth in KB/s. ZIMI_MIRROR_UPLOAD_KB
    override (default 10240 = 10 MB/s)."""
    raw = os.environ.get("ZIMI_MIRROR_UPLOAD_KB", str(DEFAULT_MIRROR_UPLOAD_KB))
    try:
        return max(64, int(raw))
    except (ValueError, TypeError):
        return DEFAULT_MIRROR_UPLOAD_KB


def get_mirror_status() -> dict:
    """Serialize current seed/mirror config for the /manage/mirror endpoint."""
    return {
        "enabled": is_mirror_enabled(),
        "env_locked": is_mirror_env_locked(),
        "seed_enabled": is_seeding_enabled(),
        "seed_env_locked": is_seed_env_locked(),
        "ratio_cap": get_mirror_ratio_cap(),
        "upload_kb": get_mirror_upload_kb(),
        "seed_ratio_cap": get_seed_ratio_cap(),
    }


def effective_seed_options() -> dict:
    """Return aria2 seed options reflecting mirror-or-personal caps.

    Mirror mode raises ratio + upload caps. Personal mode uses the
    user's `ZIMI_SEED_RATIO` (default 2.0) and `ZIMI_SEED_UPLOAD_KB`
    (default DEFAULT_SEED_BANDWIDTH_KB).
    """
    if is_mirror_enabled():
        return seed_options(
            ratio_cap=get_mirror_ratio_cap(),
            max_upload_kb=get_mirror_upload_kb(),
        )
    user_upload_raw = os.environ.get(
        "ZIMI_SEED_UPLOAD_KB", str(DEFAULT_SEED_BANDWIDTH_KB)
    )
    try:
        user_upload = max(64, int(user_upload_raw))
    except (ValueError, TypeError):
        user_upload = DEFAULT_SEED_BANDWIDTH_KB
    return seed_options(
        ratio_cap=get_seed_ratio_cap(),
        max_upload_kb=user_upload,
    )


def should_pause_for_disk_pressure(zim_dir: str) -> bool:
    """Free space below ZIMI_SEED_DISK_PCT → pause all seeds."""
    try:
        usage = shutil.disk_usage(zim_dir)
    except OSError:
        return False  # can't tell → don't pause
    if usage.total == 0:
        return False
    pct_free = (usage.free / usage.total) * 100
    return pct_free < get_disk_pressure_pct()


# ============================================================================
# Backend interface
# ============================================================================


class BTBackend(ABC):
    """Common surface across aria2 / qBittorrent / Transmission / Deluge.

    The rest of zimi only knows about this interface. Each backend
    implementation is opt-in via ZIMI_BT_BACKEND.
    """

    @abstractmethod
    def available(self) -> bool:
        """Is this backend usable? aria2 → binary on PATH; qBT → API
        reachable. Called at startup to fail-soft to HTTP."""

    @abstractmethod
    def add_torrent(
        self, source: str, *, dest_dir: str, options: dict | None = None
    ) -> str:
        """Add a torrent (URL to .torrent, magnet, or local path).

        Returns a backend-specific id we can use later.
        """

    @abstractmethod
    def pause(self, tid: str) -> None: ...

    @abstractmethod
    def resume(self, tid: str) -> None: ...

    @abstractmethod
    def remove(self, tid: str, *, delete_files: bool = False) -> None: ...

    @abstractmethod
    def status(self, tid: str) -> dict:
        """Return a normalized status dict.

        Keys: state ('downloading'|'seeding'|'paused'|'error'|'complete'),
              completed_bytes, total_bytes, peers, seeders, leechers,
              down_speed, up_speed, ratio, eta_seconds, info_hash.
        """

    @abstractmethod
    def list_managed(self) -> list[dict]:
        """All Zimi-managed torrents (filtered by category for external)."""

    def web_ui_url(self, tid: str | None = None) -> str | None:
        """Optional deep-link to the backend's web UI. None for headless."""
        return None


# ============================================================================
# aria2 sidecar — the bundled default
# ============================================================================


class Aria2Backend(BTBackend):
    """Manages a long-lived `aria2c` subprocess via its JSON-RPC interface.

    Lifecycle:
      ensure_running()         start subprocess if not already up
      _rpc(method, params)     thin client with bounded retries
      stop()                   graceful shutdown on Zimi exit

    Survives aria2 crashes via session-file resume. Listens only on
    localhost — never expose the RPC port externally.
    """

    def __init__(
        self,
        *,
        bt_port: int,
        rpc_port: int = 6800,
        data_dir: str,
        staging_dir: str,
    ) -> None:
        self.bt_port = bt_port
        self.rpc_port = rpc_port
        self.data_dir = data_dir
        self.staging_dir = staging_dir
        self.bt_dir = os.path.join(data_dir, "bt")
        self.session_path = os.path.join(self.bt_dir, "session")
        self.torrents_dir = os.path.join(self.bt_dir, "torrents")
        # 32 hex chars; localhost-only but still nice to require it
        self.rpc_secret = secrets.token_hex(16)
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    # ── availability check ────────────────────────────────────────────────

    def available(self) -> bool:
        """True if `aria2c` is on PATH and we can reach its RPC."""
        if not shutil.which("aria2c"):
            return False
        try:
            self.ensure_running()
            # Round-trip the RPC to confirm it actually responds
            self._rpc("aria2.getVersion", [])
            return True
        except Exception as e:
            log.warning("aria2 not available: %s", e)
            return False

    # ── lifecycle ─────────────────────────────────────────────────────────

    def ensure_running(self) -> None:
        with self._lock:
            if self._proc and self._proc.poll() is None:
                return  # already running
            os.makedirs(self.bt_dir, exist_ok=True)
            os.makedirs(self.torrents_dir, exist_ok=True)
            os.makedirs(self.staging_dir, exist_ok=True)
            args = [
                "aria2c",
                "--enable-rpc",
                "--rpc-listen-all=false",
                f"--rpc-listen-port={self.rpc_port}",
                f"--rpc-secret={self.rpc_secret}",
                f"--listen-port={self.bt_port}",
                f"--dht-listen-port={self.bt_port}",
                # Seed-cap policy comes via per-torrent options on add_torrent.
                "--enable-dht=false",  # opt-in only via ZIMI_DHT
                "--enable-peer-exchange=true",
                f"--dir={self.staging_dir}",
                f"--save-session={self.session_path}",
                "--save-session-interval=30",
                # Resume from session file on restart
                *(
                    ["--input-file", self.session_path]
                    if os.path.exists(self.session_path)
                    else []
                ),
                "--continue=true",
                "--max-connection-per-server=4",
                "--seed-ratio=0",  # default no auto-seed; per-torrent overrides
                "--bt-stop-timeout=0",
                "--summary-interval=0",
                "--quiet=true",
            ]
            log.info("Starting aria2c on rpc:%d, bt:%d", self.rpc_port, self.bt_port)
            self._proc = subprocess.Popen(
                args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
            )
            # Wait briefly for RPC to come up
            for _ in range(30):
                try:
                    self._rpc("aria2.getVersion", [])
                    log.info("aria2c ready on port %d", self.rpc_port)
                    return
                except Exception:
                    time.sleep(0.1)
            raise RuntimeError("aria2c failed to start within 3s")

    def stop(self) -> None:
        with self._lock:
            if not self._proc:
                return
            try:
                self._rpc("aria2.shutdown", [])
                self._proc.wait(timeout=5)
            except Exception:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
            self._proc = None

    # ── RPC client ────────────────────────────────────────────────────────

    def _rpc(self, method: str, params: list, timeout: float = 5.0) -> Any:
        """Single JSON-RPC call. Raises on transport or RPC error."""
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": secrets.token_hex(4),
                "method": method,
                "params": [f"token:{self.rpc_secret}", *params],
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.rpc_port}/jsonrpc",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read())
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            raise RuntimeError(f"aria2 RPC transport error: {e}") from e
        if "error" in data:
            raise RuntimeError(f"aria2 RPC error: {data['error']}")
        return data.get("result", {})

    # ── BTBackend impl ────────────────────────────────────────────────────

    def add_torrent(
        self, source: str, *, dest_dir: str, options: dict | None = None
    ) -> str:
        """source can be a URL to a .torrent, a magnet, or http(s) URL.

        For .torrent URLs, aria2.addUri pulls the metadata then starts the
        BT swarm. dest_dir is where the final file lands (we use staging
        and rename later — aria2 writes here directly).
        """
        opts = {"dir": dest_dir, "allow-overwrite": "false"}
        if options:
            opts.update(options)
        return self._rpc("aria2.addUri", [[source], opts])

    def pause(self, tid: str) -> None:
        self._rpc("aria2.pause", [tid])

    def resume(self, tid: str) -> None:
        self._rpc("aria2.unpause", [tid])

    def remove(self, tid: str, *, delete_files: bool = False) -> None:
        self._rpc("aria2.remove", [tid])
        if delete_files:
            self._rpc("aria2.removeDownloadResult", [tid])

    def status(self, tid: str) -> dict:
        raw = self._rpc("aria2.tellStatus", [tid])
        # A .torrent-URL download is two-phase in aria2: the GID addUri
        # returns is the tiny metadata fetch, and the content transfer
        # continues under a followedBy GID. Report the followed transfer —
        # otherwise the caller sees "complete" the moment the .torrent file
        # lands and installs a preallocated, mostly-empty staging file.
        # (This exact bug shipped corrupt ZIMs; see test_bt_followed_gid.)
        depth = 0
        while raw.get("status") == "complete" and raw.get("followedBy") and depth < 4:
            raw = self._rpc("aria2.tellStatus", [raw["followedBy"][0]])
            depth += 1
        state_map = {
            "active": "downloading",
            "waiting": "waiting",
            "paused": "paused",
            "error": "error",
            "complete": "complete",
            "removed": "removed",
        }
        completed = int(raw.get("completedLength", 0))
        total = int(raw.get("totalLength", 0))
        return {
            "state": state_map.get(raw.get("status", ""), "unknown"),
            # Callers must rebind to this GID — pause/cancel/remove on the
            # original metadata GID would not touch the content transfer.
            "gid": raw.get("gid", tid),
            "completed_bytes": completed,
            "total_bytes": total,
            "down_speed": int(raw.get("downloadSpeed", 0)),
            "up_speed": int(raw.get("uploadSpeed", 0)),
            "peers": int(raw.get("connections", 0)),
            "seeders": int(raw.get("numSeeders", 0)) if "numSeeders" in raw else 0,
            "ratio": float(raw.get("uploadLength", 0)) / max(total, 1),
            "info_hash": raw.get("infoHash", ""),
            "error_code": raw.get("errorCode", ""),
            "error_message": raw.get("errorMessage", ""),
        }

    def list_managed(self) -> list[dict]:
        active = self._rpc("aria2.tellActive", [])
        waiting = self._rpc("aria2.tellWaiting", [0, 1000])
        stopped = self._rpc("aria2.tellStopped", [0, 1000])
        return list(active) + list(waiting) + list(stopped)

    def purge_stopped(self) -> None:
        """Clear finished/errored download results from aria2's session.

        Errored torrents (e.g. broken/empty ZIMs whose .torrent won't resolve)
        otherwise linger forever in the stopped list and clutter the seeding
        panel. purgeDownloadResult only touches stopped results — active seeds
        are untouched."""
        self._rpc("aria2.purgeDownloadResult", [])


# ============================================================================
# Selection
# ============================================================================


_backend_singleton: BTBackend | None = None
_backend_lock = threading.Lock()


def get_backend(*, data_dir: str) -> BTBackend | None:
    """Return the configured backend if available; None when off or unusable.

    Calls .available() exactly once on first access. If it fails (no aria2
    on PATH, qBT unreachable), returns None and the HTTP path runs as
    before. Smart-default behavior: never crashes Zimi for a BT problem.
    """
    global _backend_singleton
    with _backend_lock:
        if _backend_singleton is not None:
            return _backend_singleton
        if not is_torrent_enabled():
            return None
        name = get_backend_name()
        bt_port = get_bt_port()
        staging = get_staging_dir(data_dir)
        if name == "aria2":
            backend: BTBackend = Aria2Backend(
                bt_port=bt_port,
                data_dir=data_dir,
                staging_dir=staging,
            )
        else:
            log.warning("ZIMI_BT_BACKEND=%r not yet implemented; HTTP-only.", name)
            return None
        if not backend.available():
            log.warning(
                "BT backend %r unavailable; downloads will use HTTP fallback. "
                "(aria2c on PATH? port %d free?)",
                name,
                bt_port,
            )
            return None
        log.info("BT backend %r ready on port %d (staging=%s)", name, bt_port, staging)
        _backend_singleton = backend
        return backend


def peek_backend() -> "BTBackend | None":
    """Return the already-running backend, or None — never starts one.

    Status views and ambient polls must use this instead of get_backend():
    with BT on by default, get_backend() would spawn the sidecar (or retry
    a missing binary) on every poll tick.
    """
    with _backend_lock:
        return _backend_singleton


def shutdown_backend() -> None:
    """Stop the running sidecar (if any). Safe to call repeatedly."""
    global _backend_singleton
    with _backend_lock:
        if _backend_singleton and isinstance(_backend_singleton, Aria2Backend):
            _backend_singleton.stop()
        _backend_singleton = None
