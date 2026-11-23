"""The server's debug log (zimi/debuglog.py): off, POST /debuglog is no route and nothing is kept; on, a signed-in
window's events are appended as JSON lines to debug/zimi-debug.jsonl, capped and rolled; the Manage switch and
ZIMI_DEBUG_LOG decide, and an open window hears the change.

Run: pytest tests/test_debuglog.py -v
"""

import http.client
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as srv  # noqa: E402
from zimi import changes, debuglog, manage, users  # noqa: E402
from zimi.http import ZimHandler  # noqa: E402


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv(debuglog.ENV, raising=False)
    monkeypatch.setattr(users, "request_data_owner", lambda handler: "alice")
    manage._prefs_cache.clear()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1], tmp_path
    httpd.shutdown()


def _post(port, body, path="/debuglog"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    c.request("POST", path, raw, {"Content-Type": "application/json"})
    r = c.getresponse()
    out = r.read()
    c.close()
    return r.status, out


def _lines(tmp_path):
    p = tmp_path / "debug" / debuglog.FILE
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()] if p.exists() else []


def test_off_is_no_route_and_keeps_nothing(server):
    port, tmp = server
    status, _ = _post(
        port, {"client": "c1", "events": [{"k": "tap", "el": "button#go"}]}
    )
    assert status == 404
    assert not (tmp / "debug").exists()


def test_on_appends_lines_with_who_and_build(server, monkeypatch):
    port, tmp = server
    monkeypatch.setenv(debuglog.ENV, "1")
    status, out = _post(
        port,
        {
            "client": "c1",
            "events": [
                {"t": 5, "k": "tap", "el": "button#go"},
                "junk",
                {"k": "error", "msg": "boom"},
            ],
        },
    )
    assert status == 200 and json.loads(out) == {"kept": 2}
    got = _lines(tmp)
    assert [g["k"] for g in got] == ["tap", "error"]
    assert (
        got[0]["user"] == "alice"
        and got[0]["client"] == "c1"
        and got[0]["build"]
        and got[0]["at"] > 0
    )


def test_signed_out_is_refused(server, monkeypatch):
    port, tmp = server
    monkeypatch.setenv(debuglog.ENV, "1")
    monkeypatch.setattr(users, "request_data_owner", lambda handler: None)
    assert _post(port, {"events": [{"k": "tap"}]})[0] == 401
    assert not (tmp / "debug").exists()


def test_caps_and_rolling(server, monkeypatch):
    port, tmp = server
    monkeypatch.setenv(debuglog.ENV, "1")
    # more events than a batch holds: the first MAX_EVENTS are kept
    status, out = _post(
        port, {"events": [{"k": "n", "i": i} for i in range(debuglog.MAX_EVENTS + 50)]}
    )
    assert json.loads(out)["kept"] == debuglog.MAX_EVENTS
    # a line too long is dropped with a note, not stored whole
    debuglog.append(
        "alice",
        "b",
        "c",
        [{"k": "console.error", **{"f%d" % i: "x" * 600 for i in range(8)}}],
    )
    assert any(g.get("note") == "event too long, dropped" for g in _lines(tmp))
    # the body cap of the route itself (413 over MAX_POST_BODY)
    assert _post(port, b"x" * (srv.MAX_POST_BODY + 10))[0] == 413
    # rolling: past MAX_BYTES the live file becomes .1, and at most KEEP files remain
    monkeypatch.setattr(debuglog, "MAX_BYTES", 3000)
    for i in range(60):
        debuglog.append("alice", "b", "c", [{"k": "n", "pad": "y" * 200, "i": i}])
    files = sorted(os.listdir(tmp / "debug"))
    assert files[0] == debuglog.FILE and len(files) == debuglog.KEEP
    assert all(os.path.getsize(tmp / "debug" / f) <= 3000 + 400 for f in files)


def test_the_switch_saves_is_heard_and_env_wins(server, monkeypatch):
    port, tmp = server
    start = changes.resume_from(None)
    assert debuglog.enabled() is False
    assert debuglog.set_enabled(True) is True
    assert debuglog.enabled() is True
    assert [c["topic"] for c in changes.wait(start, "alice", 0)[1]] == ["debuglog"]
    assert _post(port, {"events": [{"k": "tap"}]})[0] == 200
    debuglog.set_enabled(False)
    assert _post(port, {"events": [{"k": "tap"}]})[0] == 404
    # the environment decides, and the switch refuses
    monkeypatch.setenv(debuglog.ENV, "0")
    assert debuglog.set_enabled(True) is False and debuglog.enabled() is False
    monkeypatch.setenv(debuglog.ENV, "1")
    assert debuglog.enabled() is True and manage._debuglog_view()["env_locked"] is True


def test_the_stream_tick_says_whether_the_log_is_on(server, monkeypatch):
    port, _ = server
    monkeypatch.setenv(debuglog.ENV, "1")
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", "/events")
    r = c.getresponse()
    buf = b""
    while b"event: tick" not in buf or b"\n\n" not in buf.split(b"event: tick")[1]:
        buf += r.fp.readline()
    tick = json.loads(buf.split(b"event: tick\ndata: ")[1].split(b"\n")[0])
    c.close()
    assert tick["debuglog"] is True and tick["build"]


def test_an_event_cannot_speak_for_another_account_or_build(server, monkeypatch):
    port, tmp = server
    monkeypatch.setenv(debuglog.ENV, "1")
    status, _ = _post(port, {"client": "c1", "events": [{"k": "tap", "user": "mallory", "build": "x", "at": 1, "client": "z"}]})
    assert status == 200
    got = _lines(tmp)[-1]
    assert got["user"] == "alice" and got["client"] == "c1" and got["build"] != "x" and got["at"] > 1, got
