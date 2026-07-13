"""LAN peer discovery via mDNS/Zeroconf.

Zimi advertises `_zimi._tcp.local.` with TXT records describing its
HTTP port, BT port, version, and how many ZIMs it serves. It also
browses for other Zimi peers on the same LAN.

The whole module is fail-soft: if `zeroconf` isn't installed or any
network call raises, discovery silently disables and the rest of Zimi
keeps working.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time

log = logging.getLogger(__name__)

SERVICE_TYPE = "_zimi._tcp.local."
PEER_STALE_SECONDS = 120
BROWSE_REFRESH_SECONDS = 30
PEER_LIST_TTL_SECONDS = 60
PEER_LIST_MAX_BYTES = 5 * 1024 * 1024  # 5MB cap on a peer's /list response

_peers: dict[str, dict] = {}
_peers_lock = threading.Lock()
# (timestamp, list_payload) keyed by full service name
_peer_list_cache: dict[str, tuple] = {}
_peer_list_lock = threading.Lock()
_zc = None
_service_info = None
_browser = None
_self_service_name: str | None = None


def _import_zeroconf():
    """Return the zeroconf module, or None if unavailable."""
    try:
        import zeroconf

        return zeroconf
    except ImportError:
        return None


def is_enabled() -> bool:
    """LAN discovery is on by default; ZIMI_PEER_DISCOVERY=0 disables it."""
    val = os.environ.get("ZIMI_PEER_DISCOVERY", "1").strip().lower()
    return val not in ("0", "false", "no", "off", "")


def is_share_enabled() -> bool:
    """Serve our local ZIMs to LAN peers over HTTP. On by default.

    An explicitly-set ZIMI_PEER_SHARE env var wins (and locks the UI
    toggle); otherwise the persisted UI preference (shared prefs store
    in p2p — one file for all sharing toggles)."""
    val = os.environ.get("ZIMI_PEER_SHARE")
    if val is not None and val.strip():
        return val.strip().lower() not in ("0", "false", "no", "off")
    from zimi import p2p

    return bool(p2p._read_pref("peer_share", True))


def is_share_env_locked() -> bool:
    val = os.environ.get("ZIMI_PEER_SHARE")
    return val is not None and val.strip() != ""


def is_public_share_enabled() -> bool:
    """Allow non-private (WAN) clients to pull whole ZIMs from /dl/.

    Off by default: a Zimi behind a public reverse proxy
    (knowledge.zosia.io) should not let the open internet vacuum
    multi-GB files. LAN/loopback peers are always allowed when sharing
    is on; flip ZIMI_PEER_SHARE_PUBLIC=1 to also serve the public."""
    val = os.environ.get("ZIMI_PEER_SHARE_PUBLIC", "0").strip().lower()
    return val in ("1", "true", "yes", "on")


def _local_ip() -> str:
    """Best-effort: a routable IPv4 the LAN can reach. Falls back to 127.0.0.1."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def _hostname() -> str:
    try:
        return socket.gethostname().split(".")[0] or "zimi"
    except OSError:
        return "zimi"


def _peer_instance_name() -> str:
    """Friendly name advertised on mDNS. ZIMI_PEER_NAME env var
    overrides the auto-detected `zimi-<hostname>` form. Sanitized to
    `[a-zA-Z0-9-]+` to keep DNS-SD service names valid."""
    raw = os.environ.get("ZIMI_PEER_NAME", "").strip()
    if raw:
        # DNS-SD instance names allow most printable chars, but we
        # restrict to [a-zA-Z0-9-_ ] for safety + readability. Spaces
        # in DNS-SD are technically OK but cause friction in CLI tools.
        cleaned = "".join(c if (c.isalnum() or c in "-_ ") else "-" for c in raw)
        return cleaned.strip("- ")[:63] or _hostname()
    return f"zimi-{_hostname()}"


class _PeerListener:
    """Zeroconf service listener. Caches add/update events into _peers and
    drops them on remove. Self-advertisements are skipped via self_name."""

    def __init__(self, self_name: str | None = None):
        self.self_name = self_name

    def add_service(self, zc, type_, name):
        if self.self_name and name.split(".")[0] == self.self_name:
            return
        try:
            info = zc.get_service_info(type_, name)
        except Exception as e:  # pragma: no cover — defensive
            log.debug("peer info fetch failed: %s", e)
            return
        if info is None:
            return
        try:
            host = socket.inet_ntoa(info.addresses[0]) if info.addresses else "0.0.0.0"
            props = info.properties or {}
            zim_count = _txt_int(props.get(b"zim_count"))
            bt_port = _txt_int(props.get(b"bt_port"))
            version = _txt_str(props.get(b"version"))
            short_name = name.split("._")[0]
            with _peers_lock:
                _peers[name] = {
                    "name": short_name,
                    "host": host,
                    "port": info.port or 0,
                    "bt_port": bt_port,
                    "version": version,
                    "zim_count": zim_count,
                    "last_seen": time.time(),
                }
        except Exception as e:  # pragma: no cover — defensive
            log.debug("peer parse failed for %s: %s", name, e)

    update_service = add_service  # zeroconf calls this on TXT changes

    def remove_service(self, zc, type_, name):
        with _peers_lock:
            _peers.pop(name, None)


def _txt_int(value, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value.decode() if isinstance(value, bytes) else value)
    except (ValueError, AttributeError, UnicodeDecodeError):
        return default


def _txt_str(value, default: str = "") -> str:
    if value is None:
        return default
    try:
        return value.decode() if isinstance(value, bytes) else str(value)
    except (AttributeError, UnicodeDecodeError):
        return default


def get_peers() -> list[dict]:
    """Return non-stale peers, sorted by name."""
    cutoff = time.time() - PEER_STALE_SECONDS
    with _peers_lock:
        fresh = [p.copy() for p in _peers.values() if p["last_seen"] >= cutoff]
        # Prune stale entries opportunistically.
        for key in [k for k, v in _peers.items() if v["last_seen"] < cutoff]:
            _peers.pop(key, None)
    fresh.sort(key=lambda p: p["name"])
    return fresh


def start(
    *,
    http_port: int,
    bt_port: int,
    zim_count: int,
    version: str = "",
) -> bool:
    """Start advertising + browsing. Returns True on success, False if
    zeroconf is unavailable or already started."""
    global _zc, _service_info, _browser, _self_service_name

    if _zc is not None:
        return False

    if not is_enabled():
        return False

    mod = _import_zeroconf()
    if mod is None:
        log.info("Peer discovery disabled: zeroconf not installed")
        return False

    try:
        instance = _peer_instance_name()
        full_name = f"{instance}.{SERVICE_TYPE}"
        _self_service_name = instance

        properties = {
            b"version": version.encode(),
            b"zim_count": str(zim_count).encode(),
            b"port": str(http_port).encode(),
            b"bt_port": str(bt_port).encode(),
        }
        ip = _local_ip()
        si = mod.ServiceInfo(
            SERVICE_TYPE,
            full_name,
            addresses=[socket.inet_aton(ip)],
            port=http_port,
            properties=properties,
            server=f"{instance}.local.",
        )
        zc = mod.Zeroconf()
        zc.register_service(si)
        listener = _PeerListener(self_name=instance)
        browser = mod.ServiceBrowser(zc, SERVICE_TYPE, listener)

        _zc, _service_info, _browser = zc, si, browser
        log.info(
            "Peer discovery started: %s @ %s:%d (advertised %d ZIMs)",
            instance,
            ip,
            http_port,
            zim_count,
        )
        return True
    except Exception as e:
        log.warning("Peer discovery startup failed: %s", e)
        _zc = None
        _service_info = None
        _browser = None
        return False


def stop() -> None:
    global _zc, _service_info, _browser, _self_service_name
    if _zc is None:
        return
    try:
        if _service_info is not None:
            _zc.unregister_service(_service_info)
    except Exception as e:  # pragma: no cover — defensive
        log.debug("peer unregister failed: %s", e)
    try:
        _zc.close()
    except Exception as e:  # pragma: no cover — defensive
        log.debug("peer zc close failed: %s", e)
    _zc = None
    _service_info = None
    _browser = None
    _self_service_name = None


def fetch_peer_list(peer_name: str):
    """Proxy a peer's /list endpoint, cached for PEER_LIST_TTL_SECONDS.
    Returns the parsed JSON list or None if the peer is unknown / the
    fetch fails / the response is malformed."""
    import json
    import urllib.request

    full_key = None
    host = None
    port = None
    with _peers_lock:
        for key, peer in _peers.items():
            if peer["name"] == peer_name:
                full_key = key
                host = peer["host"]
                port = peer["port"]
                break
    if full_key is None:
        return None

    now = time.time()
    with _peer_list_lock:
        cached = _peer_list_cache.get(full_key)
    if cached and (now - cached[0]) < PEER_LIST_TTL_SECONDS:
        return cached[1]

    url = f"http://{host}:{port}/list"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Zimi-peer/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read(PEER_LIST_MAX_BYTES)
        parsed = json.loads(data)
        if not isinstance(parsed, list):
            return None
    except (OSError, ValueError):
        return None

    with _peer_list_lock:
        _peer_list_cache[full_key] = (now, parsed)
    return parsed


def _reset_for_tests() -> None:
    """Test-only: clear all module state without trying to close real
    Zeroconf instances. Tests use mocks so we just zero everything."""
    global _zc, _service_info, _browser, _self_service_name
    with _peers_lock:
        _peers.clear()
    _zc = None
    _service_info = None
    _browser = None
    _self_service_name = None
