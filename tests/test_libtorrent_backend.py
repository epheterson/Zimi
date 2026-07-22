"""LibtorrentBackend unit tests — run against tests/fake_lt.py.

The real libtorrent is not importable on the dev Mac (no 3.14 wheel);
these tests inject the fake as p2p._lt_module. Real-engine smoke tests
live at the bottom behind pytest.importorskip and run in the Docker CI
image only.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import fake_lt  # noqa: E402

from zimi import p2p  # noqa: E402


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setattr(p2p, "_lt_module", fake_lt)
    monkeypatch.setattr(p2p, "_lt_import_failed", False)
    b = p2p.LibtorrentBackend(
        bt_port=6881,
        data_dir=str(tmp_path),
        staging_dir=str(tmp_path / "staging"),
    )
    yield b
    b.stop()


MAGNET = "magnet:?xt=urn:btih:" + "ab" * 20 + "&dn=test.zim"


class TestImportGate:
    def test_lt_returns_none_when_unimportable(self, monkeypatch):
        monkeypatch.setattr(p2p, "_lt_module", None)
        monkeypatch.setattr(p2p, "_lt_import_failed", True)
        assert p2p._lt() is None

    def test_available_false_without_libtorrent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(p2p, "_lt_module", None)
        monkeypatch.setattr(p2p, "_lt_import_failed", True)
        b = p2p.LibtorrentBackend(
            bt_port=6881, data_dir=str(tmp_path), staging_dir=str(tmp_path / "s")
        )
        assert b.available() is False


class TestAddTorrent:
    def test_magnet_returns_info_hash_tid(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        assert tid == "ab" * 20

    def test_local_torrent_file(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "wikipedia.torrent"), dest_dir=str(tmp_path / "staging")
        )
        assert len(tid) == 40

    def test_duplicate_add_returns_existing_tid(self, backend, tmp_path):
        t1 = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        t2 = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        assert t1 == t2

    def test_save_path_is_dest_dir(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        assert backend.status(tid)  # add succeeded
        h = backend._handles[tid]
        assert h._atp.save_path == str(tmp_path / "staging")

    def test_reseed_waits_out_async_remove_and_adopts_new_save_path(
        self, backend, tmp_path
    ):
        # Post-download reseed (library.py): the staging seed is remove()d,
        # then the SAME info-hash is re-added at the library dir. libtorrent's
        # remove is async, so for a window the re-add raises duplicate and
        # find_torrent returns the STILL-REMOVING staging handle (staging
        # save_path). Adopting it means the file silently never seeds. The
        # backend must wait the removing handle out and land the seed at the
        # library dir.
        staging = tmp_path / "staging"
        zim_dir = tmp_path / "zims"
        zim_dir.mkdir()
        torrent = str(tmp_path / "wiki.torrent")

        tid = backend.add_torrent(torrent, dest_dir=str(staging))
        assert backend._handles[tid].status().save_path == str(staging)

        # Staging torrent lingers (valid, staging save_path) for 3 add attempts.
        backend._ses.remove_delay = 3
        backend.remove(tid, delete_files=True)

        tid2 = backend.add_torrent(torrent, dest_dir=str(zim_dir))
        assert tid2 == tid  # same info-hash
        seed = backend._handles[tid2]
        assert seed.is_valid()
        # The adopted handle sits at the LIBRARY dir, not stale staging.
        assert os.path.realpath(seed.status().save_path) == os.path.realpath(
            str(zim_dir)
        )
        assert os.path.realpath(seed.status().save_path) != os.path.realpath(
            str(staging)
        )


class TestStatus:
    def test_downloading(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        st = backend.status(tid)
        assert st["state"] == "downloading"
        assert st["gid"] == tid
        assert st["info_hash"] == tid

    def test_seeding_reports_complete(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.state = fake_lt.torrent_status.seeding
        assert backend.status(tid)["state"] == "complete"

    def test_finished_reports_complete(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.state = fake_lt.torrent_status.finished
        assert backend.status(tid)["state"] == "complete"

    def test_paused(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.pause(tid)
        assert backend.status(tid)["state"] == "paused"
        backend.resume(tid)
        assert backend.status(tid)["state"] == "downloading"

    def test_error(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.errc = fake_lt._ErrorCode(5, "boom")
        st = backend.status(tid)
        assert st["state"] == "error"
        assert st["error_message"] == "boom"

    def test_unknown_tid_reports_removed(self, backend):
        assert backend.status("f" * 40)["state"] == "removed"

    def test_checking_flag_true_while_hash_checking(self, backend, tmp_path):
        # The delta-update path waits on this flag before snapshotting the
        # salvaged bytes — checking_* must report checking=True, downloading
        # states must report False.
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.state = fake_lt.torrent_status.checking_files
        assert backend.status(tid)["checking"] is True
        h._status.state = fake_lt.torrent_status.checking_resume_data
        assert backend.status(tid)["checking"] is True

    def test_checking_flag_false_when_downloading(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        assert backend.status(tid)["checking"] is False

    def test_contract_keys_present(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        st = backend.status(tid)
        for key in (
            "state",
            "gid",
            "completed_bytes",
            "total_bytes",
            "down_speed",
            "up_speed",
            "peers",
            "seeders",
            "ratio",
            "info_hash",
            "error_code",
            "error_message",
        ):
            assert key in st, key

    def test_ratio_from_all_time_upload(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.total_wanted = 1000
        h._status.all_time_upload = 2500
        assert backend.status(tid)["ratio"] == 2.5


class TestListManaged:
    def test_contract_shape(self, backend, tmp_path):
        backend.add_torrent(
            str(tmp_path / "wikipedia.torrent"), dest_dir=str(tmp_path / "staging")
        )
        entries = backend.list_managed()
        assert len(entries) == 1
        raw = entries[0]
        for key in (
            "gid",
            "status",
            "files",
            "completedLength",
            "uploadLength",
            "totalLength",
            "infoHash",
            "seeder",
        ):
            assert key in raw, key
        assert raw["status"] == "active"
        assert raw["files"][0]["path"].startswith(str(tmp_path / "staging"))

    def test_paused_status_string(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "a.torrent"), dest_dir=str(tmp_path / "staging")
        )
        backend.pause(tid)
        assert backend.list_managed()[0]["status"] == "paused"

    def test_downloading_not_seeder_completed_tracks_done(self, backend, tmp_path):
        # manage.py hides in-flight downloads from the seeding panel by
        # reading seeder=="false" + completedLength<totalLength, so both
        # must reflect the real transfer, not aria2 ghosts.
        tid = backend.add_torrent(
            str(tmp_path / "wikipedia.torrent"), dest_dir=str(tmp_path / "staging")
        )
        h = backend._handles[tid]
        h._status.total_done = 400
        raw = backend.list_managed()[0]
        assert raw["seeder"] == "false"
        assert raw["completedLength"] == "400"
        assert int(raw["completedLength"]) < int(raw["totalLength"])

    def test_seeding_state_reports_seeder_true(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "wikipedia.torrent"), dest_dir=str(tmp_path / "staging")
        )
        h = backend._handles[tid]
        h._status.state = fake_lt.torrent_status.seeding
        raw = backend.list_managed()[0]
        assert raw["seeder"] == "true"


class TestRemoveSafety:
    """remove(delete_files=True) deletes payload ONLY inside staging.

    aria2's remove cleared session results and never touched payload;
    a naive libtorrent delete_files mapping would delete library ZIMs
    on stop_mirror_seeds(). This is the guard.
    """

    def test_seed_remove_never_deletes_library_payload(self, backend, tmp_path):
        zim_dir = tmp_path / "zims"
        zim_dir.mkdir()
        tid = backend.add_torrent(str(tmp_path / "seed.torrent"), dest_dir=str(zim_dir))
        backend.remove(tid, delete_files=True)
        ses = backend._ses
        assert ses.removed == [(tid, False)]  # lt delete_files flag NOT set

    def test_staging_remove_deletes_partial_payload(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.remove(tid, delete_files=True)
        ses = backend._ses
        assert ses.removed == [(tid, True)]  # partial download → clean up

    def test_remove_drops_handle(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.remove(tid)
        assert tid not in backend._handles
        assert backend.status(tid)["state"] == "removed"


class TestRateLimits:
    def test_kb_converted_to_bytes(self, backend, tmp_path):
        backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.set_global_rate_limits(2048, 512)
        assert backend._ses.settings["upload_rate_limit"] == 2048 * 1024
        assert backend._ses.settings["download_rate_limit"] == 512 * 1024

    def test_zero_means_unlimited(self, backend, tmp_path):
        backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.set_global_rate_limits(0, 0)
        assert backend._ses.settings["upload_rate_limit"] == 0
        assert backend._ses.settings["download_rate_limit"] == 0


class TestResume:
    def test_resume_round_trip(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "keep.torrent"), dest_dir=str(tmp_path / "staging")
        )
        backend._handles[tid].save_resume_data()
        backend._pump_alerts_once()
        resume_file = os.path.join(backend.resume_dir, tid + ".fastresume")
        assert os.path.exists(resume_file)
        # Fresh backend loads it back
        b2 = p2p.LibtorrentBackend(
            bt_port=6882,
            data_dir=str(tmp_path),
            staging_dir=str(tmp_path / "staging"),
        )
        b2._ensure_session()
        assert tid in b2._handles
        b2.stop()

    def test_periodic_save_writes_fastresume(self, backend, tmp_path):
        # A hard kill never calls stop(); the periodic checkpoint is what
        # keeps fastresume fresh. Drive one tick directly (no 60s wait).
        tid = backend.add_torrent(
            str(tmp_path / "tick.torrent"), dest_dir=str(tmp_path / "staging")
        )
        backend._request_resume_saves()
        backend._pump_alerts_once()
        assert os.path.exists(os.path.join(backend.resume_dir, tid + ".fastresume"))

    def test_periodic_save_skips_unchanged_handle(self, backend, tmp_path):
        # need_save_resume_data() False → no alert requested this tick.
        tid = backend.add_torrent(
            str(tmp_path / "quiet.torrent"), dest_dir=str(tmp_path / "staging")
        )
        backend._handles[tid]._need_resume = False
        backend._request_resume_saves()
        backend._pump_alerts_once()
        assert not os.path.exists(os.path.join(backend.resume_dir, tid + ".fastresume"))

    def test_remove_deletes_resume_file(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "gone.torrent"), dest_dir=str(tmp_path / "staging")
        )
        backend._handles[tid].save_resume_data()
        backend._pump_alerts_once()
        backend.remove(tid)
        assert not os.path.exists(os.path.join(backend.resume_dir, tid + ".fastresume"))


# ── Real-engine smoke (Docker CI only — needs importable libtorrent) ──────


class TestRealEngine:
    def test_real_session_starts_and_stops(self, tmp_path, monkeypatch):
        lt = pytest.importorskip("libtorrent")
        monkeypatch.setattr(p2p, "_lt_module", lt)
        monkeypatch.setattr(p2p, "_lt_import_failed", False)
        b = p2p.LibtorrentBackend(
            bt_port=16881,
            data_dir=str(tmp_path),
            staging_dir=str(tmp_path / "staging"),
        )
        assert b.available() is True
        assert b.is_alive() is True
        b.stop()
        assert b.is_alive() is False

    def test_real_add_local_torrent_and_seed(self, tmp_path, monkeypatch):
        lt = pytest.importorskip("libtorrent")
        monkeypatch.setattr(p2p, "_lt_module", lt)
        monkeypatch.setattr(p2p, "_lt_import_failed", False)
        # Build a real single-file torrent for a fixture payload
        payload_dir = tmp_path / "zims"
        payload_dir.mkdir()
        payload = payload_dir / "fixture.zim"
        payload.write_bytes(b"Z" * 65536)
        fs = lt.file_storage()
        lt.add_files(fs, str(payload))
        t = lt.create_torrent(fs)
        lt.set_piece_hashes(t, str(payload_dir))
        torrent_path = tmp_path / "fixture.torrent"
        torrent_path.write_bytes(lt.bencode(t.generate()))

        b = p2p.LibtorrentBackend(
            bt_port=16882,
            data_dir=str(tmp_path),
            staging_dir=str(tmp_path / "staging"),
        )
        tid = b.add_torrent(str(torrent_path), dest_dir=str(payload_dir))
        deadline = __import__("time").monotonic() + 20
        state = None
        while __import__("time").monotonic() < deadline:
            state = b.status(tid)["state"]
            if state == "complete":
                break
            __import__("time").sleep(0.2)
        assert state == "complete"  # hash-checked the existing file → seeding
        entries = b.list_managed()
        assert entries[0]["files"][0]["path"] == str(payload)
        b.stop()
