"""A client that hangs up mid-response is not a server error (#51).

When the Pi in #51 starved, every UI poller timed out and closed its socket;
each handler then raised BrokenPipeError in wfile.write, which the dispatch
backstops treated as a real failure: full traceback to stderr (unlocked, so
threads interleaved into noise) plus an attempted 500 to a dead socket that
raised AGAIN and reached socketserver.handle_error for a second traceback.
These tests pin the quiet path: disconnects get one debug line, no traceback,
no 500 — and the server keeps serving the next client.
"""

import contextlib
import io
import json
import logging
import os
import socket
import struct
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402
from zimi.http import ZimHandler, _DISCONNECT_ERRS  # noqa: E402


def _bare_handler():
    """A ZimHandler with no socket — enough for the dispatch backstop."""
    h = ZimHandler.__new__(ZimHandler)
    h.command = "GET"
    h.path = "/list"
    h.requestline = "GET /list HTTP/1.1"
    h.request_version = "HTTP/1.1"
    h.client_address = ("127.0.0.1", 12345)
    return h


class _RecordingLog(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record)


@contextlib.contextmanager
def _capture():
    """Capture stderr text and zimi log records for the with-block."""
    log = logging.getLogger("zimi")
    rec = _RecordingLog()
    log.addHandler(rec)
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stderr(stderr):
            yield stderr, rec
    finally:
        log.removeHandler(rec)


# ---------------------------------------------------------------------------
# Unit: the dispatch backstop
# ---------------------------------------------------------------------------


def test_disconnect_classes_are_the_expected_ones():
    assert BrokenPipeError in _DISCONNECT_ERRS
    assert ConnectionResetError in _DISCONNECT_ERRS


def test_broken_pipe_is_one_debug_line_no_traceback_no_500():
    h = _bare_handler()
    sent = []
    h._json = lambda code, data: sent.append(code)
    with _capture() as (stderr, rec):
        try:
            raise BrokenPipeError("client went away")
        except Exception as e:
            h._dispatch_error(e)
    assert sent == []  # never writes to a dead socket
    assert "Traceback" not in stderr.getvalue()
    assert all(r.levelno <= logging.DEBUG for r in rec.records)


def test_connection_reset_is_quiet_too():
    h = _bare_handler()
    sent = []
    h._json = lambda code, data: sent.append(code)
    with _capture() as (stderr, _rec):
        try:
            raise ConnectionResetError("rst")
        except Exception as e:
            h._dispatch_error(e)
    assert sent == []
    assert stderr.getvalue() == ""


def test_real_errors_still_traceback_and_500():
    h = _bare_handler()
    sent = []
    h._json = lambda code, data: sent.append(code)
    with _capture() as (stderr, _rec):
        try:
            raise ValueError("genuine bug")
        except Exception as e:
            h._dispatch_error(e)
    assert sent == [500]
    assert "Traceback" in stderr.getvalue()
    assert "genuine bug" in stderr.getvalue()


def test_disconnect_during_500_write_is_swallowed():
    """Client vanished between the failure and the error reply — the second
    BrokenPipeError must not escape (that's what reached handle_error and
    printed the interleaved second traceback in the #51 log)."""
    h = _bare_handler()

    def dead_socket_json(code, data):
        raise BrokenPipeError("dead")

    h._json = dead_socket_json
    with _capture() as (stderr, _rec):
        try:
            raise ValueError("genuine bug")
        except Exception as e:
            h._dispatch_error(e)  # must not raise
    assert "genuine bug" in stderr.getvalue()  # the real bug still surfaces


def test_handle_one_request_backstop_closes_quietly(monkeypatch):
    h = _bare_handler()
    h.close_connection = False
    monkeypatch.setattr(
        BaseHTTPRequestHandler,
        "handle_one_request",
        lambda self: (_ for _ in ()).throw(BrokenPipeError("mid-headers")),
    )
    with _capture() as (stderr, _rec):
        h.handle_one_request()  # must not raise
    assert h.close_connection is True
    assert stderr.getvalue() == ""


# ---------------------------------------------------------------------------
# Integration: real socket hangs up mid-response
# ---------------------------------------------------------------------------


def test_live_disconnect_no_traceback_no_500_and_server_survives(monkeypatch):
    # A slow /list gives the client time to hang up before the write.
    monkeypatch.setattr(
        server, "list_zims", lambda use_cache=True: time.sleep(0.6) or []
    )
    monkeypatch.setattr(server, "_load_library_layout", lambda: {})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with _capture() as (stderr, rec):
            s = socket.create_connection(("127.0.0.1", port), timeout=5)
            s.sendall(b"GET /list HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            # SO_LINGER 0 → RST on close: the handler's write must fail, the
            # deterministic stand-in for a browser giving up under load.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            s.close()
            time.sleep(1.5)  # let the handler wake, write, and fail
        assert "Traceback" not in stderr.getvalue(), stderr.getvalue()
        assert not any(
            "500" in r.getMessage() for r in rec.records if r.levelno >= logging.INFO
        ), [r.getMessage() for r in rec.records]

        # The server is unharmed: a well-behaved client still gets a 200.
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/list", timeout=10) as r:
            assert r.status == 200
            json.loads(r.read())  # parseable body, server thread healthy
    finally:
        httpd.shutdown()
        httpd.server_close()
