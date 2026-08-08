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
  ZIM_DIR        Path to directory containing *.zim files (default: /zims)
  ZIMI_DATA_DIR  Where Zimi keeps its own state (default: <ZIM_DIR>/.zimi)
  ZIMI_HOST      Address to bind (default: 0.0.0.0)
  ZIMI_PORT      Port to bind (default: 8899)
  ZIMI_CONFIG    Path to a JSON config file (default: <data dir>/zimi.json)
  ZIMI_MANAGE    Enabled by default; set to "0" to disable management endpoints

  Precedence is CLI flag > environment > config file > built-in default: the
  file sits below the environment so adding one can never change how a running
  deployment behaves. `zimi config` prints the resolved values and their
  provenance.

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
import collections
import glob
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import tempfile
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

ZIMI_VERSION = "1.8.2"

# Standing maintenance cadence: catalog TTL is 24h and UPnP leases are
# 24h — run every 12h so both stay fresh at half-life.
_MAINTENANCE_INTERVAL = 12 * 3600


_background_services_started = False


def _bt_prefs_path():
    """Where the BT/sharing prefs live. One derivation shared by the serve
    boot and the headless backup/restore CLI — if the two disagreed, a CLI
    backup would silently carry empty sharing prefs."""
    return os.path.join(ZIMI_DATA_DIR, "bt", "prefs.json")


def start_background_services(http_port):
    """P2P init, download resume, NAT/UPnP probe, LAN discovery, mirror
    upkeep, and the 12h maintenance loop — shared by the serve CLI and
    the desktop app (which builds its own HTTP server and used to miss
    ALL of this; BT only worked there via the lazy download-time spawn).

    Everything network-ish runs on background threads: nothing here may
    delay READY / the first request. Starting the BT engine once stalled
    startup for minutes. All parts fail soft."""
    global _background_services_started
    if _background_services_started:
        return
    _background_services_started = True

    from zimi import p2p

    # Prefs path must be set before the first request can read/write BT
    # settings — cheap, so it stays synchronous.
    p2p.set_prefs_path(_bt_prefs_path())

    # Registered unconditionally, not just when the startup start succeeds:
    # the session can come up LATER (port change, mirror enable, lazy
    # download-time start). shutdown_backend saves fastresume and no-ops
    # without a backend.
    import atexit

    atexit.register(p2p.shutdown_backend)
    # Registered AFTER shutdown_backend so it runs BEFORE it (atexit is
    # LIFO): the final accounting pass reads the engine's upload counters
    # while the session is still alive, so a clean shutdown loses no upload.
    from zimi import library as _lib_flush

    atexit.register(_lib_flush.flush_seed_accounting)

    def _init_p2p_background():
        try:
            backend = p2p.get_backend(data_dir=ZIMI_DATA_DIR)
            if backend:
                # Ask the router to open the BT port + record
                # reachability for the settings UI. Fails soft.
                try:
                    from zimi import p2p_nat

                    p2p_nat.probe(p2p.get_bt_port(), try_upnp=p2p.is_upnp_enabled())
                except Exception as e:
                    log.debug("NAT probe failed: %s", e)
        except Exception as e:
            log.warning("BT backend init failed (HTTP downloads unaffected): %s", e)
        try:
            from zimi import p2p_discovery as _disc

            _disc.start(
                http_port=http_port,
                # Advertise the port the engine actually listens on —
                # get_bt_port() honors the ZIMI_BT blob's port= and the
                # persisted UI pref; reading the raw env told peers 6881
                # while the session (and the NAT probe) used the configured
                # port.
                bt_port=p2p.get_bt_port(),
                zim_count=len(list_zims()),
                version=ZIMI_VERSION,
            )
            import atexit

            atexit.register(_disc.stop)
        except Exception as e:
            # repr + type: zeroconf raises exceptions with empty str()
            log.warning("Peer discovery startup failed: %s: %r", type(e).__name__, e)
        # Downloads that were in flight or queued when the server stopped
        # restart themselves (after the BT backend is up so they can take
        # the torrent-first path again).
        try:
            from zimi import library as _lib

            _lib.resume_pending_downloads()
            # Watcher that releases night-window-scheduled downloads when the
            # window opens (no-op unless the user enabled download scheduling).
            _lib.start_download_scheduler()
            # Mirror mode seeds the whole installed library; either way,
            # drop seeds whose file an update has replaced, and bring
            # session-resumed seeds under the CURRENT settings (a seed
            # added under old settings otherwise keeps its old cap forever).
            _lib.retire_stale_seeds()
            _lib.apply_seed_policy()
            _lib.reseed_from_ledger()
            _lib.mirror_sync()
            _lib.archive_catalog_torrents()
            _lib.ensure_magnets_for_installed()
            # Continuous upload books: sample the engine every 30s so the ledger
            # tracks lifetime upload closely and the ratio cap is enforced
            # within half a minute, not at the 12h maintenance cadence.
            threading.Thread(
                target=_lib.seed_accounting_loop,
                daemon=True,
                name="seed-accounting",
            ).start()
        except Exception as e:
            log.warning("Download resume failed: %s", e)

    threading.Thread(target=_init_p2p_background, daemon=True, name="p2p-init").start()

    # Standing maintenance, independent of anyone visiting the site:
    # refresh the offline catalog copy before it goes stale, renew the
    # UPnP mapping at half-lease (24h lease dies silently otherwise),
    # keep magnet manifest / mirror seeds / torrent archive current.
    def _maintenance_loop():
        import random as _random_mod

        # Jitter so a fleet of Zimis doesn't hit Kiwix on the hour
        time.sleep(_MAINTENANCE_INTERVAL / 2 + _random_mod.uniform(0, 3600))
        while True:
            _maintenance_pass()
            time.sleep(_MAINTENANCE_INTERVAL + _random_mod.uniform(0, 3600))

    threading.Thread(target=_maintenance_loop, daemon=True, name="maintenance").start()


def _maintenance_pass():
    """One standing-maintenance sweep: renew the UPnP mapping (24h lease
    dies silently otherwise), refresh the offline catalog inside its TTL,
    keep magnets / mirror seeds / torrent archive current. Runs on the
    12h loop; extracted so tests can pin it."""
    from zimi import library as _lib
    from zimi import p2p as _p2p

    try:
        if _p2p.is_torrent_enabled() and _p2p.peek_backend():
            from zimi import p2p_nat

            p2p_nat.probe(_p2p.get_bt_port(), try_upnp=_p2p.is_upnp_enabled())
    except Exception as e:
        log.debug("maintenance: NAT renew failed: %s", e)
    try:
        # Gated: only instances that consume the catalog (Mirror mode,
        # auto-update, recent user browsing) refresh it; idle Zimis make
        # zero standing kiwix.org requests.
        _lib.maintenance_catalog_refresh()
        _lib._magnets_ensured = False
        _lib.ensure_magnets_for_installed()
        _lib.retire_stale_seeds()
        _lib.apply_seed_policy()
        _lib.reseed_from_ledger()
        _lib._catalog_torrents_archived = False
        _lib.mirror_sync()
        _lib.archive_catalog_torrents()
    except Exception as e:
        log.debug("maintenance pass failed: %s", e)


log = logging.getLogger("zimi")
logging.basicConfig(
    format="%(asctime)s %(message)s", datefmt="%H:%M:%S", level=logging.INFO
)

DEFAULT_ZIM_DIR = "/zims"
DEFAULT_DATA_DIR_NAME = ".zimi"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8899

# ---------------------------------------------------------------------------
# Zero-config ZIM discovery (1.9 portable mode)
#
# When NOTHING names a ZIM directory — no flag, no env, no config file — the
# resolver used to fall straight to the hardcoded fallback (`/zims`, or the
# desktop app's `~/Zimi`). Discovery slots in strictly between "nobody said
# anything" and that fallback: it probes the directory holding the executable
# (a frozen build on a USB stick), the folder a macOS .app bundle sits in, and
# the working directory, for `*.zim` files or a `zims/` child holding them.
#
# The compatibility contract (docs/plans/2026-08-07-v19-plan.md) is why this
# is a separate, explicitly-passed layer rather than a smarter default: an
# explicit ZIM_DIR, --zim-dir, config-file zim_dir, or a desktop-configured
# folder must ALWAYS beat a discovered one, and the precedence tests pin that.
# ---------------------------------------------------------------------------

DISCOVERY_ZIMS_SUBDIR = "zims"
# The locations the last discover_zim_dir() call actually probed — surfaced in
# the empty-library boot message so "where should I put my files?" has a
# concrete answer for every install type, not just Docker.
_discovery_probed = []


def _dir_holding_zims(candidate):
    """The directory Zimi should serve from `candidate`, or None.

    A hit is `*.zim` directly in the candidate, else in a `zims/` child —
    the two shapes a hand-assembled folder of ZIMs actually has."""
    for d in (candidate, os.path.join(candidate, DISCOVERY_ZIMS_SUBDIR)):
        if glob.glob(os.path.join(d, "*.zim")):
            return d
    return None


def discovery_candidates():
    """Where discovery looks, in priority order: executable dir (frozen
    builds only — for a source checkout it would be the Python bin dir),
    the folder a macOS .app bundle sits in, then the working directory."""
    cands = []
    if getattr(sys, "frozen", False) or getattr(sys, "_MEIPASS", None):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        cands.append(exe_dir)
        # Zimi.app/Contents/MacOS/<exe> → the folder holding Zimi.app; that is
        # the stick root when someone drags the app next to their ZIMs.
        if exe_dir.replace("\\", "/").endswith(".app/Contents/MacOS"):
            cands.append(os.path.dirname(os.path.dirname(os.path.dirname(exe_dir))))
    try:
        cands.append(os.getcwd())
    except OSError:
        pass  # cwd can be deleted from under a long-lived shell
    seen = set()
    return [c for c in cands if not (c in seen or seen.add(c))]


def discover_zim_dir(candidates=None):
    """Probe the candidate locations for ZIMs. First hit wins; None if none.

    Only ever consulted when zim_dir would otherwise resolve to the hardcoded
    default — callers pass the result into resolve_settings(), which applies
    it below every explicit source."""
    global _discovery_probed
    candidates = discovery_candidates() if candidates is None else list(candidates)
    _discovery_probed = candidates
    for cand in candidates:
        hit = _dir_holding_zims(cand)
        if hit:
            return hit
    return None


# ---------------------------------------------------------------------------
# Headless configuration file
#
# One JSON file that describes an instance, so a deployment can be handed over
# without click-through setup. JSON and not TOML/YAML on purpose: the package
# supports Python 3.9 (no `tomllib`) and stays stdlib-only (no PyYAML), and
# every other file Zimi writes is already JSON.
#
# Scope is deliberately small: only settings that must be known *before* the
# server boots. Everything that already has its own state file plus an admin UI
# (access mode, auto-update, download schedule, seeding) stays where it is —
# folding those in is a migration question, not a config question.
#
# The file sits BELOW the environment in precedence, which is the whole
# compatibility argument: a running Docker/compose deployment that sets ZIM_DIR
# keeps winning, so dropping a config file next to an existing instance can
# never change how it behaves. Adding config can only fill in what nobody else
# said.
# ---------------------------------------------------------------------------

CONFIG_FILENAME = "zimi.json"
CONFIG_ENV_VAR = "ZIMI_CONFIG"
# The only keys v1 understands. Anything else is warned about, never fatal:
# failing a boot over an unknown key punishes people for a forward-compatible
# file, but silently swallowing a typo is a support ticket.
CONFIG_KEYS = ("zim_dir", "data_dir", "host", "port")


class ConfigError(Exception):
    """A config file was found but cannot be used.

    Always carries the offending path in the message — "invalid JSON" with no
    filename is exactly the error someone with three mounted config files
    cannot act on.
    """


def load_config_file(path):
    """Read and validate one config file. Returns a dict of known keys.

    Raises ConfigError (never a traceback) for anything a deployer can fix:
    unreadable file, malformed JSON, a top-level array, a wrong-typed value.
    Unknown keys are logged and dropped.
    """
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        raise ConfigError(f"config file {path}: cannot read it ({e.strerror})")
    # An empty file is a legitimate "I have nothing to say" — treat it as {}
    # rather than as a JSON syntax error, since `touch zimi.json` is a normal
    # first step and failing there is a bad first impression.
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise ConfigError(f"config file {path}: invalid JSON ({e})")
    if not isinstance(data, dict):
        raise ConfigError(
            f"config file {path}: expected a JSON object, got {type(data).__name__}"
        )

    unknown = [k for k in data if k not in CONFIG_KEYS]
    if unknown:
        log.warning(
            "config file %s: ignoring unknown key(s): %s (known keys: %s)",
            path,
            ", ".join(sorted(unknown)),
            ", ".join(CONFIG_KEYS),
        )

    config = {}
    for key in CONFIG_KEYS:
        if key not in data:
            continue
        value = data[key]
        if key == "port":
            config[key] = _coerce_port(value, f"config file {path}")
        elif not isinstance(value, str):
            raise ConfigError(
                f"config file {path}: {key} must be a string, "
                f"got {type(value).__name__}"
            )
        else:
            config[key] = value
    return config


def _coerce_port(value, origin):
    """Ports arrive as a JSON number, an env string, or an argparse int."""
    if isinstance(value, bool):  # bool is an int subclass; reject it explicitly
        raise ConfigError(f"{origin}: port must be a number, got boolean")
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ConfigError(f"{origin}: port must be a number, got {value!r}")
    # 0 stays legal: `--port 0` is how the smoke tests ask the OS for a free one.
    if not 0 <= port <= 65535:
        raise ConfigError(f"{origin}: port {port} is outside 0-65535")
    return port


def find_config_file(config_flag=None, env=None, data_dir=None):
    """Locate the config file: --config, else ZIMI_CONFIG, else <data dir>/zimi.json.

    A path someone named explicitly must exist — a typo'd --config that boots
    with silently different settings is worse than a refusal. The implicit
    ``<data dir>`` location is the opposite: absence is the normal case for
    every install that predates this feature, so it is silent.
    """
    env = os.environ if env is None else env
    for value, origin in (
        (config_flag, "--config"),
        (env.get(CONFIG_ENV_VAR), CONFIG_ENV_VAR),
    ):
        if value:
            if not os.path.isfile(value):
                raise ConfigError(f"config file {value}: no such file ({origin})")
            return value
    if data_dir:
        implicit = os.path.join(data_dir, CONFIG_FILENAME)
        if os.path.isfile(implicit):
            return implicit
    return None


def load_config(
    zim_dir_flag=None,
    data_dir_flag=None,
    config_flag=None,
    env=None,
    discovered_zim_dir=None,
):
    """Discovery + read: the one impure step. Returns ``(config, path_or_None)``.

    Kept separate from resolution so ``resolve_settings`` stays a pure function
    of (flags, env, config) and the precedence matrix is testable without
    touching a filesystem.

    Note the small circularity in the implicit location: to look for
    ``<data dir>/zimi.json`` we must first know the data dir, which is resolved
    from flags, env and the discovery probe only. That is deliberate — a file
    can only be *found* somewhere the flags/env/defaults (or a discovered stick,
    whose ``<stick>/.zimi/zimi.json`` makes it self-describing) already point,
    and a file found there may still relocate the data dir for everything else.
    """
    env = os.environ if env is None else env
    _, probe_data_dir = resolve_data_paths(
        zim_dir_flag, data_dir_flag, env, discovered_zim_dir=discovered_zim_dir
    )
    path = find_config_file(config_flag, env, probe_data_dir)
    if not path:
        return {}, None
    return load_config_file(path), path


def resolve_settings(
    zim_dir_flag=None,
    data_dir_flag=None,
    host_flag=None,
    port_flag=None,
    env=None,
    config=None,
    config_path=None,
    discovered_zim_dir=None,
):
    """Resolve every boot setting, with the provenance of each one.

    Returns an ordered ``{key: (value, source)}`` mapping where source is a
    human string like ``env: ZIM_DIR`` — `zimi config` prints it verbatim, and
    "where did this value come from" is the question that actually costs people
    time when a deployment misbehaves.

    Precedence, strictly: flag > environment > config file > discovered >
    built-in default. ``discovered_zim_dir`` is the fifth, lowest layer: it
    only ever replaces the hardcoded fallback, never a value any person or
    file supplied — that is the 1.9 compatibility contract, and it is why
    discovery is an argument (the impure probe stays in the caller) rather
    than something this function goes looking for.
    Pure: pass ``env``, ``config`` and ``discovered_zim_dir`` in, get values out.
    """
    env = os.environ if env is None else env
    config = {} if config is None else config
    file_source = f"config file: {config_path}" if config_path else "config file"

    def pick(flag, flag_name, env_key, key, default, default_note=None):
        if flag is not None:
            return flag, f"flag: {flag_name}"
        # `in`, not `.get()` truthiness: `ZIM_DIR=` resolves to the empty
        # string today and must keep doing so.
        if env_key in env:
            return env[env_key], f"env: {env_key}"
        if key in config:
            return config[key], file_source
        return default, f"default: {default_note}" if default_note else "default"

    zim_dir, zim_dir_src = pick(
        zim_dir_flag, "--zim-dir", "ZIM_DIR", "zim_dir", DEFAULT_ZIM_DIR
    )
    # Discovery fills in ONLY what was the hardcoded fallback: `pick` says
    # "default" exactly when no flag, env or config named a zim_dir. Applied
    # before the data-dir derivation below so a discovered stick carries its
    # state (`<stick>/.zimi`) with it.
    if discovered_zim_dir is not None and zim_dir_src.startswith("default"):
        zim_dir, zim_dir_src = discovered_zim_dir, f"discovered: {discovered_zim_dir}"
    # The derived `<zim dir>/.zimi` is a *default*, so an explicit data dir from
    # any layer beats it — that is what keeps `--zim-dir /media/usb` from
    # dragging state away from a configured ZIMI_DATA_DIR.
    data_dir, data_dir_src = pick(
        data_dir_flag,
        "--data-dir",
        "ZIMI_DATA_DIR",
        "data_dir",
        os.path.join(zim_dir, DEFAULT_DATA_DIR_NAME),
        f"<zim_dir>/{DEFAULT_DATA_DIR_NAME}",
    )
    host, host_src = pick(host_flag, "--host", "ZIMI_HOST", "host", DEFAULT_HOST)
    port, port_src = pick(port_flag, "--port", "ZIMI_PORT", "port", DEFAULT_PORT)
    if not isinstance(port, int) or isinstance(port, bool):
        port = _coerce_port(port, port_src)

    return collections.OrderedDict(
        (
            ("zim_dir", (zim_dir, zim_dir_src)),
            ("data_dir", (data_dir, data_dir_src)),
            ("host", (host, host_src)),
            ("port", (port, port_src)),
        )
    )


def format_config_report(settings):
    """Render `zimi config` output: value plus where it came from, one per line."""
    name_w = max(len(k) for k in settings)
    value_w = max(len(str(v)) for v, _ in settings.values())
    lines = []
    for key, (value, source) in settings.items():
        lines.append(f"{key:<{name_w}}  {str(value):<{value_w}}  ({source})")
    return "\n".join(lines)


def resolve_data_paths(
    zim_dir_flag=None,
    data_dir_flag=None,
    env=None,
    config=None,
    discovered_zim_dir=None,
):
    """Resolve ``(ZIM_DIR, ZIMI_DATA_DIR)`` from flags, environment and config.

    Precedence is flag > environment > config file > discovered > default, and
    the default data dir follows whichever ZIM dir won — so ``--zim-dir`` alone
    moves the state with it, while an explicit ``ZIMI_DATA_DIR`` stays put.
    Pure so the precedence rules can be tested without touching the process
    globals.
    """
    settings = resolve_settings(
        zim_dir_flag=zim_dir_flag,
        data_dir_flag=data_dir_flag,
        env=env,
        config=config,
        discovered_zim_dir=discovered_zim_dir,
    )
    return settings["zim_dir"][0], settings["data_dir"][0]


# ---------------------------------------------------------------------------
# Read-only media: automatic data-dir fallback (1.9 portable mode, phase 3)
#
# A ZIM library on a read-only stick/DVD/locked share used to boot with four
# permission errors and silently lose the title index, did-you-mean and Q-ID
# links, and rebuild the metadata cache on every start. When the data dir is
# the DERIVED default (`<zim_dir>/.zimi`) and turns out unwritable, state is
# rerouted to a stable per-library directory under the platform user-cache
# location instead, so indexes persist across boots of the same library.
#
# Two deliberate asymmetries:
#   * An EXPLICITLY configured data dir (--data-dir, ZIMI_DATA_DIR, config
#     file) that is unwritable is an error, never a fallback — the user asked
#     for that path, and dying with one clear line beats silently writing
#     somewhere else.
#   * If `<zim_dir>/.zimi` already EXISTS but is unwritable, its contents are
#     ignored and the cache dir is used wholesale. Reading stick indexes while
#     writing new state elsewhere would be a two-layer overlay; the simple
#     rule (documented in docs/plans/2026-08-07-zero-config-portable.md) is
#     one data dir at a time.
# ---------------------------------------------------------------------------


class DataDirError(Exception):
    """An explicitly configured data dir cannot be written.

    Same contract as ConfigError: an operator mistake reported as one clear
    line (main() exits 2), never a traceback."""


def _platform_cache_root():
    """Per-user cache location, stdlib only (no platformdirs dependency)."""
    if sys.platform == "darwin":
        return os.path.expanduser(os.path.join("~", "Library", "Caches", "Zimi"))
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser(
            os.path.join("~", "AppData", "Local")
        )
        return os.path.join(base, "Zimi", "Cache")
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser(
        os.path.join("~", ".cache")
    )
    # Lowercase on XDG systems, capitalized on macOS/Windows — each platform's
    # own convention for vendor dirs.
    return os.path.join(base, "zimi")


def fallback_data_dir(zim_dir):
    """The stable cache-dir stand-in for an unwritable `<zim_dir>/.zimi`.

    Stability is the point: indexes built on the first boot of a read-only
    library must be found again on the next one, so the name is a pure
    function of the library's real path — a readable prefix (the folder name,
    sanitized) plus a hash tail that disambiguates same-named folders on
    different mounts."""
    real = os.path.realpath(zim_dir)
    tail = hashlib.sha256(real.encode("utf-8", "surrogatepass")).hexdigest()[:10]
    base = os.path.basename(real.rstrip("/\\")) or "library"
    prefix = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-.")[:40] or "library"
    return os.path.join(_platform_cache_root(), f"{prefix}-{tail}")


def _dir_is_writable(path):
    """Probe writability by actually writing: mkdir + tempfile + unlink.

    Not os.access(): network mounts and read-only remounts routinely report
    writable modes for directories that reject every write. If the probe had
    to create the directory, it removes it again on the way out — `zimi
    config` must be able to ask the question without scattering empty dirs."""
    existed = os.path.isdir(path)
    try:
        os.makedirs(path, exist_ok=True)
        fd, probe = tempfile.mkstemp(dir=path, prefix=".zimi-write-probe-")
        os.close(fd)
        os.remove(probe)
        ok = True
    except OSError:
        ok = False
    if not existed:
        try:
            os.rmdir(path)  # only succeeds when empty, so state is never lost
        except OSError:
            pass
    return ok


def _ensure_writable_data_dir():
    """Reroute ZIMI_DATA_DIR to the per-library cache dir when the derived
    default is unwritable. Raises DataDirError for an explicit dir instead.

    Idempotent and cheap: after a reroute the bound dir IS writable, so a
    second call (main() runs it early for the CLI exit-code contract, _init()
    runs it for library/desktop entry points) is a silent no-op — the log
    line below appears exactly once per boot."""
    global ZIMI_DATA_DIR, _data_dir_fallback_from
    if _dir_is_writable(ZIMI_DATA_DIR):
        return
    if not _data_dir_source.startswith("default"):
        raise DataDirError(
            f"data dir {ZIMI_DATA_DIR} is not writable ({_data_dir_source}); "
            "fix its permissions or point --data-dir/ZIMI_DATA_DIR at a "
            "writable location"
        )
    # A missing ZIM dir means there is no library to keep state for — keep
    # today's fail-soft boot rather than manufacturing a cache dir for it.
    if not os.path.isdir(ZIM_DIR):
        return
    stale_state = os.path.isdir(ZIMI_DATA_DIR)
    fallback = fallback_data_dir(ZIM_DIR)
    if not _dir_is_writable(fallback):
        log.warning(
            "Data dir %s is not writable and neither is the cache fallback %s; "
            "state writes will fail soft",
            ZIMI_DATA_DIR,
            fallback,
        )
        return
    # The one promised log line: where state went, and why. When a read-only
    # `.zimi` already sits beside the ZIMs it is NOT read live (no two-layer
    # overlay): the standard cross-directory migration in _migrate_data_files
    # copies it once into a fresh fallback dir, and after that the cache dir
    # is the sole data dir.
    log.warning(
        "Data dir %s is not writable (read-only media?); keeping state in %s "
        "instead — it persists there across boots of this library%s",
        ZIMI_DATA_DIR,
        fallback,
        (
            "; the read-only state beside the ZIMs stays untouched (seeded "
            "into the cache dir once, never read live)"
            if stale_state
            else ""
        ),
    )
    _data_dir_fallback_from = ZIMI_DATA_DIR
    ZIMI_DATA_DIR = fallback


ZIM_DIR, ZIMI_DATA_DIR = resolve_data_paths()
# Provenance of the bound data dir, kept in lockstep with the binding above and
# in apply_data_paths(). "default: …" is the derived `<zim_dir>/.zimi`; anything
# else marks an explicit choice, which _ensure_writable_data_dir refuses to
# override. _data_dir_fallback_from records a reroute for `zimi config`.
_data_dir_source = resolve_settings()["data_dir"][1]
_data_dir_fallback_from = None
ZIMI_MANAGE = os.environ.get("ZIMI_MANAGE", "1") == "1"
_initialized = False


def apply_data_paths(
    zim_dir_flag=None, data_dir_flag=None, config=None, discovered_zim_dir=None
):
    """Rebind the path globals from CLI flags, before anything reads them.

    Every consumer resolves ``_srv.ZIM_DIR`` / ``_srv.ZIMI_DATA_DIR`` at call
    time (no module derives a constant from either), so rebinding here is
    enough — but only if it happens before ``_init()`` creates the data dir
    and runs migrations. ``main()`` calls this immediately after argparse and
    before ``load_cache()``.
    """
    global ZIM_DIR, ZIMI_DATA_DIR, _data_dir_source, _data_dir_fallback_from
    settings = resolve_settings(
        zim_dir_flag=zim_dir_flag,
        data_dir_flag=data_dir_flag,
        config=config,
        discovered_zim_dir=discovered_zim_dir,
    )
    ZIM_DIR, ZIMI_DATA_DIR = settings["zim_dir"][0], settings["data_dir"][0]
    # Rebinding invalidates any earlier read-only reroute: the fallback
    # decision belongs to whichever paths are bound when _init() runs.
    _data_dir_source = settings["data_dir"][1]
    _data_dir_fallback_from = None
    return ZIM_DIR, ZIMI_DATA_DIR


def _init():
    """Initialize data directory and run migrations. Called lazily on first use."""
    global _initialized
    if _initialized:
        return
    _initialized = True
    # Read-only media check first, so the makedirs below (and every migration
    # after it) already targets the rerouted dir. Raises DataDirError for an
    # explicitly configured unwritable dir — main() converts that to exit 2.
    _ensure_writable_data_dir()
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
    if (
        ZIMI_DATA_DIR == "/config"
        and os.path.isdir("/data")
        and not os.path.exists("/config/cache.json")
    ):
        data_files = [
            "cache.json",
            "collections.json",
            "history.json",
            "suggest_cache.json",
            "auto_update.json",
            "password",
        ]
        migrated_any = False
        for fname in data_files:
            old = os.path.join("/data", fname)
            if os.path.exists(old) and not os.path.exists(
                os.path.join("/config", fname)
            ):
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
    if os.path.normpath(ZIMI_DATA_DIR) != os.path.normpath(
        old_data_dir
    ) and os.path.isdir(old_data_dir):
        # Only migrate if new data dir has no cache yet (fresh destination)
        if not os.path.exists(os.path.join(ZIMI_DATA_DIR, "cache.json")):
            data_files = [
                "cache.json",
                "collections.json",
                "history.json",
                "suggest_cache.json",
                "auto_update.json",
                "password",
            ]
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

    # 4. Stray .torrent companions in ZIM_DIR → ZIMI_DATA_DIR/bt/torrents
    _migrate_stray_torrent_files()


def _migrate_stray_torrent_files():
    """Move any ``*.torrent`` companions out of ZIM_DIR into the cache dir.

    Torrent metadata belongs under ``ZIMI_DATA_DIR/bt/torrents`` — never beside
    the ZIMs. Older installs (aria2-era, pre-1.8) left ``<name>.zim.torrent``
    next to the ZIM; those are bencoded metadata, not ZIMs, so a health scan
    flags them and zimcheck chokes on one with "Invalid magic number", looking
    like ZIM corruption (#38). Move them once — non-recursive listdir, never a
    walk — repoint any torrents-manifest record that referenced the old
    in-library path, and log a single summary line. Idempotent."""
    try:
        strays = [f for f in os.listdir(ZIM_DIR) if f.endswith(".torrent")]
    except OSError:
        return
    if not strays:
        return
    tdir = os.path.join(ZIMI_DATA_DIR, "bt", "torrents")
    try:
        os.makedirs(tdir, exist_ok=True)
    except OSError:
        return
    moved = {}  # old ZIM_DIR path -> new bt/torrents path
    for fn in strays:
        src = os.path.join(ZIM_DIR, fn)
        dst = os.path.join(tdir, fn)
        if os.path.exists(dst):
            # A good copy is already archived — drop the in-library litter.
            try:
                os.remove(src)
                moved[os.path.normpath(src)] = dst
            except OSError:
                pass
            continue
        try:
            os.replace(src, dst)  # same-filesystem fast path
        except OSError:
            try:
                shutil.copy2(src, dst)
                os.remove(src)
            except OSError:
                continue
        moved[os.path.normpath(src)] = dst
    if not moved:
        return
    # Repoint any manifest record whose torrent_file pointed into ZIM_DIR.
    manifest_path = os.path.join(ZIMI_DATA_DIR, "bt", "torrents.json")
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        manifest = None
    if isinstance(manifest, dict):
        changed = False
        for entry in manifest.values():
            if not isinstance(entry, dict):
                continue
            tf = entry.get("torrent_file")
            if tf and os.path.normpath(tf) in moved:
                entry["torrent_file"] = moved[os.path.normpath(tf)]
                changed = True
        if changed:
            try:
                _atomic_write_json(manifest_path, manifest)
            except OSError:
                pass
    log.info(
        "Moved %d stray .torrent file(s) out of ZIM_DIR into bt/torrents", len(moved)
    )


# ============================================================================
# Constants & Shared Utilities
# ============================================================================

# (Password & Authentication → zimi/manage.py)
# (Rate Limiting, Metrics & Usage → zimi/http.py)

MAX_CONTENT_LENGTH = (
    8000  # chars returned per article, keeps responses manageable for LLMs
)
READ_MAX_LENGTH = 50000  # longer limit for the web UI reader
MAX_SEARCH_LIMIT = (
    50  # upper bound for search results per ZIM to prevent resource exhaustion
)
MAX_CONTENT_BYTES = (
    10 * 1024 * 1024
)  # 10 MB — skip snippet extraction for entries larger than this
MAX_SERVE_BYTES = (
    50 * 1024 * 1024
)  # 50 MB — refuse to serve entries larger than this (prevents OOM)
MAX_POST_BODY = 65536  # max bytes accepted in POST requests (64KB — handles ~500 URLs for batch resolve)
# Backup bundles and per-user data blobs (bookmarks/history/preferences) are the
# one class of POST that legitimately runs large — a full-server backup carries
# users, history and every per-user blob. They get their own ceiling so the tight
# 64 KB cap keeps guarding every other endpoint.
MAX_BACKUP_BODY = 8 * 1024 * 1024  # 8 MB — backup import + /userdata save
_BYTES_PER_GB = 1024**3


def _atomic_write_json(path, data, indent=None):
    """Write JSON data to a file atomically via temp file + os.replace().

    Used for all persistent state files to prevent corruption from
    crashes or concurrent writes. indent=None for compact output.
    """
    # Unique temp name per write: a fixed "<path>.tmp" collides when two
    # threads write the same target concurrently — the second os.replace races
    # against the first's rename/unlink and can fail or observe a torn file.
    directory = os.path.dirname(path) or "."
    prefix = os.path.basename(path) + "."
    try:
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=prefix, suffix=".tmp")
        # mkstemp creates 0600 and os.replace carries that mode onto the
        # target — which would silently strip group/world read from state
        # files (e.g. .zimi_cache.json inspected host-side over SSH).
        # Restore the umask-style default the old open()-based writer had.
        # POSIX-only: Windows has no fchmod and no meaningful mode bits.
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o644)
    except OSError as e:
        log.warning("Atomic write failed for %s: %s", path, e)
        return
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(
                data,
                f,
                ensure_ascii=False,
                indent=indent,
                separators=(",", ":") if indent is None else None,
            )
        os.replace(tmp, path)
    except OSError as e:
        log.warning("Atomic write failed for %s: %s", path, e)
        try:
            os.unlink(tmp)
        except OSError:
            pass


# MIME type fallback for ZIM entries with empty mimetype
MIME_FALLBACK = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".otf": "font/otf",
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".wasm": "application/wasm",
    ".bcmap": "application/octet-stream",
    ".properties": "text/plain",
    ".ftl": "text/plain",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
    ".vtt": "text/vtt",
    ".srt": "text/plain",
    # Map tiles / geodata. OSM map ZIMs (Leaflet / MapLibre) store vector
    # tiles as .pbf|.mvt; a loader that inspects Content-Type needs protobuf,
    # not octet-stream. Raster (.png) tiles already covered above.
    ".pbf": "application/x-protobuf",
    ".mvt": "application/x-protobuf",
    ".geojson": "application/geo+json",
    ".topojson": "application/json",
}


def split_entry_fragment(path):
    """Split a ZIM entry path at its first URL fragment ('#').

    Single-page docs (notably devdocs ZIMs like devdocs_en_markdown) surface
    suggestion/title-index paths of the form ``index#backslash`` where the real
    ZIM entry is ``index`` and ``#backslash`` is an in-page fragment. Callers use
    this to fall back to the base entry when a lookup for the full string fails.

    Returns ``(base_path, fragment)`` with the fragment excluding the '#', or
    ``(path, "")`` when there is no fragment."""
    hash_idx = path.find("#")
    if hash_idx == -1:
        return path, ""
    return path[:hash_idx], path[hash_idx + 1 :]


def _namespace_fallbacks(path):
    """Generate alternative paths for old/new namespace ZIM compatibility.
    Old ZIMs use A/ (articles), I/ (images), C/ (CSS), -/ (metadata) prefixes.
    New ZIMs dropped them. Try stripping or adding prefixes to find the entry."""
    prefixes = ("A/", "I/", "C/", "-/")
    for p in prefixes:
        if path.startswith(p):
            yield path[len(p) :]  # strip prefix
            return
    for p in prefixes:
        yield p + path  # add prefix


def _categorize_zim(name):
    """Auto-categorize a ZIM by name pattern. Ordered rules, first match wins. None if unknown."""
    n = name.lower()
    # Medical — before Wikimedia so wikipedia_en_medicine categorizes correctly
    if (
        "medicine" in n
        or n == "wikem"
        or "ready.gov" in n
        or (
            n.startswith("zimgit-")
            and any(k in n for k in ("water", "food", "disaster"))
        )
    ):
        return "Medical"
    # Stack Exchange — check before Wikimedia (some SEs have wiki-adjacent names)
    if (
        n in ("stackoverflow", "askubuntu", "superuser", "serverfault")
        or "stackexchange" in n
    ):
        return "Stack Exchange"
    # Dev Docs
    if n.startswith("devdocs_") or n == "freecodecamp":
        return "Dev Docs"
    # Education
    if (
        n.startswith("ted_")
        or n.startswith("phzh_")
        or n
        in (
            "crashcourse",
            "phet",
            "appropedia",
            "artofproblemsolving",
            "edutechwiki",
            "explainxkcd",
            "coreeng1",
        )
    ):
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
        with open(_history_file_path(), encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except FileNotFoundError:
        pass  # fresh install — no history yet
    except (OSError, json.JSONDecodeError) as e:
        # Unreadable/corrupt (e.g. a bind mount owned by the wrong uid raising
        # PermissionError/EIO) must degrade to empty, not 500 the request and
        # look like data loss. Log so the real problem stays visible.
        log.warning("Could not read history file, returning empty: %s", e)
    return []


def _save_history(entries):
    """Replace the persistent event history with ``entries`` (capped, newest
    first). Used by the full-server backup restore. Thread-safe."""
    with _history_lock:
        clean = [e for e in entries if isinstance(e, dict)][:_HISTORY_MAX]
    _atomic_write_json(_history_file_path(), clean)


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
        with open(_collections_file_path(), encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") != 1:
            return {"version": 1, "favorites": [], "collections": {}}
        return data
    except FileNotFoundError:
        pass  # fresh install — no collections yet
    except (OSError, json.JSONDecodeError, KeyError) as e:
        # Unreadable/corrupt data dir must degrade to the empty default rather
        # than 500 /collections and blank the user's bookmarks (issue #36).
        log.warning("Could not read collections file, returning default: %s", e)
    return {"version": 1, "favorites": [], "collections": {}}


def _save_collections(data):
    """Save collections to disk (atomic write via rename)."""
    data["version"] = 1
    _atomic_write_json(_collections_file_path(), data, indent=2)


# ── Library layout: per-ZIM category overrides + home section order (#37) ──
#
# Storage: ZIMI_DATA_DIR/library_layout.json —
#   {"overrides": {"<zim name>": "<category>"},
#    "section_order": ["cat:<key>"|"col:<name>"|"other", ...],
#    "sections": ["<category name>", ...]}
# Overrides win over the _categorize_zim heuristic; section_order drives the
# home page ordering (unlisted sections append in default order); `sections`
# holds user-declared empty categories that should be offered as Move-to targets
# and reorder rows before any ZIM lives in them. Reads are public (ride /list);
# writes are auth-gated /manage endpoints.
_library_layout_lock = threading.Lock()

#: Section-order keys are namespaced so categories and collections can share one
#: ordered list without colliding (a collection named "Books" != category Books).
#: The bare `other` key is the reserved slot for the uncategorized catch-all, so
#: it can be ordered like any real section instead of being pinned last.
_SECTION_KEY_RE = re.compile(r"^(?:(?:cat:|col:).+|other)$")
#: Defensive caps so a hostile/buggy client can't write an unbounded file.
_LAYOUT_MAX_OVERRIDES = 5000
_LAYOUT_MAX_ORDER = 500
_LAYOUT_MAX_SECTIONS = 200
_LAYOUT_STR_MAX = 128


def _library_layout_file_path():
    """Path to the library-layout JSON file."""
    return os.path.join(ZIMI_DATA_DIR, "library_layout.json")


def _load_library_layout():
    """Load library layout from disk. Fail-soft to the empty default.

    A missing or corrupt file must degrade to the empty default
    (``{"overrides": {}, "section_order": [], "sections": []}``) rather than 500
    /list — the whole home page renders from this, so a bad read can never be
    allowed to blank the library.
    """
    empty = {"overrides": {}, "section_order": [], "sections": []}
    try:
        with open(_library_layout_file_path(), encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return empty
        overrides = data.get("overrides")
        order = data.get("section_order")
        sections = data.get("sections")
        return {
            "overrides": overrides if isinstance(overrides, dict) else {},
            "section_order": order if isinstance(order, list) else [],
            "sections": sections if isinstance(sections, list) else [],
        }
    except FileNotFoundError:
        pass  # fresh install — no layout yet
    except (OSError, json.JSONDecodeError) as e:
        log.warning("Could not read library layout, returning default: %s", e)
    return empty


def _save_library_layout(data):
    """Save library layout to disk (atomic write via rename)."""
    _atomic_write_json(_library_layout_file_path(), data, indent=2)


_ISO639_3_TO_1 = {
    "eng": "en",
    "fra": "fr",
    "deu": "de",
    "spa": "es",
    "por": "pt",
    "rus": "ru",
    "zho": "zh",
    "jpn": "ja",
    "kor": "ko",
    "ara": "ar",
    "hin": "hi",
    "ita": "it",
    "nld": "nl",
    "pol": "pl",
    "tur": "tr",
    "vie": "vi",
    "tha": "th",
    "swe": "sv",
    "nor": "no",
    "dan": "da",
    "fin": "fi",
    "ces": "cs",
    "ron": "ro",
    "hun": "hu",
    "ell": "el",
    "heb": "he",
    "ukr": "uk",
    "cat": "ca",
    "ind": "id",
    "msa": "ms",
    "fas": "fa",
    "ben": "bn",
    "tam": "ta",
    "tel": "te",
    "urd": "ur",
    "mul": "mul",  # multiple languages (keep as-is)
}

# ============================================================================
# ZIM Loading & Title Index
# ============================================================================

# Opening ZIM archives is expensive (~0.3s each on NAS spinning disks).
# Persistent cache in .zimi_cache.json enables instant startup on subsequent runs.
# Archives are opened lazily (on first search/read) instead of all at once.
_CACHE_VERSION = 2  # bumped for language metadata
# Self-heal thresholds for the "whole library badged New" bug: a full cache
# rebuild once stamped first_seen=now for every ZIM at once. first_seen values
# within this window are treated as "the same instant" (a rebuild), and a stamp
# is only trusted if it lands within the mtime tolerance of the file itself.
# A full rebuild stamps entries across the whole scan, which takes ~13s per 66
# ZIMs on NAS spinning disks — the bucket must swallow an entire slow scan or
# the majority test splits across buckets and the heal never fires. Safe to be
# generous: the per-entry mtime tolerance below is the guard that protects
# genuine batch downloads, the bucket is only a pre-filter.
_MASS_STAMP_WINDOW = 120.0  # seconds
_MASS_STAMP_MTIME_TOL = 3600.0  # first_seen must be within 1h of file mtime to be real
_zim_list_cache = None
_zim_files_cache = None  # {name: path} — cached at startup, ZIM dir is read-only

# ── Per-request ZIM allow context (multi-user v1) ────────────────────────────
# When a named USER (not admin, not anonymous) is logged in, the request's ZIM
# view is restricted to their allowlist. ThreadingHTTPServer runs one thread per
# request, so a thread-local is naturally request-scoped; http.do_GET/do_POST set
# it from zimi.users.request_allow() and clear it in a finally. A value of None
# means all-access (admin/anonymous/all-access user) — the common case, and what
# background threads (indexing, downloads) always see since they never set it.
# get_zim_files() and list_zims() consult it so every dict-based read path
# (search_all, read_article, chunk_article, resolve_almanac_qids, /list) is
# filtered from one place; zim_allowed() covers the two spots that bypass them.
_request_ctx = threading.local()


def set_request_allow(allow):
    """Set the current request's ZIM allow set (a set of names) or None for all."""
    _request_ctx.allow = allow


def clear_request_allow():
    """Clear the request allow context (always call in a finally)."""
    _request_ctx.allow = None


def current_allow():
    """The current request's allow set, or None for all-access."""
    return getattr(_request_ctx, "allow", None)


def zim_allowed(name):
    """True if `name` is visible to the current request. Gates the paths that
    don't flow through get_zim_files() (pooled /w/ content, direct list reads)."""
    allow = current_allow()
    return allow is None or name in allow


_cache_generation = 0  # incremented on load_cache(force=True) — used in ETags
_archive_pool = {}  # {name: Archive} — kept open for fast search
_archive_lock = threading.Lock()  # protects _archive_pool writes in threaded mode
_zim_lock = (
    threading.Lock()
)  # serializes all libzim operations (C library is NOT thread-safe)
# Lock ordering: _zim_lock → _archive_lock (never acquire _zim_lock while holding _archive_lock)

# Separate archive handles for suggestion search — allows title lookups to run in
# parallel with Xapian FTS by using independent C++ Archive objects + their own lock.
# Each ZIM gets its own lock so multi-ZIM scoped searches can query in parallel.
_suggest_pool = {}  # {name: Archive} — independent handles for SuggestionSearcher
_suggest_pool_lock = threading.Lock()  # protects _suggest_pool writes
_suggest_zim_locks = {}  # {name: Lock} — per-ZIM lock for suggestion operations

# Separate archive handles for full-text search — allows parallel Xapian FTS across ZIMs.
# Same pattern as _suggest_pool: each ZIM gets its own Archive + Lock.
_fts_pool = {}  # {name: Archive}
_fts_pool_lock = threading.Lock()
_fts_zim_locks = {}  # {name: Lock}

# Asset extensions to skip when indexing — images, fonts, scripts, not articles
_ASSET_EXTS = frozenset(
    (
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".svg",
        ".webp",
        ".ico",
        ".avif",
        ".css",
        ".js",
        ".json",
        ".woff",
        ".woff2",
        ".ttf",
        ".eot",
        ".otf",
        ".mp3",
        ".mp4",
        ".ogg",
        ".wav",
        ".webm",
    )
)

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
    lang_match = re.search(r"(?:\.com)?_([a-z]{2,3})_(?:all|maxi|2\d{3})", name)
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
    name = re.sub(
        r"_[a-z]{2}_2\d{3}.*", "", name
    )  # Only 2-letter codes before dates (avoids css/git)
    name = re.sub(r"_maxi_2\d{3}.*", "", name)
    name = re.sub(r"_2\d{3}-\d{2}$", "", name)
    # Append language suffix for non-English ZIMs
    if not is_english and lang_code:
        # Normalize 3-letter to 2-letter
        short_lang = _ISO639_3_TO_1.get(
            lang_code, lang_code if len(lang_code) == 2 else ""
        )
        if short_lang and short_lang != "en":
            name = name + "_" + short_lang
    return name


def _scan_zim_files():
    """Scan ZIM_DIR plus exactly one level of subdirectories for ZIM files.
    Returns {short_name: path} mapping.

    Collision rule (documented, deliberate): root-level files are scanned
    before subdirectory files, each group sorted; when two files produce the
    same short name (maxi vs mini flavors, or the same file present both in
    the root and in a subfolder) the LARGER file wins so the richest content
    is served, and a size tie keeps the earlier — root — copy, so a duplicate
    dropped into a subfolder can never displace the file already being served.
    Every collision is logged. glob's `*` never matches dotted names, so the
    `.zimi` state directory is not scanned as content; deeper nesting is
    deliberately out of scope (the empty-library boot hint says so).
    """
    zims = {}
    paths = sorted(glob.glob(os.path.join(ZIM_DIR, "*.zim"))) + sorted(
        glob.glob(os.path.join(ZIM_DIR, "*", "*.zim"))
    )
    for path in paths:
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
                log.info(
                    "ZIM name collision '%s': %s (%.1f GB) replaces %s (%.1f GB)",
                    name,
                    filename,
                    new_size / _BYTES_PER_GB,
                    os.path.basename(existing),
                    existing_size / _BYTES_PER_GB,
                )
                zims[name] = path
            else:
                log.info(
                    "ZIM name collision '%s': keeping %s (%.1f GB), skipping %s (%.1f GB)",
                    name,
                    os.path.basename(existing),
                    existing_size / _BYTES_PER_GB,
                    filename,
                    new_size / _BYTES_PER_GB,
                )
        else:
            zims[name] = path
    return zims


def get_zim_files():
    """Get ZIM file mapping. Uses startup cache (ZIM dir is read-only mount).

    When a restricted user is logged in (current_allow() is not None), the mapping
    is filtered to their allowlist — a fresh dict, never a mutation of the cache.
    This is the single choke point every dict-based read path flows through."""
    global _zim_files_cache
    if _zim_files_cache is None:
        _zim_files_cache = _scan_zim_files()
    allow = current_allow()
    if allow is None:
        return _zim_files_cache
    return {k: v for k, v in _zim_files_cache.items() if k in allow}


def open_archive(path):
    """Open a ZIM archive."""
    return Archive(path)


from zimi.previews import (  # noqa: E402
    strip_html,
    _extract_preview,
    _resolve_img_path,
    extract_snippet,
)

# ============================================================================
# ZIM Listing & Metadata Cache
# ============================================================================


def list_zims(use_cache=True):
    """List all available ZIM files with metadata. Uses startup cache when available."""
    global _zim_list_cache
    if use_cache and _zim_list_cache is not None:
        allow = current_allow()
        if allow is None:
            return _zim_list_cache
        # Restricted user: return a filtered copy, never mutate the shared cache.
        return [z for z in _zim_list_cache if z.get("name") in allow]

    zims = get_zim_files()
    info = []
    for name, path in zims.items():
        size_bytes = os.path.getsize(path)
        article_count = None
        try:
            archive = open_archive(path)
            entry_count = archive.entry_count
            try:
                article_count = archive.article_count
            except Exception:
                article_count = None
        except Exception as e:
            log.debug("Failed to open archive for listing %s: %s", name, e)
            entry_count = "?"
        entry = {
            "name": name,
            "file": os.path.basename(path),
            "size_gb": round(size_bytes / (1024**3), 3),
            "size_bytes": size_bytes,
            "entries": entry_count,
        }
        if article_count is not None:
            entry["article_count"] = article_count
        info.append(entry)
    return info


def get_archive(name):
    """Get a cached archive handle, or open it fresh. Thread-safe.

    Fails closed for a restricted user: a ZIM outside their allowlist resolves to
    None (as if not installed), gating every archive-based content path (/w/,
    /snippet, /catalog, /article-languages, /random) including already-pooled
    handles. Background/admin requests have current_allow()==None → no change."""
    if not zim_allowed(name):
        return None
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
        with open(_cache_file_path(), encoding="utf-8") as f:
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
    m = re.search(r"_(\d{4}-\d{2})\.zim$", filename)
    if m:
        base = filename[: m.start()]
        return base, m.group(1)
    return filename.replace(".zim", ""), None


def _extract_zim_metadata(name, path):
    """Open a ZIM archive and extract its metadata. Returns (info_dict, archive)."""
    size_bytes = os.path.getsize(path)
    size_gb = size_bytes / (1024**3)
    meta_title = name
    meta_desc = ""
    meta_date = ""
    meta_lang = ""
    meta_creator = ""
    has_icon = False
    main_path = ""
    archive = None
    article_count = None
    try:
        archive = open_archive(path)
        entry_count = archive.entry_count
        # Real article count (user-facing content entries, excluding redirects
        # and non-article assets). Additive over `entries` (all user entries):
        # cards/info panels prefer this when present, fall back to entry_count.
        try:
            article_count = archive.article_count
        except Exception:
            article_count = None
        for key in archive.metadata_keys:
            try:
                val = bytes(archive.get_metadata(key))
                if key == "Title":
                    meta_title = val.decode("utf-8", errors="replace").strip() or name
                elif key == "Description":
                    meta_desc = val.decode("utf-8", errors="replace").strip()
                elif key == "Date":
                    meta_date = val.decode("utf-8", errors="replace").strip()
                elif key == "Creator":
                    meta_creator = val.decode("utf-8", errors="replace").strip()
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
        m = re.match(r"^[a-zA-Z]+(?:\.\w+)*_([a-z]{2,3})_", os.path.basename(path))
        if m:
            code = m.group(1)
            meta_lang = _ISO639_3_TO_1.get(code, code)
    info = {
        "name": name,
        "file": os.path.basename(path),
        "size_gb": round(size_gb, 3),
        # Exact byte size: peers verify a pulled .zim against this (a
        # truncated transfer is the realistic LAN failure mode).
        "size_bytes": size_bytes,
        "entries": entry_count,
        "title": meta_title,
        "description": meta_desc,
        "date": meta_date,
        "language": meta_lang,
        "has_icon": has_icon,
        "category": _categorize_zim(name),
        "main_path": main_path,
    }
    if article_count is not None:
        info["article_count"] = article_count
    # Additive flag: a ZIM Zimi itself exported (bookmark exports). The UI
    # shows these with their full creation date.
    if meta_creator == "Zimi":
        info["zimi_export"] = True
    return info, archive


def _self_heal_mass_first_seen(info, file_cache, zims):
    """Repair a library-wide first_seen stamp left by a full cache rebuild.

    A pre-fix rebuild stamped ``first_seen = now`` for every ZIM at once, so the
    whole library badged "New". Detect that fingerprint — a majority of entries
    sharing one first_seen instant that does NOT match their file mtimes — and
    re-derive each affected stamp from the file's own mtime. Mutates ``info`` and
    ``file_cache`` in place; returns True if anything was repaired.

    The mtime check is the safety guard: a genuine batch download (10 ZIMs
    pulled within seconds) also shares one first_seen, but there the files' own
    mtimes match that instant, so those are left untouched.
    """
    stamped = [e for e in info if e.get("first_seen")]
    if len(stamped) < 4:
        return False  # too small a library to distinguish a rebuild from reality
    from collections import Counter

    buckets = Counter(round(e["first_seen"] / _MASS_STAMP_WINDOW) for e in stamped)
    bucket_key, count = buckets.most_common(1)[0]
    if count <= len(stamped) * 0.5:
        return False  # no dominant shared instant → not a mass rebuild

    now = time.time()
    repaired = 0
    for e in info:
        fs = e.get("first_seen")
        if not fs or round(fs / _MASS_STAMP_WINDOW) != bucket_key:
            continue
        path = zims.get(e["name"])
        if not path:
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        # Stamp is plausible if it lands near the file's own mtime — leave it.
        if abs(fs - mtime) <= _MASS_STAMP_MTIME_TOL:
            continue
        new_fs = min(mtime, now)
        e["first_seen"] = new_fs
        fc = file_cache.get(e["file"])
        if fc is not None:
            fc["first_seen"] = new_fs
        repaired += 1

    if repaired:
        log.info(
            "first_seen self-heal: re-derived %d/%d ZIM stamps from file mtime "
            "(a full cache rebuild had stamped them all at once)",
            repaired,
            len(stamped),
        )
    return repaired > 0


def _self_heal_update_stamps(info, file_cache):
    """Repair 'New' badges on ZIMs that were actually UPDATED before the
    dated-filename inherit fix landed.

    The pre-fix updater re-stamped ``first_seen=now`` and left ``updated_at``
    unset when an update arrived under a new dated filename, so a genuinely
    updated ZIM badges 'New' instead of 'Updated' — indistinguishable from a
    fresh install by its stamps alone. The persistent event history IS the
    authority: it records an ``updated`` event per real update. For any ZIM the
    history says was updated, sync its cache stamps to that truth — set
    ``updated_at`` from the update event and pull ``first_seen`` back to the
    earliest recorded event so ``updated_at > first_seen`` and the badge reads
    'Updated', matching the activity log. Only touches ZIMs with a recorded
    update event, so it can never misfire on a real fresh install. Mutates
    ``info`` and ``file_cache`` in place; returns True if anything changed."""
    try:
        history = _load_history()
    except Exception:
        return False
    if not history:
        return False
    # Per logical ZIM name: earliest recorded event (install) and latest update.
    earliest = {}
    latest_update = {}
    for ev in history:
        ts = ev.get("ts")
        name = ev.get("name")
        if not ts or not name:
            continue
        if name not in earliest or ts < earliest[name]:
            earliest[name] = ts
        if ev.get("event") == "updated" and (
            name not in latest_update or ts > latest_update[name]
        ):
            latest_update[name] = ts
    if not latest_update:
        return False
    repaired = 0
    for e in info:
        new_ua = latest_update.get(e.get("name"))
        if not new_ua:
            continue
        # Already correctly flagged 'Updated' (updated_at > first_seen)? Leave it.
        if (e.get("updated_at") or 0) > (e.get("first_seen") or 0):
            continue
        # first_seen must precede the update. Prefer the earliest recorded event;
        # if the only record IS the update (original install predates history),
        # nudge first_seen just below it so the ordering — hence badge — is right.
        new_fs = min(earliest.get(e.get("name"), new_ua), new_ua)
        if new_fs >= new_ua:
            new_fs = new_ua - 1
        if e.get("updated_at") == new_ua and e.get("first_seen") == new_fs:
            continue
        e["updated_at"] = new_ua
        e["first_seen"] = new_fs
        fc = file_cache.get(e["file"])
        if fc is not None:
            fc["updated_at"] = new_ua
            fc["first_seen"] = new_fs
        repaired += 1
    if repaired:
        log.info(
            "update-stamp self-heal: re-flagged %d ZIM(s) as 'Updated' from the "
            "event history (pre-fix updates had mis-stamped them 'New')",
            repaired,
        )
    return repaired > 0


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

    # Always load the persisted cache. Even on a forced rebuild we re-scan every
    # archive (fresh metadata) but must carry each ZIM's first_seen/updated_at
    # forward — otherwise a rebuild re-stamps the whole library and every ZIM
    # badges "New" at once (the bug this fix closes).
    disk_cache = _load_disk_cache()

    info = []
    scanned = 0
    backfilled = 0  # legacy entries whose first_seen we filled from file mtime
    file_cache = {}  # for saving back to disk

    # Index prior cache entries by date-stripped short name. ZIM filenames carry
    # a date (…_2026-07.zim); an update downloads a NEW dated filename, so the
    # cache — keyed by full filename — misses and the update masquerades as a
    # brand-new install (first_seen≈now, no updated_at → badges "New" not
    # "Updated"). This lets the cache-miss path recognise that a new filename is
    # the SAME logical ZIM as a known one, inherit its original first_seen, and
    # stamp updated_at. Keep the earliest first_seen per name (true install).
    prior_by_name = {}
    if disk_cache:
        for _fn, _ce in disk_cache.items():
            if not isinstance(_ce, dict):
                continue
            _sn = _zim_short_name(_fn)
            _prev = prior_by_name.get(_sn)
            if _prev is None or (_ce.get("first_seen") or float("inf")) < (
                _prev.get("first_seen") or float("inf")
            ):
                prior_by_name[_sn] = _ce

    for name, path in zims.items():
        filename = os.path.basename(path)
        try:
            stat = os.stat(path)
            mtime = stat.st_mtime
            size = stat.st_size
        except OSError:
            continue

        cached = disk_cache.get(filename) if disk_cache else None
        # When Zimi first sees a ZIM, stamp it so the UI can flag it "New" for
        # a few days (#34 — a fresh install is otherwise lost in a big
        # library). A ZIM already known (even if its file changed on an update)
        # keeps its original stamp; a ZIM present in a pre-feature cache with no
        # stamp is treated as long-installed, not retroactively "new".
        # A new filename whose date-stripped name matches a known ZIM is an
        # UPDATE arriving under a new dated filename, not a first install.
        prior = prior_by_name.get(name) if cached is None else None
        prior_first_seen = prior.get("first_seen") if prior else None
        is_update_rename = cached is None and prior_first_seen is not None
        if cached is None:
            if is_update_rename:
                # Same logical ZIM, newer file: inherit the ORIGINAL first_seen
                # (never re-stamp it) so updated_at>first_seen and the badge
                # reads "Updated", matching the activity log.
                first_seen = prior_first_seen
            else:
                # First time Zimi has ever seen this file. Stamp first_seen from
                # the file's own mtime — NOT wall-clock now. A genuinely new
                # download has mtime≈now, so it still lights up "New"; but a full
                # cache rebuild of an old library (force=True, or a
                # corrupt/unreadable cache.json) now re-derives quiet, honest
                # stamps from the files instead of badging the whole library at
                # once. min() guards against future mtimes.
                first_seen = min(mtime, time.time())
        else:
            first_seen = cached.get("first_seen")
            # Legacy cache entries (written before #34) carry no first_seen.
            # Backfill from the ZIM file's own mtime so a recently-downloaded
            # ZIM lights up "Recently added" on an already-established library,
            # while a long-installed file (old mtime) stays quiet. Persisted by
            # the cache-hit write-back below, so it's computed once. If the file
            # vanished mid-scan, leave it None rather than stamping "now".
            if first_seen is None:
                try:
                    first_seen = os.path.getmtime(path)
                    backfilled += 1
                except OSError:
                    first_seen = None
        # An already-known ZIM whose file changed on disk is an update — stamp
        # updated_at so the UI can flag it "Updated" (distinct from "New").
        file_unchanged = bool(
            cached and cached.get("mtime") == mtime and cached.get("size") == size
        )
        # Skip re-opening the archive only on a normal load; a forced rebuild
        # re-scans even unchanged files, but must not mistake that for a change.
        cache_hit = file_unchanged and not force
        if cached is None:
            # Brand-new install → no update stamp; an update-under-new-filename
            # → stamp updated_at=now (it's a change to an already-known ZIM).
            updated_at = time.time() if is_update_rename else None
        elif file_unchanged:
            updated_at = cached.get("updated_at")
        else:
            updated_at = time.time()
        if cache_hit and cached:
            # Cache hit — use stored metadata, skip opening archive
            entry = {
                "name": name,
                "file": filename,
                "size_gb": cached.get("size_gb", round(size / (1024**3), 3)),
                # Exact bytes straight from stat — peers verify pulled ZIMs
                # against this, so it must be present even on a cache hit
                # (older disk caches predate the field).
                "size_bytes": size,
                "entries": cached.get("entries", "?"),
                "title": cached.get("title", name),
                "description": cached.get("description", ""),
                "date": cached.get("date", ""),
                "language": cached.get("language", ""),
                "has_icon": cached.get("has_icon", False),
                "category": _categorize_zim(name),
                "main_path": cached.get("main_path", ""),
                "first_seen": first_seen,
                "updated_at": updated_at,
            }
            if "has_qids" in cached:
                entry["has_qids"] = cached["has_qids"]
            # Additive: real article count. Absent in caches built before this
            # field existed — the UI falls back to `entries` when it's missing.
            if cached.get("article_count") is not None:
                entry["article_count"] = cached["article_count"]
            # Additive: Zimi-exported flag (bookmark exports show full dates).
            if cached.get("zimi_export"):
                entry["zimi_export"] = True
            info.append(entry)
            cached_out = dict(cached)
            if first_seen is not None:
                cached_out["first_seen"] = first_seen
            if updated_at is not None:
                cached_out["updated_at"] = updated_at
            file_cache[filename] = cached_out
        else:
            # Cache miss — scan this ZIM
            entry, archive = _extract_zim_metadata(name, path)
            if archive and entry.get("entries") != "?":
                _archive_pool[name] = archive
            if first_seen is not None:
                entry["first_seen"] = first_seen
            entry["updated_at"] = updated_at
            info.append(entry)
            scanned += 1
            new_cached = {
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
            if entry.get("article_count") is not None:
                new_cached["article_count"] = entry["article_count"]
            if entry.get("zimi_export"):
                new_cached["zimi_export"] = True
            if first_seen is not None:
                new_cached["first_seen"] = first_seen
            if updated_at is not None:
                new_cached["updated_at"] = updated_at
            file_cache[filename] = new_cached

    # Self-heal a library that a pre-fix rebuild already mass-stamped. The code
    # fix above stops NEW rebuilds from doing it, but existing disk caches still
    # carry first_seen=<rebuild instant> for every ZIM; repair them from mtime.
    healed = _self_heal_mass_first_seen(info, file_cache, zims)
    # Repair 'New' badges on ZIMs the event history proves were UPDATED before
    # the dated-filename inherit fix (pre-fix updates mis-stamped them 'New').
    healed_updates = _self_heal_update_stamps(info, file_cache)

    _zim_list_cache = info
    elapsed = time.time() - t0

    # Persist cache if we scanned anything new, backfilled a legacy first_seen
    # (so the mtime stamp is computed once), or repaired mass-stamped entries.
    if scanned > 0 or backfilled > 0 or disk_cache is None or healed or healed_updates:
        _save_disk_cache(file_cache)

    cached_count = len(info) - scanned
    if cached_count > 0 and scanned > 0:
        print(
            f"  Cache loaded: {len(info)} ZIMs ({cached_count} cached, {scanned} scanned) in {elapsed:.1f}s",
            flush=True,
        )
    elif scanned > 0:
        print(f"  Cache built: {len(info)} ZIMs scanned in {elapsed:.1f}s", flush=True)
    elif len(info) > 0:
        print(
            f"  Cache loaded: {len(info)} ZIMs from disk cache in {elapsed:.1f}s",
            flush=True,
        )
    else:
        # Install-neutral empty state: this line is read by Docker admins,
        # stick users and source checkouts alike, so it names every location
        # that was actually searched instead of assuming a volume mount.
        searched = [ZIM_DIR] + [p for p in _discovery_probed if p != ZIM_DIR]
        missing = "" if os.path.isdir(ZIM_DIR) else " (directory does not exist)"
        print(f"  No ZIM files found in {ZIM_DIR}{missing}", flush=True)
        if os.path.isdir(ZIM_DIR):
            # The scan covers ZIM_DIR plus one level of subfolders; only files
            # nested deeper than that are invisible now, so only they get the
            # hint (a recursive glob at boot is fine — the library is empty).
            deep_zims = glob.glob(os.path.join(ZIM_DIR, "**", "*.zim"), recursive=True)
            if deep_zims:
                print(
                    f"  Found {len(deep_zims)} ZIM file(s) nested deeper than one folder — "
                    f"Zimi scans {ZIM_DIR} and its immediate subfolders only",
                    flush=True,
                )
        print(
            f"  Searched: {', '.join(searched)}. Put .zim files in any of these, "
            f"or point ZIM_DIR / --zim-dir at your ZIM folder.",
            flush=True,
        )

    # Rebuild domain map whenever ZIM list changes
    _build_domain_zim_map()


def _domain_map_entries_for_zim(name, filename, source_meta):
    """Domain→ZIM entries ONE ZIM contributes, without opening any archive.

    Mirrors the three discovery methods of interlang._build_domain_zim_map
    (filename prefix, Source metadata, name-based TLD inference) plus its
    www./mobile variant expansion — keep the two in sync. The full rebuild
    still owns startup and manual refresh; this exists because the rebuild
    calls get_archive() for every unmapped ZIM, and with a cold archive pool
    that re-opens the whole library — minutes under _zim_lock on a Pi with a
    NAS mount, the exact starvation register_zim_file removes (#51). Here the
    Source string is read from the registration's own private handle, so the
    merge is pure string work.
    """
    domains = []

    def _add(domain):
        domain = (domain or "").lower().strip()
        if not domain or "." not in domain:
            return
        domains.append(domain)
        if domain.startswith("www."):
            domains.append(domain[4:])
        else:
            domains.append("www." + domain)
        m = re.match(r"^(\w{2,3})\.(wiki\w+\.org)$", domain)
        if m:
            domains.append(f"{m.group(1)}.m.{m.group(2)}")
        if domain in ("stackoverflow.com", "stackexchange.com"):
            domains.append("m." + domain)

    base = filename.split(".zim")[0]
    m = re.match(r"^([a-zA-Z0-9.-]+\.[a-z]{2,})_", base)
    if m:
        _add(m.group(1))
    elif source_meta:
        from urllib.parse import urlparse  # local: server.py has no other use

        try:
            if "://" in source_meta:
                _add(urlparse(source_meta).hostname or "")
            else:
                _add(source_meta.split("/")[0])
        except Exception as e:
            log.debug("Failed to parse Source %r for %s: %s", source_meta, name, e)
    elif not name.startswith("zimgit") and "_en_" not in name:
        for tld in (".com", ".org", ".io", ".net"):
            _add(name + tld)
    return {d: name for d in domains}


def register_zim_file(path, removed_files=()):
    """Incrementally register ONE just-downloaded ZIM into the live library.

    Replaces the post-download ``load_cache(force=True)`` full rebuild, which
    re-opened and re-scanned EVERY archive in the library while the caller
    held ``_zim_lock``. On a small box (Raspberry Pi) serving a big library
    from network storage that held the lock for minutes — every request that
    touches libzim starved until the browser gave up, which reads as a server
    crash (#51). The forced rebuild also pooled every archive at once, a
    memory spike small boards can't absorb.

    Shape: the expensive work (archive open + metadata extraction — real I/O
    on a slow mount) runs BEFORE the lock on a private handle; ``_zim_lock``
    is held only to splice the result into the in-memory registry. Opening a
    private Archive off-lock is safe: libzim's hazard is two threads on ONE
    Archive object, and this handle is not shared until after the splice
    (same practice as the post-download validation open in library.py).

    ``removed_files``: basenames of older versions the caller already deleted
    from disk; they are dropped from the registry and disk cache in the same
    splice.

    Returns True when the library reflects the file; False when the file
    could not be read — the caller should fall back to a full load_cache().
    """
    global _zim_files_cache, _zim_list_cache, _cache_generation
    _init()
    if _zim_files_cache is None or _zim_list_cache is None:
        # Library was never scanned (headless/startup edge): there is nothing
        # to splice into, and a plain load — which will pick the new file up
        # from disk along with everything else — is the cheap normal path.
        load_cache()
        return True
    filename = os.path.basename(path)
    name = _zim_short_name(filename)
    try:
        st = os.stat(path)
    except OSError as e:
        log.warning("register_zim_file: cannot stat %s: %s", path, e)
        return False

    # Mirror _scan_zim_files' collision rule: when a DIFFERENT file already
    # backs this short name, the larger file keeps serving. The routine case
    # — an update replacing an older dated file the caller just deleted —
    # falls through because the old path no longer stats.
    existing_path = _zim_files_cache.get(name)
    if existing_path and os.path.realpath(existing_path) != os.path.realpath(path):
        try:
            if os.path.getsize(existing_path) >= st.st_size:
                log.info(
                    "ZIM name collision '%s': keeping %s, new %s stays shadowed",
                    name,
                    os.path.basename(existing_path),
                    filename,
                )
                return True  # library correctly unchanged
        except OSError:
            pass  # existing file is gone — the new one takes over

    # ---- Phase 1: metadata extraction, deliberately WITHOUT _zim_lock ----
    entry, archive = _extract_zim_metadata(name, path)
    if entry.get("entries") == "?":
        # Unreadable despite the download path's libzim validation — let the
        # caller run the full-scan fallback rather than splice a broken entry.
        return False
    # Source metadata feeds the domain-map merge below; read it here on the
    # private handle so the merge itself never touches libzim.
    try:
        source_meta = (
            bytes(archive.get_metadata("Source")).decode("utf-8", "replace").strip()
        )
    except Exception:
        source_meta = ""

    # New/Updated stamps, same semantics as load_cache: a new dated filename
    # of an already-known ZIM inherits the ORIGINAL first_seen and stamps
    # updated_at (badge reads "Updated"); a genuinely new ZIM derives
    # first_seen from its own mtime (badge reads "New").
    disk_cache = _load_disk_cache()
    prior_first_seen = None
    if disk_cache:
        for _fn, _ce in disk_cache.items():
            if _fn == filename or not isinstance(_ce, dict):
                continue
            if _zim_short_name(_fn) == name:
                _fs = _ce.get("first_seen")
                if _fs is not None and (
                    prior_first_seen is None or _fs < prior_first_seen
                ):
                    prior_first_seen = _fs
    now = time.time()
    if prior_first_seen is not None:
        entry["first_seen"] = prior_first_seen
        entry["updated_at"] = now
    else:
        entry["first_seen"] = min(st.st_mtime, now)
        entry["updated_at"] = None

    # Disk-cache record, same shape load_cache's scan branch writes.
    new_cached = {
        "name": name,
        "mtime": st.st_mtime,
        "size": st.st_size,
        "size_gb": entry["size_gb"],
        "entries": entry["entries"],
        "title": entry["title"],
        "description": entry["description"],
        "date": entry.get("date", ""),
        "language": entry.get("language", ""),
        "has_icon": entry["has_icon"],
        "main_path": entry["main_path"],
    }
    for _opt in ("article_count", "zimi_export", "first_seen", "updated_at"):
        if entry.get(_opt) is not None:
            new_cached[_opt] = entry[_opt]

    removed = {os.path.basename(f) for f in removed_files}

    # ---- Phase 2: splice under _zim_lock — dict surgery + a small json ----
    with _zim_lock:
        # Rebind fresh containers instead of mutating: readers iterate these
        # without the lock, and an atomic rebind can never trip them mid-walk.
        files = dict(_zim_files_cache)
        files[name] = path
        _zim_files_cache = files
        listing = [
            z
            for z in (_zim_list_cache or [])
            if z.get("name") != name and z.get("file") not in removed
        ]
        listing.append(entry)
        _zim_list_cache = listing
        with _archive_lock:
            # Hand the already-open archive to the pool (and drop any handle
            # still pointing at a replaced file) so nothing re-opens it.
            _archive_pool[name] = archive
        # Invalidates /w/ entry ETags and the interlang resolution caches —
        # cross-ZIM answers can genuinely change when a ZIM arrives.
        _cache_generation += 1
        # Re-read the disk cache under the lock: the phase-1 copy fed the
        # stamp inheritance, but a concurrent full load_cache (manage
        # refresh) may have rewritten the file since — mutate the freshest
        # version so its work isn't clobbered.
        disk_now = _load_disk_cache()
        if disk_now is not None:
            for _fn in list(disk_now):
                if _fn in removed or _zim_short_name(_fn) == name:
                    disk_now.pop(_fn, None)
            disk_now[filename] = new_cached
            _save_disk_cache(disk_now)
        # Domain map: merge ONLY this ZIM's domains. The full rebuild
        # (_build_domain_zim_map) opens every unmapped archive via
        # get_archive — with a cold pool (e.g. right after a previous
        # download's cache clear) that re-opens the whole library under this
        # lock, the same minutes-long starvation this function exists to
        # remove. Existing entries win, matching the rebuild's first-wins
        # rule; the map is rebound (not mutated) in interlang, whose
        # _resolve_url_to_zim is the live consumer.
        import zimi.interlang as _interlang

        merged = dict(_interlang._domain_zim_map)
        for _d, _n in _domain_map_entries_for_zim(name, filename, source_meta).items():
            merged.setdefault(_d, _n)
        _interlang._domain_zim_map = merged
        # Keep this module's re-export binding fresh too (manage/status reads
        # it via _srv; the import-time binding would otherwise go stale).
        globals()["_domain_zim_map"] = merged
    log.info(
        "Registered %s (%s entries) without a library rescan",
        filename,
        entry.get("entries"),
    )
    return True


# (HTTP Request Handler extracted to zimi/http.py)


# ============================================================================
# CLI & Entry Points (ZimHandler class → zimi/http.py)
# ============================================================================


def _cli_die(msg):
    """One-line CLI refusal, exit code 2 — the same convention main() uses for
    a ConfigError. No traceback: these are operator mistakes, not bugs."""
    print(f"zimi: {msg}", file=sys.stderr)
    sys.exit(2)


def _headless_state_boot():
    """Point the state machinery at the resolved paths WITHOUT a running
    server. Backup-before-upgrade is the whole point of the CLI, so it must
    work while Zimi is stopped: load_cache() runs _init() (data-dir creation +
    migrations) and fills the library metadata cache, and the BT prefs path —
    normally wired up by start_background_services(), which never runs here —
    is set explicitly so sharing prefs actually reach the bundle."""
    from zimi import p2p

    p2p.set_prefs_path(_bt_prefs_path())
    load_cache()


def _cli_backup(file_arg):
    """`zimi backup [FILE]` — write a server-scope bundle (the same payload as
    GET /manage/backup?scope=server) to a local file."""
    from zimi import manage as _manage

    _headless_state_boot()
    bundle = _manage._build_backup_bundle(scope="server")
    path = os.path.abspath(file_arg or time.strftime("zimi-backup-%Y-%m-%d.json"))
    payload = json.dumps(bundle, ensure_ascii=False, indent=2)
    try:
        # 0600 from the first byte: the bundle carries password hashes, so
        # there must be no window in which another local user can read it. The
        # explicit chmod covers a pre-existing file — O_CREAT's mode argument
        # only applies when the file is actually created.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.chmod(path, 0o600)
    except OSError as e:
        _cli_die(f"cannot write {path}: {e.strerror or e}")
    pa = bundle.get("public_access") or {}
    coll = bundle.get("collections") or {}
    print(f"Backup written: {path}")
    print(
        f"  scope: server (schema v{bundle['schema_version']}, "
        f"zimi {bundle['zimi_version']})"
    )
    print(
        f"  library manifest: {len(bundle.get('library') or [])} ZIM(s) "
        "(metadata only — ZIM files are re-downloadable, not bundled)"
    )
    print(
        f"  users: {len(bundle.get('users') or {})} account(s), "
        f"public access: {pa.get('mode', '?')}"
    )
    print(
        f"  collections: {len(coll.get('collections') or {})}, "
        f"favorites: {len(coll.get('favorites') or [])}"
    )
    print(
        "  settings: download schedule, auto-update, sharing prefs, "
        f"{len(bundle.get('seed_intents') or {})} seed intent(s), "
        f"{len(bundle.get('hot_zims') or [])} hot ZIM(s)"
    )
    print(
        f"  history: {len(bundle.get('history') or [])} event(s), "
        f"per-user data: {len(bundle.get('user_data') or {})} user(s)"
    )
    print(
        "Note: this bundle includes user password hashes; "
        "file mode is 0600 — keep it private."
    )


def _cli_restore(path, overwrite):
    """`zimi restore FILE [--overwrite]` — apply a bundle with the same
    merge/overwrite semantics as POST /manage/backup. Headless and ungated:
    whoever can run the CLI against the data dir already owns it."""
    from zimi import manage as _manage

    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        _cli_die(f"backup file not found: {path}")
    except IsADirectoryError:
        _cli_die(f"not a file: {path}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        _cli_die(f"not a valid backup (malformed JSON): {path}")
    except OSError as e:
        _cli_die(f"cannot read {path}: {e.strerror or e}")
    # The HTTP route tolerates a missing schema key (hand-assembled payloads);
    # the CLI does not — a stray JSON file (say, zimi.json) fed to `restore`
    # must refuse outright, not half-apply.
    if not isinstance(data, dict) or data.get("schema") != _manage._BACKUP_SCHEMA:
        _cli_die(f"not a Zimi backup bundle: {path}")

    _headless_state_boot()
    result, err = _manage._apply_backup_bundle(data, overwrite=overwrite)
    if err:
        _cli_die(f"restore failed: {err}")
    applied = result["applied"]
    # Present-but-untouched keys: env-locked settings (ZIMI_HOT_ZIMS,
    # ZIMI_AUTO_UPDATE) or server keys riding on a device-scope bundle, which
    # the plan deliberately strips. Saying so beats a silent partial restore.
    skipped = [k for k in _manage._BUNDLE_STATE_KEYS if k in data and k not in applied]
    preview = result["preview"]
    print(
        f"Restored from {path} (scope: {preview['scope']}, "
        f"mode: {'overwrite' if overwrite else 'merge'})"
    )
    print("  applied: " + (", ".join(applied) if applied else "nothing (empty bundle)"))
    if skipped:
        print("  skipped: " + ", ".join(skipped))
    missing = preview.get("missing_zims")
    if missing:
        print(
            f"  note: {missing} ZIM(s) in the bundle's library manifest are not "
            "installed; re-download them from the catalog"
        )


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

    # Every path/bind flag defaults to None, not to its real default: that is
    # how resolve_settings tells "flag omitted" (fall through to env, then the
    # config file) from "flag given". Shared by `serve` and `config` so the
    # latter reports exactly what the former would boot with.
    def add_boot_flags(p):
        p.add_argument(
            "--port",
            type=int,
            default=None,
            help=f"Port to bind (overrides ZIMI_PORT, default: {DEFAULT_PORT})",
        )
        p.add_argument(
            "--zim-dir",
            default=None,
            help=f"Directory containing *.zim files (overrides ZIM_DIR, default: {DEFAULT_ZIM_DIR})",
        )
        p.add_argument(
            "--data-dir",
            default=None,
            help=f"Directory for Zimi's own state (overrides ZIMI_DATA_DIR, default: <zim-dir>/{DEFAULT_DATA_DIR_NAME})",
        )
        p.add_argument(
            "--host",
            default=None,
            help=f"Address to bind (default: {DEFAULT_HOST})",
        )
        p.add_argument(
            "--config",
            default=None,
            help=f"Path to a JSON config file (overrides {CONFIG_ENV_VAR}, default: <data-dir>/{CONFIG_FILENAME} if present)",
        )

    p_serve = sub.add_parser("serve", help="Start HTTP API server")
    add_boot_flags(p_serve)
    p_serve.add_argument(
        "--ui",
        action="store_true",
        help="Open in a native desktop window (requires pywebview)",
    )

    p_config = sub.add_parser(
        "config", help="Print the resolved configuration and where each value came from"
    )
    add_boot_flags(p_config)

    # backup/restore take the same boot flags as serve/config so they operate
    # on exactly the paths a `serve` with the same arguments would use — the
    # point is backing up the RIGHT instance, not whichever one env defaults
    # happen to name.
    p_backup = sub.add_parser(
        "backup",
        help="Write a full-server backup bundle (users, access policy, "
        "settings, collections) to a JSON file",
    )
    p_backup.add_argument(
        "file",
        nargs="?",
        default=None,
        help="Output path (default: ./zimi-backup-<date>.json)",
    )
    add_boot_flags(p_backup)

    p_restore = sub.add_parser(
        "restore", help="Apply a backup bundle (merges by default)"
    )
    p_restore.add_argument("file", help="Backup bundle (JSON) to apply")
    p_restore.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace matching state wholesale instead of merging",
    )
    add_boot_flags(p_restore)

    sub.add_parser(
        "desktop",
        help="Start server and open in a native desktop window (requires pywebview)",
    )

    args = parser.parse_args()

    # Before anything can read a path: argparse runs long after the module-level
    # env read, so the flags (and the config file, which only argparse can point
    # us at) have to be folded back into the globals here. Done for every
    # subcommand, not just `serve`, so one file describes the whole instance —
    # with no config file present this resolves to exactly today's values.
    # getattr with a default: only `serve` and `config` carry these flags, and
    # the rest of the subcommands still want the file's zim_dir/data_dir.
    flags = {
        k: getattr(args, k, None)
        for k in ("zim_dir", "data_dir", "host", "port", "config")
    }
    # The one impure discovery probe, shared by every resolution below so all
    # of them agree on the same answer. Cheap (a few globs), and inert unless
    # zim_dir would otherwise fall to the hardcoded default.
    discovered = discover_zim_dir()
    try:
        config, config_path = load_config(
            flags["zim_dir"],
            flags["data_dir"],
            flags["config"],
            discovered_zim_dir=discovered,
        )
        settings = resolve_settings(
            zim_dir_flag=flags["zim_dir"],
            data_dir_flag=flags["data_dir"],
            host_flag=flags["host"],
            port_flag=flags["port"],
            config=config,
            config_path=config_path,
            discovered_zim_dir=discovered,
        )
    except ConfigError as e:
        print(f"zimi: {e}", file=sys.stderr)
        sys.exit(2)
    apply_data_paths(
        flags["zim_dir"],
        flags["data_dir"],
        config=config,
        discovered_zim_dir=discovered,
    )
    # Read-only media check, up front for every subcommand: an explicitly
    # configured unwritable data dir is an operator mistake (one line, exit 2,
    # same convention as ConfigError), while an unwritable DERIVED default
    # reroutes to the per-library cache dir — and `zimi config` must report
    # the reroute as the provenance of the value actually in effect.
    #
    # EXCEPT `zimi config` itself: it is the diagnostic you reach for to debug
    # exactly this misconfiguration, so it must never refuse to print. It
    # reports the problem beneath the table instead of dying above it.
    data_dir_problem = None
    try:
        _ensure_writable_data_dir()
    except DataDirError as e:
        if args.command == "config":
            data_dir_problem = str(e)
        else:
            print(f"zimi: {e}", file=sys.stderr)
            sys.exit(2)
    if _data_dir_fallback_from:
        settings["data_dir"] = (
            ZIMI_DATA_DIR,
            f"fallback: {_data_dir_fallback_from} not writable",
        )
    host = settings["host"][0]
    port = settings["port"][0]

    if args.command == "config":
        print(format_config_report(settings))
        if data_dir_problem:
            # Diagnosis, not death: the whole point of this command is seeing
            # the resolution that a failing serve/backup would die over.
            print(f"\nwarning: {data_dir_problem}")
        if not config_path:
            # The most common config-file support question is "why is my file
            # not being read", and the answer is nearly always that it is not
            # where Zimi looked.
            print(
                f"\nno config file in use (looked for {os.path.join(ZIMI_DATA_DIR, CONFIG_FILENAME)})"
            )

    elif args.command == "search":
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
            entries = z["entries"] if isinstance(z["entries"], int) else 0
            print(
                f"  {z['name']:40s} {z['size_gb']:>8.1f} GB  {entries:>10} entries  ({z['file']})"
            )

    elif args.command == "backup":
        _cli_backup(args.file)

    elif args.command == "restore":
        _cli_restore(args.file, args.overwrite)

    elif args.command == "desktop" or (args.command == "serve" and args.ui):
        try:
            # The desktop entry-point lives in the repo's desktop/ dir (a sibling
            # of this package), not on the default import path — add it first.
            _desktop_dir = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "desktop"
            )
            if _desktop_dir not in sys.path:
                sys.path.insert(0, _desktop_dir)
            from zimi_desktop import main as desktop_main
        except ImportError:
            print(
                "Desktop mode requires pywebview: pip install pywebview",
                file=sys.stderr,
            )
            sys.exit(1)
        desktop_main()

    elif args.command == "serve":
        print(f"ZIM Reader API starting on port {port}")
        print(f"ZIM directory: {ZIM_DIR}")
        load_cache()
        # Startup partial-download sweep. Keep partials that a download record
        # still wants (resume_pending_downloads() picks those up via Range).
        # For the rest (orphaned), auto-delete only the stale ones (>24h) — a
        # recent orphaned partial is left in place so the user can re-add it and
        # resume; the interactive "clean up" action can clear it on demand.
        from zimi import library as _lib

        _protected, _orphaned = _lib.classify_partials()
        for info in _protected:
            log.info("Partial download found (resumable): %s", info["filename"])
        for info in _orphaned:
            if info["age_hours"] * 3600 <= 86400:
                log.info("Partial download found (orphaned): %s", info["filename"])
                continue
            try:
                os.remove(os.path.join(ZIM_DIR, info["filename"]))
                log.info("Cleaned up stale partial download: %s", info["filename"])
            except OSError:
                pass
        warm_indexes()
        start_background_services(port)
        # Start auto-update thread if enabled
        global _auto_update_thread
        if _auto_update_enabled:
            import random as _rand_mod

            _auto_update_thread = threading.Thread(
                target=_auto_update_loop,
                # Jittered first check: a fleet booting together (power
                # restored, coordinated deploy) must not stampede Kiwix
                # with simultaneous catalog fetches at startup.
                kwargs={"initial_delay": int(_rand_mod.uniform(60, 900))},
                daemon=True,
            )
            _auto_update_thread.start()
        print(f"Endpoints: /search, /read, /suggest, /list, /health")
        if ZIMI_MANAGE:
            if _get_manage_password_hash():
                log.info("Library management enabled (password protected)")
            else:
                log.info(
                    "Library management enabled (no password — set one in Settings for public servers)"
                )
        # docker stop / systemd / CI teardown send SIGTERM, which by default
        # kills Python without running atexit — skipping the clean engine
        # shutdown that flushes fastresume + the final upload accounting.
        # Route it through sys.exit so cleanup handlers run.
        import signal

        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

        server = ThreadingHTTPServer((host, port), ZimHandler)
        # Emit READY <actual-port> so wrapper scripts (CI smoke tests, the
        # desktop launcher) can capture the bound port — important when
        # --port 0 is used to let the OS pick a free port.
        actual_port = server.server_address[1]
        print(f"READY {actual_port}", flush=True)
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
# Hot ZIM cache (Pro feature)
#
# Hot ZIMs are pre-warmed at startup; cold ones stay lazy. Targets users with
# 1000+ ZIMs who want fast searches against a small frequently-used subset.
#
# Source priority:
#   1. ZIMI_HOT_ZIMS env var (csv) — overrides file
#   2. ZIMI_DATA_DIR/hot.json    — persistent across restarts
#   3. empty                      — fall back to existing warm-everything
# ============================================================================

_HOT_ZIMS_FILENAME = "hot.json"


def _hot_zims_file():
    return os.path.join(ZIMI_DATA_DIR, _HOT_ZIMS_FILENAME)


def _parse_hot_csv(raw):
    """Split a comma-separated env value into a clean list of names."""
    return [item.strip() for item in raw.split(",") if item.strip()]


def get_hot_zims():
    """Names of ZIMs configured as hot, in priority order. Never raises."""
    raw = os.environ.get("ZIMI_HOT_ZIMS")
    if raw is not None:
        return _parse_hot_csv(raw)
    path = _hot_zims_file()
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return [s for s in data if isinstance(s, str) and s]
        except (OSError, json.JSONDecodeError):
            log.warning("hot.json corrupt or unreadable; treating as empty")
    return []


def set_hot_zims(names):
    """Persist the hot-ZIMs list to ZIMI_DATA_DIR/hot.json. Atomic.

    Validates: every entry must be a string. Duplicates are dropped while
    preserving first-seen order.
    """
    if not isinstance(names, list):
        raise TypeError("names must be a list of strings")
    seen = set()
    deduped = []
    for n in names:
        if not isinstance(n, str):
            raise TypeError(f"hot-zim name must be string, got {type(n).__name__}")
        if not n or n in seen:
            continue
        seen.add(n)
        deduped.append(n)
    os.makedirs(ZIMI_DATA_DIR, exist_ok=True)
    _atomic_write_json(_hot_zims_file(), deduped)
    log.info("hot.json updated: %d ZIM(s)", len(deduped))


def warm_indexes():
    """Pre-warm indexes for fast first queries.

    Called by serve() at startup and by mcp_server.py on init.

    Eager Archive pre-warm is gated on a non-empty hot list (env
    `ZIMI_HOT_ZIMS` or `hot.json`). With no hot list — the default for
    fragile / lightweight hosts — Archive handles open lazily on first
    use. Search itself is unaffected: title indexes are SQLite, not
    libzim, and the startup worker still builds them. The lazy default
    keeps peak startup memory bounded regardless of ZIM count; users
    with beefy hosts can opt back in by populating hot.json.
    """
    zims = get_zim_files()
    hot = get_hot_zims()
    names_to_warm = []
    if hot:
        # Validate every named hot ZIM exists; warn on misses.
        unknown = [h for h in hot if h not in zims]
        if unknown:
            log.warning("Hot ZIMs not found in library: %s", ", ".join(unknown))
        names_to_warm = [h for h in hot if h in zims]
        log.info(
            "Pre-warming %d hot archive(s) of %d total (cold ZIMs stay lazy)",
            len(names_to_warm),
            len(zims),
        )
        for name in names_to_warm:
            try:
                get_archive(name)
            except Exception as e:
                log.warning("Skipping %s: %s", name, e)
        log.info("Hot archives ready")
    else:
        log.info(
            "%d ZIM(s) registered; archives open lazily on first use "
            "(set ZIMI_HOT_ZIMS to pre-warm)",
            len(zims),
        )

    # Single sequential startup worker. Five parallel fan-out threads (with a
    # ThreadPoolExecutor inside one of them) used to open Archive handles for
    # every ZIM concurrently, blowing memory on weak hosts. We now run the
    # phases in order on one daemon thread — peak memory at startup is one
    # Archive handle plus one SQLite tmp instead of N×5 mmaps.
    def _startup_worker():
        # Phase 1: build/refresh title indexes (one Archive open at a time).
        try:
            _build_all_title_indexes()
        except Exception as e:
            log.warning("Title index build phase failed: %s", e)

        # Phase 2: build/refresh Q-ID indexes (one Archive open at a time).
        try:
            _build_all_qid_indexes()
        except Exception as e:
            log.warning("Q-ID index build phase failed: %s", e)

        # Phase 3: warm suggestion indexes for hot ZIMs only. With no hot
        # list, suggest archives open lazily on first /suggest call —
        # paying the open once per ZIM at first use is cheaper than
        # holding N libzim mmaps continuously.
        if hot:
            try:
                zim_files = get_zim_files()
                targets = {n: zim_files[n] for n in names_to_warm if n in zim_files}
                warmed = 0
                for name, path in targets.items():
                    try:
                        _get_suggest_archive(name)
                        archive = open_archive(path)
                        try:
                            ss = SuggestionSearcher(archive)
                            s = ss.suggest("a")
                            s.getResults(0, 1)
                        finally:
                            del archive
                        warmed += 1
                    except Exception as e:
                        log.debug("Failed to warm suggest index for %s: %s", name, e)
                log.info("Suggestion indexes warmed: %d/%d", warmed, len(targets))
            except Exception as e:
                log.warning("Suggest warm phase failed: %s", e)

        # Phase 4: warm FTS archive pool — hot list only, same rationale.
        if hot:
            try:
                for name in names_to_warm:
                    try:
                        _get_fts_archive(name)
                    except Exception as e:
                        log.debug("Failed to warm FTS archive for %s: %s", name, e)
                log.info("FTS pool warmed: %d archives", len(_fts_pool))
            except Exception as e:
                log.warning("FTS warm phase failed: %s", e)

        # Phase 5: warm title-index SQLite B-trees (no Archive opens — cheap).
        try:
            zim_files = get_zim_files()
            opened = 0
            for name in zim_files:
                conn = _get_title_db(name)
                if conn is not None:
                    try:
                        for prefix in ("a", "m", "s"):
                            conn.execute(
                                "SELECT title FROM titles WHERE title_lower >= ? LIMIT 1",
                                (prefix,),
                            ).fetchone()
                    except Exception as e:
                        log.debug("Failed to warm title B-tree for %s: %s", name, e)
                    opened += 1
            log.info("Title indexes warmed: %d/%d", opened, len(zim_files))
        except Exception as e:
            log.warning("Title B-tree warm phase failed: %s", e)

    threading.Thread(
        target=_startup_worker, daemon=True, name="zimi-startup-worker"
    ).start()

    loaded = _suggest_cache_restore()
    if loaded:
        log.info("Suggest cache restored: %d entries", loaded)


# ============================================================================
# Re-exports from extracted modules
# ============================================================================
# These keep ``zimi.server.search_all`` etc. working so callers (tests,
# mcp_server.py, handler code still in this file) need zero changes.

from zimi.search import (  # noqa: E402, F401
    # Search / suggest caches (dicts + constants + functions)
    _search_cache,
    SEARCH_CACHE_MAX,
    _search_cache_key,
    _search_cache_get,
    _search_cache_put,
    _search_cache_clear,
    _suggest_cache,
    _suggest_cache_get,
    _suggest_cache_put,
    _suggest_cache_clear,
    _suggest_cache_persist,
    _suggest_cache_restore,
    # SQLite pooling helpers (used by Q-ID code above)
    _get_pooled_db,
    _close_pooled_db,
    _index_is_current,
    # Title index
    _get_title_db,
    _close_title_db,
    _title_index_dir,
    _title_index_path,
    _title_index_is_current,
    _build_title_index,
    _build_fts_for_index,
    _title_index_search,
    _get_title_index_stats,
    _get_title_index_status_brief,
    _build_all_title_indexes,
    _clean_stale_title_indexes,
    # Archive pools for suggest/FTS
    _get_suggest_archive,
    _get_fts_archive,
    _get_pooled_archive,
    # Search functions
    suggest_search_zim,
    search_zim,
    _score_result,
    _clean_query,
    search_all,
    read_article,
    chunk_article,
    CHUNK_SIZE_MIN,
    CHUNK_SIZE_MAX,
    CHUNK_SIZE_DEFAULT,
    CHUNK_OVERLAP_DEFAULT,
    suggest,
    extract_pdf_text,
    get_catalog,
    parse_catalog,
    # Content serving & discover
    random_entry,
    _get_dated_entry,
    _xkcd_date_lookup,
    _pick_html_entry,
    _get_factbook_countries,
    # Constants & compiled patterns (used by tests)
    _meta_title_re,
    STOP_WORDS,
)

from zimi.interlang import (  # noqa: E402, F401
    # Language data
    _LANG_NATIVE_NAMES,
    _STOPWORDS,
    _detect_query_language,
    # Q-ID matching
    _build_all_qid_indexes,
    _qid_passive_cache,
    _qid_passive_extract,
    _qid_lookup,
    _qid_extract_from_html,
    _qid_cache_store,
    _qid_find_in_zim,
    _qid_has_index,
    # Almanac deep-links (closed-set Q-ID → article batch resolution)
    resolve_almanac_qids,
    ALMANAC_QID_BATCH_MAX,
    # Cross-ZIM resolution
    _domain_zim_map,
    _xzim_refs,
    _xzim_refs_lock,
    _build_domain_zim_map,
    _resolve_url_to_zim,
    # Article language matching
    get_article_languages,
    _zim_project_name,
    _zim_quality_score,
    _find_article_in_lang_zims,
)

from zimi.library import (  # noqa: E402, F401
    # Auto-update
    _auto_update_config_path,
    _auto_update_env_locked,
    _load_auto_update_config,
    _save_auto_update_config,
    _auto_update_enabled,
    _auto_update_freq,
    _auto_update_last_check,
    _auto_update_thread,
    _auto_update_loop,
    _FREQ_SECONDS,
    # Downloads & catalog
    _active_downloads,
    _download_lock,
    _download_counter,
    _opds_cache,
    _OPDS_CACHE_TTL,
    _start_download,
    _start_peer_download,
    _start_import,
    _get_downloads,
    _fetch_kiwix_catalog,
    maintenance_catalog_refresh,
    USER_AGENT,
    _check_updates,
    _fetch_thumb,
    _clear_thumb_cache,
    _thumb_dir,
    _download_thread,
    _fetch_mirrors,
    _download_from_url,
    _title_from_filename,
    KIWIX_OPDS_BASE,
)

from zimi.manage import (  # noqa: E402, F401
    # Password & authentication
    _hash_pw,
    _PW_ITERATIONS,
    _env_pw_hash_cache,
    _get_manage_password_hash,
    _api_token_file,
    _get_api_token,
    _generate_api_token,
    _revoke_api_token,
    _check_manage_auth,
    # Manage route handlers
    handle_manage_get,
    handle_manage_post,
)

from zimi.http import (  # noqa: E402, F401
    # Rate limiting
    RATE_LIMIT,
    RATE_LIMIT_CONTENT,
    _rate_buckets,
    _rate_buckets_content,
    _rate_lock,
    _check_rate_limit,
    # Metrics
    _metrics,
    _metrics_lock,
    _record_metric,
    _get_metrics,
    # Usage stats
    _usage_stats,
    _usage_lock,
    _record_usage,
    _get_usage_stats,
    _get_disk_usage,
    # UI templates
    COMPRESSIBLE_TYPES,
    SEARCH_UI_HTML,
    # HTTP handler
    ZimHandler,
)

if __name__ == "__main__":
    main()
