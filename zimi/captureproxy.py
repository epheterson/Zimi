"""The capture proxy: where a web capture's browser and downloaders send every
request while the private-address rule is in force.

Chromium's request interception never sees a redirect's next hop, and
SingleFile and yt-dlp bring their own network stacks, so the rule cannot be
kept by asking about URLs. It is kept here, on the connection: every request
names its host to this proxy, which resolves it, connects, and refuses a
private peer before a byte is sent. A redirect, an image, a script's own
fetch and a name that answers differently the second time (DNS rebinding)
all come through the same door.

One proxy per capture, on loopback, started only when an engine asks for one
and stopped with the capture. It forwards bytes; it never reads or keeps
them, and it does not chain to another proxy.
"""

import logging
import select
import socket
import socketserver
import threading
import urllib.parse

log = logging.getLogger("zimi")

CONNECT_TIMEOUT = 30  # seconds to reach a host before the request is refused
IDLE_TIMEOUT = 120  # seconds a tunnel may sit silent before it is closed
_HEAD_LIMIT = 64 * 1024  # a request line and headers longer than this are refused
_CHUNK = 64 * 1024
# A Chromium sent through this proxy sends everything: loopback too (Chromium
# leaves loopback out of any proxy unless told), and no WebRTC around it.
CHROMIUM_PROXIED_ARGS = [
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]


def _host_port(authority, default_port):
    """``(host, port)`` from ``host:port`` or ``[v6]:port``."""
    parsed = urllib.parse.urlsplit("//" + authority)
    return parsed.hostname or "", parsed.port or default_port


def _refusal(code, reason):
    body = reason.encode()
    return (
        f"HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    ).encode() + body


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        client.settimeout(IDLE_TIMEOUT)
        try:
            head, rest = self._read_head(client)
        except OSError:
            return
        if head is None:
            client.sendall(_refusal(400, "Bad Request"))
            return
        lines = head.split(b"\r\n")
        try:
            method, target, version = lines[0].decode("latin-1").split(" ", 2)
        except ValueError:
            client.sendall(_refusal(400, "Bad Request"))
            return
        if method.upper() == "CONNECT":
            host, port = _host_port(target, 443)
            upstream = self.server.open(host, port)
            if upstream is None:
                client.sendall(_refusal(403, "Forbidden"))  # a failed tunnel to the browser
                return
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if rest:
                upstream.sendall(rest)
        else:
            parsed = urllib.parse.urlsplit(target)
            if parsed.scheme.lower() != "http" or not parsed.netloc:
                client.sendall(_refusal(400, "Bad Request"))
                return
            host, port = _host_port(parsed.netloc, 80)
            upstream = self.server.open(host, port)
            if upstream is None:
                # Nothing at all: an answer here would be taken for the page's
                # own, and a redirect to a private address would be captured
                # as a page that says Forbidden.
                return
            path = urllib.parse.urlunsplit(
                ("", "", parsed.path or "/", parsed.query, "")
            )
            headers = [
                line
                for line in lines[1:]
                if line
                and not line.lower().startswith(
                    (b"proxy-", b"connection:", b"keep-alive:")
                )
            ]
            # One request per connection: the browser opens another for the
            # next, and each is judged where it is going.
            upstream.sendall(
                b"\r\n".join(
                    [
                        f"{method} {path} {version}".encode("latin-1"),
                        *headers,
                        b"Connection: close",
                        b"",
                        b"",
                    ]
                )
                + rest
            )
        _relay(client, upstream)

    @staticmethod
    def _read_head(sock):
        """The request line and headers, and whatever came after them."""
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(_CHUNK)
            if not chunk:
                return None, b""
            data += chunk
            if len(data) > _HEAD_LIMIT:
                return None, b""
        head, rest = data.split(b"\r\n\r\n", 1)
        return head, rest


def _relay(a, b):
    """Copy bytes both ways until either side closes or goes quiet."""
    socks = [a, b]
    try:
        while True:
            ready, _, broken = select.select(socks, [], socks, IDLE_TIMEOUT)
            if broken or not ready:
                return
            for src in ready:
                data = src.recv(_CHUNK)
                if not data:
                    return
                (b if src is a else a).sendall(data)
    except OSError:
        return
    finally:
        for s in socks:
            try:
                s.close()
            except OSError:
                pass


class CaptureProxy(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """A forward proxy on loopback that refuses what ``guard`` refuses."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, guard):
        self.guard = guard
        self.refused = set()
        super().__init__(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(
            target=self.serve_forever, daemon=True, name="zimi-capture-proxy"
        )
        self._thread.start()

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.server_address[1]

    def open(self, host, port):
        """A socket to ``host:port``, or None when the rule refuses the name
        or the address the connection actually reached."""
        if not host or self.guard.refuses(host):
            self.refused.add(host)
            log.debug("capture proxy refused %s", host)
            return None
        try:
            sock = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT)
        except OSError as e:
            log.debug("capture proxy could not reach %s:%s: %s", host, port, e)
            return None
        peer = sock.getpeername()[0].split("%")[0]
        if self.guard.refuses(peer):
            sock.close()
            self.refused.add(host)
            log.debug("capture proxy refused %s: it reached %s", host, peer)
            return None
        sock.settimeout(IDLE_TIMEOUT)
        return sock

    def close(self):
        self.shutdown()
        self.server_close()
