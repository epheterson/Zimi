"""#104: "Why are searches limited? If everything is local, searches
shouldn't be restricted."

A real Zimi server, real sockets. This machine (and the LAN, by the same
rule: tests/test_unit.py TestTrustedRateTier covers every private range)
searches without limit; an internet client, here one a reverse proxy on this
host forwarded, keeps the anonymous budget. A password is set, as on the
reporter's instance: before the fix that put a LAN client on the anonymous
60 a minute.
"""

import http.client
import threading
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import pytest

from zimi import http as _http
from zimi import manage as _manage


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _http.ZimHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with (
        patch.object(_http, "RATE_LIMIT", 60),
        patch.object(_http, "RATE_LIMIT_EXPLICIT", False),
        patch.object(_manage, "_get_manage_password_hash", return_value="salt$hash"),
    ):
        _http._rate_buckets.clear()
        yield srv.server_address[1]
        _http._rate_buckets.clear()
    srv.shutdown()
    srv.server_close()


def _statuses(port, n, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    out = []
    try:
        for i in range(n):
            conn.request(
                "GET",
                "/suggest?q=a" if i % 2 else "/search?q=water&fast=1",
                headers=headers or {},
            )
            r = conn.getresponse()
            r.read()
            out.append(r.status)
    finally:
        conn.close()
    return out


def test_this_machine_searches_200_times_a_minute_unlimited(server):
    statuses = _statuses(server, 200)
    assert 429 not in statuses, statuses


def test_an_internet_client_is_still_limited(server):
    # A same-host reverse proxy forwarding a public client: the socket is
    # loopback, and that must not make the internet look local.
    statuses = _statuses(server, 80, {"X-Forwarded-For": "8.8.8.8"})
    assert 429 in statuses
    assert statuses.index(429) == _http.RATE_LIMIT


def test_a_forged_private_claim_through_a_proxy_is_not_local(server):
    statuses = _statuses(server, 80, {"X-Forwarded-For": "192.168.1.9"})
    assert 429 in statuses
