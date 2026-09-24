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
_refresh_stop: threading.Event | None = None
# What the advert says that can change while the server runs (the ZIM count,
# the BT port), read again on every refresh; and the ServiceInfo arguments
# that do not change, to announce a changed record with.
_advert_now = None
_advert_fixed: dict = {}


def _import_zeroconf():
    """Return the zeroconf module, or None if unavailable."""
    try:
        import zeroconf

        return zeroconf
    except ImportError:
        return None


def _nearby_conf() -> dict:
    from zimi import p2p

    return p2p.parse_conf_blob("ZIMI_NEARBY")


def is_enabled() -> bool:
    """Whether this instance announces itself on the LAN and looks for others.

    Only while Nearby is on (Eric, 2026-09-23: "no advertising unless nearby
    is on"). It used to be on by default on its own switch, so a default
    install announced its name (zimi-<hostname>), address, version and ZIM
    count to the network while the Nearby switch in Settings read OFF, which
    the 1.7.0 promise and the README said it would not do. ZIMI_NEARBY's
    discovery= field (or legacy ZIMI_PEER_DISCOVERY) still decides it
    outright when set."""
    conf = _nearby_conf()
    if "discovery" in conf:
        return str(conf["discovery"]).lower() not in ("0", "false", "no", "off")
    if "enabled" in conf and not conf["enabled"]:
        return False  # NEARBY=off silences the whole feature, adverts included
    val = os.environ.get("ZIMI_PEER_DISCOVERY", "").strip().lower()
    if val:
        return val not in ("0", "false", "no", "off")
    return is_share_enabled()


def apply_enabled() -> bool:
    """Start or stop announcing to match the Nearby switch, live. Needs the
    arguments start() was first called with (it records them even when it
    does not start). Returns whether discovery is running afterwards."""
    if is_enabled():
        if _zc is None and _last_start_args:
            start(**_last_start_args)
    elif _zc is not None:
        stop()
    return _zc is not None


def is_share_enabled() -> bool:
    """Serve our local ZIMs to LAN peers over HTTP. OFF by default —
    talking to other machines is opt-in, one switch away.

    ZIMI_NEARBY (or legacy ZIMI_PEER_SHARE) wins and locks the UI
    switch; otherwise the persisted UI preference (shared prefs store
    in p2p — one file for all sharing toggles)."""
    conf = _nearby_conf()
    if "enabled" in conf:
        return bool(conf["enabled"])
    val = os.environ.get("ZIMI_PEER_SHARE")
    if val is not None and val.strip():
        return val.strip().lower() not in ("0", "false", "no", "off")
    from zimi import p2p

    return bool(p2p._read_pref("peer_share", False))


def is_name_env_locked() -> bool:
    return bool(
        str(_nearby_conf().get("name", "")).strip()
        or os.environ.get("ZIMI_PEER_NAME", "").strip()
    )


def is_share_env_locked() -> bool:
    if "enabled" in _nearby_conf():
        return True
    val = os.environ.get("ZIMI_PEER_SHARE")
    return val is not None and val.strip() != ""


def is_public_share_enabled() -> bool:
    """Allow non-private (WAN) clients to pull whole ZIMs from /dl/.

    Off by default: a Zimi behind a public reverse proxy
    (a public https:// URL) should not let the open internet vacuum
    multi-GB files. LAN/loopback peers are always allowed when sharing
    is on; ZIMI_NEARBY's public= field (or legacy ZIMI_PEER_SHARE_PUBLIC)
    opts into serving the public."""
    conf = _nearby_conf()
    if "public" in conf:
        return str(conf["public"]).lower() in ("1", "true", "yes", "on")
    val = os.environ.get("ZIMI_PEER_SHARE_PUBLIC", "0").strip().lower()
    return val in ("1", "true", "yes", "on")


def get_advertise_ip() -> str:
    """The address peers are told to connect to. ZIMI_NEARBY's ip= field
    overrides detection — required in Docker bridge mode, where the
    auto-detected address is the container's bridge IP and unreachable
    from the LAN. (Host networking needs no override.)"""
    override = str(_nearby_conf().get("ip", "")).strip()
    if override:
        return override
    return _local_ip()


def advertised_ip_looks_unreachable() -> bool:
    """True when we're advertising a Docker-bridge address (172.16/12 or
    a veth-style /16 the LAN can't route to). Drives a UI warning —
    Nearby silently doesn't work in bridge mode without ip= or host
    networking."""
    if str(_nearby_conf().get("ip", "")).strip():
        return False  # operator override — trust it
    ip = _local_ip()
    try:
        import ipaddress as _ipa

        addr = _ipa.ip_address(ip)
        return addr in _ipa.ip_network("172.16.0.0/12") or ip == "127.0.0.1"
    except ValueError:
        return False


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


def local_ipv4s() -> list[str]:
    """Every IPv4 on this machine another device could reach: the routed one
    `_local_ip` finds first, then the other adapters the host name resolves
    to. A Windows mobile hotspot (192.168.137.1) is one of the others: it has
    no route to the internet, so `_local_ip` never sees it (issue #90)."""
    import ipaddress as _ipa

    candidates = [_local_ip()]
    try:
        candidates += [
            a[4][0]
            for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        ]
    except OSError:
        pass
    found = []
    for ip in candidates:
        try:
            addr = _ipa.ip_address(ip)
        except ValueError:
            continue
        if addr.is_loopback or addr.is_link_local or addr.is_unspecified or ip in found:
            continue
        found.append(ip)
    return found


def _hostname() -> str:
    try:
        return socket.gethostname().split(".")[0] or "zimi"
    except OSError:
        return "zimi"


def _peer_instance_name(http_port: int | None = None) -> str:
    """Friendly name advertised on mDNS. ZIMI_PEER_NAME env var
    overrides the auto-detected `zimi-<hostname>` form. Sanitized to
    `[a-zA-Z0-9-]+` to keep DNS-SD service names valid.

    A server on another port than the default gets it in the default name
    (`zimi-<hostname>-8900`): two Zimis on one host both announced
    `zimi-<hostname>`, and a peer saw one of them."""
    raw = (
        str(_nearby_conf().get("name", "")).strip()
        or os.environ.get("ZIMI_PEER_NAME", "").strip()
    )
    if not raw:
        from zimi import p2p

        raw = str(p2p._read_pref("peer_name", "")).strip()
    if raw:
        # DNS-SD instance names allow most printable chars, but we
        # restrict to [a-zA-Z0-9-_ ] for safety + readability. Spaces
        # in DNS-SD are technically OK but cause friction in CLI tools.
        cleaned = "".join(c if (c.isalnum() or c in "-_ ") else "-" for c in raw)
        return cleaned.strip("- ")[:63] or _hostname()
    from zimi.server import DEFAULT_PORT

    port = http_port or _last_start_args.get("http_port")
    if port and port != DEFAULT_PORT:
        return f"zimi-{_hostname()}-{port}"
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


def _refresh_loop(zc, listener, stop_evt):
    """Keep known peers' last_seen fresh while they stay reachable.

    Zeroconf fires update_service only when a record CHANGES; a healthy,
    quiet peer emits nothing after its initial announce, so every peer used
    to hit PEER_STALE_SECONDS and vanish from get_peers() two minutes after
    discovery — taking the Nearby pills, the peer-only catalog section and
    peer pulls with it. Re-confirm each cached service on a cadence:
    add_service re-queries its info and stamps last_seen; a peer that has
    genuinely gone answers nothing and ages out through the stale cutoff.
    """
    while not stop_evt.wait(BROWSE_REFRESH_SECONDS):
        _refresh_advert()
        with _peers_lock:
            names = list(_peers.keys())
        for name in names:
            if stop_evt.is_set():
                return
            try:
                listener.add_service(zc, SERVICE_TYPE, name)
            except Exception as e:  # pragma: no cover — refresh must outlive hiccups
                log.debug("peer refresh failed for %s: %s", name, e)


def _refresh_advert() -> None:
    """Announce the record again if the ZIM count or BT port changed since.

    They were written once at start, so a peer kept being told the library
    had the ZIMs it had at boot and the BT port it had before a restart of
    the engine from Settings."""
    global _service_info
    if _zc is None or _service_info is None or _advert_now is None or not _advert_fixed:
        return
    try:
        now = _advert_now()
        props = dict(_service_info.properties)
        new = dict(props)
        new[b"zim_count"] = str(now["zim_count"]).encode()
        new[b"bt_port"] = str(now["bt_port"]).encode()
        if new == props:
            return
        si = _advert_fixed["mod"].ServiceInfo(*_advert_fixed["args"], properties=new, **_advert_fixed["kwargs"])
        _zc.update_service(si)
        _service_info = si
    except Exception as e:  # pragma: no cover — refresh must outlive hiccups
        log.debug("advert refresh failed: %s", e)


_last_start_args: dict = {}


def restart_advertising() -> bool:
    """Re-register with current settings (e.g. a renamed instance) without
    a server restart. No-op when discovery isn't running."""
    global _last_start_args
    if _zc is None or not _last_start_args:
        return False
    args = dict(_last_start_args)
    stop()
    return start(**args)


def start(
    *,
    http_port: int,
    bt_port: int,
    zim_count: int,
    version: str = "",
    current=None,
) -> bool:
    """Start advertising + browsing. Returns True on success, False if
    zeroconf is unavailable or already started. `current`, when given,
    answers {"zim_count", "bt_port"} as they are now, for the refresh."""
    global _zc, _service_info, _browser, _self_service_name, _last_start_args
    global _refresh_stop, _advert_now, _advert_fixed
    _last_start_args = {
        "http_port": http_port,
        "bt_port": bt_port,
        "zim_count": zim_count,
        "version": version,
        "current": current,
    }

    if _zc is not None:
        return False

    if not is_enabled():
        return False

    mod = _import_zeroconf()
    if mod is None:
        log.info("Peer discovery disabled: zeroconf not installed")
        return False

    try:
        instance = _peer_instance_name(http_port)
        full_name = f"{instance}.{SERVICE_TYPE}"
        _self_service_name = instance

        properties = {
            b"version": version.encode(),
            b"zim_count": str(zim_count).encode(),
            b"port": str(http_port).encode(),
            b"bt_port": str(bt_port).encode(),
        }
        ip = get_advertise_ip()
        fixed_args = (SERVICE_TYPE, full_name)
        fixed_kwargs = {
            "addresses": [socket.inet_aton(ip)],
            "port": http_port,
            "server": f"{instance}.local.",
        }
        si = mod.ServiceInfo(*fixed_args, properties=properties, **fixed_kwargs)
        zc = mod.Zeroconf()
        zc.register_service(si)
        _advert_now = current
        _advert_fixed = {"mod": mod, "args": fixed_args, "kwargs": fixed_kwargs}
        listener = _PeerListener(self_name=instance)
        browser = mod.ServiceBrowser(zc, SERVICE_TYPE, listener)
        _refresh_stop = threading.Event()
        threading.Thread(
            target=_refresh_loop,
            args=(zc, listener, _refresh_stop),
            daemon=True,
            name="zimi-peer-refresh",
        ).start()

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
    global _zc, _service_info, _browser, _self_service_name, _refresh_stop
    global _advert_fixed
    if _refresh_stop is not None:
        _refresh_stop.set()
        _refresh_stop = None
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
    _advert_fixed = {}


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
    global _zc, _service_info, _browser, _self_service_name, _refresh_stop
    global _advert_now, _advert_fixed
    _advert_now = None
    _advert_fixed = {}
    with _peers_lock:
        _peers.clear()
    if _refresh_stop is not None:
        _refresh_stop.set()
    _refresh_stop = None
    _zc = None
    _service_info = None
    _browser = None
    _self_service_name = None
