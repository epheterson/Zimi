"""Tests for delta updates via BitTorrent piece reuse.

When updating a ZIM, the previous version is copied into staging under the new
filename before the torrent is added, so libtorrent's hash check salvages every
unchanged piece and only the changed pieces download. Salvaged bytes surface as
`reused_bytes` on the download record.

Fake-lt level — no real libtorrent, no real HTTP.
"""

import os
import sys
import time
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402

OLD = "wikipedia_en_top_2026-01.zim"
NEW = "wikipedia_en_top_2026-02.zim"


def _mk_dl(zim_dir, staging_dir, name=NEW, is_update=True):
    return {
        "id": "1",
        "url": f"https://download.kiwix.org/zim/wikipedia/{name}",
        "filename": name,
        "dest": os.path.join(str(zim_dir), name),
        "started": time.time(),
        "done": False,
        "error": None,
        "is_update": is_update,
    }


def _mk_backend(*, status_sequence):
    backend = MagicMock()
    backend.add_torrent.return_value = "gid-001"
    it = iter(status_sequence)
    backend.status.side_effect = lambda tid: next(it)
    return backend


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    """A ZIM_DIR seeded with an old version, and an empty staging dir."""
    zim_dir = tmp_path / "zim"
    zim_dir.mkdir()
    staging = tmp_path / "staging"
    (zim_dir / OLD).write_bytes(b"OLD-CONTENT" * 100)
    monkeypatch.setattr(library._srv, "ZIM_DIR", str(zim_dir))
    return zim_dir, staging


# ── _find_previous_version ──────────────────────────────────────────────────


def test_find_previous_version_picks_newest(dirs):
    zim_dir, _ = dirs
    (zim_dir / "wikipedia_en_top_2025-12.zim").write_bytes(b"older")
    assert library._find_previous_version(NEW) == OLD  # 2026-01 > 2025-12


def test_find_previous_version_none_without_predecessor(tmp_path, monkeypatch):
    zim_dir = tmp_path / "zim"
    zim_dir.mkdir()
    monkeypatch.setattr(library._srv, "ZIM_DIR", str(zim_dir))
    assert library._find_previous_version(NEW) is None


def test_find_previous_version_ignores_other_zims(dirs):
    zim_dir, _ = dirs
    (zim_dir / "stackoverflow_en_all_2026-01.zim").write_bytes(b"unrelated")
    assert library._find_previous_version(NEW) == OLD


# ── _prepare_delta_staging ──────────────────────────────────────────────────


def test_prepare_delta_copies_for_update(dirs):
    zim_dir, staging = dirs
    dl = _mk_dl(zim_dir, staging, is_update=True)
    library._prepare_delta_staging(dl, str(staging))
    staged = staging / NEW
    assert staged.exists()
    assert staged.read_bytes() == (zim_dir / OLD).read_bytes()
    assert dl["delta_from"] == OLD


def test_prepare_delta_skips_fresh_download(dirs):
    zim_dir, staging = dirs
    dl = _mk_dl(zim_dir, staging, is_update=False)
    library._prepare_delta_staging(dl, str(staging))
    assert not (staging / NEW).exists()
    assert "delta_from" not in dl


def test_prepare_delta_skips_when_no_predecessor(tmp_path, monkeypatch):
    zim_dir = tmp_path / "zim"
    zim_dir.mkdir()
    staging = tmp_path / "staging"
    monkeypatch.setattr(library._srv, "ZIM_DIR", str(zim_dir))
    dl = _mk_dl(zim_dir, staging, is_update=True)
    library._prepare_delta_staging(dl, str(staging))
    assert not (staging / NEW).exists()
    assert "delta_from" not in dl


def test_prepare_delta_preserves_resume_partial(dirs):
    """A staging partial from an interrupted download must never be clobbered
    by the delta copy — that would throw away real downloaded progress."""
    zim_dir, staging = dirs
    staging.mkdir()
    (staging / NEW).write_bytes(b"PARTIAL-RESUME-DATA")
    dl = _mk_dl(zim_dir, staging, is_update=True)
    library._prepare_delta_staging(dl, str(staging))
    assert (staging / NEW).read_bytes() == b"PARTIAL-RESUME-DATA"  # untouched
    assert "delta_from" not in dl


def test_prepare_delta_disk_space_guard(dirs, monkeypatch):
    """No room for a full copy of the old file → skip, leave staging clean."""
    zim_dir, staging = dirs
    dl = _mk_dl(zim_dir, staging, is_update=True)

    class _Usage:
        free = 1  # effectively zero free space

    monkeypatch.setattr(library.shutil, "disk_usage", lambda p: _Usage())
    library._prepare_delta_staging(dl, str(staging))
    assert not (staging / NEW).exists()
    assert "delta_from" not in dl


def test_prepare_delta_copy_failure_is_soft(dirs, monkeypatch):
    """A copy error falls through to a normal full download (no delta_from,
    no half-written staged file left behind)."""
    zim_dir, staging = dirs
    dl = _mk_dl(zim_dir, staging, is_update=True)

    def _boom(src, dst):
        raise OSError("copy failed")

    monkeypatch.setattr(library.shutil, "copyfile", _boom)
    library._prepare_delta_staging(dl, str(staging))
    assert not (staging / NEW).exists()
    assert "delta_from" not in dl


# ── reused_bytes surfacing through _try_bt_download ─────────────────────────


def test_reused_bytes_surfaced_on_delta(dirs, monkeypatch):
    """An update pre-seeds staging, then the first post-check poll reports the
    salvaged fraction — surfaced as dl['reused_bytes']."""
    zim_dir, staging = dirs
    dl = _mk_dl(zim_dir, staging, is_update=True)
    monkeypatch.setattr(library._srv, "open_archive", lambda p: object())
    backend = _mk_backend(
        status_sequence=[
            {  # hash check done: 850/1000 salvaged from the old version
                "state": "downloading",
                "checking": False,
                "completed_bytes": 850,
                "total_bytes": 1000,
                "peers": 6,
                "info_hash": "abc",
            },
            {
                "state": "complete",
                "checking": False,
                "completed_bytes": 1000,
                "total_bytes": 1000,
                "peers": 6,
                "info_hash": "abc",
            },
        ]
    )
    out = library._try_bt_download(
        backend,
        dl,
        torrent_url=dl["url"] + ".torrent",
        staging_dir=str(staging),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert out == "success"
    assert dl["delta_from"] == OLD
    assert dl["reused_bytes"] == 850


def test_reused_bytes_waits_for_hash_check(dirs, monkeypatch):
    """While checking is in progress, completed_bytes is partial check
    progress, not the final salvage — reused_bytes must not be snapshotted
    until checking finishes."""
    zim_dir, staging = dirs
    dl = _mk_dl(zim_dir, staging, is_update=True)
    monkeypatch.setattr(library._srv, "open_archive", lambda p: object())
    backend = _mk_backend(
        status_sequence=[
            {  # still checking — 300 is mid-check, NOT the answer
                "state": "downloading",
                "checking": True,
                "completed_bytes": 300,
                "total_bytes": 1000,
                "peers": 6,
                "info_hash": "abc",
            },
            {  # check complete — 850 is the real salvaged total
                "state": "downloading",
                "checking": False,
                "completed_bytes": 850,
                "total_bytes": 1000,
                "peers": 6,
                "info_hash": "abc",
            },
            {
                "state": "complete",
                "checking": False,
                "completed_bytes": 1000,
                "total_bytes": 1000,
                "peers": 6,
                "info_hash": "abc",
            },
        ]
    )
    out = library._try_bt_download(
        backend,
        dl,
        torrent_url=dl["url"] + ".torrent",
        staging_dir=str(staging),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert out == "success"
    assert dl["reused_bytes"] == 850  # not 300


def test_no_reused_bytes_for_fresh_download(dirs, monkeypatch):
    """A fresh (non-update) BT download never sets reused_bytes."""
    zim_dir, staging = dirs
    dl = _mk_dl(zim_dir, staging, is_update=False)
    staging.mkdir()
    (staging / NEW).write_bytes(b"fresh content")  # what BT "downloaded"
    monkeypatch.setattr(library._srv, "open_archive", lambda p: object())
    backend = _mk_backend(
        status_sequence=[
            {
                "state": "complete",
                "checking": False,
                "completed_bytes": 1000,
                "total_bytes": 1000,
                "peers": 6,
                "info_hash": "abc",
            },
        ]
    )
    out = library._try_bt_download(
        backend,
        dl,
        torrent_url=dl["url"] + ".torrent",
        staging_dir=str(staging),
        poll_interval=0.001,
        no_peers_timeout=10.0,
    )
    assert out == "success"
    assert "delta_from" not in dl
    assert "reused_bytes" not in dl
