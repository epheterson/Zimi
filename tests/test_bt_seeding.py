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


def test_bt_rate_limits_default_unlimited(monkeypatch, tmp_path):
    monkeypatch.delenv("ZIMI_BT", raising=False)
    monkeypatch.delenv("ZIMI_BT_UP_KB", raising=False)
    monkeypatch.delenv("ZIMI_BT_DOWN_KB", raising=False)
    p2p.set_prefs_path(str(tmp_path / "prefs.json"))
    assert p2p.get_bt_up_limit_kb() == 0
    assert p2p.get_bt_down_limit_kb() == 0


def test_bt_rate_limits_from_pref(monkeypatch, tmp_path):
    monkeypatch.delenv("ZIMI_BT", raising=False)
    monkeypatch.delenv("ZIMI_BT_UP_KB", raising=False)
    p2p.set_prefs_path(str(tmp_path / "prefs.json"))
    p2p.set_pref("bt_up_kb", 5120)
    p2p.set_pref("bt_down_kb", 20480)
    assert p2p.get_bt_up_limit_kb() == 5120
    assert p2p.get_bt_down_limit_kb() == 20480


def test_bt_rate_limit_env_locks_field(monkeypatch):
    monkeypatch.setenv("ZIMI_BT", "up=8192")
    assert p2p.get_bt_up_limit_kb() == 8192
    assert p2p.is_bt_up_env_locked() is True


def test_effective_seed_options_no_per_torrent_cap(monkeypatch, tmp_path):
    monkeypatch.delenv("ZIMI_MIRROR", raising=False)
    p2p.set_prefs_path(str(tmp_path / "prefs.json"))
    opts = p2p.effective_seed_options()
    assert opts["max-upload-limit"] == "0K"  # global limit governs, not per-torrent


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
    # Unset → None: the absolute byte floor governs, not a percent
    monkeypatch.delenv("ZIMI_SEED_DISK_PCT", raising=False)
    assert p2p.get_disk_pressure_pct() is None


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


def test_no_pause_on_big_healthy_drive(monkeypatch):
    """4.3% free on a 466 GB drive is still 20 GB — don't pause seeding.
    The old percent default refused exactly this (seeding writes ~nothing)."""
    monkeypatch.delenv("ZIMI_SEED_DISK_PCT", raising=False)
    gb = 1024**3
    fake_usage = MagicMock(total=466 * gb, free=20 * gb, used=446 * gb)
    monkeypatch.setattr(p2p.shutil, "disk_usage", lambda p: fake_usage)
    assert p2p.should_pause_for_disk_pressure("/zims") is False


def test_pause_below_absolute_floor(monkeypatch):
    monkeypatch.delenv("ZIMI_SEED_DISK_PCT", raising=False)
    gb = 1024**3
    fake_usage = MagicMock(total=466 * gb, free=1 * gb, used=465 * gb)
    monkeypatch.setattr(p2p.shutil, "disk_usage", lambda p: fake_usage)
    assert p2p.should_pause_for_disk_pressure("/zims") is True


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
    b = _mk_backend(
        monkeypatch,
        {
            "meta1": {
                "gid": "meta1",
                "status": "complete",
                "followedBy": ["content1"],
                "completedLength": "40960",
                "totalLength": "40960",
            },
            "content1": {
                "gid": "content1",
                "status": "active",
                "completedLength": "1048576",
                "totalLength": "23000000000",
                "downloadSpeed": "9999",
                "connections": "12",
            },
        },
    )
    st = b.status("meta1")
    assert st["state"] == "downloading"
    assert st["gid"] == "content1"  # caller must rebind to this
    assert st["total_bytes"] == 23000000000  # real totals, not the .torrent's


def test_status_reports_complete_only_when_content_done(monkeypatch):
    b = _mk_backend(
        monkeypatch,
        {
            "meta1": {"gid": "meta1", "status": "complete", "followedBy": ["c1"]},
            "c1": {
                "gid": "c1",
                "status": "complete",
                "completedLength": "100",
                "totalLength": "100",
            },
        },
    )
    st = b.status("meta1")
    assert st["state"] == "complete"
    assert st["gid"] == "c1"


def test_status_plain_download_unchanged(monkeypatch):
    """Direct downloads (no followedBy) behave exactly as before."""
    b = _mk_backend(
        monkeypatch,
        {
            "g1": {
                "gid": "g1",
                "status": "active",
                "completedLength": "5",
                "totalLength": "10",
            },
        },
    )
    st = b.status("g1")
    assert st["gid"] == "g1"
    assert st["completed_bytes"] == 5


def test_status_seeding_torrent_reports_complete(monkeypatch):
    """aria2 keeps a finished torrent 'active' while seeding — the download
    itself is done and must report complete, or the UI sits at 100% until
    the seed ratio caps."""
    b = _mk_backend(
        monkeypatch,
        {
            "g1": {
                "gid": "g1",
                "status": "active",
                "seeder": "true",
                "completedLength": "100",
                "totalLength": "100",
            },
        },
    )
    st = b.status("g1")
    assert st["state"] == "complete"


def test_peer_share_pref_and_env_lock(_prefs, monkeypatch):
    """LAN sharing follows the same pref+env-lock contract as seed/mirror."""
    from zimi import p2p_discovery as disc

    monkeypatch.delenv("ZIMI_PEER_SHARE", raising=False)
    assert disc.is_share_enabled() is False  # OFF by default: LAN is opt-in
    p2p.set_pref("peer_share", True)
    assert disc.is_share_enabled() is True
    assert disc.is_share_env_locked() is False
    monkeypatch.setenv("ZIMI_PEER_SHARE", "1")
    assert disc.is_share_enabled() is True  # env wins over pref
    assert disc.is_share_env_locked() is True


def test_torrent_pref_and_env_lock(_prefs, monkeypatch):
    """The BitTorrent master switch follows the pref+env-lock contract."""
    monkeypatch.delenv("ZIMI_TORRENT", raising=False)
    assert p2p.is_torrent_enabled() is True  # default on
    p2p.set_pref("torrent", False)
    assert p2p.is_torrent_enabled() is False
    assert p2p.is_torrent_env_locked() is False
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    assert p2p.is_torrent_enabled() is True
    assert p2p.is_torrent_env_locked() is True


def test_seed_ratio_pref_and_env_lock(_prefs, monkeypatch):
    monkeypatch.delenv("ZIMI_SEED_RATIO", raising=False)
    assert p2p.get_seed_ratio_cap() == 2.0  # default
    p2p.set_pref("seed_ratio", 3.5)
    assert p2p.get_seed_ratio_cap() == 3.5
    p2p.set_pref("seed_ratio", 99)  # clamped
    assert p2p.get_seed_ratio_cap() == 10.0
    monkeypatch.setenv("ZIMI_SEED_RATIO", "1.5")
    assert p2p.get_seed_ratio_cap() == 1.5
    assert p2p.is_seed_ratio_env_locked() is True


def test_get_backend_honors_torrent_pref_over_singleton(_prefs, monkeypatch):
    """Switching BT off must take effect even with a live sidecar cached."""
    monkeypatch.delenv("ZIMI_TORRENT", raising=False)
    p2p._backend_singleton = object()  # simulate running backend
    p2p.set_pref("torrent", False)
    assert p2p.get_backend(data_dir="/tmp") is None
    p2p.set_pref("torrent", True)
    assert p2p.get_backend(data_dir="/tmp") is not None
    p2p._backend_singleton = None


# ────────────────────────────────────────────────────────────────────────────
# ZIMI_BT / ZIMI_NEARBY compact config blobs
# ────────────────────────────────────────────────────────────────────────────


def test_bt_blob_master_switch_and_fields(_prefs, monkeypatch):
    monkeypatch.setenv("ZIMI_BT", "off")
    assert p2p.is_torrent_enabled() is False
    assert p2p.is_torrent_env_locked() is True
    monkeypatch.setenv("ZIMI_BT", "on,port=16881,ratio=3,mirror=on")
    assert p2p.is_torrent_enabled() is True
    assert p2p.get_bt_port() == 16881
    assert p2p.get_seed_ratio_cap() == 3.0
    assert p2p.is_seed_ratio_env_locked() is True
    assert p2p.is_mirror_enabled() is True
    assert p2p.is_mirror_env_locked() is True


def test_bt_blob_field_only_does_not_lock_switch(_prefs, monkeypatch):
    """Setting just port= must not lock the on/off switch (granular locks)."""
    monkeypatch.setenv("ZIMI_BT", "port=16881")
    assert p2p.get_bt_port() == 16881
    assert p2p.is_torrent_env_locked() is False
    assert p2p.is_torrent_enabled() is True  # pref default still applies
    p2p.set_pref("torrent", False)
    assert p2p.is_torrent_enabled() is False  # UI switch still works


def test_legacy_vars_still_work(_prefs, monkeypatch):
    monkeypatch.delenv("ZIMI_BT", raising=False)
    monkeypatch.setenv("ZIMI_TORRENT", "0")
    assert p2p.is_torrent_enabled() is False
    monkeypatch.setenv("ZIMI_SEED_RATIO", "1.5")
    assert p2p.get_seed_ratio_cap() == 1.5


def test_nearby_blob(_prefs, monkeypatch):
    from zimi import p2p_discovery as disc

    monkeypatch.delenv("ZIMI_PEER_SHARE", raising=False)
    monkeypatch.setenv("ZIMI_NEARBY", "off")
    assert disc.is_share_enabled() is False
    assert disc.is_share_env_locked() is True
    assert disc.is_enabled() is False  # off silences discovery too
    monkeypatch.setenv("ZIMI_NEARBY", "on,name=my box!,public=on")
    assert disc.is_share_enabled() is True
    assert disc.is_public_share_enabled() is True
    assert disc._peer_instance_name() == "my box"


def test_find_aria2c_falls_back_to_homebrew_paths(monkeypatch):
    """macOS GUI apps launch without Homebrew on PATH — the finder must
    check the standard install locations before giving up."""
    monkeypatch.setattr(p2p.shutil, "which", lambda _: None)
    calls = []

    def fake_isfile(path):
        calls.append(path)
        return path == "/usr/local/bin/aria2c"

    monkeypatch.setattr(p2p.os.path, "isfile", fake_isfile)
    monkeypatch.setattr(p2p.os, "access", lambda p, m: True)
    assert p2p.find_aria2c() == "/usr/local/bin/aria2c"


def test_find_aria2c_prefers_bundled_sidecar(tmp_path, monkeypatch):
    """Desktop builds ship aria2c inside the bundle (sys._MEIPASS) — it
    must win over any system install so behavior is self-contained."""
    import sys

    bundled = tmp_path / "aria2c"
    bundled.write_text("#!/bin/sh\n")
    bundled.chmod(0o755)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(p2p.shutil, "which", lambda b: "/usr/bin/aria2c")
    assert p2p.find_aria2c() == str(bundled)


def test_find_aria2c_ignores_empty_bundle_dir(tmp_path, monkeypatch):
    import sys

    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(p2p.shutil, "which", lambda b: None)
    monkeypatch.setattr(p2p.os.path, "isfile", lambda p: False)
    assert p2p.find_aria2c() is None


def test_dht_enabled_by_default(monkeypatch):
    """DHT is what makes magnets and trackerless swarms work — on unless
    explicitly opted out."""
    monkeypatch.delenv("ZIMI_DHT", raising=False)
    monkeypatch.delenv("ZIMI_BT", raising=False)
    assert p2p.is_dht_enabled() is True


def test_dht_blob_opt_out(monkeypatch):
    monkeypatch.setenv("ZIMI_BT", "on,dht=off")
    assert p2p.is_dht_enabled() is False


def test_dht_legacy_env_opt_out(monkeypatch):
    monkeypatch.delenv("ZIMI_BT", raising=False)
    monkeypatch.setenv("ZIMI_DHT", "0")
    assert p2p.is_dht_enabled() is False


def test_bt_port_pref_and_env_lock(_prefs, monkeypatch):
    monkeypatch.delenv("ZIMI_BT", raising=False)
    monkeypatch.delenv("ZIMI_BT_PORT", raising=False)
    assert p2p.get_bt_port() == 6881
    assert p2p.is_bt_port_env_locked() is False
    p2p.set_pref("bt_port", 51413)
    assert p2p.get_bt_port() == 51413
    monkeypatch.setenv("ZIMI_BT", "on,port=16881")
    assert p2p.get_bt_port() == 16881
    assert p2p.is_bt_port_env_locked() is True


# ────────────────────────────────────────────────────────────────────────────
# apply_seed_policy — current settings govern LIVE seeds, not just future adds
# ────────────────────────────────────────────────────────────────────────────


def _policy_backend(zim_dir, *, ratio="0", uploaded=0, total=1000):
    """Backend with one live library seed and one staging transfer."""
    backend = MagicMock()
    backend.list_managed.return_value = [
        {
            "gid": "lib-1",
            "status": "active",
            "uploadLength": str(uploaded),
            "totalLength": str(total),
            "files": [{"path": os.path.join(zim_dir, "wiki.zim")}],
        },
        {
            "gid": "stg-1",
            "status": "active",
            "files": [{"path": os.path.join(zim_dir, "staging", "dl.zim")}],
        },
    ]
    backend.get_options.return_value = {"seed-ratio": ratio}
    backend.change_options.return_value = True
    return backend


def _run_policy(monkeypatch, backend, zim_dir, *, mirror=False, seed=True, cap=2.0):
    import zimi.library as library

    monkeypatch.setattr(p2p, "peek_backend", lambda: backend)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: mirror)
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: seed)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: cap)
    monkeypatch.setattr(library._srv, "ZIM_DIR", zim_dir)
    monkeypatch.setattr(
        library._srv, "ZIMI_DATA_DIR", os.path.join(zim_dir, "data")
    )
    return library.apply_seed_policy()


def test_policy_normalizes_stale_numeric_ratio_to_zero(tmp_path, monkeypatch):
    """A seed carrying an old numeric aria2 cap (the kill switch: aria2
    counts session download, 0 for re-seeds) is reset to uncapped."""
    backend = _policy_backend(str(tmp_path), ratio="2.0")
    changed = _run_policy(monkeypatch, backend, str(tmp_path), cap=2.0)
    assert changed == 1
    backend.change_options.assert_called_once_with("lib-1", {"seed-ratio": "0"})
    backend.remove.assert_not_called()


def test_policy_skips_staging_transfers(tmp_path, monkeypatch):
    """Downloads in staging belong to the download machinery — untouched."""
    backend = _policy_backend(str(tmp_path), ratio="0")
    _run_policy(monkeypatch, backend, str(tmp_path), cap=2.0)
    for call in backend.change_options.call_args_list:
        assert call.args[0] != "stg-1"


def test_policy_leaves_ratio_zero_seed_running_under_cap(tmp_path, monkeypatch):
    backend = _policy_backend(str(tmp_path), ratio="0", uploaded=500, total=1000)
    changed = _run_policy(monkeypatch, backend, str(tmp_path), cap=2.0)
    assert changed == 0
    backend.change_options.assert_not_called()
    backend.remove.assert_not_called()


def test_policy_mirror_never_cap_stops(tmp_path, monkeypatch):
    """Mirror on: even a heavily-uploaded seed keeps seeding."""
    backend = _policy_backend(str(tmp_path), ratio="0", uploaded=999999, total=1000)
    changed = _run_policy(monkeypatch, backend, str(tmp_path), mirror=True)
    assert changed == 0
    backend.remove.assert_not_called()


def test_policy_stops_seed_at_cumulative_cap(tmp_path, monkeypatch):
    """Uploaded 2x the file size (across sessions) -> stop + intent gone."""
    import zimi.library as library

    backend = _policy_backend(str(tmp_path), ratio="0", uploaded=2000, total=1000)
    changed = _run_policy(monkeypatch, backend, str(tmp_path), cap=2.0)
    assert changed == 1
    backend.remove.assert_called_once_with("lib-1", delete_files=True)
    assert "wiki.zim" not in library._seed_ledger()


def test_policy_accumulates_upload_across_sessions(tmp_path, monkeypatch):
    """1200 uploaded under one gid + 900 under a new gid = 2100 >= 2x1000:
    the second pass must stop the seed even though neither session alone
    reached the cap."""
    import zimi.library as library

    b1 = _policy_backend(str(tmp_path), ratio="0", uploaded=1200, total=1000)
    assert _run_policy(monkeypatch, b1, str(tmp_path), cap=2.0) == 0
    b2 = _policy_backend(str(tmp_path), ratio="0", uploaded=900, total=1000)
    b2.list_managed.return_value[0]["gid"] = "lib-2"
    changed = _run_policy(monkeypatch, b2, str(tmp_path), cap=2.0)
    assert changed == 1
    b2.remove.assert_called_once_with("lib-2", delete_files=True)


def test_policy_seeding_off_stops_library_seeds(tmp_path, monkeypatch):
    """Cap 0 / seeding off stops live seeds; the ZIM stays on disk."""
    backend = _policy_backend(str(tmp_path), ratio="2.0")
    changed = _run_policy(monkeypatch, backend, str(tmp_path), seed=False)
    assert changed == 1
    backend.remove.assert_called_once_with("lib-1", delete_files=True)
    backend.change_options.assert_not_called()


def test_policy_no_backend_is_a_noop(monkeypatch):
    import zimi.library as library

    monkeypatch.setattr(p2p, "peek_backend", lambda: None)
    assert library.apply_seed_policy() == 0


# ────────────────────────────────────────────────────────────────────────────
# Seed intent ledger — restarts must not drop seeds; stops must not resurrect
# ────────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def _ledger_env(tmp_path, monkeypatch):
    import zimi.library as library

    monkeypatch.setattr(library._srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(library._srv, "ZIM_DIR", str(tmp_path))
    return library


def test_ledger_record_unrecord_roundtrip(_ledger_env):
    lib = _ledger_env
    lib.record_seed("a.zim")
    lib.record_seed("b.zim")
    assert set(lib._seed_ledger()) == {"a.zim", "b.zim"}
    lib.unrecord_seed("a.zim")
    assert set(lib._seed_ledger()) == {"b.zim"}


def test_reseed_readds_missing_seed_from_local_torrent(_ledger_env, tmp_path, monkeypatch):
    lib = _ledger_env
    (tmp_path / "wiki.zim").write_bytes(b"z")
    tfile = tmp_path / "data" / "bt" / "torrents" / "wiki.zim.torrent"
    tfile.parent.mkdir(parents=True)
    tfile.write_bytes(b"t")
    lib.record_seed("wiki.zim")
    monkeypatch.setattr(lib, "_get_torrent_metadata", lambda: {"wiki.zim": {"torrent_file": str(tfile)}})
    backend = MagicMock()
    backend.list_managed.return_value = []
    monkeypatch.setattr(p2p, "peek_backend", lambda: backend)
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: True)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    assert lib.reseed_from_ledger() == 1
    args, kwargs = backend.add_torrent.call_args
    assert args[0] == str(tfile)
    # aria2 layer is always uncapped; Zimi enforces the user's cap itself.
    assert kwargs["options"]["seed-ratio"] == "0"
    assert kwargs["options"]["bt-hash-check-seed"] == "true"


def test_reseed_skips_already_managed(_ledger_env, tmp_path, monkeypatch):
    lib = _ledger_env
    (tmp_path / "wiki.zim").write_bytes(b"z")
    lib.record_seed("wiki.zim")
    backend = MagicMock()
    backend.list_managed.return_value = [
        {"gid": "g1", "files": [{"path": str(tmp_path / "wiki.zim")}]}
    ]
    monkeypatch.setattr(p2p, "peek_backend", lambda: backend)
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: True)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    assert lib.reseed_from_ledger() == 0
    backend.add_torrent.assert_not_called()


def test_reseed_drops_intent_when_file_deleted(_ledger_env, monkeypatch):
    lib = _ledger_env
    lib.record_seed("gone.zim")
    backend = MagicMock()
    backend.list_managed.return_value = []
    monkeypatch.setattr(p2p, "peek_backend", lambda: backend)
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: True)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    assert lib.reseed_from_ledger() == 0
    assert "gone.zim" not in lib._seed_ledger()
    backend.add_torrent.assert_not_called()


def test_reseed_respects_seeding_off(_ledger_env, monkeypatch):
    lib = _ledger_env
    lib.record_seed("wiki.zim")
    monkeypatch.setattr(p2p, "peek_backend", lambda: MagicMock())
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: False)
    assert lib.reseed_from_ledger() == 0


def test_policy_stop_removes_ledger_intent(_ledger_env, tmp_path, monkeypatch):
    """Seeding toggled off: the policy stop also clears intent, so the seed
    doesn't resurrect at next startup."""
    lib = _ledger_env
    lib.record_seed("wiki.zim")
    backend = MagicMock()
    backend.list_managed.return_value = [
        {"gid": "g1", "files": [{"path": str(tmp_path / "wiki.zim")}]}
    ]
    monkeypatch.setattr(p2p, "peek_backend", lambda: backend)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: False)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    assert lib.apply_seed_policy() == 1
    assert "wiki.zim" not in lib._seed_ledger()
