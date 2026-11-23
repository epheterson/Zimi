"""A .meta4 download keeps Kiwix's mirror order, gives failed mirrors a second
round, and carries on with the same mirror after a pause.

Local HTTP server with Range support, no real network. The mirrors are plain
http on a free port, so the tests hand _download_thread the list _fetch_mirrors
would return (the parser itself is checked with a fake .meta4 body).
"""

import http.server
import io
import os
import sys
import threading
import time
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.library as lib  # noqa: E402
import zimi.server as server  # noqa: E402
from ports import free_port  # noqa: E402

CHUNK = 65536  # the read size of the download loop
BODY = bytes(range(256)) * 1200  # 307,200 bytes, several chunks
FILENAME = "mirror_order_2026-01.zim"
WAIT_FOR = 10  # seconds a test gives a background thread


class _Mirrors:
    """A server whose paths each behave as set: ok, fail (500), or drop (send
    one chunk, hold until released, then hang up short)."""

    def __init__(self):
        self.behaviour = {}
        self.hits = []  # (path, Range header)
        self.release = threading.Event()
        self.sent_first = threading.Event()
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_GET(self):
                path = self.path
                rng = self.headers.get("Range")
                outer.hits.append((path, rng))
                mode = outer.behaviour.get(path, "ok")
                if isinstance(mode, list):  # one behaviour per visit
                    mode = mode.pop(0) if len(mode) > 1 else mode[0]
                if mode == "fail":
                    self.send_response(500)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                start = int(rng.split("=")[1].rstrip("-")) if rng else 0
                data = BODY[start:]
                if rng:
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{len(BODY) - 1}/{len(BODY)}")
                else:
                    self.send_response(200)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if mode == "drop":
                    self.wfile.write(data[:CHUNK])
                    self.wfile.flush()
                    outer.sent_first.set()
                    outer.release.wait(WAIT_FOR)
                    self.close_connection = True
                    return
                self.wfile.write(data)

        self.port = free_port()
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self, name):
        return f"http://127.0.0.1:{self.port}/{name}"

    def paths(self):
        return [p for p, _ in self.hits]

    def close(self):
        self.release.set()
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def mirrors():
    m = _Mirrors()
    yield m
    m.close()


@pytest.fixture
def thread_env(tmp_path, monkeypatch):
    """Everything around _download_thread stubbed except the mirror loop."""
    import zimi.p2p as p2p

    monkeypatch.setattr(p2p, "get_backend", lambda **k: None)
    monkeypatch.setattr(server, "open_archive", lambda path: None)
    monkeypatch.setattr(lib, "_post_download_finalize", lambda dl: None)
    monkeypatch.setattr(lib, "_seed_after_http_download", lambda dl: None)
    monkeypatch.setattr(lib, "_record_download_activity", lambda *a, **k: None)
    monkeypatch.setattr(server, "_append_history", lambda *a, **k: None)
    monkeypatch.setattr(lib, "MIRROR_ROUND_WAIT_S", 0.3, raising=False)
    monkeypatch.setattr(lib, "MIRROR_WAIT_STEP_S", 0.05, raising=False)
    monkeypatch.setattr(lib, "PAUSE_POLL_S", 0.05, raising=False)

    def make(direct, fetched):
        monkeypatch.setattr(lib, "_fetch_mirrors", lambda url: list(fetched))
        return {
            "id": "t1",
            "filename": FILENAME,
            "dest": str(tmp_path / FILENAME),
            "url": direct,
            "mirrors": [direct],
            "_meta4": direct + ".meta4",
            "size_bytes": len(BODY),
        }

    return make


def _run(dl):
    t = threading.Thread(target=lib._download_thread, args=(dl,), daemon=True)
    t.start()
    return t


def _read(dl):
    with open(dl["dest"], "rb") as f:
        return f.read()


# ── 1. Kiwix's order, never shuffled ──────────────────────────────────────

def test_fetch_mirrors_orders_by_priority_document_order_for_ties(monkeypatch):
    xml = (
        b'<metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="f.zim">'
        b'<url location="de" priority="3">https://c.example/f.zim</url>'
        b'<url location="us" priority="1">https://a.example/f.zim</url>'
        b'<url location="fr" priority="2">https://b1.example/f.zim</url>'
        b'<url location="fr" priority="2">https://b2.example/f.zim</url>'
        b"</file></metalink>"
    )
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: io.BytesIO(xml))
    got = lib._fetch_mirrors("https://x.example/f.zim.meta4")
    assert got == [
        "https://a.example/f.zim",
        "https://b1.example/f.zim",
        "https://b2.example/f.zim",
        "https://c.example/f.zim",
    ]


@pytest.mark.parametrize("run_no", range(5))
def test_meta4_download_uses_priority_order_direct_last(mirrors, thread_env, run_no):
    mirrors.behaviour = {"/m1": "fail", "/m2": "fail", "/m3": "fail", "/direct": "fail"}
    dl = thread_env(mirrors.url("direct"), [mirrors.url("m1"), mirrors.url("m2"), mirrors.url("m3")])
    t = _run(dl)
    t.join(WAIT_FOR)
    assert mirrors.paths()[:4] == ["/m1", "/m2", "/m3", "/direct"]


def test_failing_first_mirror_falls_to_the_second(mirrors, thread_env):
    mirrors.behaviour = {"/m1": "fail"}
    dl = thread_env(mirrors.url("direct"), [mirrors.url("m1"), mirrors.url("m2")])
    _run(dl).join(WAIT_FOR)
    assert dl.get("error") is None and dl["done"]
    assert mirrors.paths() == ["/m1", "/m2"]
    assert _read(dl) == BODY


# ── 2. A second round ─────────────────────────────────────────────────────

def test_second_round_after_the_wait_succeeds(mirrors, thread_env):
    mirrors.behaviour = {"/m1": ["fail", "ok"], "/direct": "fail"}
    dl = thread_env(mirrors.url("direct"), [mirrors.url("m1")])
    started = time.time()
    _run(dl).join(WAIT_FOR)
    assert dl.get("error") is None and dl["done"]
    assert mirrors.paths() == ["/m1", "/direct", "/m1"]
    assert time.time() - started >= lib.MIRROR_ROUND_WAIT_S
    assert _read(dl) == BODY


def test_all_failing_stops_after_two_rounds_and_says_so(mirrors, thread_env):
    mirrors.behaviour = {"/m1": "fail", "/direct": "fail"}
    dl = thread_env(mirrors.url("direct"), [mirrors.url("m1")])
    _run(dl).join(WAIT_FOR)
    assert mirrors.paths() == ["/m1", "/direct", "/m1", "/direct"]
    assert "after 2 tries" in dl["error"]


def test_cancel_ends_the_wait_at_once(mirrors, thread_env, monkeypatch):
    monkeypatch.setattr(lib, "MIRROR_ROUND_WAIT_S", 30, raising=False)
    mirrors.behaviour = {"/m1": "fail", "/direct": "fail"}
    dl = thread_env(mirrors.url("direct"), [mirrors.url("m1")])
    t = _run(dl)
    deadline = time.time() + WAIT_FOR
    while len(mirrors.hits) < 2 and time.time() < deadline:
        time.sleep(0.02)
    time.sleep(0.2)
    cancelled_at = time.time()
    dl["cancelled"] = True
    t.join(WAIT_FOR)
    assert not t.is_alive()
    assert time.time() - cancelled_at < 2
    assert dl["error"] == "Cancelled"
    assert len(mirrors.hits) == 2  # no second round


def test_non_meta4_download_gets_one_round(mirrors, thread_env):
    mirrors.behaviour = {"/direct": "fail"}
    dl = thread_env(mirrors.url("direct"), [])
    dl.pop("_meta4")
    _run(dl).join(WAIT_FOR)
    assert mirrors.paths() == ["/direct"]
    assert "tries" not in dl["error"]


# ── 3. Same mirror after a pause ──────────────────────────────────────────

def test_dropped_connection_after_a_pause_resumes_on_the_same_mirror(mirrors, thread_env):
    mirrors.behaviour = {"/m1": ["drop", "ok"]}
    dl = thread_env(mirrors.url("direct"), [mirrors.url("m1"), mirrors.url("m2")])
    dl["paused"] = True
    t = _run(dl)
    assert mirrors.sent_first.wait(WAIT_FOR)
    mirrors.release.set()  # the server hangs up while the download is paused
    time.sleep(0.3)
    dl["paused"] = False
    t.join(WAIT_FOR)
    assert dl.get("error") is None and dl["done"]
    assert mirrors.hits == [("/m1", None), ("/m1", f"bytes={CHUNK}-")]
    assert _read(dl) == BODY


def test_a_drop_with_no_pause_is_a_real_failure(mirrors, thread_env):
    mirrors.behaviour = {"/m1": "drop"}
    mirrors.release.set()
    dl = thread_env(mirrors.url("direct"), [mirrors.url("m1"), mirrors.url("m2")])
    _run(dl).join(WAIT_FOR)
    assert dl.get("error") is None
    assert mirrors.paths()[:2] == ["/m1", "/m2"]
    assert _read(dl) == BODY


def test_pause_resumes_are_bounded(mirrors, tmp_path):
    """With no resumes left, a drop after a pause is the mirror's failure."""
    mirrors.behaviour = {"/m1": "drop"}
    dl = {"filename": FILENAME, "size_bytes": len(BODY), "paused": True}
    threading.Timer(0.3, mirrors.release.set).start()
    threading.Timer(0.6, lambda: dl.update(paused=False)).start()
    ok, err = lib._download_from_url(dl, mirrors.url("m1"), str(tmp_path / "x.tmp"), 0)
    assert not ok and "mismatch" in err
    assert mirrors.paths() == ["/m1"]
