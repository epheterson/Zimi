"""Which network addresses a web-started capture may not reach.

A capture started from the web is a request a server makes on a person's
behalf, so it must not be turned on the network the server sits in: a
loopback service, a router page, a cloud metadata endpoint. The command line is
the machine's own operator and is never held to this.

One rule, used everywhere a capture fetches: an address is private when it is
loopback, RFC 1918 or ULA, link-local (169.254.169.254 included), carrier-grade
NAT (the range Tailscale hands out), unspecified or multicast. A NAME is judged
by what it RESOLVES to, so a public-looking name pointing at 10.x is private
too. Resolution is cached per guard (one guard per job) so a crawl does not
ask the resolver once per asset.
"""

import ipaddress
import os
import socket
import threading

# Carrier-grade NAT / overlay-network shared address space (RFC 6598): Tailscale
# gives every node one. Python's ipaddress.is_private is False for it, so it is
# named here, and zimi.http reads it from here for its own trust tier.
CGNAT_NET = ipaddress.ip_network("100.64.0.0/10")


_NAT64 = ipaddress.ip_network("64:ff9b::/96")
# RFC 8215's local-use NAT64 prefix: a network's own translator, so a private
# address behind it is as private as one behind the well-known prefix.
_NAT64_LOCAL = ipaddress.ip_network("64:ff9b:1::/48")
# ::/96, the long-deprecated IPv4-compatible form: ::10.9.8.1
_IPV4_COMPATIBLE = ipaddress.ip_network("::/96")
RESOLVE_TIMEOUT = 5.0  # seconds one name may take to resolve before it is refused


def _embedded_addresses(ip):
    """The IPv4 addresses an IPv6 one carries, which is where it really goes:
    IPv4-mapped (``::ffff:10.9.8.1``), NAT64 (``64:ff9b::a09:801``), 6to4
    (``2002:a00:1::``), Teredo (server and client) and the deprecated
    IPv4-compatible form."""
    if ip.version != 6:
        return []
    found = []
    if ip.ipv4_mapped is not None:
        found.append(ip.ipv4_mapped)
    if ip.sixtofour is not None:
        found.append(ip.sixtofour)
    if ip.teredo is not None:
        found.extend(ip.teredo)
    if ip in _NAT64 or ip in _NAT64_LOCAL or (ip in _IPV4_COMPATIBLE and int(ip) > 1):
        found.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return found


def is_private_address(ip):
    """Whether an ``ipaddress`` object is one a web capture may not reach.
    An IPv4 address carried inside an IPv6 one (mapped, NAT64, 6to4, Teredo) is
    judged as the IPv4 address it is, as well as the IPv6 one."""
    if any(is_private_address(inner) for inner in _embedded_addresses(ip)):
        return True
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_unspecified
        or ip.is_multicast
        or (ip.version == 4 and ip in CGNAT_NET)
    )


class PrivateGuard:
    """The rule for one job: ``refuses(host)`` for a name or an address."""

    def __init__(self, resolve=None, timeout=RESOLVE_TIMEOUT):
        self._resolve = resolve or socket.getaddrinfo
        self._timeout = timeout
        self._verdicts = {}
        self._unresolved = set()
        self._lock = threading.Lock()

    def refuses(self, host):
        host = (host or "").strip("[]").lower()
        if not host:
            return False
        with self._lock:
            known = self._verdicts.get(host)
        if known is None:
            # Outside the lock: one slow lookup must not hold up every other
            # request the capture makes.
            known, final = self._judge(host)
            with self._lock:
                if final:
                    self._verdicts[host] = known
                    self._unresolved.discard(host)
                else:
                    # Refused for now, and asked again next time: a resolver
                    # that hiccuped once must not condemn a host for the job.
                    self._unresolved.add(host)
        return known

    def could_not_resolve(self, host):
        """Whether the last refusal of ``host`` was for want of an answer
        rather than for the address it gave."""
        with self._lock:
            return (host or "").strip("[]").lower() in self._unresolved

    def _lookup(self, host):
        """``getaddrinfo`` with a deadline: the entries, or None for an error or
        a lookup that took too long."""
        box = {}

        def work():
            try:
                box["found"] = self._resolve(host, None)
            except (OSError, UnicodeError):
                pass

        worker = threading.Thread(target=work, daemon=True, name="zimi-guard-resolve")
        worker.start()
        worker.join(self._timeout)
        return box.get("found")

    def _judge(self, host):
        """``(refused, final)``: a verdict from an address is final; a name that
        would not resolve, or not in time, is refused but not remembered."""
        try:
            return is_private_address(ipaddress.ip_address(host)), True
        except ValueError:
            pass
        found = self._lookup(host)
        if not found:
            return True, False
        for entry in found:
            try:
                if is_private_address(ipaddress.ip_address(entry[4][0].split("%")[0])):
                    return True, True
            except ValueError:
                continue
        return False, True


# ── Container networks ──────────────────────────────────────────────────────
# A fresh install's setup page trusts the home network (manage.
# _first_run_lan_client), and a neighbouring container is the one device that
# can sit inside a home-looking range without being the owner: Docker Desktop
# hands compose networks 192.168.x, and a daemon's address pool can be set to
# anything. These are the subnets such a neighbour comes from.
# Virtual bridges, seen from the host (or a host-network container): Docker's,
# libvirt's (virbr0 is 192.168.122.x), LXD's, Podman's and the CNI plugins'.
_BRIDGE_IFACES = ("docker", "br-", "virbr", "lxdbr", "cni", "podman", "flannel", "cali", "vxlan")
_PROC_ROUTE = "/proc/net/route"
_PROC_INET6 = "/proc/net/if_inet6"
_CONTAINER_MARKERS = ("/.dockerenv", "/run/.containerenv")
_own_networks = None
_own_networks_lock = threading.Lock()


def _ipv4_routes(path=_PROC_ROUTE):
    """(interface, network) for each connected IPv4 route in /proc/net/route:
    the subnets this machine sits on. Hex fields are little-endian."""
    out = []
    try:
        with open(path, encoding="utf-8") as fh:
            rows = fh.read().splitlines()[1:]
    except OSError:
        return out
    for row in rows:
        parts = row.split()
        if len(parts) < 8 or parts[2] != "00000000":  # a gateway: not connected
            continue
        try:
            dest = ipaddress.IPv4Address(bytes.fromhex(parts[1])[::-1])
            mask = ipaddress.IPv4Address(bytes.fromhex(parts[7])[::-1])
            net = ipaddress.ip_network(f"{dest}/{mask}", strict=False)
        except ValueError:
            continue
        if net.prefixlen:  # the default route is no subnet
            out.append((parts[0], net))
    return out


def _ipv6_addrs(path=_PROC_INET6):
    """(interface, network) for each IPv6 address in /proc/net/if_inet6."""
    out = []
    try:
        with open(path, encoding="utf-8") as fh:
            rows = fh.read().splitlines()
    except OSError:
        return out
    for row in rows:
        parts = row.split()
        if len(parts) < 6:
            continue
        try:
            addr = ipaddress.IPv6Address(bytes.fromhex(parts[0]))
            net = ipaddress.ip_network(f"{addr}/{int(parts[2], 16)}", strict=False)
        except ValueError:
            continue
        if not (addr.is_loopback or addr.is_link_local):
            out.append((parts[5], net))
    return out


def orchestrated():
    """Whether Zimi runs under Kubernetes, where a NodePort can hand the
    internet a 10.x node address: no network there is the home network."""
    return bool(os.environ.get("KUBERNETES_SERVICE_HOST"))


def own_networks(routes=None, addrs=None, in_container=None):
    """The container networks this server is attached to, read once.

    The daemon's bridges (docker0, br-*), wherever Zimi runs. Inside a
    bridge-network container, which sees no bridge of its own, every subnet it
    is attached to, gateway included: there a published port's connection
    arrives from the gateway (Docker Desktop), and a neighbour from the same
    subnet. A host-network container (Zimi's own compose files) sees the host's
    interfaces, its LAN among them, and so only its bridges count, as on the
    host. Linux only; elsewhere there is nothing to read."""
    global _own_networks
    if routes is None and addrs is None and in_container is None and _own_networks is not None:
        return _own_networks
    pairs = (_ipv4_routes() if routes is None else routes) + (_ipv6_addrs() if addrs is None else addrs)
    if in_container is None:
        in_container = any(os.path.exists(p) for p in _CONTAINER_MARKERS)
    bridged = [net for iface, net in pairs if iface.startswith(_BRIDGE_IFACES)]
    nets = tuple(bridged if (bridged or not in_container) else [net for _, net in pairs])
    if routes is None and addrs is None:
        with _own_networks_lock:
            _own_networks = nets
    return nets


def on_own_network(ip):
    """Whether an ``ipaddress`` object is inside one of own_networks()."""
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return any(ip.version == net.version and ip in net for net in own_networks())
