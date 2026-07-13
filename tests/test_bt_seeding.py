"""Tests for the seeding manager.

After a BT download completes, the torrent stays in aria2 and seeds up
to a 2× ratio cap. Per-ZIM pause/disable, global disable via env, and
disk-pressure auto-pause are all tested here.
"""

import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.p2p as p2p  # noqa: E402


@pytest.fixture(autouse=True)
def _reset():
    p2p._backend_singleton = None
    yield
    p2p._backend_singleton = None


# ────────────────────────────────────────────────────────────────────────────
# Seeding policy helpers
# ────────────────────────────────────────────────────────────────────────────


def test_seed_options_default_2x_ratio():
    """add_torrent should pass seed-ratio=2.0 by default."""
    opts = p2p.seed_options(ratio_cap=2.0, max_upload_kb=2048)
    assert opts["seed-ratio"] == "2.0"
    assert opts["seed-time"] == "0"  # we use ratio cap, not time cap
    assert opts["max-upload-limit"] == "2048K"


def test_seed_options_zero_ratio_disables_seeding():
    """ratio_cap=0 means leech-only — set seed-time=0 + seed-ratio low."""
    opts = p2p.seed_options(ratio_cap=0, max_upload_kb=2048)
    assert opts["seed-ratio"] == "0"
    assert "bt-stop-timeout" in opts


def test_seed_disabled_when_zimi_seed_off(monkeypatch):
    monkeypatch.setenv("ZIMI_SEED", "0")
    assert p2p.is_seeding_enabled() is False


def test_seed_enabled_by_default(monkeypatch):
    monkeypatch.delenv("ZIMI_SEED", raising=False)
    assert p2p.is_seeding_enabled() is True


def test_ratio_cap_default(monkeypatch):
    monkeypatch.delenv("ZIMI_SEED_RATIO", raising=False)
    assert p2p.get_seed_ratio_cap() == 2.0


def test_ratio_cap_override(monkeypatch):
    monkeypatch.setenv("ZIMI_SEED_RATIO", "3.5")
    assert p2p.get_seed_ratio_cap() == 3.5


def test_ratio_cap_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("ZIMI_SEED_RATIO", "abc")
    assert p2p.get_seed_ratio_cap() == 2.0


def test_disk_pressure_threshold_default(monkeypatch):
    monkeypatch.delenv("ZIMI_SEED_DISK_PCT", raising=False)
    assert p2p.get_disk_pressure_pct() == 5  # 5% free → pause seeding


def test_disk_pressure_threshold_override(monkeypatch):
    monkeypatch.setenv("ZIMI_SEED_DISK_PCT", "10")
    assert p2p.get_disk_pressure_pct() == 10


# ────────────────────────────────────────────────────────────────────────────
# Disk-pressure check
# ────────────────────────────────────────────────────────────────────────────


def test_should_pause_for_disk_pressure_when_low(monkeypatch):
    """When free space < threshold, should pause seeding."""
    monkeypatch.setenv("ZIMI_SEED_DISK_PCT", "10")
    fake_usage = MagicMock(total=100, free=5, used=95)
    monkeypatch.setattr(p2p.shutil, "disk_usage", lambda p: fake_usage)
    assert p2p.should_pause_for_disk_pressure("/zims") is True


def test_should_not_pause_when_disk_ok(monkeypatch):
    monkeypatch.setenv("ZIMI_SEED_DISK_PCT", "5")
    fake_usage = MagicMock(total=100, free=50, used=50)
    monkeypatch.setattr(p2p.shutil, "disk_usage", lambda p: fake_usage)
    assert p2p.should_pause_for_disk_pressure("/zims") is False


def test_disk_check_handles_missing_path(monkeypatch):
    """If the path doesn't exist or stat fails, default to NOT pausing."""
    monkeypatch.setattr(
        p2p.shutil, "disk_usage", MagicMock(side_effect=OSError("nope"))
    )
    assert p2p.should_pause_for_disk_pressure("/zims") is False


# ────────────────────────────────────────────────────────────────────────────
# Persisted UI preferences (seed/mirror toggles) + env-var lock
# ────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def _prefs(tmp_path, monkeypatch):
    """Point p2p at a temp prefs file and clear the seed/mirror env vars."""
    monkeypatch.delenv("ZIMI_SEED", raising=False)
    monkeypatch.delenv("ZIMI_MIRROR", raising=False)
    path = str(tmp_path / "bt" / "prefs.json")
    old = p2p._prefs_path
    p2p.set_prefs_path(path)
    yield path
    p2p.set_prefs_path(old)


def test_seed_pref_persists_and_disables(_prefs):
    assert p2p.is_seeding_enabled() is True  # default without env or pref
    p2p.set_pref("seed", False)
    assert p2p.is_seeding_enabled() is False
    assert p2p.is_seed_env_locked() is False


def test_seed_env_wins_over_pref(_prefs, monkeypatch):
    p2p.set_pref("seed", False)
    monkeypatch.setenv("ZIMI_SEED", "1")
    assert p2p.is_seeding_enabled() is True
    assert p2p.is_seed_env_locked() is True


def test_mirror_pref_enables_without_env(_prefs):
    assert p2p.is_mirror_enabled() is False  # default off
    p2p.set_pref("mirror", True)
    assert p2p.is_mirror_enabled() is True
    assert p2p.is_mirror_env_locked() is False


def test_mirror_env_wins_over_pref(_prefs, monkeypatch):
    p2p.set_pref("mirror", True)
    monkeypatch.setenv("ZIMI_MIRROR", "0")
    assert p2p.is_mirror_enabled() is False
    assert p2p.is_mirror_env_locked() is True


def test_prefs_survive_corrupt_file(_prefs):
    os.makedirs(os.path.dirname(_prefs), exist_ok=True)
    with open(_prefs, "w") as f:
        f.write("{not json")
    assert p2p.is_seeding_enabled() is True  # falls back to default
    p2p.set_pref("seed", False)  # write replaces the corrupt file
    assert p2p.is_seeding_enabled() is False


def test_mirror_status_reports_lock_state(_prefs, monkeypatch):
    monkeypatch.setenv("ZIMI_SEED", "0")
    status = p2p.get_mirror_status()
    assert status["seed_enabled"] is False
    assert status["seed_env_locked"] is True
    assert status["env_locked"] is False  # mirror env not set


# ────────────────────────────────────────────────────────────────────────────
# Two-phase GID (metadata → content) — the bug that installed corrupt ZIMs
# ────────────────────────────────────────────────────────────────────────────


def _mk_backend(monkeypatch, responses):
    """Aria2Backend with a mocked RPC returning per-GID tellStatus dicts."""
    b = p2p.Aria2Backend.__new__(p2p.Aria2Backend)
    monkeypatch.setattr(
        b, "_rpc", lambda method, params: responses[params[0]], raising=False
    )
    return b


def test_status_follows_metadata_gid_to_content_transfer(monkeypatch):
    """A .torrent URL's original GID completes the moment the tiny metadata
    file lands; the content transfer continues under followedBy. status()
    must report the content transfer — reporting the metadata GID made the
    caller install a preallocated, mostly-empty staging file."""
    b = _mk_backend(monkeypatch, {
        "meta1": {"gid": "meta1", "status": "complete", "followedBy": ["content1"],
                  "completedLength": "40960", "totalLength": "40960"},
        "content1": {"gid": "content1", "status": "active",
                     "completedLength": "1048576", "totalLength": "23000000000",
                     "downloadSpeed": "9999", "connections": "12"},
    })
    st = b.status("meta1")
    assert st["state"] == "downloading"
    assert st["gid"] == "content1"          # caller must rebind to this
    assert st["total_bytes"] == 23000000000  # real totals, not the .torrent's


def test_status_reports_complete_only_when_content_done(monkeypatch):
    b = _mk_backend(monkeypatch, {
        "meta1": {"gid": "meta1", "status": "complete", "followedBy": ["c1"]},
        "c1": {"gid": "c1", "status": "complete",
               "completedLength": "100", "totalLength": "100"},
    })
    st = b.status("meta1")
    assert st["state"] == "complete"
    assert st["gid"] == "c1"


def test_status_plain_download_unchanged(monkeypatch):
    """Direct downloads (no followedBy) behave exactly as before."""
    b = _mk_backend(monkeypatch, {
        "g1": {"gid": "g1", "status": "active",
               "completedLength": "5", "totalLength": "10"},
    })
    st = b.status("g1")
    assert st["gid"] == "g1"
    assert st["completed_bytes"] == 5


def test_status_seeding_torrent_reports_complete(monkeypatch):
    """aria2 keeps a finished torrent 'active' while seeding — the download
    itself is done and must report complete, or the UI sits at 100% until
    the seed ratio caps."""
    b = _mk_backend(monkeypatch, {
        "g1": {"gid": "g1", "status": "active", "seeder": "true",
               "completedLength": "100", "totalLength": "100"},
    })
    st = b.status("g1")
    assert st["state"] == "complete"
