"""BitTorrent engine: a single in-process libtorrent session.

  BTBackend (abstract)
    LibtorrentBackend — in-process libtorrent 2.0 session, no sidecar

The interface stays abstract because the test fakes subclass it, but
there is now exactly one real engine. BT-first downloads are ON by
default so the install base shares distribution load with the Kiwix
mirrors; ZIMI_TORRENT=0 opts out entirely.

Smart defaults: if libtorrent isn't importable on this install, we log
+ skip silently rather than crashing. The HTTP path keeps working
unchanged — HTTP is the universal transport underneath.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
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
        with open(_prefs_path, encoding="utf-8") as f:
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
            with open(_prefs_path, encoding="utf-8") as f:
                prefs = json.load(f)
        except (OSError, ValueError):
            pass
        prefs[key] = value
        try:
            os.makedirs(os.path.dirname(_prefs_path), exist_ok=True)
            tmp = _prefs_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
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
    UI preference. Installs without libtorrent silently use HTTP."""
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


# Global BitTorrent bandwidth caps in KB/s, 0 = unlimited. Applied to the
# whole libtorrent session — downloads AND seeds, mirror included — so one
# pair of numbers governs all sharing speed. ZIMI_BT's up=/down= fields lock
# the UI field when set.
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
    """Push the current up/down caps to the running session (live, no restart)."""
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


# ============================================================================
# Mirror mode — opt-in "I'm an active mirror" flag that lifts the
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
    """The engine surface the rest of Zimi knows about.

    Kept abstract so the test fakes can subclass a stable contract, but
    LibtorrentBackend is the only real implementation.
    """

    @abstractmethod
    def available(self) -> bool:
        """Is this backend usable? (libtorrent importable and its session
        starts.) Called at startup to fail-soft to HTTP."""

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
# libtorrent — the in-process engine (v1.8+)
# ============================================================================

_lt_module = None
_lt_import_failed = False

# .torrent metadata fetches: bounded so a hostile/misbehaving URL can't
# balloon memory. Real Kiwix .torrent files are tens of KB.
TORRENT_FETCH_TIMEOUT_S = 30
TORRENT_FETCH_MAX_BYTES = 10 * 1024 * 1024

# How long the alert pump blocks per iteration. Also the unit the fastresume
# checkpoint cadence counts in, so the two must be read together.
ALERT_TICK_S = 1.0
# Fastresume checkpoint cadence, in alert-loop ticks. Without a periodic save,
# resume data is only written on a clean stop(); a hard kill (power loss,
# `docker kill`) would then force a full re-hash/re-download of every in-flight
# torrent. At the default tick that is about a minute of at-most-lost progress.
RESUME_SAVE_TICKS = 60


def _lt():
    """Import libtorrent lazily; None when unavailable (→ HTTP floor).

    Not a hard dependency: the PyPI package has patchy wheel coverage
    (nothing for 3.13+/some platforms). Docker installs it; pip installs
    of zimi work without it and simply don't torrent.
    """
    global _lt_module, _lt_import_failed
    if _lt_module is not None:
        return _lt_module
    if _lt_import_failed:
        return None
    try:
        import libtorrent

        _lt_module = libtorrent
    except ImportError:
        _lt_import_failed = True
        log.info("libtorrent not importable — BT off, downloads use HTTP")
        return None
    return _lt_module


class LibtorrentBackend(BTBackend):
    """In-process libtorrent session. One engine, no sidecar. Torrent ids are
    v1 info-hash hex.

    list_managed() entries are the contract library.py and manage.py parse:
    gid/status/files/completedLength/uploadLength/totalLength/infoHash/seeder.
    The string-typed values are load-bearing for those parsers — `seeder` is
    "true"/"false" and `completedLength` is a str byte count.
    """

    def __init__(self, *, bt_port: int, data_dir: str, staging_dir: str) -> None:
        self.bt_port = bt_port
        self.data_dir = data_dir
        self.staging_dir = staging_dir
        self.bt_dir = os.path.join(data_dir, "bt")
        self.resume_dir = os.path.join(self.bt_dir, "resume")
        self._ses = None
        self._handles: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._alert_stop = threading.Event()
        self._alert_thread: threading.Thread | None = None

    # ── availability / lifecycle ──────────────────────────────────────────

    def available(self) -> bool:
        if _lt() is None:
            return False
        try:
            self._ensure_session()
            return True
        except Exception as e:
            log.warning("libtorrent session failed to start: %s", e)
            return False

    def is_alive(self) -> bool:
        return self._ses is not None

    def ensure_running(self) -> None:
        self._ensure_session()

    def _ensure_session(self) -> None:
        with self._lock:
            if self._ses is not None:
                return
            lt = _lt()
            if lt is None:
                raise RuntimeError("libtorrent not importable")
            os.makedirs(self.resume_dir, exist_ok=True)
            os.makedirs(self.staging_dir, exist_ok=True)
            settings = {
                "listen_interfaces": f"0.0.0.0:{self.bt_port},[::]:{self.bt_port}",
                "enable_dht": is_dht_enabled(),
                "enable_upnp": is_upnp_enabled(),
                "enable_natpmp": is_upnp_enabled(),
                "upload_rate_limit": get_bt_up_limit_kb() * 1024,
                "download_rate_limit": get_bt_down_limit_kb() * 1024,
                # port_mapping category surfaces UPnP/NAT-PMP success or
                # failure — the single most useful signal for "why is BT slow":
                # a node that never maps its port is not connectable and starves
                # on a thin swarm. The enum's name varies across libtorrent
                # versions (and the test double omits it), so resolve it
                # defensively — 0 is a harmless no-op when it's absent.
                "alert_mask": (
                    lt.alert.category_t.status_notification
                    | lt.alert.category_t.error_notification
                    | lt.alert.category_t.storage_notification
                    | getattr(lt.alert.category_t, "port_mapping_notification", 0)
                    | getattr(lt.alert.category_t, "port_mapping", 0)
                ),
            }
            self._ses = lt.session(settings)
            log.info("libtorrent session up (bt port %d)", self.bt_port)
            self._load_resume_files(lt)
            self._alert_stop.clear()
            self._alert_thread = threading.Thread(
                target=self._alert_loop, name="lt-alerts", daemon=True
            )
            self._alert_thread.start()

    def stop(self) -> None:
        # Snapshot and clear handles under the same lock that takes the
        # session, so a concurrent add_torrent() can't start a fresh
        # session and then have its handle wiped by an unlocked clear().
        # (A post-stop add_torrent re-runs _ensure_session() cleanly.)
        with self._lock:
            ses, self._ses = self._ses, None
            handles = dict(self._handles)
            self._handles.clear()
        if ses is None:
            return
        self._alert_stop.set()
        if self._alert_thread is not None:
            self._alert_thread.join(timeout=2)
        # Ask every handle for resume data, then drain the alerts that
        # carry it — this is what makes restarts not re-download.
        pending = 0
        for h in handles.values():
            try:
                if h.is_valid():
                    h.save_resume_data()
                    pending += 1
            except Exception:
                pass
        deadline = time.monotonic() + 5.0
        while pending > 0 and time.monotonic() < deadline:
            for alert in ses.pop_alerts():
                name = alert.what()
                if name == "save_resume_data":
                    self._write_resume_file(alert)
                    pending -= 1
                elif name == "save_resume_data_failed":
                    pending -= 1
            time.sleep(0.05)

    # ── resume persistence ────────────────────────────────────────────────

    def _resume_path(self, tid: str) -> str:
        return os.path.join(self.resume_dir, tid + ".fastresume")

    def _write_resume_file(self, alert) -> None:
        lt = _lt()
        try:
            tid = str(alert.params.info_hashes.v1)
            buf = lt.write_resume_data_buf(alert.params)
            tmp = self._resume_path(tid) + ".tmp"
            with open(tmp, "wb") as f:
                f.write(buf)
            os.replace(tmp, self._resume_path(tid))
        except Exception as e:
            log.debug("resume-data write failed: %s", e)

    def _load_resume_files(self, lt) -> None:
        try:
            names = os.listdir(self.resume_dir)
        except OSError:
            return
        for name in names:
            if not name.endswith(".fastresume"):
                continue
            path = os.path.join(self.resume_dir, name)
            try:
                with open(path, "rb") as f:
                    atp = lt.read_resume_data(f.read())
                h = self._ses.add_torrent(atp)
                self._handles[str(atp.info_hashes.v1)] = h
            except Exception as e:
                log.warning("stale resume file %s dropped: %s", name, e)
                try:
                    os.unlink(path)
                except OSError:
                    pass

    # ── alert pump ────────────────────────────────────────────────────────

    def _alert_loop(self) -> None:
        ticks = 0
        while not self._alert_stop.wait(ALERT_TICK_S):
            ticks += 1
            try:
                self._pump_alerts_once()
                # Checkpoint fastresume periodically, not just on stop(),
                # so a hard kill costs at most RESUME_SAVE_TICKS of progress
                # instead of a full re-hash on next start.
                if ticks % RESUME_SAVE_TICKS == 0:
                    self._request_resume_saves()
            except Exception as e:
                log.debug("alert pump error: %s", e)

    def _request_resume_saves(self) -> None:
        """Ask libtorrent to emit resume-data alerts for handles that
        changed since their last save. The alerts are picked up by the
        normal pump and written to disk — this method only requests.

        Extracted from the loop so tests can drive one checkpoint without
        waiting a real minute for the tick."""
        lt = _lt()
        if lt is None:
            return
        # save_info_dict rewrites the (rarely-changing) torrent metadata
        # too; absent on older builds, in which case a plain save is fine.
        flags = getattr(lt.torrent_handle, "save_info_dict", 0)
        with self._lock:
            handles = list(self._handles.values())
        for h in handles:
            try:
                if not h.is_valid():
                    continue
                # need_save_resume_data() is the state gate: it skips
                # handles with nothing new to persist (and metadata-less
                # magnets whose save would just fail). Older APIs lack it —
                # save unconditionally there.
                if (
                    hasattr(h, "need_save_resume_data")
                    and not h.need_save_resume_data()
                ):
                    continue
                h.save_resume_data(flags)
            except Exception as e:
                log.debug("periodic resume save skipped for a handle: %s", e)

    def _pump_alerts_once(self) -> None:
        ses = self._ses
        if ses is None:
            return
        for alert in ses.pop_alerts():
            name = alert.what()
            if name == "save_resume_data":
                self._write_resume_file(alert)
            elif name == "portmap":
                # UPnP/NAT-PMP mapped our port — we're now connectable.
                log.info("BT port mapped (connectable): %s", alert.message())
            elif name == "portmap_error":
                # Mapping failed — inbound peers can't reach us; expect slow
                # peer acquisition on thin swarms. Surface it so it's diagnosable.
                log.warning(
                    "BT port mapping failed (not connectable): %s", alert.message()
                )

    # ── BTBackend impl ────────────────────────────────────────────────────

    def add_torrent(
        self, source: str, *, dest_dir: str, options: dict | None = None
    ) -> str:
        lt = _lt()
        self._ensure_session()
        if source.startswith("magnet:"):
            atp = lt.parse_magnet_uri(source)
        elif source.startswith(("http://", "https://")):
            atp = lt.load_torrent_buffer(self._fetch_torrent_bytes(source))
        else:
            atp = lt.load_torrent_file(source)
        atp.save_path = dest_dir
        # No auto_managed: Zimi is the manager (ledger enforces caps,
        # policy passes stop seeds). Auto-management would resurrect
        # paused torrents behind our back.
        atp.flags &= ~lt.torrent_flags.auto_managed
        # Default add_torrent_params flags set BOTH auto_managed AND paused;
        # libtorrent's auto-manager is what normally unpauses. With auto_managed
        # stripped, nothing unpauses it, so an added torrent would sit paused
        # forever (never downloads, never seeds). Clear paused so it starts;
        # Zimi drives pause()/resume() explicitly from here on.
        atp.flags &= ~lt.torrent_flags.paused
        tid = str(atp.info_hashes.v1)
        with self._lock:
            if tid in self._handles and self._handles[tid].is_valid():
                return tid  # duplicate add — already managed
            self._handles[tid] = self._add_resolving_duplicate(atp, dest_dir)
        return tid

    # A staging seed that was just remove()d still holds its info-hash for a
    # brief window: libtorrent's remove_torrent is async, so re-adding the
    # same hash at the library path (post-download reseed, library.py) raises
    # "duplicate" while find_torrent still returns the STILL-REMOVING staging
    # handle — whose save_path points at staging, not the library dir. Adopting
    # it means the file silently never seeds until the next restart. Wait the
    # removing handle out instead, adopting only a handle that already sits at
    # the destination.
    _DUP_RETRY_ATTEMPTS = 20
    _DUP_RETRY_SLEEP_S = 0.1

    def _add_resolving_duplicate(self, atp, dest_dir: str):
        """Add atp, tolerating the async-remove duplicate window.

        Retries the add until it succeeds (the removing handle finally
        clears) or a found handle is confirmed to already live at dest_dir.
        Caller holds self._lock."""
        want = os.path.realpath(dest_dir)
        last_exc: Exception | None = None
        for _ in range(self._DUP_RETRY_ATTEMPTS):
            try:
                return self._ses.add_torrent(atp)
            except Exception as e:
                last_exc = e
                existing = self._ses.find_torrent(atp.info_hashes.v1)
                if existing is not None and existing.is_valid():
                    save_path = os.path.realpath(existing.status().save_path)
                    if save_path == want:
                        return existing  # genuinely already managed at dest
                # No valid handle yet, or a stale removing handle at the wrong
                # save_path — let the async remove finish, then retry the add.
                time.sleep(self._DUP_RETRY_SLEEP_S)
        # Window never closed. Adopt only if the survivor sits at dest.
        existing = self._ses.find_torrent(atp.info_hashes.v1)
        if (
            existing is not None
            and existing.is_valid()
            and os.path.realpath(existing.status().save_path) == want
        ):
            return existing
        raise last_exc if last_exc is not None else RuntimeError("add_torrent failed")

    def _fetch_torrent_bytes(self, url: str) -> bytes:
        """Bounded .torrent metadata fetch, done before the torrent joins the
        session. Holding the full metadata up front is what makes 'complete'
        unambiguously mean the *content* is complete — a two-phase add can
        report complete on metadata alone and hand back a truncated ZIM."""
        req = urllib.request.Request(url, headers={"User-Agent": "zimi"})
        with urllib.request.urlopen(req, timeout=TORRENT_FETCH_TIMEOUT_S) as resp:
            data = resp.read(TORRENT_FETCH_MAX_BYTES + 1)
        if len(data) > TORRENT_FETCH_MAX_BYTES:
            raise RuntimeError(f".torrent metadata too large from {url}")
        return data

    def pause(self, tid: str) -> None:
        h = self._handles.get(tid)
        if h is not None and h.is_valid():
            h.pause()

    def resume(self, tid: str) -> None:
        h = self._handles.get(tid)
        if h is not None and h.is_valid():
            h.resume()

    def remove(self, tid: str, *, delete_files: bool = False) -> None:
        """delete_files only ever deletes payload under the staging dir.

        libtorrent's delete_files flag REALLY deletes, and mirror seeds point
        at library ZIMs — passing it straight through would let
        stop_mirror_seeds() erase the library. Staging partials are ours to
        clean; library files never."""
        lt = _lt()
        with self._lock:
            h = self._handles.pop(tid, None)
        if h is not None and h.is_valid() and self._ses is not None:
            in_staging = False
            try:
                # realpath, not normpath: a symlink textually under staging
                # but physically pointing outside must NOT count as staging,
                # or it would defeat the library-payload delete guard.
                save_path = os.path.realpath(h.status().save_path)
                staging = os.path.realpath(self.staging_dir)
                in_staging = save_path == staging or save_path.startswith(
                    staging + os.sep
                )
            except Exception:
                pass
            flags = lt.session.delete_files if (delete_files and in_staging) else 0
            try:
                self._ses.remove_torrent(h, flags)
            except Exception as e:
                log.debug("remove_torrent failed for %s: %s", tid, e)
        try:
            os.unlink(self._resume_path(tid))
        except OSError:
            pass

    def status(self, tid: str) -> dict:
        lt = _lt()
        h = self._handles.get(tid)
        if h is None or not h.is_valid():
            return {
                "state": "removed",
                "gid": tid,
                "completed_bytes": 0,
                "total_bytes": 0,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 0,
                "seeders": 0,
                "ratio": 0.0,
                "info_hash": tid,
                "error_code": "",
                "error_message": "",
            }
        s = h.status()
        if s.errc.value() != 0:
            state = "error"
        elif bool(s.flags & lt.torrent_flags.paused):
            state = "paused"
        elif s.state in (lt.torrent_status.seeding, lt.torrent_status.finished):
            # Content is done — the caller installs the file while seeding
            # continues on the live handle.
            state = "complete"
        else:
            # checking_files / downloading_metadata / downloading /
            # checking_resume_data all present as in-progress.
            state = "downloading"
        total = int(s.total_wanted)
        # Distinct from "downloading" so the delta-update path can wait for the
        # hash check to finish before snapshotting the salvaged (reused) bytes.
        # status() collapses checking into "downloading" for the progress UI;
        # this flag exposes it without changing that contract.
        checking = s.state in (
            lt.torrent_status.checking_files,
            lt.torrent_status.checking_resume_data,
        )
        return {
            "state": state,
            "checking": checking,
            "gid": tid,
            "completed_bytes": int(s.total_done),
            "total_bytes": total,
            "down_speed": int(s.download_payload_rate),
            "up_speed": int(s.upload_payload_rate),
            "peers": int(s.num_peers),
            "seeders": int(s.num_seeds),
            "ratio": float(s.all_time_upload) / max(total, 1),
            "info_hash": tid,
            "error_code": str(s.errc.value()) if s.errc.value() else "",
            "error_message": s.errc.message() if s.errc.value() else "",
        }

    def list_managed(self) -> list[dict]:
        lt = _lt()
        out = []
        for tid, h in list(self._handles.items()):
            if not h.is_valid():
                continue
            try:
                s = h.status()
            except Exception:
                continue
            if s.errc.value() != 0:
                status = "error"
            elif bool(s.flags & lt.torrent_flags.paused):
                status = "paused"
            else:
                status = "active"
            ti = h.torrent_file()
            files = []
            total = int(s.total_wanted)
            if ti is not None:
                fs = ti.files()
                files = [
                    {"path": os.path.join(s.save_path, fs.file_path(i))}
                    for i in range(fs.num_files())
                ]
                total = int(ti.total_size())
            done = int(s.total_done)
            wanted = int(s.total_wanted)
            # Has all the data? Mirror status()'s completion test: the engine
            # flags it seeding/finished, or the payload is fully in hand.
            is_seeder = s.state in (
                lt.torrent_status.seeding,
                lt.torrent_status.finished,
            ) or (wanted > 0 and done >= wanted)
            out.append(
                {
                    "gid": tid,
                    "status": status,
                    "files": files,
                    "completedLength": str(done),
                    "uploadLength": str(int(s.all_time_upload)),
                    "totalLength": str(total),
                    "infoHash": tid,
                    # manage.py tests `seeder in ("true", True)` — keep the
                    # string form or seeding rows silently read as leechers.
                    "seeder": "true" if is_seeder else "false",
                }
            )
        return out

    def set_global_rate_limits(self, up_kb: int, down_kb: int) -> None:
        self._ensure_session()
        self._ses.apply_settings(
            {
                "upload_rate_limit": max(0, int(up_kb)) * 1024,
                "download_rate_limit": max(0, int(down_kb)) * 1024,
            }
        )

    def purge_stopped(self, keep_errors: bool = True) -> None:
        """No-op: libtorrent has no stopped-results ledger to groom.
        Finished downloads keep seeding on their live handle; policy
        passes remove() them when a cap is hit."""


# ============================================================================
# Selection
# ============================================================================


_backend_singleton: BTBackend | None = None
_backend_lock = threading.Lock()


def get_backend(*, data_dir: str) -> BTBackend | None:
    """Return the libtorrent backend, or None (→ HTTP floor).

    None when: BT disabled, libtorrent unimportable on this install, or
    the session fails to start. Never crashes Zimi for a BT problem —
    HTTP is the universal transport underneath.
    """
    global _backend_singleton
    with _backend_lock:
        if not is_torrent_enabled():
            return None
        if _backend_singleton is not None:
            return _backend_singleton
        backend = LibtorrentBackend(
            bt_port=get_bt_port(),
            data_dir=data_dir,
            staging_dir=get_staging_dir(data_dir),
        )
        if not backend.available():
            log.info("BT unavailable (libtorrent missing?) — HTTP downloads only")
            return None
        log.info(
            "BT engine libtorrent ready on port %d (staging=%s)",
            backend.bt_port,
            backend.staging_dir,
        )
        _backend_singleton = backend
        return backend


def peek_backend() -> "BTBackend | None":
    """Return the already-running backend, or None — never starts one.

    Status views and ambient polls must use this instead of get_backend():
    with BT on by default, get_backend() would start the session on every
    poll tick.
    """
    with _backend_lock:
        return _backend_singleton


def shutdown_backend() -> None:
    """Stop the running engine (if any). Safe to call repeatedly."""
    global _backend_singleton
    with _backend_lock:
        if _backend_singleton is not None:
            try:
                _backend_singleton.stop()
            except Exception:
                pass
        _backend_singleton = None
