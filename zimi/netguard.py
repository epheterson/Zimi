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
import socket
import threading

# Carrier-grade NAT / overlay-network shared address space (RFC 6598): Tailscale
# gives every node one. Python's ipaddress.is_private is False for it, so it is
# named here, and zimi.http reads it from here for its own trust tier.
CGNAT_NET = ipaddress.ip_network("100.64.0.0/10")


def is_private_address(ip):
    """Whether an ``ipaddress`` object is one a web capture may not reach.
    An IPv4 address wrapped in IPv6 (``::ffff:10.0.0.1``) is judged as the
    IPv4 address it is."""
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
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

    def __init__(self, resolve=None):
        self._resolve = resolve or socket.getaddrinfo
        self._verdicts = {}
        self._lock = threading.Lock()

    def refuses(self, host):
        host = (host or "").strip("[]").lower()
        if not host:
            return False
        with self._lock:
            if host not in self._verdicts:
                self._verdicts[host] = self._judge(host)
            return self._verdicts[host]

    def _judge(self, host):
        try:
            return is_private_address(ipaddress.ip_address(host))
        except ValueError:
            pass
        try:
            found = self._resolve(host, None)
        except (OSError, UnicodeError):
            return False  # unresolvable: the fetch fails on its own
        for entry in found:
            try:
                if is_private_address(ipaddress.ip_address(entry[4][0].split("%")[0])):
                    return True
            except ValueError:
                continue
        return False
