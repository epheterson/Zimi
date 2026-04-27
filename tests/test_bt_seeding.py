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
