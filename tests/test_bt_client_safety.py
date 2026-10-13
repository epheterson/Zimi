"""What a BitTorrent client the operator runs must never suffer from Zimi.

Each test is one way the first version could hurt someone: adopting and
moving a torrent that is not Zimi's, deleting a finished file mid-move,
waiting hours on a move nobody is doing, sending a saved password to a new
address, switching to a client that does not answer, and asking a dead
client again on every status poll.
"""

import os
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import btclient, manage, p2p  # noqa: E402
from tests.test_qbittorrent import (
    REMOTE_DL,
    REMOTE_LIB,
    _backend,
    _torrent,
    world,
)  # noqa: E402,F401


def _add(fake, b, tmp_path, name, dest):
    data, tid = _torrent(name)
    p = tmp_path / (name + ".torrent")
    p.write_bytes(data)
    b.add_torrent(str(p), dest_dir=str(dest))
    return tid


def test_someone_elses_torrent_is_neither_adopted_nor_moved(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(
        fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    )
    data, tid = _torrent("wiki.zim")
    fake.torrents[tid] = {
        "hash": tid,
        "name": "wiki.zim",
        "category": "mine",
        "save_path": f"{REMOTE_DL}/mine",
        "content_path": f"{REMOTE_DL}/mine/wiki.zim",
        "state": "uploading",
        "progress": 1.0,
        "size": 11,
        "completed": 11,
        "uploaded": 0,
        "num_seeds": 0,
        "num_leechs": 0,
    }
    p = tmp_path / "wiki.torrent"
    p.write_bytes(data)
    with pytest.raises(btclient.ClientError):
        b.add_torrent(str(p), dest_dir=str(staging))
    with pytest.raises(btclient.ClientError):
        b.install(tid, "", str(lib_local / "wiki.zim"))
    b.pause(tid)
    assert fake.torrents[tid]["category"] == "mine"
    assert fake.torrents[tid]["save_path"] == f"{REMOTE_DL}/mine"
    assert fake.torrents[tid]["state"] == "uploading"


def test_a_finished_download_being_moved_is_not_handed_over(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(
        fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    )
    tid = _add(fake, b, tmp_path, "moving.zim", staging)
    fake.finish(tid)
    fake.torrents[tid]["state"] = "moving"
    assert b.release() == 0
    assert tid in fake.torrents
    assert os.path.exists(fake.local(fake.torrents[tid]["content_path"]))


def test_a_move_nobody_is_doing_gives_up(world, tmp_path, monkeypatch):
    fake, dl_local, lib_local, staging = world
    b = _backend(
        fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    )
    tid = _add(fake, b, tmp_path, "stuck.zim", staging)
    fake.finish(tid)
    monkeypatch.setattr(btclient, "MOVE_POLL_S", 0)
    monkeypatch.setattr(btclient, "MOVE_STALL_S", 0.05)
    monkeypatch.setattr(
        b, "_move", lambda tid, remote_dir: None
    )  # the client refuses quietly
    with pytest.raises(btclient.ClientError):
        b.install(tid, "", str(lib_local / "stuck.zim"))
    b.retired = True
    monkeypatch.setattr(btclient, "MOVE_STALL_S", 10**6)
    with pytest.raises(btclient.ClientError):
        b.install(tid, "", str(lib_local / "stuck.zim"))


def test_one_client_typed_two_ways_is_one_engine():
    assert btclient.same_url("http://Host:9091/transmission/web/", "http://host:9091")
    assert btclient.identity(
        {
            "kind": "transmission",
            "url": "http://host:9091/transmission/rpc",
            "category": "zimi",
        }
    ) == btclient.identity(
        {"kind": "transmission", "url": "http://HOST:9091/", "category": "zimi"}
    )
    assert not btclient.same_url("http://host:9091", "http://other:9091")


def test_windows_paths_map_whatever_their_case():
    pairs = btclient.parse_paths(r"C:\Dl=/downloads")
    assert btclient.to_local(r"c:\dl\a.zim", pairs) == os.path.normpath("/downloads/a.zim")


# ── saving a client ──────────────────────────────────────────────────────


class _Handler:
    def _json(self, code, body):
        self.code, self.body = code, body
        return body


@pytest.fixture
def saved(tmp_path, monkeypatch):
    monkeypatch.setattr(p2p, "_prefs_path", str(tmp_path / "prefs.json"))
    for k in btclient.ENV.values():
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(manage, "_btc_locked", lambda: None)
    switched = []
    monkeypatch.setattr(p2p, "switch_engine", lambda **kw: switched.append(kw))
    p2p.set_prefs(
        {
            btclient.PREF["kind"]: "qbittorrent",
            btclient.PREF["url"]: "http://qbt:8080",
            btclient.PREF["user"]: "admin",
            btclient.PREF["password"]: "s3cret",
        }
    )
    return switched


def test_the_saved_password_goes_only_to_its_own_address(saved, monkeypatch):
    sent = []
    monkeypatch.setattr(
        btclient,
        "probe",
        lambda cfg, library_dir=None: sent.append(cfg["password"]) or {"ok": False},
    )
    manage._handle_bt_client(
        _Handler(),
        {"kind": "qbittorrent", "url": "http://elsewhere:8080", "test": True},
    )
    manage._handle_bt_client(
        _Handler(), {"kind": "qbittorrent", "url": "http://QBT:8080/", "test": True}
    )
    assert sent == ["", "s3cret"]


def test_a_client_that_does_not_answer_is_not_switched_to(saved, monkeypatch):
    monkeypatch.setattr(
        btclient,
        "probe",
        lambda cfg, library_dir=None: {"ok": False, "error_key": "btc_err_unreachable"},
    )
    h = _Handler()
    manage._handle_bt_client(h, {"kind": "transmission", "url": "http://nowhere:9091"})
    assert h.code == 409 and h.body["error_key"] == "btc_err_unreachable"
    assert btclient.config()["kind"] == "qbittorrent" and not saved


def test_a_dead_client_is_not_asked_again_on_every_poll(tmp_path, monkeypatch):
    monkeypatch.setattr(p2p, "_prefs_path", str(tmp_path / "prefs.json"))
    for k in btclient.ENV.values():
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(p2p, "_backend_singleton", None)
    monkeypatch.setattr(p2p, "_unreachable", (None, 0.0))
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: True)
    p2p.set_prefs(
        {btclient.PREF["kind"]: "qbittorrent", btclient.PREF["url"]: "http://dead:8080"}
    )
    asked = []

    class Dead:
        def available(self):
            asked.append(1)
            return False

    monkeypatch.setattr(btclient, "make_backend", lambda cfg, **kw: Dead())
    for _ in range(3):
        assert p2p.get_backend(data_dir=str(tmp_path)) is None
    assert len(asked) == 1


# ── from the second review ─────────────────────────────────────────────


def test_zimis_torrents_are_clear_of_the_clients_own_seeding_limits(world, tmp_path):
    """A client rule like "at ratio 2, remove torrent and files" would delete a
    library ZIM: Zimi's torrents opt out, and Zimi's own cap applies."""
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    tid = _add(fake, b, tmp_path, "limits.zim", staging)
    # qBittorrent 5.2 refuses the call without an action; Stop never deletes.
    assert fake.torrents[tid].get("limits") == ("-1", "-1", "Stop")


def test_torrents_already_in_the_client_are_cleared_at_start_too(world, tmp_path, monkeypatch):
    """Lifting limits only on add left torrents an earlier run had added (a
    real qBittorrent 5.2 had refused that call) under the client's rule."""
    from zimi import library

    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    tid = _add(fake, b, tmp_path, "earlier.zim", staging)
    fake.torrents[tid]["limits"] = ("-2", "-2", "Default")  # the client's own rule
    monkeypatch.setattr(p2p, "peek_backend", lambda: b)
    library.reseed_from_ledger()
    assert fake.torrents[tid]["limits"] == ("-1", "-1", "Stop")

def test_a_sub_category_is_not_zimis(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    _, tid = _torrent("other.zim")
    fake.torrents[tid] = {
        "hash": tid, "name": "other.zim", "category": "zimi/old", "save_path": f"{REMOTE_DL}/x",
        "content_path": f"{REMOTE_DL}/x/other.zim", "state": "downloading", "progress": 0.1,
        "size": 11, "completed": 1, "uploaded": 0, "num_seeds": 0, "num_leechs": 0,
    }
    real = fake.handle

    def by_prefix(h, path, q, form):  # qBittorrent lists sub-categories too
        if path == "torrents/info" and "category" in q:
            rows = [t for t in fake.torrents.values() if t["category"].split("/")[0] == q["category"]]
            return h._send(200, rows)
        return real(h, path, q, form)

    fake.handle = by_prefix
    assert b.release() == 0 and tid in fake.torrents


def test_a_download_zimi_paused_runs_again_after_a_restart(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    tid = _add(fake, b, tmp_path, "paused.zim", staging)
    b.pause(tid)
    assert fake.torrents[tid]["state"] != "downloading"
    _add(fake, b, tmp_path, "paused.zim", staging)  # Zimi restarted, asks again
    assert fake.torrents[tid]["state"] == "downloading"


def test_a_new_category_relabels_instead_of_handing_over(world, tmp_path, monkeypatch):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    tid = _add(fake, b, tmp_path, "keep.zim", staging)
    monkeypatch.setattr(p2p, "_prefs_path", str(tmp_path / "prefs.json"))
    for k in btclient.ENV.values():
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: False)  # no new engine needed here
    p2p.set_prefs({btclient.PREF["kind"]: "qbittorrent", btclient.PREF["url"]: fake.url,
                   btclient.PREF["category"]: "library"})
    monkeypatch.setattr(p2p, "_backend_singleton", b)
    released = []
    monkeypatch.setattr(b, "release", lambda: released.append(1))
    p2p.switch_engine(data_dir=str(tmp_path))
    assert not released and fake.torrents[tid]["category"] == "library"


def test_a_qbittorrent_too_old_to_say_where_files_are_is_refused(world):
    fake, dl_local, lib_local, staging = world
    real = fake.handle

    def old(h, path, q, form):
        if path == "app/webapiVersion":
            return h._send(200, "2.5.1")  # qBittorrent 4.2: no content_path
        return real(h, path, q, form)

    fake.handle = old
    cfg = {"kind": "qbittorrent", "url": fake.url, "user": "", "password": "", "category": "zimi", "paths": []}
    got = btclient.probe(cfg, library_dir=str(lib_local))
    assert not got["ok"] and "4.3.2" in got["error"]


def test_a_move_queued_behind_others_is_not_a_stall(world, tmp_path, monkeypatch):
    """qBittorrent moves one torrent at a time: a queued one says "moving"
    while nothing has arrived. That is a wait, never a reason to give up (and
    a give-up used to delete the finished download)."""
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    tid = _add(fake, b, tmp_path, "queued.zim", staging)
    fake.finish(tid)
    monkeypatch.setattr(btclient, "MOVE_POLL_S", 0)
    monkeypatch.setattr(btclient, "MOVE_STALL_S", 0.01)
    monkeypatch.setattr(btclient, "MOVE_LIMIT_S", 0.3)
    monkeypatch.setattr(b, "_move", lambda tid, remote_dir: fake.torrents[tid].update(state="moving"))
    with pytest.raises(btclient.ClientError) as e:
        b.install(tid, "", str(lib_local / "queued.zim"))
    assert "did not finish" in str(e.value)  # waited out the whole limit, not the stall


def test_offline_saves_and_probes_no_client(saved, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setattr(btclient, "probe", lambda *a, **k: pytest.fail("probed while offline"))
    h = _Handler()
    manage._handle_bt_client(h, {"kind": "transmission", "url": "http://t:9091", "test": True})
    assert (h.code, h.body.get("var")) == (403, "ZIMI_OFFLINE")


def test_a_redirecting_transmission_gets_no_login(tmp_path):
    """A forward-auth proxy's 302 to a login host is an error, and the
    Authorization header never follows it there."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from zimi import transmission

    seen = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            seen.append((self.path, self.headers.get("Authorization")))
            if self.path.startswith("/login"):
                self.send_response(200)
                self.end_headers()
                return
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:%d/login" % self.server.server_address[1])
            self.end_headers()

        do_GET = do_POST

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c = transmission.Client("http://127.0.0.1:%d/transmission/rpc" % srv.server_address[1], "u", "p")
        with pytest.raises(urllib.error.HTTPError) as refused:
            c.call("session-get")
        assert refused.value.code == 302
    finally:
        srv.shutdown()
    assert [p for p, _ in seen] == ["/transmission/rpc"], seen
