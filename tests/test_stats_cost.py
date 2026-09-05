"""/manage/stats must be cheap by default.

Three UI panes fetch it — two of them only want disk paths or the partial
download list — and the per-index walk it used to do unconditionally opens
every title index on disk. On a Pi with a spun-down drive that is seconds of
work per poll. The full report is now opt-in (?detail=1), and the disk figures
are memoized briefly because every caller re-derives the same gigabyte-rounded
numbers from a getsize() over the whole library. The partials list is
deliberately left out of the memo — it is cheap and it changes the moment a
download starts.
"""

import os
import sys
import time
from unittest import mock
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.http as http  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402

_BRIEF = {"state": "idle", "ready": 3, "total": 3, "building_now": None, "errors": []}
_FULL = dict(_BRIEF, indexes=[{"name": "wikipedia", "size_mb": 12.0}], index_count=1)


@pytest.fixture
def stats_env(monkeypatch):
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_manage_auth_challenge", lambda h: None)
    monkeypatch.setattr(server, "_get_metrics", lambda: {})
    monkeypatch.setattr(server, "_get_disk_usage", lambda: {})
    return monkeypatch


def _stats(params=None):
    h = MagicMock()
    captured = {}

    def _json(status, payload):
        captured["status"] = status
        captured["payload"] = payload

    h._json = _json
    parsed = MagicMock()
    parsed.path = "/manage/stats"
    manage.handle_manage_get(h, parsed, params or {})
    return captured["status"], captured["payload"]


def test_default_uses_the_brief_snapshot(stats_env):
    with (
        mock.patch.object(
            server, "_get_title_index_status_brief", return_value=_BRIEF
        ) as brief,
        mock.patch.object(server, "_get_title_index_stats") as full,
    ):
        status, body = _stats()
    assert status == 200
    brief.assert_called_once()
    full.assert_not_called()
    assert "indexes" not in body["title_index"]


def test_detail_opts_into_the_full_walk(stats_env):
    with (
        mock.patch.object(server, "_get_title_index_status_brief") as brief,
        mock.patch.object(server, "_get_title_index_stats", return_value=_FULL) as full,
    ):
        status, body = _stats({"detail": ["1"]})
    assert status == 200
    full.assert_called_once()
    brief.assert_not_called()
    assert body["title_index"]["indexes"]


@pytest.mark.parametrize("params", [{"detail": ["0"]}, {"detail": [""]}, {}])
def test_only_detail_1_opts_in(stats_env, params):
    with (
        mock.patch.object(server, "_get_title_index_status_brief", return_value=_BRIEF),
        mock.patch.object(server, "_get_title_index_stats") as full,
    ):
        _stats(params)
    full.assert_not_called()


# ---------------------------------------------------------------------------
# Disk usage memoization
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_disk_cache():
    http._reset_disk_usage_cache()
    yield
    http._reset_disk_usage_cache()


def test_disk_usage_is_memoized(monkeypatch):
    calls = []
    monkeypatch.setattr(
        http, "_read_disk_space", lambda: (calls.append(1), {"n": 1})[1]
    )
    assert http._get_disk_usage()["n"] == 1
    for _ in range(20):
        http._get_disk_usage()
    assert len(calls) == 1  # 21 reports, one walk


def test_memo_expires(monkeypatch):
    calls = []
    monkeypatch.setattr(
        http, "_read_disk_space", lambda: (calls.append(1), {"n": 1})[1]
    )
    http._get_disk_usage()
    # Rewind the stamp past the TTL rather than sleeping through it.
    zim_dir, stamp, payload = http._disk_usage_cache
    http._disk_usage_cache = (zim_dir, stamp - http._DISK_USAGE_TTL - 1, payload)
    http._get_disk_usage()
    assert len(calls) == 2


def test_reset_forces_a_recompute(monkeypatch):
    """Deleting a ZIM changes the numbers — the pane must not keep showing
    pre-delete free space for the rest of the memo window."""
    calls = []
    monkeypatch.setattr(
        http, "_read_disk_space", lambda: (calls.append(1), {"n": 1})[1]
    )
    http._get_disk_usage()
    http._reset_disk_usage_cache()
    http._get_disk_usage()
    assert len(calls) == 2


def test_an_empty_reading_is_still_cached(monkeypatch):
    """{} is what a failed stat returns. Caching it matters most: the failure
    path is the slow one (a stalled mount), and re-probing it every poll is
    how a UI freezes. The whole report stays {} — the old contract."""
    calls = []
    monkeypatch.setattr(http, "_read_disk_space", lambda: (calls.append(1), {})[1])
    assert http._get_disk_usage() == {}
    assert http._get_disk_usage() == {}
    assert len(calls) == 1


def test_real_disk_usage_still_reports(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    with open(os.path.join(str(tmp_path), "a.zim"), "wb") as f:
        f.write(b"x" * 1024)
    usage = http._get_disk_usage()
    assert usage["zim_dir"] == str(tmp_path)
    assert usage["disk_total_gb"] > 0
    assert usage["tmp_files"] == []
    assert time.time() - http._disk_usage_cache[1] < http._DISK_USAGE_TTL

    # A partial that appears after the space figures were memoized still shows
    # up immediately — that list is never cached.
    with open(os.path.join(str(tmp_path), "b.zim.tmp"), "wb") as f:
        f.write(b"x" * 32)
    assert [t["filename"] for t in http._get_disk_usage()["tmp_files"]] == ["b.zim.tmp"]


def test_pointing_at_another_folder_recomputes(tmp_path, monkeypatch):
    """The desktop folder picker can move ZIM_DIR under a running server.
    Reporting the previous drive's free space would be a plain wrong number."""
    calls = []
    monkeypatch.setattr(http, "_read_disk_space", lambda: (calls.append(1), {})[1])
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    http._get_disk_usage()
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path / "elsewhere"))
    http._get_disk_usage()
    assert len(calls) == 2
