"""Tests for the download queue.

Concurrent downloads cap at MAX_CONCURRENT_DOWNLOADS (default 3,
overridable via ZIMI_MAX_CONCURRENT_DOWNLOADS). Extras queue and
dispatch smallest-first as slots free up.
"""

import os
import sys

import pytest

# Ensure repo root on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Direct module imports avoid the zimi/__init__.py proxy that delegates
# attribute access to zimi.server.
import zimi.library as library  # noqa: E402
import zimi.server as server  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_library_state(tmp_path, monkeypatch):
    """Reset queue + active state and stub out file-system pre-checks each test."""
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))

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
    """Replace Thread so download threads never actually run."""
    started = []

    class _FakeThread:
        def __init__(self, target=None, args=(), kwargs=None, daemon=None):
            self.target = target
            self.args = args
            self.kwargs = kwargs or {}

        def start(self):
            started.append(self)

    monkeypatch.setattr(library.threading, "Thread", _FakeThread)
    return started


@pytest.fixture
def _no_mirrors(monkeypatch):
    """_fetch_mirrors does network IO. Make it a no-op."""
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])


def _kiwix_url(name):
    return f"https://download.kiwix.org/zim/{name}.zim"


# ────────────────────────────────────────────────────────────────────────────
# _max_concurrent
# ────────────────────────────────────────────────────────────────────────────


def test_default_max_concurrent_is_3(monkeypatch):
    monkeypatch.delenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", raising=False)
    from zimi import library

    assert library._max_concurrent() == 3


def test_env_var_overrides_max_concurrent(monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "7")
    from zimi import library

    assert library._max_concurrent() == 7


def test_env_var_invalid_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "not-a-number")
    from zimi import library

    assert library._max_concurrent() == library._MAX_CONCURRENT_DEFAULT


def test_env_var_zero_clamps_to_one(monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "0")
    from zimi import library

    assert library._max_concurrent() == 1


# ────────────────────────────────────────────────────────────────────────────
# Cap & queueing
# ────────────────────────────────────────────────────────────────────────────


def test_under_cap_starts_immediately(_no_real_threads, _no_mirrors, monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "3")
    from zimi import library

    dl_id, err = library._start_download(_kiwix_url("a"), size_bytes=100)
    assert err is None
    assert dl_id in library._active_downloads
    assert len(library._download_queue) == 0


def test_at_cap_queues_extras(_no_real_threads, _no_mirrors, monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "2")
    from zimi import library

    library._start_download(_kiwix_url("a"), size_bytes=100)
    library._start_download(_kiwix_url("b"), size_bytes=200)
    qid, err = library._start_download(_kiwix_url("c"), size_bytes=300)
    assert err is None

    assert len(library._active_downloads) == 2
    assert len(library._download_queue) == 1
    assert library._download_queue[0]["id"] == qid


def test_queue_orders_smallest_first(_no_real_threads, _no_mirrors, monkeypatch):
    """When the cap is full, queued items are sorted smallest-first."""
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "1")
    from zimi import library

    # Fill the active slot
    library._start_download(_kiwix_url("active"), size_bytes=1)
    # Now queue 4 with sizes [10G, 100M, 5G, 500M]
    big = library._start_download(_kiwix_url("big"), size_bytes=10 * 10**9)[0]
    small = library._start_download(_kiwix_url("small"), size_bytes=100 * 10**6)[0]
    medium_big = library._start_download(_kiwix_url("midbig"), size_bytes=5 * 10**9)[0]
    medium_small = library._start_download(
        _kiwix_url("midsmall"), size_bytes=500 * 10**6
    )[0]

    queue_ids = [q["id"] for q in library._download_queue]
    assert queue_ids == [small, medium_small, medium_big, big]


def test_unknown_size_sorts_to_back(_no_real_threads, _no_mirrors, monkeypatch):
    """Items without a known size are dispatched after sized items."""
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "1")
    from zimi import library

    library._start_download(_kiwix_url("active"))
    unknown_id = library._start_download(_kiwix_url("unknown"))[0]
    sized_id = library._start_download(_kiwix_url("sized"), size_bytes=100)[0]

    queue_ids = [q["id"] for q in library._download_queue]
    assert queue_ids == [sized_id, unknown_id]


# ────────────────────────────────────────────────────────────────────────────
# Drain on completion
# ────────────────────────────────────────────────────────────────────────────


def test_completion_drains_queue(_no_real_threads, _no_mirrors, monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "1")
    from zimi import library

    a = library._start_download(_kiwix_url("a"), size_bytes=100)[0]
    b = library._start_download(_kiwix_url("b"), size_bytes=200)[0]

    assert a in library._active_downloads
    assert len(library._download_queue) == 1

    # Mark active item as done and trigger drain
    library._active_downloads[a]["done"] = True
    library._drain_queue()

    assert b in library._active_downloads
    assert len(library._download_queue) == 0


def test_drain_respects_cap(_no_real_threads, _no_mirrors, monkeypatch):
    """Drain only promotes as many items as the cap allows."""
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "2")
    from zimi import library

    library._start_download(_kiwix_url("a"), size_bytes=100)
    library._start_download(_kiwix_url("b"), size_bytes=200)
    library._start_download(_kiwix_url("c"), size_bytes=300)
    library._start_download(_kiwix_url("d"), size_bytes=400)

    assert len(library._active_downloads) == 2
    assert len(library._download_queue) == 2

    # Complete one — drain should promote exactly one
    next(iter(library._active_downloads.values()))["done"] = True
    library._drain_queue()

    not_done = [d for d in library._active_downloads.values() if not d.get("done")]
    assert len(not_done) == 2
    assert len(library._download_queue) == 1


def test_drain_with_empty_queue_is_noop(_no_real_threads, _no_mirrors):
    from zimi import library

    library._drain_queue()  # must not raise
    assert library._download_queue == []


# ────────────────────────────────────────────────────────────────────────────
# Visibility through the existing status endpoint
# ────────────────────────────────────────────────────────────────────────────


def test_get_downloads_includes_queue(_no_real_threads, _no_mirrors, monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "1")
    from zimi import library

    library._start_download(_kiwix_url("a"), size_bytes=100)
    library._start_download(_kiwix_url("b"), size_bytes=200)

    statuses = library._get_downloads()
    queued = [s for s in statuses if s.get("queued")]
    active = [s for s in statuses if not s.get("queued")]

    assert len(active) == 1
    assert len(queued) == 1
    assert queued[0]["filename"] == "b.zim"
    # Queued items report 0% and 0 bytes downloaded
    assert queued[0]["percent"] == 0
    assert queued[0]["downloaded_bytes"] == 0


# ────────────────────────────────────────────────────────────────────────────
# Cancellation while queued
# ────────────────────────────────────────────────────────────────────────────


def test_cancel_removes_queued_item(_no_real_threads, _no_mirrors, monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "1")
    from zimi import library

    library._start_download(_kiwix_url("a"), size_bytes=100)
    qid, _ = library._start_download(_kiwix_url("b"), size_bytes=200)

    library._cancel_download(qid)

    assert qid not in library._active_downloads
    assert all(q["id"] != qid for q in library._download_queue)
