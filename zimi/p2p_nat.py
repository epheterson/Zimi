"""NAT traversal + port reachability for the BT sidecar.

Real BT apps show whether the listen port is reachable and try to open it
via UPnP; Zimi does the same with a stdlib-only implementation:

- SSDP discovery (UDP multicast) finds the Internet Gateway Device
- A SOAP AddPortMapping call maps the BT port (TCP+UDP, 24h lease,
  refreshed on every startup/recheck)
- GetExternalIPAddress comes straight from the gateway (works offline)
- Actual reachability is confirmed via Transmission's public port checker
  when the internet is available; otherwise it stays "unknown"

Everything fails soft — a router without UPnP or an offline network just
reports what it can. No state here is trusted for security decisions.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket
import threading
import time
import urllib.request
from xml.etree import ElementTree as ET

log = logging.getLogger("zimi")

SSDP_ADDR = ("239.255.255.250", 1900)
_IGD_SEARCH_TARGETS = (
    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
)
_WAN_SERVICES = (
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
)
PORT_CHECK_URL = "https://portcheck.transmissionbt.com/{port}"
MAPPING_LEASE_SECONDS = 86400

# Last probe result, served by /manage/nat-status without re-probing.
_status_lock = threading.Lock()
_last_status: dict = {}


def _local_ip() -> str | None:
    """The LAN address the OS would route external traffic from."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))  # no packets are actually sent
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return None


def _is_private_url(url: str) -> bool:
    """Only talk UPnP to hosts on the local network — a spoofed SSDP
    response must not turn this into a generic HTTP client."""
    m = re.match(r"https?://([^/:]+)", url or "")
    if not m:
        return False
    try:
        ip = ipaddress.ip_address(m.group(1))
    except ValueError:
        return False
    return ip.is_private or ip.is_link_local


def discover_gateway(timeout: float = 2.0) -> str | None:
    """SSDP M-SEARCH for an IGD; returns its description URL or None."""
    for target in _IGD_SEARCH_TARGETS:
        msg = (
            "M-SEARCH * HTTP/1.1\r\n"
            f"HOST: {SSDP_ADDR[0]}:{SSDP_ADDR[1]}\r\n"
            'MAN: "ssdp:discover"\r\n'
            "MX: 2\r\n"
            f"ST: {target}\r\n\r\n"
        ).encode()
        s = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(timeout)
            s.sendto(msg, SSDP_ADDR)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    data, _addr = s.recvfrom(4096)
                except socket.timeout:
                    break
                m = re.search(
                    rb"^LOCATION:\s*(\S+)", data, re.IGNORECASE | re.MULTILINE
                )
                if m:
                    loc = m.group(1).decode(errors="replace")
                    if _is_private_url(loc):
                        return loc
        except OSError:
            continue
        finally:
            if s is not None:
                s.close()
    return None


def _find_control(desc_url: str) -> tuple[str, str] | None:
    """Parse the IGD description; return (control_url, service_type)."""
    try:
        with urllib.request.urlopen(desc_url, timeout=3) as resp:
            xml = resp.read(262144)  # IGD descriptions are a few KB
    except Exception:
        return None
    # stdlib expat won't fetch external entities, but reject DTDs outright —
    # a hostile LAN device gets no entity-expansion surface at all.
    if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    # Strip namespaces for painless matching
    for el in root.iter():
        el.tag = el.tag.rsplit("}", 1)[-1]
    base = desc_url.rsplit("/", 1)[0]
    url_base = (root.findtext(".//URLBase") or "").strip()
    if url_base:
        base = url_base.rstrip("/")
    for svc in root.iter("service"):
        stype = (svc.findtext("serviceType") or "").strip()
        if stype in _WAN_SERVICES:
            ctl = (svc.findtext("controlURL") or "").strip()
            if not ctl:
                continue
            if not ctl.startswith("http"):
                ctl = base + (ctl if ctl.startswith("/") else "/" + ctl)
            # LAN-only, enforced on the RESOLVED URL: a spoofed SSDP
            # response with a public URLBase must not turn the SOAP
            # client into a generic HTTP poster.
            if not _is_private_url(ctl):
                return None
            return ctl, stype
    return None


def _soap(control_url: str, service_type: str, action: str, args: dict) -> str | None:
    body_args = "".join(f"<{k}>{v}</{k}>" for k, v in args.items())
    envelope = (
        '<?xml version="1.0"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        f'<s:Body><u:{action} xmlns:u="{service_type}">{body_args}</u:{action}>'
        "</s:Body></s:Envelope>"
    ).encode()
    req = urllib.request.Request(
        control_url,
        data=envelope,
        headers={
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPAction": f'"{service_type}#{action}"',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            return resp.read().decode(errors="replace")
    except Exception as e:
        log.debug("UPnP %s failed: %s", action, e)
        return None


def add_port_mapping(port: int) -> bool:
    """Map TCP+UDP `port` to this host on the gateway. True if TCP mapped."""
    desc = discover_gateway()
    if not desc:
        return False
    found = _find_control(desc)
    if not found:
        return False
    control_url, stype = found
    local = _local_ip()
    if not local:
        return False
    ok = False
    for proto in ("TCP", "UDP"):
        resp = _soap(
            control_url,
            stype,
            "AddPortMapping",
            {
                "NewRemoteHost": "",
                "NewExternalPort": port,
                "NewProtocol": proto,
                "NewInternalPort": port,
                "NewInternalClient": local,
                "NewEnabled": "1",
                "NewPortMappingDescription": "Zimi BitTorrent",
                "NewLeaseDuration": MAPPING_LEASE_SECONDS,
            },
        )
        if proto == "TCP" and resp is not None and "Fault" not in resp:
            ok = True
    return ok


def get_external_ip() -> str | None:
    """Ask the gateway for its WAN address (works without internet)."""
    desc = discover_gateway()
    if not desc:
        return None
    found = _find_control(desc)
    if not found:
        return None
    resp = _soap(found[0], found[1], "GetExternalIPAddress", {})
    if not resp:
        return None
    m = re.search(r"<NewExternalIPAddress>([^<]+)<", resp)
    return m.group(1).strip() if m else None


def _port_listening(port: int) -> bool:
    """Is anything (i.e. aria2) accepting on the BT port locally?"""
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=1)
        s.close()
        return True
    except OSError:
        return False


def _port_reachable_external(port: int) -> bool | None:
    """Public port check (Transmission's service). None when unreachable
    (offline) — reachability is then honestly unknown."""
    try:
        req = urllib.request.Request(
            PORT_CHECK_URL.format(port=port), headers={"User-Agent": "Zimi"}
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            return resp.read().strip() == b"1"
    except Exception:
        return None


def probe(bt_port: int, *, try_upnp: bool = True) -> dict:
    """Full NAT probe: listen state, UPnP mapping, external view.

    Slow (seconds) — callers run it off the request thread except for the
    explicit recheck button.
    """
    result = {
        "bt_port": bt_port,
        "listening": _port_listening(bt_port),
        "upnp": "off",
        "external_ip": None,
        "reachable": None,
        "checked_at": time.time(),
    }
    if try_upnp:
        mapped = add_port_mapping(bt_port)
        result["upnp"] = "mapped" if mapped else "unavailable"
        if mapped:
            result["external_ip"] = get_external_ip()
    result["reachable"] = _port_reachable_external(bt_port)
    with _status_lock:
        _last_status.clear()
        _last_status.update(result)
    return dict(result)


def last_status() -> dict:
    with _status_lock:
        return dict(_last_status)
