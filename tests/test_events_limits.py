"""GET /events holds a thread and a socket per open stream, so the streams are
capped (all together and per client address, the same _client_ip the rate
limiter uses, forwarded headers and trust rules included), the path takes the
normal rate limit, and a full server answers 429 with Retry-After. The page's
stream waits that long before asking again (no hot loop).

Run: pytest tests/test_events_limits.py -v
"""

import http.client
import os
import re
import sys
import threading
import time
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.http as zhttp  # noqa: E402
from zimi.http import ZimHandler  # noqa: E402

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def port(monkeypatch):
    monkeypatch.setattr(zhttp, "_EVENTS_HEARTBEAT_S", 0.1)  # a closed stream is noticed at its next write
    monkeypatch.setattr(zhttp, "_EVENTS_MAX_PER_IP", 2)
    monkeypatch.setattr(zhttp, "_EVENTS_MAX_STREAMS", 3)
    monkeypatch.setattr(zhttp, "_events_open", {})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()


def _open(port, ip=None):
    """GET /events, headers read; the connection stays open."""
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", "/events", headers={"CF-Connecting-IP": ip} if ip else {})
    r = c.getresponse()
    c.close = lambda close=c.close: (r.close(), close())  # the response holds the socket too
    return c, r


def _wait(cond, secs=5):
    end = time.monotonic() + secs
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_events_takes_the_rate_limit():
    assert zhttp._rate_class("/events") == (True, False)


def test_a_client_over_its_cap_gets_429_with_retry_after_and_others_do_not(port):
    open_ = []
    try:
        for _ in range(2):
            c, r = _open(port, "8.8.8.8")
            assert r.status == 200 and r.getheader("Content-Type").startswith("text/event-stream")
            open_.append(c)
        c, r = _open(port, "8.8.8.8")
        assert r.status == 429
        assert int(r.getheader("Retry-After")) == zhttp._EVENTS_FULL_RETRY_S
        assert b"error" in r.read() and b"Traceback" not in r.read()
        c.close()
        # Another address (CF-Connecting-IP, trusted from this hop) has its own count.
        c, r = _open(port, "1.1.1.1")
        assert r.status == 200
        open_.append(c)
    finally:
        for c in open_:
            c.close()


def test_this_machine_reached_directly_has_no_per_client_cap_but_the_server_cap_holds(port):
    open_ = []
    try:
        for _ in range(3):  # more than the per-client cap of 2, all from 127.0.0.1 with nothing in front
            c, r = _open(port)
            assert r.status == 200
            open_.append(c)
        c, r = _open(port)
        assert r.status == 429, "the whole-server cap (3) still holds"
        c.close()
    finally:
        for c in open_:
            c.close()


def test_the_whole_server_has_a_cap_too(port):
    open_ = []
    try:
        for ip in ("8.8.8.8", "1.1.1.1", "9.9.9.9"):
            c, r = _open(port, ip)
            assert r.status == 200
            open_.append(c)
        c, r = _open(port, "4.4.4.4")
        assert r.status == 429 and r.getheader("Retry-After")
        c.close()
    finally:
        for c in open_:
            c.close()


def test_a_closed_stream_gives_its_place_back(port):
    a, _ = _open(port, "8.8.8.8")
    b, _ = _open(port, "8.8.8.8")
    assert _open(port, "8.8.8.8")[1].status == 429
    a.close()
    assert _wait(lambda: zhttp._events_open.get("8.8.8.8") == 1)
    c, r = _open(port, "8.8.8.8")
    assert r.status == 200
    for x in (b, c):
        x.close()
    assert _wait(lambda: not zhttp._events_open), "nothing left counted"


def test_the_page_waits_after_a_refusal_instead_of_asking_again_at_once():
    js = open(os.path.join(_ROOT, "zimi", "static", "app.js"), encoding="utf-8").read()
    wait = int(re.search(r"var _LIVE_RETRY_MS = (\d+)", js).group(1))
    assert wait >= zhttp._EVENTS_FULL_RETRY_S * 1000
    handler = js[js.index("src.onerror = function"):]
    handler = handler[: handler.index("};")]
    assert "readyState !== 2" in handler and "setTimeout(_liveOpen, _LIVE_RETRY_MS)" in handler
