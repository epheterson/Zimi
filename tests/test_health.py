"""Library health report — per-ZIM integrity check over real fixture ZIMs."""

import os
import sys
import time

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
import zimi.server as server  # noqa: E402
import zimi.health as health  # noqa: E402


def _setup(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "survival_en_2026-06.zim"))
    # Known-broken case: a tiny, non-openable "ZIM".
    (zdir / "broken_en_2026-06.zim").write_bytes(b"\0" * 512)
    ddir = tmp_path / "data"
    ddir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(ddir))
    server._archive_pool.clear()
    server.load_cache(force=True)
    return zdir


def _run_check():
    started, _ = health.start_check()
    assert started
    for _ in range(200):
        st = health.get_state()
        if st["phase"] in ("done", "error"):
            return st
        time.sleep(0.02)
    raise AssertionError("health check did not finish")


def test_stray_torrent_metadata_flagged_distinctly(tmp_path, monkeypatch):
    """An aria2-era leftover ``<name>.zim.torrent`` in ZIM_DIR is bencoded
    metadata, not a ZIM. It must surface as a distinct info row (kind
    'torrent_meta'), never as a broken ZIM, and be counted in
    summary['torrent_files'] (#38)."""
    zdir = _setup(tmp_path, monkeypatch)
    (zdir / "devdocs_en_markdown_2026-07.zim.torrent").write_bytes(b"d4:infod")
    st = _run_check()
    rows = {r["name"]: r for r in st["report"]}
    stray = rows["devdocs_en_markdown_2026-07.zim.torrent"]
    assert stray["kind"] == "torrent_meta"
    assert stray["status"] == "info"
    assert stray["opens"] is False
    assert st["summary"]["torrent_files"] == 1
    # Never counted as a broken ZIM.
    assert st["summary"]["total"] == 2  # survival + broken, torrent excluded
    assert "devdocs_en_markdown_2026-07.zim.torrent" not in {
        r["name"] for r in st["report"] if r.get("status") == "warn"
    }


def test_report_flags_broken_and_healthy(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    st = _run_check()
    assert st["phase"] == "done"
    rows = {r["name"]: r for r in st["report"]}

    good = rows["survival"]
    assert good["opens"] is True
    assert good["has_main"] is True
    assert good["entries"] and good["entries"] > 0
    assert good["status"] == "ok"

    bad = rows["broken"]
    assert bad["opens"] is False
    assert bad["status"] == "warn"
    assert bad["issues"]

    assert st["summary"]["total"] == 2
    assert st["summary"]["healthy"] == 1
    assert st["summary"]["warnings"] == 1


def test_second_start_is_rejected_while_running(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    # Occupy the lock to simulate an in-flight run.
    assert health._lock.acquire(blocking=False)
    try:
        started, msg = health.start_check()
        assert started is False
        assert "running" in msg
    finally:
        health._lock.release()
