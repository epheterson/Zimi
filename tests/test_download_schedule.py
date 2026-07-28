"""Tests for scheduled / night-window downloads.

When scheduling is enabled, downloads started outside the local-time window
are held in the queue as ``scheduled`` and released when the window opens
(by the watcher tick or a config change). Window logic is server-local time,
supports overnight-spanning ranges, and never traps downloads on bad config.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402
import zimi.server as server  # noqa: E402


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(
        server,
        "_DOWNLOAD_SCHEDULE_CONFIG",
        str(tmp_path / "download_schedule.json"),
        raising=False,
    )
    monkeypatch.delenv("ZIMI_DL_WINDOW", raising=False)
    with library._download_lock:
        library._active_downloads.clear()
        library._download_queue.clear()
        library._download_counter = 0
    yield
    with library._download_lock:
        library._active_downloads.clear()
        library._download_queue.clear()


@pytest.fixture
def _no_real_threads(monkeypatch):
    class _FakeThread:
        def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
            self.target, self.args, self.kwargs = target, args, kwargs or {}

        def start(self):
            pass

    monkeypatch.setattr(library.threading, "Thread", _FakeThread)


def _kiwix_url(name):
    return f"https://download.kiwix.org/zim/{name}.zim"


# ────────────────────────────────────────────────────────────────────────────
# Pure window math
# ────────────────────────────────────────────────────────────────────────────


def test_parse_hhmm():
    assert library._parse_hhmm("01:00") == 60
    assert library._parse_hhmm("07:30") == 450
    assert library._parse_hhmm("23:59") == 1439
    assert library._parse_hhmm("00:00") == 0


def test_parse_hhmm_rejects_garbage():
    for bad in ("", "24:00", "1:60", "aa:bb", "7", "07-00", None, "25:10"):
        assert library._parse_hhmm(bad) is None


def test_fmt_hhmm():
    assert library._fmt_hhmm(60) == "01:00"
    assert library._fmt_hhmm(450) == "07:30"
    assert library._fmt_hhmm(1440) == "00:00"  # wraps


def test_in_window_daytime_range():
    # 01:00–07:00
    s, e = 60, 420
    assert not library._in_window(0, s, e)  # 00:00 before
    assert library._in_window(60, s, e)  # 01:00 start inclusive
    assert library._in_window(300, s, e)  # 05:00 inside
    assert not library._in_window(420, s, e)  # 07:00 end exclusive
    assert not library._in_window(600, s, e)  # 10:00 after


def test_in_window_spans_midnight():
    # 22:00–06:00
    s, e = 1320, 360
    assert library._in_window(1380, s, e)  # 23:00
    assert library._in_window(0, s, e)  # 00:00
    assert library._in_window(300, s, e)  # 05:00
    assert not library._in_window(360, s, e)  # 06:00 end exclusive
    assert not library._in_window(720, s, e)  # 12:00 outside
    assert library._in_window(1320, s, e)  # 22:00 start inclusive


def test_in_window_equal_bounds_is_always_open():
    assert library._in_window(0, 120, 120)
    assert library._in_window(1000, 120, 120)


# ────────────────────────────────────────────────────────────────────────────
# Config load / save
# ────────────────────────────────────────────────────────────────────────────


def test_default_schedule_disabled():
    sched = library._load_download_schedule()
    assert sched["enabled"] is False
    assert sched["start"] == "01:00"
    assert sched["end"] == "07:00"
    assert sched["locked"] is False


def test_save_and_reload():
    assert library._save_download_schedule(True, "23:00", "05:00")
    sched = library._load_download_schedule()
    assert sched == {
        "enabled": True,
        "start": "23:00",
        "end": "05:00",
        "locked": False,
    }


def test_malformed_persisted_times_fall_back():
    cfg = server._DOWNLOAD_SCHEDULE_CONFIG
    with open(cfg, "w") as f:
        f.write('{"enabled": true, "start": "nope", "end": "99:99"}')
    sched = library._load_download_schedule()
    assert sched["start"] == "01:00"
    assert sched["end"] == "07:00"


def test_env_var_locks_window(monkeypatch):
    monkeypatch.setenv("ZIMI_DL_WINDOW", "02:00-04:00")
    sched = library._load_download_schedule()
    assert sched["enabled"] is True
    assert sched["start"] == "02:00"
    assert sched["end"] == "04:00"
    assert sched["locked"] is True
    # A locked window refuses persistence.
    assert library._save_download_schedule(False, "10:00", "12:00") is False


def test_env_var_malformed_ignored(monkeypatch):
    monkeypatch.setenv("ZIMI_DL_WINDOW", "notatime")
    assert library._load_download_schedule()["locked"] is False


# ────────────────────────────────────────────────────────────────────────────
# _within_download_window / _schedule_defers_now
# ────────────────────────────────────────────────────────────────────────────


def test_disabled_schedule_always_in_window():
    library._save_download_schedule(False, "01:00", "07:00")
    assert library._within_download_window(now_min=720) is True
    assert library._schedule_defers_now() is False


def test_enabled_outside_window_defers(monkeypatch):
    library._save_download_schedule(True, "01:00", "07:00")
    # Pin "now" to noon — outside the window.
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)
    assert library._within_download_window() is False
    assert library._schedule_defers_now() is True


def test_enabled_inside_window_does_not_defer(monkeypatch):
    library._save_download_schedule(True, "01:00", "07:00")
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 180)  # 03:00
    assert library._within_download_window() is True
    assert library._schedule_defers_now() is False


# ────────────────────────────────────────────────────────────────────────────
# Queue transitions
# ────────────────────────────────────────────────────────────────────────────


def test_outside_window_queues_as_scheduled(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    library._save_download_schedule(True, "01:00", "07:00")
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)  # noon
    dl_id, err = library._start_download(_kiwix_url("a"), size_bytes=100)
    assert err is None
    assert dl_id not in library._active_downloads
    assert len(library._download_queue) == 1
    assert library._download_queue[0]["scheduled"] is True


def test_inside_window_starts_immediately(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    library._save_download_schedule(True, "01:00", "07:00")
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 180)  # 03:00
    dl_id, err = library._start_download(_kiwix_url("a"), size_bytes=100)
    assert err is None
    assert dl_id in library._active_downloads
    assert len(library._download_queue) == 0


def test_scheduled_not_drained_outside_window(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    library._save_download_schedule(True, "01:00", "07:00")
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)
    library._start_download(_kiwix_url("a"), size_bytes=100)
    with library._download_lock:
        library._drain_queue()
    # Still parked — window is closed.
    assert len(library._download_queue) == 1
    assert len(library._active_downloads) == 0


def test_window_open_releases_scheduled(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    library._save_download_schedule(True, "01:00", "07:00")
    # Queue it while the window is closed…
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)
    library._start_download(_kiwix_url("a"), size_bytes=100)
    assert len(library._download_queue) == 1
    # …then the window opens and the watcher tick releases it.
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 180)
    library._download_schedule_tick()
    assert len(library._download_queue) == 0
    assert len(library._active_downloads) == 1


def test_tick_noop_outside_window(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    library._save_download_schedule(True, "01:00", "07:00")
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)
    library._start_download(_kiwix_url("a"), size_bytes=100)
    library._download_schedule_tick()  # still outside window
    assert len(library._download_queue) == 1


def test_scheduled_status_serialization(monkeypatch):
    library._save_download_schedule(True, "01:00", "07:00")
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 180)
    from zimi import p2p

    monkeypatch.setattr(p2p, "get_download_limit_kb", lambda: 300)
    monkeypatch.setattr(p2p, "is_bt_down_env_locked", lambda: False)
    st = library._download_schedule_status()
    assert st["enabled"] is True
    assert st["start"] == "01:00"
    assert st["in_window"] is True
    assert st["download_kb"] == 300
    assert st["download_kb_locked"] is False


def test_get_downloads_reports_scheduled(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    library._save_download_schedule(True, "01:00", "07:00")
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)
    library._start_download(_kiwix_url("a"), size_bytes=100)
    rows = library._get_downloads()
    queued = [r for r in rows if r.get("queued")]
    assert len(queued) == 1
    assert queued[0]["scheduled"] is True


# ────────────────────────────────────────────────────────────────────────────
# Start-now override (_start_scheduled_now)
# ────────────────────────────────────────────────────────────────────────────


def test_start_now_launches_scheduled_item(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    library._save_download_schedule(True, "01:00", "07:00")
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)  # outside
    dl_id, _ = library._start_download(_kiwix_url("a"), size_bytes=100)
    assert library._download_queue[0]["scheduled"] is True
    # Override the window for this one — still outside it.
    status, code = library._start_scheduled_now(dl_id)
    assert (status, code) == ("started", 200)
    assert dl_id in library._active_downloads
    assert len(library._download_queue) == 0


def test_start_now_at_cap_promotes_to_normal_queue(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "1")
    library._save_download_schedule(True, "01:00", "07:00")
    # One active (in-window start), one scheduled (outside window).
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 180)  # inside
    library._start_download(_kiwix_url("active"), size_bytes=100)
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)  # outside
    sid, _ = library._start_download(_kiwix_url("later"), size_bytes=200)
    assert library._download_queue[0]["scheduled"] is True
    # No free slot: start-now clears the scheduled flag but can't launch yet.
    status, code = library._start_scheduled_now(sid)
    assert (status, code) == ("queued", 200)
    assert "scheduled" not in library._download_queue[0]
    # It now drains on the next slot regardless of the window (not gated).
    monkeypatch.setattr(library, "_now_local_minutes", lambda: 720)
    with library._download_lock:
        library._active_downloads.clear()  # free the slot
        library._drain_queue()
    assert sid in library._active_downloads


def test_start_now_unknown_id_not_found():
    assert library._start_scheduled_now("nope") == ("not_found", 404)


def test_start_now_on_active_item_reports_already_active(_no_real_threads, monkeypatch):
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    library._save_download_schedule(False, "01:00", "07:00")  # off → starts active
    dl_id, _ = library._start_download(_kiwix_url("a"), size_bytes=100)
    assert dl_id in library._active_downloads
    assert library._start_scheduled_now(dl_id) == ("already_active", 200)
