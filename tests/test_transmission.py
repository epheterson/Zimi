"""Transmission as the engine, against a fake Transmission.

The fake speaks the RPC calls Zimi makes, with the session-id handshake (409)
and Basic auth, keeps its own view of the disk under remote paths, and
completes a download when the test says so. The client-independent half
(paths, install, the remove guard) is the same code qBittorrent runs, so these
tests cover the RPC half and the places Transmission differs: labels for the
category, the RPC URL, and an asynchronous move.
"""

import base64
import http.server
import json
import os
import re
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import btclient, library, p2p  # noqa: E402
from zimi import transmission as tr  # noqa: E402
from tests.test_qbittorrent import _torrent  # noqa: E402

REMOTE_DL = "/downloads/complete"
REMOTE_LIB = "/zims"
SESSION = "sess-1"


class FakeTransmission:
    def __init__(self, disk, auth=None, rpc_version=17):
        self.disk = disk
        self.auth = auth  # (user, password) or None
        self.rpc_version = rpc_version
        self.torrents = {}
        self.calls = []
        self.refuse = set()  # methods this fake answers with a failure
        fake = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body, headers=()):
                body = json.dumps(body).encode() if isinstance(body, dict) else body
                self.send_response(code)
                for k, v in headers:
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                if self.path != "/transmission/rpc":
                    return self._send(404, b"not here")
                if fake.auth:
                    want = (
                        "Basic "
                        + base64.b64encode(":".join(fake.auth).encode()).decode()
                    )
                    if self.headers.get("Authorization") != want:
                        return self._send(401, b"Unauthorized")
                if self.headers.get(tr.SESSION_HEADER) != SESSION:
                    return self._send(409, b"Conflict", [(tr.SESSION_HEADER, SESSION)])
                req = json.loads(raw)
                fake.calls.append(req["method"])
                return self._send(
                    200, fake.handle(req["method"], req.get("arguments") or {})
                )

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def local(self, remote):
        for r, l in self.disk.items():
            if remote == r or remote.startswith(r + "/"):
                root = os.path.normpath(l)
                path = os.path.normpath(l + remote[len(r) :])
                if path == root or path.startswith(root + os.sep):
                    return path
        raise AssertionError(f"fake Transmission cannot see {remote}")

    def _pick(self, args):
        ids = args.get("ids")
        return [t for h, t in self.torrents.items() if ids is None or h in ids]

    def handle(self, method, args):
        if method in self.refuse:
            return {"result": "refused by the test"}
        ok = {"result": "success", "arguments": {}}
        if method == "session-get":
            ok["arguments"] = {
                "version": "4.0.6 (38c164933e)",
                "rpc-version": self.rpc_version,
                "download-dir": REMOTE_DL,
            }
        elif method == "torrent-get":
            ok["arguments"] = {
                "torrents": [
                    {k: t[k] for k in args["fields"] if k in t}
                    for t in self._pick(args)
                ]
            }
        elif method == "torrent-add":
            data = base64.b64decode(args["metainfo"])
            tid = library._torrent_info_hash(data)
            m = re.search(rb"4:name(\d+):", data)
            name = data[m.end() : m.end() + int(m.group(1))].decode()
            if tid in self.torrents:
                ok["arguments"] = {"torrent-duplicate": {"hashString": tid}}
                return ok
            self.torrents[tid] = {
                "hashString": tid,
                "name": name,
                "status": 4,
                "percentDone": 0.0,
                "sizeWhenDone": 11,
                "leftUntilDone": 11,
                "rateDownload": 0,
                "rateUpload": 0,
                "peersConnected": 1,
                "peersSendingToUs": 1,
                "uploadRatio": -1,
                "uploadedEver": 0,
                "downloadDir": args.get("download-dir") or REMOTE_DL,
                "labels": [],
                "error": 0,
                "errorString": "",
            }
            ok["arguments"] = {"torrent-added": {"hashString": tid}}
        elif method == "torrent-set":
            for t in self._pick(args):
                for k in ("labels", "seedRatioMode", "seedIdleMode"):
                    if k in args:
                        t[k] = args[k]
        elif method in ("torrent-stop", "torrent-start"):
            for t in self._pick(args):
                t["status"] = (
                    0
                    if method == "torrent-stop"
                    else (6 if t["percentDone"] >= 1 else 4)
                )
        elif method == "torrent-remove":
            for t in self._pick(args):
                del self.torrents[t["hashString"]]
                if args.get("delete-local-data"):
                    path = self.local(t["downloadDir"] + "/" + t["name"])
                    if os.path.exists(path):
                        os.remove(path)
        elif method == "torrent-set-location":
            for t in self._pick(args):
                src = self.local(t["downloadDir"] + "/" + t["name"])
                dst = self.local(args["location"] + "/" + t["name"])

                # Transmission moves on its own thread and only then names
                # the new folder.
                def move(t=t, src=src, dst=dst):
                    time.sleep(0.2)
                    os.replace(src, dst)
                    t["downloadDir"] = args["location"]

                threading.Thread(target=move).start()
        else:
            ok = {"result": f"method name not recognized: {method}"}
        return ok

    def finish(self, tid, payload=b"hello world"):
        t = self.torrents[tid]
        path = self.local(t["downloadDir"] + "/" + t["name"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(payload)
        t.update(status=6, percentDone=1.0, leftUntilDone=0)

    def close(self):
        self.server.shutdown()


@pytest.fixture
def world(tmp_path):
    dl_local = tmp_path / "tr-downloads"
    lib_local = tmp_path / "library"
    staging = tmp_path / "staging"
    for d in (dl_local, lib_local, staging):
        d.mkdir()
    fake = FakeTransmission({REMOTE_DL: str(dl_local), REMOTE_LIB: str(lib_local)})
    yield fake, dl_local, lib_local, staging
    fake.close()


def _cfg(fake, paths="", **kw):
    return dict(
        {
            "kind": "transmission",
            "url": fake.url,
            "user": "",
            "password": "",
            "category": "zimi",
            "paths": btclient.parse_paths(paths),
        },
        **kw,
    )


def _backend(fake, lib_local, staging, paths):
    b = tr.TransmissionBackend(
        _cfg(fake, paths), library_dir=str(lib_local), staging_dir=str(staging)
    )
    assert b.available()
    return b


def _write_torrent(tmp_path, name):
    data, tid = _torrent(name)
    p = tmp_path / (name + ".torrent")
    p.write_bytes(data)
    return str(p), tid


def test_the_rpc_url_from_whatever_someone_types():
    for typed in (
        "http://nas:9091",
        "http://nas:9091/",
        "http://nas:9091/transmission/web",
        "http://nas:9091/transmission/web/",
        "http://nas:9091/transmission/rpc",
    ):
        assert tr.rpc_url(typed) == "http://nas:9091/transmission/rpc", typed
    assert (
        tr.rpc_url("https://h/tr/transmission/rpc") == "https://h/tr/transmission/rpc"
    )


def test_session_handshake_and_login(tmp_path):
    fake = FakeTransmission({REMOTE_DL: str(tmp_path)}, auth=("admin", "s3cret"))
    try:
        c = tr.Client(fake.url, "admin", "s3cret")
        assert c.call("session-get")["rpc-version"] == 17
        with pytest.raises(
            btclient.ClientError, match="refused the username or password"
        ):
            tr.Client(fake.url, "admin", "wrong").call("session-get")
    finally:
        fake.close()


def test_transmission_before_3_is_refused_with_a_reason(tmp_path):
    fake = FakeTransmission({REMOTE_DL: str(tmp_path)}, rpc_version=15)
    try:
        b = tr.TransmissionBackend(
            _cfg(fake), library_dir=str(tmp_path), staging_dir=str(tmp_path)
        )
        assert not b.available()
        with pytest.raises(btclient.ClientError, match="3.00 or newer"):
            b._prepare()
    finally:
        fake.close()


def test_probe_reports_what_zimi_can_see(world):
    fake, dl_local, lib_local, _ = world
    got = btclient.probe(_cfg(fake), library_dir=str(lib_local))
    assert got["ok"] and got["version"] == "4.0.6" and got["client"] == "Transmission"
    assert (
        got["save_path"] == REMOTE_DL
        and not got["visible"]
        and not got["library_mapped"]
    )
    got = btclient.probe(
        _cfg(fake, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"),
        library_dir=str(lib_local),
    )
    assert got["visible"] and got["library_mapped"]
    bad = btclient.probe(_cfg(fake, url="http://127.0.0.1:9"), library_dir=None)
    assert not bad["ok"] and bad["error_key"] == "btc_err_unreachable" and "error" not in bad


def test_a_download_carries_zimis_label_and_pauses(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    assert b.add_torrent(src, dest_dir=str(staging)) == tid
    t = fake.torrents[tid]
    assert t["labels"] == ["zimi"] and t["downloadDir"] == REMOTE_DL
    assert b.status(tid)["state"] == "downloading"
    assert b.add_torrent(src, dest_dir=str(staging)) == tid  # a restart finds it
    assert fake.calls.count("torrent-add") == 1
    b.pause(tid)
    assert b.status(tid)["state"] == "paused"
    assert b.list_managed()[0]["status"] == "paused"
    b.resume(tid)
    fake.finish(tid)
    st = b.status(tid)
    assert (
        st["state"] == "complete" and st["completed_bytes"] == 11 and st["ratio"] == 0.0
    )
    assert b.payload_path(tid, "wiki.zim", str(staging)) == str(dl_local / "wiki.zim")


def test_with_the_library_mapped_it_moves_the_file_in_and_keeps_seeding(
    world, tmp_path, monkeypatch
):
    fake, dl_local, lib_local, staging = world
    monkeypatch.setattr(btclient, "MOVE_POLL_S", 0.05)
    b = _backend(
        fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    )
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    b.add_torrent(src, dest_dir=str(staging))
    fake.finish(tid)
    payload = b.payload_path(tid, "wiki.zim", str(staging))
    dest = str(lib_local / "wiki.zim")
    assert b.install(tid, payload, dest) == tid
    assert open(dest, "rb").read() == b"hello world" and not os.path.exists(payload)
    assert fake.torrents[tid]["downloadDir"] == REMOTE_LIB
    b.remove(tid, delete_files=True)  # stopping the seed never deletes the library file
    assert tid not in fake.torrents and os.path.exists(dest)


def test_never_touches_a_torrent_without_its_label(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    fake.torrents["f" * 40] = {
        "hashString": "f" * 40,
        "name": "x",
        "status": 6,
        "percentDone": 1.0,
        "downloadDir": REMOTE_DL,
        "labels": ["tv"],
        "error": 0,
    }
    b.remove("f" * 40, delete_files=True)
    assert "f" * 40 in fake.torrents and b.list_managed() == []


def test_a_tracker_error_is_not_a_failed_download(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    b.add_torrent(src, dest_dir=str(staging))
    fake.torrents[tid].update(error=2, errorString="Tracker gave HTTP 502")
    assert b.status(tid)["state"] == "downloading"
    fake.torrents[tid].update(
        error=3, errorString="No data found! Ensure your drives are connected"
    )
    st = b.status(tid)
    assert st["state"] == "error" and "No data found" in st["error_message"]


def test_the_download_loop_installs_through_transmission(world, tmp_path, monkeypatch):
    fake, dl_local, lib_local, staging = world
    monkeypatch.setattr(btclient, "MOVE_POLL_S", 0.05)
    b = _backend(
        fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    )
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    monkeypatch.setattr(library._srv, "open_archive", lambda path: object())
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: True)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 1.0)
    seeded = []
    monkeypatch.setattr(
        library, "record_seed", lambda f, origin="download": seeded.append(f)
    )
    monkeypatch.setattr(library, "_record_torrent_metadata", lambda *a, **k: None)
    dl = {
        "id": "1",
        "filename": "wiki.zim",
        "dest": str(lib_local / "wiki.zim"),
        "started": time.time(),
    }
    threading.Timer(0.3, fake.finish, args=(tid,)).start()
    got = library._try_bt_download(
        b, dl, torrent_url=src, staging_dir=str(staging), poll_interval=0.05
    )
    assert got == "success"
    assert open(dl["dest"], "rb").read() == b"hello world"
    assert fake.torrents[tid]["downloadDir"] == REMOTE_LIB
    assert seeded == ["wiki.zim"] and dl["bt_gid"] == tid


def test_settings_name_the_client(tmp_path, monkeypatch):
    for k in btclient.ENV.values():
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(p2p, "_prefs_path", str(tmp_path / "prefs.json"))
    p2p.set_pref(btclient.PREF["kind"], "transmission")
    p2p.set_pref(btclient.PREF["url"], "http://nas:9091")
    assert p2p.engine_name() == "transmission"
    # The environment: a URL alone is a qBittorrent; ZIMI_BT_CLIENT names
    # another, or pins the built-in engine.
    monkeypatch.setenv("ZIMI_BT_CLIENT_URL", "http://qbt:8080")
    assert btclient.config()["kind"] == "qbittorrent"
    monkeypatch.setenv("ZIMI_BT_CLIENT", "transmission")
    assert btclient.config()["kind"] == "transmission"
    monkeypatch.setenv("ZIMI_BT_CLIENT", "builtin")
    assert btclient.config() is None and btclient.env_var() == "ZIMI_BT_CLIENT"


def test_a_torrent_that_could_not_be_labelled_is_taken_back_out(world, tmp_path):
    """Added but not labelled, it would run on in the client as nobody's:
    Zimi refuses to touch an unlabelled torrent, so it never could again."""
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    fake.refuse.add("torrent-set")
    with pytest.raises(btclient.ClientError):
        b.add_torrent(src, dest_dir=str(staging))
    assert tid not in fake.torrents


def test_a_refused_move_is_not_left_moving(world, tmp_path):
    """A move the client refused never comes, so the torrent must not read as
    moving: a hand-over skips moving torrents and would leave it behind."""
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    b.add_torrent(src, dest_dir=str(staging))
    fake.finish(tid)
    fake.refuse.add("torrent-set-location")
    with pytest.raises(btclient.ClientError):
        b.install(tid, b.payload_path(tid, "wiki.zim", str(staging)), str(lib_local / "wiki.zim"))
    assert not b._row(tid)["moving"]
