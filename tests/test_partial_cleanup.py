"""classify_partials protects still-wanted .zim.tmp files and only offers
genuinely orphaned ones for cleanup.

Field report: after relaunching mid-download, Settings offered to "clean up" a
partial that was still wanted. The cleanup offer (disk.tmp_files) and the
/manage/cleanup-tmp handler both draw their delete set from classify_partials.
Protection is *state-based*: a partial is protected only when a download record
still wants it (active — including a failed-but-retryable download the UI shows
Retry for — queued, or pending-resume). A bare .zim.tmp with no matching record
is orphaned regardless of age, and stays cleanable.
"""

import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.server as server  # noqa: E402


@pytest.fixture
def _env(tmp_path, monkeypatch):
    zim_dir = tmp_path / "zims"
    zim_dir.mkdir()
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zim_dir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(data_dir))

    # Isolate the in-memory download state.
    lib._active_downloads.clear()
    lib._download_queue.clear()

    def _tmp(name, size, age_hours):
        p = zim_dir / name
        p.write_bytes(b"\x00" * size)
        past = time.time() - age_hours * 3600
        os.utime(p, (past, past))
        return name

    yield zim_dir, data_dir, _tmp

    lib._active_downloads.clear()
    lib._download_queue.clear()


def test_only_orphaned_partials_are_offered_for_cleanup(_env):
    zim_dir, data_dir, _tmp = _env

    # Protected — a download record still wants each of these:
    _tmp("active_en_2026-01.zim.tmp", 100, 0.1)
    _tmp("queued_en_2026-01.zim.tmp", 100, 0.1)
    _tmp("pending_en_2026-01.zim.tmp", 100, 0.1)
    _tmp("failed_en_2026-01.zim.tmp", 100, 0.1)  # done+error → Retry available
    # Orphaned — no matching record, cleanable regardless of age:
    _tmp("recent_en_2026-01.zim.tmp", 100, 1.0)  # young but no download record
    _tmp("stale_en_2026-01.zim.tmp", 100, 48.0)
    _tmp("empty_en_2026-01.zim.tmp", 0, 48.0)
    # Cancelled downloads disown their partial → orphaned.
    _tmp("cancelled_en_2026-01.zim.tmp", 100, 0.1)

    lib._active_downloads["1"] = {"filename": "active_en_2026-01.zim", "done": False}
    lib._active_downloads["2"] = {
        "filename": "failed_en_2026-01.zim",
        "done": True,
        "error": "All mirror(s) failed",
    }
    lib._active_downloads["3"] = {
        "filename": "cancelled_en_2026-01.zim",
        "done": True,
        "cancelled": True,
    }
    lib._download_queue.append({"filename": "queued_en_2026-01.zim"})
    (data_dir / "downloads.json").write_text(
        json.dumps({"pending": [{"filename": "pending_en_2026-01.zim"}]})
    )

    protected, orphaned = lib.classify_partials()
    prot = {p["filename"] for p in protected}
    orph = {o["filename"] for o in orphaned}

    assert prot == {
        "active_en_2026-01.zim.tmp",
        "queued_en_2026-01.zim.tmp",
        "pending_en_2026-01.zim.tmp",
        "failed_en_2026-01.zim.tmp",
    }
    assert orph == {
        "recent_en_2026-01.zim.tmp",
        "stale_en_2026-01.zim.tmp",
        "empty_en_2026-01.zim.tmp",
        "cancelled_en_2026-01.zim.tmp",
    }


def test_cleanup_removing_orphaned_leaves_protected_on_disk(_env):
    zim_dir, data_dir, _tmp = _env
    _tmp("active_en_2026-01.zim.tmp", 100, 0.1)
    _tmp("orphan_en_2026-01.zim.tmp", 100, 1.0)  # no record → orphaned

    lib._active_downloads["1"] = {"filename": "active_en_2026-01.zim", "done": False}

    _protected, orphaned = lib.classify_partials()
    # Simulate the cleanup handler: it deletes exactly the orphaned set.
    for info in orphaned:
        os.remove(os.path.join(str(zim_dir), info["filename"]))

    assert (zim_dir / "active_en_2026-01.zim.tmp").exists()
    assert not (zim_dir / "orphan_en_2026-01.zim.tmp").exists()
