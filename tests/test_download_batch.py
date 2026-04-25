"""Tests for /manage/download-batch (W2.2).

Backend half of multi-select downloads. UI half is in W3.1.
"""

import json
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    with library._download_lock:
        library._active_downloads.clear()
        library._download_queue.clear()
        library._download_counter = 0
    # Skip auth gate
    monkeypatch.setattr(manage, "_check_manage_auth", lambda h: None)

    # No real threads
    class _FakeThread:
        def __init__(self, *a, **k):
            pass

        def start(self):
            pass

    monkeypatch.setattr(library.threading, "Thread", _FakeThread)
    monkeypatch.setattr(library, "_fetch_mirrors", lambda url: [])
    yield


def _fake_handler():
    """Minimal stand-in for ZimHandler with the bits the manage module touches."""
    h = MagicMock()
    captured = {}

    def _json(status, payload):
        captured["status"] = status
        captured["payload"] = payload
        return None

    h._json = _json
    h._captured = captured
    return h


def _post(path, body):
    h = _fake_handler()
    parsed = MagicMock()
    parsed.path = path
    manage.handle_manage_post(h, parsed, body)
    return h._captured["status"], h._captured["payload"]


def _kiwix(name):
    return f"https://download.kiwix.org/zim/{name}.zim"


# ────────────────────────────────────────────────────────────────────────────


def test_batch_returns_id_per_url():
    status, body = _post(
        "/manage/download-batch",
        {"urls": [_kiwix("a"), _kiwix("b"), _kiwix("c")]},
    )
    assert status == 200
    assert len(body["ids"]) == 3
    assert all(i is not None for i in body["ids"])
    assert body["started"] == 3


def test_batch_partial_failures_reported():
    status, body = _post(
        "/manage/download-batch",
        {"urls": [_kiwix("good"), "ftp://nope.example.com/file.zim"]},
    )
    assert status == 200
    assert body["ids"][0] is not None
    assert body["ids"][1] is None
    assert body["errors"][0] is None
    assert body["errors"][1] is not None
    assert body["started"] == 1


def test_batch_empty_array():
    status, body = _post("/manage/download-batch", {"urls": []})
    assert status == 200
    assert body["ids"] == []
    assert body["errors"] == []
    assert body["started"] == 0


def test_batch_missing_urls_returns_400():
    status, body = _post("/manage/download-batch", {})
    assert status == 400
    assert "urls" in body["error"]


def test_batch_invalid_entry_continues():
    status, body = _post(
        "/manage/download-batch",
        {"urls": [_kiwix("ok"), "", 42, _kiwix("ok2")]},
    )
    assert status == 200
    assert body["ids"][0] is not None
    assert body["ids"][1] is None
    assert body["ids"][2] is None
    assert body["ids"][3] is not None


def test_batch_passes_sizes_for_queue_ordering(monkeypatch):
    """Sizes flow through to the queue so ordering is correct."""
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "1")
    status, body = _post(
        "/manage/download-batch",
        {
            "urls": [_kiwix("active"), _kiwix("big"), _kiwix("small")],
            "sizes": [1, 10_000_000_000, 100_000],
        },
    )
    assert status == 200
    # First call took the active slot; remaining two queued, smallest first
    assert len(library._download_queue) == 2
    assert library._download_queue[0]["filename"] == "small.zim"
    assert library._download_queue[1]["filename"] == "big.zim"


def test_batch_non_list_urls_returns_400():
    status, body = _post("/manage/download-batch", {"urls": "not-a-list"})
    assert status == 400
