"""Tests for _try_bt_download — BT-first with HTTP-fallback decision logic.

Outcomes the function must return:
    'success'  → file downloaded and renamed; caller is done
    'fallback' → BT path didn't pan out; caller should run HTTP path
    'cancelled' → user cancelled mid-flight
    'error'    → unrecoverable; caller should report

Heavily mocked — no real subprocess, no real HTTP.
"""

import os
import sys
import time
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402


def _mk_dl(tmp_path, name="wikipedia_en_top_2026-02.zim"):
    """Build a minimal dl dict like _start_download produces."""
    return {
        "id": "1",
        "url": f"https://download.kiwix.org/zim/wikipedia/{name}",
        "filename": name,
        "dest": str(tmp_path / name),
        "started": time.time(),
        "done": False,
        "error": None,
        "is_update": False,
    }


def _mk_backend(*, status_sequence):
    """Mock backend that returns the given status dicts in order on each
    .status() call. Each status dict represents one poll tick."""
    backend = MagicMock()
    backend.add_torrent.return_value = "gid-001"
    iter_status = iter(status_sequence)
    backend.status.side_effect = lambda tid: next(iter_status)
    return backend


def test_success_path_renames_to_dest(tmp_path, monkeypatch):
    """A torrent that completes verifies and renames into ZIM_DIR."""
    dl = _mk_dl(tmp_path)
    staging_path = tmp_path / "staging" / dl["filename"]
    staging_path.parent.mkdir()
    staging_path.write_bytes(b"fake zim content")
    # The completion guard libzim-validates the staged file before install;
    # this test's stub isn't a real ZIM, so validation is mocked out. The
    # guard itself is covered by test_complete_with_invalid_staged_file.
    monkeypatch.setattr(library._srv, "open_archive", lambda path: object())
    backend = _mk_backend(
        status_sequence=[
            {
                "state": "downloading",
                "completed_bytes": 100,
                "total_bytes": 1000,
                "down_speed": 1000,
                "up_speed": 0,
                "peers": 5,
                "info_hash": "abc",
            },
            {
                "state": "downloading",
                "completed_bytes": 500,
                "total_bytes": 1000,
                "down_speed": 1000,
                "up_speed": 0,
                "peers": 5,
                "info_hash": "abc",
            },
            {
                "state": "complete",
                "completed_bytes": 1000,
                "total_bytes": 1000,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 5,
                "info_hash": "abc",
            },
        ]
    )
    result = library._try_bt_download(
        backend,
        dl,
        torrent_url="https://download.kiwix.org/zim/wikipedia/foo.zim.torrent",
        staging_dir=str(tmp_path / "staging"),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert result == "success"
    assert os.path.exists(dl["dest"])
    assert not os.path.exists(staging_path)


def test_fallback_when_no_peers_within_timeout(tmp_path):
    """0 peers + <1% downloaded after the timeout → fall back to HTTP."""
    dl = _mk_dl(tmp_path)
    backend = _mk_backend(
        status_sequence=[
            {
                "state": "downloading",
                "completed_bytes": 0,
                "total_bytes": 1000,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 0,
                "info_hash": "",
            }
        ]
        * 100
    )
    result = library._try_bt_download(
        backend,
        dl,
        torrent_url="https://download.kiwix.org/zim/foo.zim.torrent",
        staging_dir=str(tmp_path / "staging"),
        poll_interval=0.001,
        no_peers_timeout=0.05,
    )
    assert result == "fallback"
    backend.remove.assert_called_once()


def test_fallback_when_aria_reports_error(tmp_path):
    """Aria-side error (e.g. tracker unreachable) → fall back, don't strand."""
    dl = _mk_dl(tmp_path)
    backend = _mk_backend(
        status_sequence=[
            {
                "state": "error",
                "completed_bytes": 0,
                "total_bytes": 0,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 0,
                "info_hash": "",
                "error_code": "1",
                "error_message": "tracker timeout",
            },
        ]
    )
    result = library._try_bt_download(
        backend,
        dl,
        torrent_url="https://download.kiwix.org/zim/foo.zim.torrent",
        staging_dir=str(tmp_path / "staging"),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert result == "fallback"


def test_cancelled_mid_download(tmp_path):
    """User cancels — backend gets removed, status returned cleanly."""
    dl = _mk_dl(tmp_path)
    poll_count = [0]

    def status_with_cancel(tid):
        poll_count[0] += 1
        if poll_count[0] == 2:
            dl["cancelled"] = True
        return {
            "state": "downloading",
            "completed_bytes": 100,
            "total_bytes": 1000,
            "down_speed": 100,
            "up_speed": 0,
            "peers": 5,
            "info_hash": "abc",
        }

    backend = MagicMock()
    backend.add_torrent.return_value = "gid"
    backend.status.side_effect = status_with_cancel
    result = library._try_bt_download(
        backend,
        dl,
        torrent_url="https://download.kiwix.org/zim/foo.zim.torrent",
        staging_dir=str(tmp_path / "staging"),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert result == "cancelled"
    backend.remove.assert_called_once()


def test_progress_updates_dl_dict(tmp_path):
    """Each poll updates downloaded_bytes / total_bytes so /manage/downloads
    reflects BT progress through the existing UI."""
    dl = _mk_dl(tmp_path)
    staging_path = tmp_path / "staging" / dl["filename"]
    staging_path.parent.mkdir()
    staging_path.write_bytes(b"x" * 1000)
    backend = _mk_backend(
        status_sequence=[
            {
                "state": "downloading",
                "completed_bytes": 250,
                "total_bytes": 1000,
                "down_speed": 5_000_000,
                "up_speed": 0,
                "peers": 8,
                "info_hash": "h",
            },
            {
                "state": "complete",
                "completed_bytes": 1000,
                "total_bytes": 1000,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 8,
                "info_hash": "h",
            },
        ]
    )
    library._try_bt_download(
        backend,
        dl,
        torrent_url="https://download.kiwix.org/zim/foo.zim.torrent",
        staging_dir=str(tmp_path / "staging"),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert dl["total_bytes"] == 1000
    assert dl["downloaded_bytes"] == 1000
    assert dl["bt_peers"] == 8
    assert dl["bt_info_hash"] == "h"


def test_add_failure_falls_back_cleanly(tmp_path):
    """If add_torrent itself raises (e.g. network blip fetching .torrent),
    we fall back to HTTP rather than failing loud."""
    dl = _mk_dl(tmp_path)
    backend = MagicMock()
    backend.add_torrent.side_effect = RuntimeError("torrent metadata fetch failed")
    result = library._try_bt_download(
        backend,
        dl,
        torrent_url="https://download.kiwix.org/zim/foo.zim.torrent",
        staging_dir=str(tmp_path / "staging"),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert result == "fallback"


def test_complete_with_invalid_staged_file(tmp_path, monkeypatch):
    """A staged file that fails libzim validation must NEVER be installed —
    fall back to HTTP instead. (The two-phase GID bug installed full-size
    preallocated garbage exactly this way before release.)"""
    name = "wikipedia_en_top_2026-02.zim"
    dl = _mk_dl(tmp_path, name)
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / name).write_bytes(b"\x00" * 4096)  # preallocated garbage
    backend = _mk_backend(
        status_sequence=[
            {
                "state": "complete",
                "completed_bytes": 4096,
                "total_bytes": 4096,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 0,
                "info_hash": "abc",
            },
        ]
    )
    result = library._try_bt_download(
        backend,
        dl,
        torrent_url="https://download.kiwix.org/zim/wikipedia/foo.zim.torrent",
        staging_dir=str(staging),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert result == "fallback"
    assert not os.path.exists(dl["dest"])  # garbage never installed


def test_complete_with_aria2_control_file_falls_back(tmp_path, monkeypatch):
    """A .aria2 control file beside the staged download means the transfer
    is unfinished — 'complete' belongs to some other GID. Never install."""
    name = "wikipedia_en_top_2026-02.zim"
    dl = _mk_dl(tmp_path, name)
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / name).write_bytes(b"partial")
    (staging / (name + ".aria2")).write_bytes(b"ctl")
    monkeypatch.setattr(library._srv, "open_archive", lambda path: object())
    backend = _mk_backend(
        status_sequence=[
            {
                "state": "complete",
                "completed_bytes": 7,
                "total_bytes": 7,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 0,
                "info_hash": "abc",
            },
        ]
    )
    result = library._try_bt_download(
        backend,
        dl,
        torrent_url="https://download.kiwix.org/zim/wikipedia/foo.zim.torrent",
        staging_dir=str(staging),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert result == "fallback"
    assert not os.path.exists(dl["dest"])


# ────────────────────────────────────────────────────────────────────────────
# Honest-seeding re-add policy: what happens to the torrent after install
# ────────────────────────────────────────────────────────────────────────────


def _run_completion(tmp_path, monkeypatch, *, seeding, mirror, cap):
    """Drive _try_bt_download to a clean completion under a seed policy;
    return the mocked backend for assertions."""
    import zimi.p2p as p2p

    dl = _mk_dl(tmp_path)
    staging_path = tmp_path / "staging" / dl["filename"]
    staging_path.parent.mkdir(exist_ok=True)
    staging_path.write_bytes(b"fake zim content")
    monkeypatch.setattr(library._srv, "open_archive", lambda path: object())
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: seeding)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: mirror)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: cap)
    backend = _mk_backend(
        status_sequence=[
            {
                "state": "complete",
                "completed_bytes": 16,
                "total_bytes": 16,
                "peers": 0,
                "info_hash": "aa11",
                "gid": "gid-001",
            }
        ]
    )
    out = library._try_bt_download(
        backend,
        dl,
        torrent_url=dl["url"] + ".torrent",
        staging_dir=str(staging_path.parent),
        poll_interval=0.01,
    )
    assert out == "success"
    return backend


def test_reseed_normal_cap_readds_from_library(tmp_path, monkeypatch):
    """Seeding on, cap 2: the finished torrent re-adds against ZIM_DIR
    with the cap, so the seed survives restarts (the honest-seeding fix)."""
    backend = _run_completion(tmp_path, monkeypatch, seeding=True, mirror=False, cap=2.0)
    readds = [c for c in backend.add_torrent.call_args_list[1:]]
    assert len(readds) == 1
    args, kwargs = readds[0]
    assert kwargs["dest_dir"] == str(tmp_path)
    assert kwargs["options"]["seed-ratio"] == "2.0"
    assert kwargs["options"]["bt-seed-unverified"] == "true"
    backend.remove.assert_called_with("gid-001", delete_files=True)


def test_reseed_mirror_mode_is_uncapped(tmp_path, monkeypatch):
    backend = _run_completion(tmp_path, monkeypatch, seeding=True, mirror=True, cap=2.0)
    _args, kwargs = backend.add_torrent.call_args_list[1]
    assert kwargs["options"]["seed-ratio"] == "0"


def test_reseed_cap_zero_means_leech_only(tmp_path, monkeypatch):
    """Zimi's ratio 0 = never seed; aria2's 0 = forever. Cap 0 must remove
    the torrent, never re-add it uncapped."""
    backend = _run_completion(tmp_path, monkeypatch, seeding=True, mirror=False, cap=0.0)
    assert len(backend.add_torrent.call_args_list) == 1  # only the download add
    backend.remove.assert_called_with("gid-001", delete_files=True)


def test_seeding_disabled_removes_torrent(tmp_path, monkeypatch):
    backend = _run_completion(tmp_path, monkeypatch, seeding=False, mirror=False, cap=2.0)
    assert len(backend.add_torrent.call_args_list) == 1  # no re-add
    assert backend.remove.call_args_list[-1].args[0] == "gid-001"
