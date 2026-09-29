"""ZIMI_OFFLINE=1 means nothing leaves for the internet: proved on a real server.

The other offline suites test each switch where it lives. This one starts
Zimi in this process with ZIMI_OFFLINE=1, with every setting that would reach
out on its own turned on as well (Auto-update, BitTorrent and Mirror, update
checks and satellite data on Automatically, single sign-on set up, an
internet download waiting to resume), runs the boot and the 12-hour upkeep,
and drives the pages and actions an admin would. Every outbound connection is
a tripwire: a name lookup or a connect to anything but this machine or its
local network is recorded and refused. The test fails on the first one.

Local addresses stay allowed: the test client talks to 127.0.0.1, and Nearby
(link-local multicast) is not the internet.

Run: pytest tests/test_offline_no_outbound.py -v
"""

import http.client
import ipaddress
import json
import os
import socket
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _local_address(host):
    """True for this machine and its network: loopback, private, link-local,
    multicast, unspecified. False for anything else, a name included."""
    if host in (None, "", "localhost", socket.gethostname()):
        return True
    try:
        ip = ipaddress.ip_address(str(host).split("%", 1)[0])
    except ValueError:
        return False
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
    )


class _Tripwire:
    """Records every attempt to reach past the local network, and refuses it."""

    def __init__(self):
        self.attempts = []
        self._lock = threading.Lock()

    def hit(self, what, host):
        with self._lock:
            self.attempts.append("%s %s" % (what, host))
        raise OSError("tripwire: %s %s (ZIMI_OFFLINE)" % (what, host))


@pytest.fixture
def tripwire(monkeypatch):
    wire = _Tripwire()
    real_getaddrinfo = socket.getaddrinfo
    real_create = socket.create_connection
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def getaddrinfo(host, *a, **k):
        if not _local_address(host):
            wire.hit("lookup", host)
        return real_getaddrinfo(host, *a, **k)

    def create_connection(address, *a, **k):
        if not _local_address(address[0]):
            wire.hit("connect", address[0])
        return real_create(address, *a, **k)

    def _checked(real):
        def connect(self, address):
            host = address[0] if isinstance(address, tuple) else None
            # A UDP "connect" sends nothing: it asks the kernel for a route,
            # which is how Zimi finds its own LAN address.
            if (
                host is not None
                and self.type != socket.SOCK_DGRAM
                and not _local_address(host)
            ):
                wire.hit("connect", host)
            return real(self, address)

        return connect

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    monkeypatch.setattr(socket, "create_connection", create_connection)
    monkeypatch.setattr(socket.socket, "connect", _checked(real_connect))
    monkeypatch.setattr(socket.socket, "connect_ex", _checked(real_connect_ex))
    return wire


@pytest.fixture
def offline_server(tmp_path, monkeypatch, tripwire):
    """Zimi, offline, with everything that could reach out switched on."""
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    import zimi.library as library
    import zimi.manage as manage
    import zimi.p2p as p2p
    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    data = tmp_path / "data"
    zdir.mkdir()
    data.mkdir()
    build_fixture_zim(str(zdir / "water.zim"))
    env = {
        "ZIMI_OFFLINE": "1",
        "ZIMI_BT": "on,mirror=on,seed=on,dht=on,upnp=on",
        "ZIMI_UPDATE_CHECK": "auto",
        "ZIMI_SATELLITE_UPDATES": "auto",
        "ZIMI_SSO_TEAM": "zimi-offline-test",
        "ZIMI_SSO_AUD": "0" * 64,
    }
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    for name in ("ZIMI_MANAGE_PASSWORD", "ZIMI_MANAGE_USER", "ZIMI_NEARBY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(data))
    monkeypatch.setattr(srv, "ZIMI_MANAGE", True)
    monkeypatch.setattr(srv, "_auto_update_enabled", True, raising=False)
    monkeypatch.setattr(p2p, "_prefs_path", None)
    # The host is the admin: no password, a local client.
    monkeypatch.setattr(manage, "_manage_auth_challenge", lambda h: None)
    # An internet download that was running when the server last stopped.
    with open(os.path.join(str(data), "downloads.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "pending": [
                    {
                        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_100_2026-01.zim",
                        "filename": "wikipedia_en_100_2026-01.zim",
                        "size_bytes": 1000,
                        "source": "",
                        "peer_name": "",
                    }
                ]
            },
            f,
        )
    # A seed someone kept, so the BitTorrent engine would have work at boot.
    library.record_seed("water.zim")
    srv.load_cache(force=True)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]

    # The boot: what `zimi serve` starts beside the HTTP server.
    monkeypatch.setattr(srv, "_background_services_started", False)
    srv.start_background_services(port)

    def call(method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(headers or {})
        try:
            conn.request(
                method, path, json.dumps(body or {}) if method == "POST" else None, hdrs
            )
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            conn.close()

    yield call
    httpd.shutdown()
    httpd.server_close()


def _settle(seconds=1.5):
    """Let the boot's and the requests' background threads run."""
    time.sleep(seconds)


def test_offline_zimi_reaches_nothing_on_the_internet(offline_server, tripwire):
    call = offline_server
    import zimi.library as library
    import zimi.p2p as p2p
    import zimi.server as srv
    from zimi import sso

    # The reader's pages.
    for path in (
        "/",
        "/health",
        "/list",
        "/search?q=water",
        "/suggest?q=wat",
        "/read?zim=water&path=A/Water",
        "/random?zim=water",
        "/w/water/A/Water",
        "/static/exchange.html",
        "/almanac-satellites",
    ):
        status, _h, _b = call("GET", path)
        assert status < 500, (path, status)

    # Settings, every pane an admin opens, and the buttons that fetch.
    for path in (
        "/manage/stats",
        "/manage/catalog?lang=&count=500&start=0",
        "/manage/check-updates",
        "/manage/updates",
        "/manage/app-update",
        "/manage/thumb?url=https://library.kiwix.org/catalog/v2/illustration/x",
        "/manage/catalog-streetzim",
        "/manage/satellites",
        "/manage/bt-status",
        "/manage/mirror",
        "/manage/peers",
        "/manage/outbound",
    ):
        status, _h, _b = call("GET", path)
        assert status < 500 or status == 502, (path, status)
    for path, body in (
        ("/manage/app-update-check", {}),
        ("/manage/satellites/refresh", {}),
        ("/manage/nat-recheck", {}),
        (
            "/manage/download",
            {
                "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_100_2026-02.zim"
            },
        ),
        ("/manage/create", {"mode": "page", "source": "https://example.com/"}),
    ):
        call("POST", path, body)

    # A sign-in through Cloudflare Access whose key this server has never seen.
    call(
        "GET",
        "/list",
        headers={sso.SSO_HEADER: "eyJhbGciOiJSUzI1NiIsImtpZCI6Im5ldyJ9.e30.c2ln"},
    )

    # The 12-hour upkeep, and Auto-update's check, now rather than later.
    srv._maintenance_pass()
    library._check_updates()
    _settle()

    assert tripwire.attempts == [], "reached out while offline: %s" % tripwire.attempts
    # And what should have happened instead did.
    assert p2p.peek_backend() is None, "a BitTorrent engine started while offline"
    with open(library._pending_downloads_path(), encoding="utf-8") as f:
        pending = [p["filename"] for p in json.load(f)["pending"]]
    assert (
        "wikipedia_en_100_2026-01.zim" in pending
    ), "an offline boot dropped a download it could not resume"


def test_the_download_route_says_offline(offline_server, tripwire):
    status, _h, body = offline_server(
        "POST",
        "/manage/download",
        {
            "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_100_2026-02.zim"
        },
    )
    assert status == 400
    assert "ZIMI_OFFLINE" in json.loads(body)["error"]
    assert tripwire.attempts == []


def test_every_row_of_the_list_is_off_but_nearby(offline_server, tripwire):
    status, _h, body = offline_server("GET", "/manage/outbound")
    assert status == 200
    inv = json.loads(body)
    assert inv["offline"] is True
    on = [r["id"] for r in inv["rows"] if r["state"] not in ("off", "unset", "lan")]
    assert on == [], on


def test_app_pages_refuse_anything_from_another_host(offline_server):
    """A ZIM's question or post, shown in an app page, cannot fetch from the
    internet either: the page carries the policy ZIM articles carry."""
    from zimi.http import APP_PAGES, ZIM_HTML_CSP

    for page in APP_PAGES:
        status, headers, _b = offline_server("GET", "/static/" + page)
        assert status == 200, page
        assert headers.get("Content-Security-Policy") == ZIM_HTML_CSP, page
    _s, headers, _b = offline_server("GET", "/w/water/A/Water")
    assert headers.get("Content-Security-Policy") == ZIM_HTML_CSP


def test_the_tripwire_catches_a_reach_out(tripwire):
    """The tripwire itself: a fetch to the internet is caught, not made."""
    import urllib.request

    with pytest.raises(OSError):
        urllib.request.urlopen("https://library.kiwix.org/catalog/search", timeout=5)
    assert tripwire.attempts and "library.kiwix.org" in tripwire.attempts[0]
