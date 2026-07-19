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


def find_aria2c() -> str | None:
    """Locate aria2c. Desktop builds ship their own sidecar (checked
    first, so a bundled aria2 wins over whatever's on the machine). GUI
    apps on macOS launch with a bare PATH that misses Homebrew, so fall
    back to the standard install locations after PATH."""
    import sys as _sys

    bundle_base = getattr(_sys, "_MEIPASS", None)
    if bundle_base:
        for name in ("aria2c", "aria2c.exe"):
            cand = os.path.join(bundle_base, name)
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                return cand
    found = shutil.which("aria2c")
    if found:
        return found
    for candidate in (
        "/usr/local/bin/aria2c",  # Homebrew (Intel)
        "/opt/homebrew/bin/aria2c",  # Homebrew (Apple Silicon)
        "/usr/bin/aria2c",  # Linux distro packages
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _bool_env(key: str, default: bool = False) -> bool:
    raw = os.environ.get(key, "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


# ============================================================================
# Compact config blobs — the documented env surface is just two vars:
#   ZIMI_BT="on,port=6881,ratio=2,up=2048,mirror=off"
#   ZIMI_NEARBY="on,name=my-zimi,public=off"
# A bare on/off token drives the master switch; key=value pairs set single
# fields. Any field present in the blob is env-locked in the UI — fields
# left out stay UI-controlled. The pre-release per-feature vars
# (ZIMI_TORRENT, ZIMI_SEED, ...) keep working as undocumented fallbacks so
# :dev testers don't break.
# ============================================================================


def parse_conf_blob(name: str) -> dict:
    raw = os.environ.get(name, "")
    conf: dict = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            k, v = part.split("=", 1)
            conf[k.strip().lower()] = v.strip()
        else:
            conf["enabled"] = part.lower() not in ("0", "false", "no", "off")
    return conf


def _conf_bool(v, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() not in ("0", "false", "no", "off")


def _bt_conf() -> dict:
    return parse_conf_blob("ZIMI_BT")


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


def set_pref(key: str, value) -> bool:
    """Persist a UI preference. Returns False (and logs) when the config
    dir isn't writable — callers surface that instead of a 500."""
    if not _prefs_path:
        return False
    with _prefs_lock:
        prefs = {}
        try:
            with open(_prefs_path) as f:
                prefs = json.load(f)
        except (OSError, ValueError):
            pass
        prefs[key] = value
        try:
            os.makedirs(os.path.dirname(_prefs_path), exist_ok=True)
            tmp = _prefs_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(prefs, f)
            os.replace(tmp, _prefs_path)
        except OSError as e:
            log.warning("could not persist preference %s: %s", key, e)
            return False
    return True


def _env_explicitly_set(key: str) -> bool:
    raw = os.environ.get(key)
    return raw is not None and raw.strip() != ""


def is_torrent_enabled() -> bool:
    """BT-first downloads are ON by default (v1.7.0) — every Zimi that can
    torrent takes load off the Kiwix mirrors. ZIMI_BT (or legacy
    ZIMI_TORRENT) wins and locks the UI switch; otherwise the persisted
    UI preference. Installs without aria2c silently use HTTP."""
    conf = _bt_conf()
    if "enabled" in conf:
        return bool(conf["enabled"])
    if _env_explicitly_set("ZIMI_TORRENT"):
        return _bool_env("ZIMI_TORRENT", default=True)
    return bool(_read_pref("torrent", True))


def is_torrent_env_locked() -> bool:
    return "enabled" in _bt_conf() or _env_explicitly_set("ZIMI_TORRENT")


def get_bt_port() -> int:
    """Inbound BT port. ZIMI_BT's port= field (or legacy ZIMI_BT_PORT)
    wins; otherwise the persisted UI preference; default 6881."""
    raw = (
        _bt_conf().get("port")
        or os.environ.get("ZIMI_BT_PORT")
        or _read_pref("bt_port", DEFAULT_BT_PORT)
    )
    try:
        n = int(raw)
        if 1024 <= n <= 65535:
            return n
    except (ValueError, TypeError):
        pass
    log.warning("BT port %r invalid; using default %d", raw, DEFAULT_BT_PORT)
    return DEFAULT_BT_PORT


def is_bt_port_env_locked() -> bool:
    return bool(_bt_conf().get("port") or os.environ.get("ZIMI_BT_PORT"))


def get_staging_dir(data_dir: str) -> str:
    """Where in-progress downloads land before being renamed to ZIM_DIR."""
    explicit = _bt_conf().get("staging") or os.environ.get("ZIMI_STAGING_DIR")
    if explicit:
        return explicit
    return os.path.join(data_dir, "staging")


def get_backend_name() -> str:
    """Which BT backend to use. Default 'aria2'."""
    conf = _bt_conf()
    if conf.get("backend"):
        return str(conf["backend"]).lower()
    return os.environ.get("ZIMI_BT_BACKEND", "aria2").strip().lower()


# ============================================================================
# Seeding policy
# ============================================================================


def is_seeding_enabled() -> bool:
    """Seed by default when BT is enabled. ZIMI_BT's seed= field (or
    legacy ZIMI_SEED) wins; otherwise the persisted UI preference."""
    conf = _bt_conf()
    if "seed" in conf:
        return _conf_bool(conf["seed"])
    if _env_explicitly_set("ZIMI_SEED"):
        return _bool_env("ZIMI_SEED", True)
    return bool(_read_pref("seed", True))


def is_seed_env_locked() -> bool:
    return "seed" in _bt_conf() or _env_explicitly_set("ZIMI_SEED")


def get_seed_ratio_cap() -> float:
    """Stop seeding once we've uploaded N× the file size. Default 2.0.
    ZIMI_BT's ratio= field (or legacy ZIMI_SEED_RATIO) wins; otherwise
    the persisted UI value. 0 = never seed."""
    raw = _bt_conf().get("ratio") or os.environ.get("ZIMI_SEED_RATIO")
    if raw is None or not str(raw).strip():
        try:
            return max(
                0.0, min(10.0, float(_read_pref("seed_ratio", DEFAULT_RATIO_CAP)))
            )
        except (ValueError, TypeError):
            return DEFAULT_RATIO_CAP
    try:
        return max(0.0, float(raw))
    except (ValueError, TypeError):
        return DEFAULT_RATIO_CAP


def is_seed_ratio_env_locked() -> bool:
    return "ratio" in _bt_conf() or _env_explicitly_set("ZIMI_SEED_RATIO")


# Global BitTorrent bandwidth caps in KB/s, 0 = unlimited (aria2's default).
# Applied to the whole aria2 process — downloads AND seeds, mirror included —
# so one pair of numbers governs all sharing speed. ZIMI_BT's up=/down= fields
# lock the UI field when set.
def get_bt_up_limit_kb() -> int:
    raw = _bt_conf().get("up") or os.environ.get("ZIMI_BT_UP_KB")
    if raw in (None, ""):
        raw = _read_pref("bt_up_kb", 0)
    try:
        return max(0, int(raw))
    except (ValueError, TypeError):
        return 0


def get_bt_down_limit_kb() -> int:
    raw = _bt_conf().get("down") or os.environ.get("ZIMI_BT_DOWN_KB")
    if raw in (None, ""):
        raw = _read_pref("bt_down_kb", 0)
    try:
        return max(0, int(raw))
    except (ValueError, TypeError):
        return 0


def is_bt_up_env_locked() -> bool:
    return "up" in _bt_conf() or _env_explicitly_set("ZIMI_BT_UP_KB")


def is_bt_down_env_locked() -> bool:
    return "down" in _bt_conf() or _env_explicitly_set("ZIMI_BT_DOWN_KB")


def apply_rate_limits() -> None:
    """Push the current up/down caps to a running sidecar (live, no respawn)."""
    backend = peek_backend()
    if backend is not None and hasattr(backend, "set_global_rate_limits"):
        try:
            backend.set_global_rate_limits(get_bt_up_limit_kb(), get_bt_down_limit_kb())
        except Exception as e:
            log.debug("live rate-limit apply failed: %s", e)


# Absolute free-space floor shared by the download gate and the seeding
# pause. Percent-of-drive defaults are wrong at both ends: 5% of a 466 GB
# drive is 23 GB of "missing" space, and seeding existing files writes
# almost nothing anyway.
DISK_FLOOR_BYTES = 2 * 1024**3


def get_disk_pressure_pct() -> int | None:
    """Explicit percent threshold for the seeding pause, or None when the
    user hasn't set one (the absolute DISK_FLOOR_BYTES applies instead)."""
    raw = _bt_conf().get("disk_min") or os.environ.get("ZIMI_SEED_DISK_PCT")
    if raw in (None, ""):
        return None
    try:
        return max(1, min(50, int(raw)))
    except (ValueError, TypeError):
        return None


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


def is_dht_enabled() -> bool:
    """DHT on by default: trackerless peer discovery is what makes magnet
    links and post-world swarms work when the Kiwix trackers are gone.
    ZIMI_BT's dht= field (or legacy ZIMI_DHT) opts out."""
    conf = _bt_conf()
    if "dht" in conf:
        return _conf_bool(conf["dht"])
    if _env_explicitly_set("ZIMI_DHT"):
        return _bool_env("ZIMI_DHT", True)
    return True


def is_upnp_enabled() -> bool:
    """Ask the router to open the BT port automatically (like every BT
    client). ZIMI_BT's upnp= field wins; otherwise the persisted UI
    preference. On by default — it fails soft on routers without UPnP."""
    conf = _bt_conf()
    if "upnp" in conf:
        return _conf_bool(conf["upnp"])
    return bool(_read_pref("upnp", True))


def is_upnp_env_locked() -> bool:
    return "upnp" in _bt_conf()


def is_mirror_enabled() -> bool:
    """Mirror mode lifts the seed-ratio cap and raises upload bandwidth.
    ZIMI_BT's mirror= field (or legacy ZIMI_MIRROR) wins; otherwise the
    persisted UI preference. Off by default."""
    conf = _bt_conf()
    if "mirror" in conf:
        return _conf_bool(conf["mirror"])
    if _env_explicitly_set("ZIMI_MIRROR"):
        return _bool_env("ZIMI_MIRROR", False)
    return bool(_read_pref("mirror", False))


def is_mirror_env_locked() -> bool:
    return "mirror" in _bt_conf() or _env_explicitly_set("ZIMI_MIRROR")


def get_mirror_ratio_cap() -> float:
    """Mirror-mode ratio cap. ZIMI_MIRROR_RATIO override (default 1000)."""
    raw = _bt_conf().get("mirror_ratio") or os.environ.get(
        "ZIMI_MIRROR_RATIO", str(DEFAULT_MIRROR_RATIO_CAP)
    )
    try:
        return max(1.0, float(raw))
    except (ValueError, TypeError):
        return DEFAULT_MIRROR_RATIO_CAP


def get_mirror_upload_kb() -> int:
    """Mirror-mode upload bandwidth in KB/s. ZIMI_MIRROR_UPLOAD_KB
    override (default 10240 = 10 MB/s)."""
    raw = _bt_conf().get("mirror_up") or os.environ.get(
        "ZIMI_MIRROR_UPLOAD_KB", str(DEFAULT_MIRROR_UPLOAD_KB)
    )
    try:
        return max(64, int(raw))
    except (ValueError, TypeError):
        return DEFAULT_MIRROR_UPLOAD_KB


def get_mirror_status() -> dict:
    """Serialize current sharing config for the /manage/mirror endpoint."""
    from zimi import p2p_discovery as _disc

    return {
        "enabled": is_mirror_enabled(),
        "env_locked": is_mirror_env_locked(),
        "seed_enabled": is_seeding_enabled(),
        "seed_env_locked": is_seed_env_locked(),
        "torrent_enabled": is_torrent_enabled(),
        "torrent_env_locked": is_torrent_env_locked(),
        "peer_share": _disc.is_share_enabled(),
        "peer_share_env_locked": _disc.is_share_env_locked(),
        "peer_name_env_locked": _disc.is_name_env_locked(),
        "ratio_cap": get_mirror_ratio_cap(),
        "upload_kb": get_mirror_upload_kb(),
        "seed_ratio_cap": get_seed_ratio_cap(),
        "seed_ratio_env_locked": is_seed_ratio_env_locked(),
        "bt_up_kb": get_bt_up_limit_kb(),
        "bt_down_kb": get_bt_down_limit_kb(),
        "bt_up_env_locked": is_bt_up_env_locked(),
        "bt_down_env_locked": is_bt_down_env_locked(),
        # Docker bridge mode advertises an unreachable container IP —
        # Nearby silently doesn't work. The UI warns; ZIMI_NEARBY's ip=
        # field (or host networking) fixes it.
        "peer_ip_unreachable": (
            _disc.is_share_enabled() and _disc.advertised_ip_looks_unreachable()
        ),
        "progress": _mirror_progress_snapshot(),
    }


def _mirror_progress_snapshot() -> dict:
    try:
        from zimi import library as _lib

        return dict(_lib._mirror_progress)
    except Exception:
        return {"phase": None, "done": 0, "total": 0}


def effective_seed_options() -> dict:
    """Per-torrent seed options: just the ratio cap (mirror lifts it).

    Speed is NOT capped per-torrent — the global up/down limits
    (get_bt_up_limit_kb / get_bt_down_limit_kb) govern total bandwidth for
    downloads and seeds alike, so one BT-section control covers personal
    seeding AND mirror. max_upload_kb=0 means per-torrent unlimited.
    """
    ratio = get_mirror_ratio_cap() if is_mirror_enabled() else get_seed_ratio_cap()
    return seed_options(ratio_cap=ratio, max_upload_kb=0)


def should_pause_for_disk_pressure(zim_dir: str) -> bool:
    """Pause all seeds when free space is critically low: below the
    absolute DISK_FLOOR_BYTES, or below ZIMI_SEED_DISK_PCT percent when
    the user set one explicitly."""
    try:
        usage = shutil.disk_usage(zim_dir)
    except OSError:
        return False  # can't tell → don't pause
    if usage.total == 0:
        return False
    pct = get_disk_pressure_pct()
    if pct is not None:
        return (usage.free / usage.total) * 100 < pct
    return usage.free < DISK_FLOOR_BYTES


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

    def is_alive(self) -> bool:
        """Whether the engine is actually running right now. Backends that
        manage a subprocess override this; for API-reachable backends mere
        existence is liveness."""
        return True

    def change_options(self, tid: str, options: dict) -> bool:
        """Change per-torrent options on a live transfer (e.g. seed-ratio).
        Returns True on success. Backends without live-option support may
        leave this as a no-op — callers treat False as 'unchanged'."""
        return False


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
        if not find_aria2c():
            return False
        try:
            self._spawn_with_fallback()
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
                find_aria2c() or "aria2c",
                "--enable-rpc",
                "--rpc-listen-all=false",
                f"--rpc-listen-port={self.rpc_port}",
                f"--rpc-secret={self.rpc_secret}",
                f"--listen-port={self.bt_port}",
                f"--dht-listen-port={self.bt_port}",
                # Seed-cap policy comes via per-torrent options on add_torrent.
                f"--enable-dht={'true' if is_dht_enabled() else 'false'}",
                # Persisted routing table: rejoining swarms after a restart
                # doesn't depend on bootstrap nodes being reachable.
                f"--dht-file-path={os.path.join(self.bt_dir, 'dht.dat')}",
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
                # Global bandwidth caps (0 = unlimited). One pair governs all
                # traffic — downloads, seeds, mirror — changeable live via RPC.
                f"--max-overall-upload-limit={get_bt_up_limit_kb()}K",
                f"--max-overall-download-limit={get_bt_down_limit_kb()}K",
            ]
            log.info("Starting aria2c on rpc:%d, bt:%d", self.rpc_port, self.bt_port)
            # Bundled aria2c (desktop builds): its relocated libcrypto must
            # load OpenSSL provider modules from the bundle, not from a
            # Homebrew path baked in at build time (absent on user machines
            # -> "OSSL_PROVIDER_load 'legacy' failed" and instant death).
            env = None
            binary = args[0]
            modules_dir = os.path.join(os.path.dirname(binary), "ossl-modules")
            if os.path.isdir(modules_dir):
                env = dict(os.environ, OPENSSL_MODULES=modules_dir)
            self._proc = subprocess.Popen(
                args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env
            )
            # Wait briefly for RPC to come up. Deadline-based with short
            # probe timeouts: a squatted RPC port (half-dead aria2 from
            # another process) must fail here in seconds, not stretch into
            # 30 probes x 5s default timeout — that once blocked startup
            # for minutes before READY.
            deadline = time.monotonic() + 5.0
            last_err: Exception | None = None
            while time.monotonic() < deadline:
                if self._proc.poll() is not None:
                    err = b""
                    try:
                        if self._proc.stderr:
                            err = self._proc.stderr.read()
                    except OSError:
                        pass
                    raise RuntimeError(
                        f"aria2c exited at startup (rpc port {self.rpc_port} "
                        f"or bt port {self.bt_port} in use?): "
                        f"{err.decode(errors='replace').strip()[:300]}"
                    )
                try:
                    self._rpc("aria2.getVersion", [], timeout=0.5)
                    log.info("aria2c ready on port %d", self.rpc_port)
                    return
                except Exception as e:
                    last_err = e
                    time.sleep(0.1)
            raise RuntimeError(f"aria2c failed to start within 5s: {last_err}")

    def _spawn_with_fallback(self) -> None:
        """ensure_running, walking alternate RPC ports when the default is
        squatted. One retry wasn't enough on real desktops: a desktop app
        plus a docker instance plus a dev server is three sidecars, and
        orphans from crashed quits squat ports too."""
        last: RuntimeError | None = None
        for attempt in range(5):
            if attempt:
                with self._lock:
                    if self._proc is not None:
                        try:
                            self._proc.terminate()
                        except Exception:
                            pass
                        self._proc = None
                self.rpc_port += 13
                log.info("aria2 RPC port busy; retrying on %d", self.rpc_port)
            try:
                self.ensure_running()
                return
            except RuntimeError as e:
                last = e
        raise last if last else RuntimeError("aria2 spawn failed")

    def is_alive(self) -> bool:
        """Non-spawning liveness check. A crashed/killed aria2 left the cached
        singleton in place, so the status view reported 'sidecar_running' from
        mere object existence and painted a green dot over a dead engine. Poll
        the process handle instead — never starts aria2."""
        proc = self._proc
        return proc is not None and proc.poll() is None

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
        # aria2.remove only accepts active/waiting/paused GIDs — errored
        # or completed ones raise. The result cleanup below is what
        # actually clears those, so a failed remove must not abort it.
        try:
            self._rpc("aria2.remove", [tid])
        except Exception:
            pass
        if delete_files:
            try:
                self._rpc("aria2.removeDownloadResult", [tid])
            except Exception:
                pass

    def get_options(self, tid: str) -> dict:
        """Per-download options (seed-ratio etc.). Empty dict on error."""
        try:
            return self._rpc("aria2.getOption", [tid]) or {}
        except Exception:
            return {}

    def change_options(self, tid: str, options: dict) -> bool:
        """aria2.changeOption on a live transfer. seed-ratio is on aria2's
        changeable-options list, so a running seed picks a new cap up
        immediately (and stops itself if it's already past it)."""
        try:
            self._rpc(
                "aria2.changeOption", [tid, {k: str(v) for k, v in options.items()}]
            )
            return True
        except Exception:
            return False

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
        # aria2 keeps a finished torrent 'active' while it seeds — the
        # download itself is done. Report 'complete' so the caller installs
        # the file instead of waiting out the seed ratio; seeding continues
        # inside aria2 either way.
        raw_state = raw.get("status", "")
        if raw_state == "active" and raw.get("seeder") in ("true", True):
            raw_state = "complete"
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
            "state": state_map.get(raw_state, "unknown"),
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

    def set_global_rate_limits(self, up_kb: int, down_kb: int) -> None:
        """Change the overall up/down caps on the fly (0 = unlimited)."""
        self._rpc(
            "aria2.changeGlobalOption",
            [
                {
                    "max-overall-upload-limit": f"{max(0, int(up_kb))}K",
                    "max-overall-download-limit": f"{max(0, int(down_kb))}K",
                }
            ],
        )

    def purge_stopped(self, keep_errors: bool = True) -> None:
        """Clear finished download results from aria2's session.

        Completed/removed results are noise; errored ones are SIGNAL (a
        snagged seed the user should see) and stay visible by default —
        the seeding panel renders them as errors instead of hiding them.
        Active seeds are never touched."""
        try:
            stopped = self._rpc("aria2.tellStopped", [0, 1000])
        except Exception:
            return
        for raw in stopped:
            status = raw.get("status", "")
            if keep_errors and status == "error":
                continue
            try:
                self._rpc("aria2.removeDownloadResult", [raw.get("gid", "")])
            except Exception:
                pass


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
        # Checked before the singleton so the UI switch takes effect
        # immediately — an already-running sidecar stops being used (and
        # the toggle handler shuts it down).
        if not is_torrent_enabled():
            return None
        if _backend_singleton is not None:
            return _backend_singleton
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
            # available() may have spawned a sidecar before failing the RPC
            # round-trip — reap it or it lingers and squats the RPC port
            # for every later start (tests leaked these for exactly this
            # reason and wedged CI smoke runs).
            if isinstance(backend, Aria2Backend):
                backend.stop()
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
