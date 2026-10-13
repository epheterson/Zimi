"""Switching engines, back and forth: built in, qBittorrent, Transmission.

What a person sees when they change Settings > BitTorrent > Engine: a running
download carries on with the new engine; seeds follow the ledger to it, or
wait (with a reason) when it cannot see the library; the old engine is left
with nothing of Zimi's running, and the built-in engine's leftovers are gone.
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fake_lt  # noqa: E402

from zimi import btclient, library, p2p  # noqa: E402
from zimi import qbittorrent as qbt  # noqa: E402
from tests.test_qbittorrent import (
    REMOTE_DL,
    REMOTE_LIB,
    FakeQbt,
    _torrent,
)  # noqa: E402
from tests.test_transmission import FakeTransmission  # noqa: E402


@pytest.fixture
def world(tmp_path, monkeypatch):
    dl_local, lib_local, data = tmp_path / "dl", tmp_path / "library", tmp_path / "data"
    for d in (dl_local, lib_local, data):
        d.mkdir()
    monkeypatch.setattr(library._srv, "ZIM_DIR", str(lib_local))
    monkeypatch.setattr(library._srv, "ZIMI_DATA_DIR", str(data))
    monkeypatch.setattr(p2p, "_backend_singleton", None)
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: True)
    for k in btclient.ENV.values():
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(p2p, "_prefs_path", str(tmp_path / "prefs.json"))
    qb = FakeQbt({REMOTE_DL: str(dl_local), REMOTE_LIB: str(lib_local)})
    yield qb, dl_local, lib_local, data
    qb.close()
    p2p._switch_done.set()


def _qbt(fake, lib_local, data, paths):
    cfg = {
        "kind": "qbittorrent",
        "url": fake.url,
        "user": "",
        "password": "",
        "category": "zimi",
        "paths": btclient.parse_paths(paths),
    }
    b = qbt.QBittorrentBackend(
        cfg, library_dir=str(lib_local), staging_dir=str(data / "staging")
    )
    assert b.available()
    return b


def _add(fake, b, tmp_path, name, dest):
    data, tid = _torrent(name)
    p = tmp_path / (name + ".torrent")
    p.write_bytes(data)
    b.add_torrent(str(p), dest_dir=str(dest))
    return tid


# ── leaving a client ─────────────────────────────────────────────────────


def test_leaving_a_client_takes_zimis_torrents_out_and_keeps_the_library(
    world, tmp_path
):
    fake, dl_local, lib_local, data = world
    b = _qbt(fake, lib_local, data, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    running = _add(fake, b, tmp_path, "running.zim", data / "staging")
    in_lib = _add(fake, b, tmp_path, "inlib.zim", data / "staging")
    copy = _add(fake, b, tmp_path, "copy.zim", data / "staging")
    stray = _add(fake, b, tmp_path, "stray.zim", data / "staging")
    for tid in (in_lib, copy, stray):
        fake.finish(tid)
    b.install(in_lib, b.payload_path(in_lib, "", ""), str(lib_local / "inlib.zim"))
    (lib_local / "copy.zim").write_bytes(b"hello world")  # Zimi copied it in
    fake.torrents["e" * 40] = {
        "hash": "e" * 40,
        "category": "tv",
        "content_path": f"{REMOTE_DL}/tv/x",
        "state": "uploading",
        "progress": 1.0,
        "size": 1,
    }

    assert b.release() == 3
    assert set(fake.torrents) == {stray, "e" * 40}  # not one Zimi installed; not Zimi's
    assert (lib_local / "inlib.zim").exists() and (lib_local / "copy.zim").exists()
    assert not (dl_local / "zimi" / "copy.zim").exists()  # the library has it
    assert not (dl_local / "zimi" / "running.zim").exists()


# ── leaving the built-in engine ─────────────────────────────────────────


def test_leaving_the_built_in_engine_leaves_nothing_to_come_back(tmp_path, monkeypatch):
    monkeypatch.setattr(p2p, "_lt_module", fake_lt)
    monkeypatch.setattr(p2p, "_lt_import_failed", False)
    data = tmp_path / "data"
    b = p2p.LibtorrentBackend(
        bt_port=6881, data_dir=str(data), staging_dir=str(data / "staging")
    )
    b.add_torrent(str(tmp_path / "a.torrent"), dest_dir=str(data / "staging"))
    b.add_torrent(str(tmp_path / "b.torrent"), dest_dir=str(tmp_path / "library"))
    for h in b._handles.values():
        h.save_resume_data()
    b._pump_alerts_once()
    (data / "staging").mkdir(parents=True, exist_ok=True)
    (data / "staging" / "partial.zim").write_bytes(b"x")
    assert os.listdir(b.resume_dir)
    assert b.release() == 2
    b.stop()
    assert not b._handles and os.listdir(b.resume_dir) == []
    assert os.listdir(data / "staging") == []


def test_a_staging_folder_a_client_sees_is_the_clients(tmp_path):
    data = tmp_path / "data"
    staging = data / "staging"
    staging.mkdir(parents=True)
    (staging / "keep.zim").write_bytes(b"x")
    os.makedirs(p2p.resume_dir(str(data)))
    open(os.path.join(p2p.resume_dir(str(data)), "ab.fastresume"), "w").close()
    p2p.purge_builtin_leftovers(str(data), keep_staging=True)
    assert os.listdir(p2p.resume_dir(str(data))) == [] and (staging / "keep.zim").exists()
    p2p.purge_builtin_leftovers(str(data))
    assert os.listdir(staging) == []


# ── the switch ───────────────────────────────────────────────────────────


class _Old(p2p.BTBackend):
    """An engine being switched away from; records what happened to it."""

    def __init__(self, ident=("LibtorrentBackend",), on_release=None):
        self.ident, self.on_release, self.log = ident, on_release, []

    def identity(self):
        return self.ident

    def release(self):
        self.log.append("release")
        if self.on_release:
            self.on_release()
        return 0

    def stop(self):
        self.log.append("stop")

    available = add_torrent = pause = resume = remove = status = list_managed = (
        lambda *a, **k: None
    )


def test_a_different_engine_is_handed_over_to_and_waited_for(
    world, monkeypatch, tmp_path
):
    """A download asking for the engine mid-switch gets the new one, never
    the one being taken apart."""
    fake, dl_local, lib_local, data = world
    tr_fake = FakeTransmission({"/downloads/complete": str(dl_local)})
    try:
        p2p.set_pref(btclient.PREF["kind"], "transmission")
        p2p.set_pref(btclient.PREF["url"], tr_fake.url)
        asked = {}

        def mid_switch():
            t = threading.Thread(
                target=lambda: asked.setdefault(
                    "got", p2p.get_backend(data_dir=str(data))
                )
            )
            t.start()
            time.sleep(0.2)
            asked["waited"] = t.is_alive()
            asked["thread"] = t

        old = _Old(on_release=mid_switch)
        p2p._backend_singleton = old
        new = p2p.switch_engine(data_dir=str(data))
        asked["thread"].join(5)
        assert old.log == ["release", "stop"] and old.retired
        assert asked["waited"] and asked["got"] is new
        assert new.kind == "transmission"
    finally:
        tr_fake.close()
        p2p._backend_singleton = None


def test_the_same_engine_restarted_hands_nothing_over(world, monkeypatch):
    fake, dl_local, lib_local, data = world
    p2p.set_pref(btclient.PREF["kind"], "qbittorrent")
    p2p.set_pref(btclient.PREF["url"], fake.url)
    # The same client typed with a trailing slash is still the same engine.
    old = _Old(ident=btclient.identity({"kind": "qbittorrent", "url": fake.url + "/", "category": "zimi"}))
    p2p._backend_singleton = old
    try:
        new = p2p.switch_engine(data_dir=str(data))
        assert old.log == ["stop"] and new.kind == "qbittorrent"
    finally:
        p2p._backend_singleton = None


def test_a_running_download_carries_on_with_the_next_engine(world, monkeypatch):
    fake, dl_local, lib_local, data = world
    engines = iter(["first", "second"])
    monkeypatch.setattr(p2p, "get_backend", lambda data_dir: next(engines))
    monkeypatch.setattr(
        library, "_resolve_torrent_url", lambda url: "https://x/wiki.zim.torrent"
    )
    used = []

    def attempt(backend, dl, **kw):
        used.append(backend)
        return "restart" if backend == "first" else "success"

    monkeypatch.setattr(library, "_try_bt_download", attempt)
    finalized = []
    monkeypatch.setattr(
        library, "_post_download_finalize", lambda dl: finalized.append(dl)
    )
    dl = {
        "id": "1",
        "filename": "wiki.zim",
        "url": "https://x/wiki.zim",
        "dest": str(lib_local / "wiki.zim"),
    }
    library._download_thread(dl)
    assert used == ["first", "second"] and dl["done"] and finalized


# ── seeds ────────────────────────────────────────────────────────────────


def _ledger(names):
    for n in names:
        library.record_seed(n)


def test_seeds_wait_with_a_reason_when_the_client_cannot_see_the_library(
    world, monkeypatch, caplog
):
    fake, dl_local, lib_local, data = world
    b = _qbt(fake, lib_local, data, f"{REMOTE_DL}={dl_local}")
    p2p._backend_singleton = b
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: True)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    try:
        (lib_local / "a.zim").write_bytes(b"x")
        _ledger(["a.zim"])
        caplog.set_level("INFO", logger="zimi")
        assert library.reseed_from_ledger() == 0
        assert "1 seed(s) wait: qBittorrent cannot see the library" in caplog.text
        assert "a.zim" in library.seed_ledger_snapshot()  # kept for the way back
    finally:
        p2p._backend_singleton = None


def test_a_clients_own_copy_counts_against_the_ratio_cap(world, monkeypatch, tmp_path):
    fake, dl_local, lib_local, data = world
    b = _qbt(fake, lib_local, data, f"{REMOTE_DL}={dl_local}")
    p2p._backend_singleton = b
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: True)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 1.0)
    try:
        tid = _add(fake, b, tmp_path, "wiki.zim", data / "staging")
        fake.finish(tid)
        b.install(tid, b.payload_path(tid, "", ""), str(lib_local / "wiki.zim"))
        _ledger(["wiki.zim"])
        fake.torrents[tid]["uploaded"] = 5
        library.apply_seed_policy()
        assert library.seed_ledger_snapshot()["wiki.zim"]["uploaded"] == 5
        fake.torrents[tid]["uploaded"] = 11  # 1.0x of 11 bytes
        assert library.apply_seed_policy() == 1
        assert (
            tid not in fake.torrents and not (dl_local / "zimi" / "wiki.zim").exists()
        )
        assert (lib_local / "wiki.zim").exists()
    finally:
        p2p._backend_singleton = None


def test_a_clients_copy_of_a_deleted_zim_is_retired(world, monkeypatch, tmp_path):
    fake, dl_local, lib_local, data = world
    b = _qbt(fake, lib_local, data, f"{REMOTE_DL}={dl_local}")
    p2p._backend_singleton = b
    try:
        tid = _add(fake, b, tmp_path, "old.zim", data / "staging")
        fake.finish(tid)
        unlisted = _add(fake, b, tmp_path, "unlisted.zim", data / "staging")
        fake.finish(unlisted)  # finished, but never installed: not a seed
        _ledger(["old.zim"])
        assert library.retire_stale_seeds() == 1
        assert set(fake.torrents) == {unlisted}
        assert "old.zim" not in library.seed_ledger_snapshot()
    finally:
        p2p._backend_singleton = None


def test_out_of_restarts_the_last_engine_lets_go_of_the_torrent(world, monkeypatch):
    """Every engine retired under it: HTTP brings the file, and the torrent the
    last engine holds goes, so it cannot land on top later."""
    fake, dl_local, lib_local, data = world
    dropped = []

    class Engine:
        def remove(self, tid, *, delete_files=False):
            dropped.append((tid, delete_files))

    monkeypatch.setattr(p2p, "get_backend", lambda data_dir: Engine())
    monkeypatch.setattr(library, "_resolve_torrent_url", lambda url: "https://x/wiki.zim.torrent")

    def attempt(backend, dl, **kw):
        dl["bt_info_hash"] = "ab" * 20
        return "restart"

    monkeypatch.setattr(library, "_try_bt_download", attempt)
    monkeypatch.setattr(library, "_download_from_url", lambda dl, url, tmp: (False, "offline in this test"))
    dl = {"id": "1", "filename": "wiki.zim", "url": "https://x/wiki.zim", "dest": str(lib_local / "wiki.zim")}
    library._download_thread(dl)
    assert dropped == [("ab" * 20, True)]


def test_a_poll_reads_the_clients_last_list_and_never_waits_on_it(world, monkeypatch):
    """Activity polls every 5 s per tab: a client engine answers from its last
    list, refreshed in the background, so a slow or down client never holds a
    poll (or the lock the downloads poll under)."""
    import threading
    import time

    fake, dl_local, lib_local, data = world
    b = _qbt(fake, lib_local, data, "")
    gate = threading.Event()
    calls = []

    def slow():
        calls.append(1)
        gate.wait(5)
        return [{"gid": "ab", "status": "active", "seeder": "true"}]

    monkeypatch.setattr(b, "list_managed", slow)
    started = time.monotonic()
    assert b.list_managed_cached() == []  # nothing yet, and no wait
    assert b.list_managed_cached() == []  # one refresh in flight, not two
    assert time.monotonic() - started < 1 and calls == [1]
    gate.set()
    deadline = time.monotonic() + 5
    while not b.list_managed_cached() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert b.list_managed_cached()[0]["gid"] == "ab"


def test_turning_bittorrent_off_takes_zimis_torrents_out_of_a_client(world, tmp_path):
    """The client keeps running after Zimi stops talking to it; left in, Zimi's
    seeds would upload on with no ratio cap enforced. The library stays."""
    import time

    fake, dl_local, lib_local, data = world
    b = _qbt(fake, lib_local, data, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    tid = _add(fake, b, tmp_path, "wiki.zim", data / "staging")
    p2p._backend_singleton = b
    try:
        p2p.shutdown_backend(release=True)
        deadline = time.monotonic() + 10
        while tid in fake.torrents and time.monotonic() < deadline:
            time.sleep(0.05)
        assert tid not in fake.torrents and p2p.peek_backend() is None
    finally:
        p2p._backend_singleton = None
