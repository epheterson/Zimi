"""Library health report — per-ZIM integrity check over real fixture ZIMs."""

import os
import sys
import time

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import (  # noqa: E402
    build_empty_text_fixture_zim,
    build_fixture_zim,
    build_media_fixture_zim,
)
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


def test_zero_byte_media_entry_flagged(tmp_path, monkeypatch):
    """A ZIM that opens fine and has entries can still ship broken media — a
    0-byte video the count and size-vs-catalog checks never see. The media
    sampler must count it and flag the ZIM (issue #38 follow-up: the shape of
    ted_en_technology_2023-09)."""
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_media_fixture_zim(str(zdir / "talks_en_2026-06.zim"))
    ddir = tmp_path / "data"
    ddir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(ddir))
    server._archive_pool.clear()
    server.load_cache(force=True)

    st = _run_check()
    row = {r["name"]: r for r in st["report"]}["talks"]
    assert row["opens"] is True
    assert row["media_sampled"] == 2  # one real + one empty
    assert row["media_empty"] == 1
    assert row["status"] == "warn"
    assert any("empty" in i and "0-byte" in i for i in row["issues"])
    assert "videos/2/video.webm" in (row.get("media_examples") or [])


def test_healthy_media_not_flagged(tmp_path, monkeypatch):
    """A ZIM whose media all carry bytes stays healthy — the sampler counts
    them but raises no issue and never demotes an otherwise-clean ZIM."""
    zdir = tmp_path / "zims"
    zdir.mkdir()
    # Rebuild with both videos non-empty by writing a second real-media ZIM.
    from conftest_zim import _Article, _MediaItem, _StringProvider  # noqa: F401
    from libzim.writer import Creator

    p = str(zdir / "goodtalks_en_2026-06.zim")
    with Creator(p).config_indexing(True, "eng") as creator:
        creator.set_mainpath("A/Talks")
        creator.add_item(_Article("A/Talks", "Talks", b"<html><body>ok</body></html>"))
        creator.add_item(_MediaItem("videos/1/video.webm", "video/webm", b"realbytes1"))
        creator.add_item(_MediaItem("videos/2/video.webm", "video/webm", b"realbytes2"))
        creator.add_metadata("Title", "Good Talks")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Description", "media fixture")
    ddir = tmp_path / "data"
    ddir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(ddir))
    server._archive_pool.clear()
    server.load_cache(force=True)

    st = _run_check()
    row = {r["name"]: r for r in st["report"]}["goodtalks"]
    assert row["media_sampled"] == 2
    assert row["media_empty"] == 0
    assert row["status"] == "ok"
    assert not row["issues"]


def test_empty_articles_flagged_without_media(tmp_path, monkeypatch):
    """A ZIM that opens, has entries, and carries no media can still be a broken
    scrape — every article a 0-byte shell. The universal text-sanity sampler
    must catch it (the media sampler never fires here) and demote it to warn."""
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_empty_text_fixture_zim(str(zdir / "empties_en_2026-06.zim"))
    ddir = tmp_path / "data"
    ddir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(ddir))
    server._archive_pool.clear()
    server.load_cache(force=True)

    st = _run_check()
    row = {r["name"]: r for r in st["report"]}["empties"]
    assert row["opens"] is True
    assert row["entries"] and row["entries"] > 0
    assert row["text_sampled"] and row["text_sampled"] > 0
    assert row["text_empty"] == row["text_sampled"]
    assert row["media_sampled"] is None  # no media entries at all
    assert row["status"] == "warn"
    assert any("articles empty" in i for i in row["issues"])


def test_healthy_text_not_flagged(tmp_path, monkeypatch):
    """The text-sanity sampler must never demote a normal content ZIM: the
    survival fixture's articles all carry bytes, so it stays healthy."""
    _setup(tmp_path, monkeypatch)
    st = _run_check()
    good = {r["name"]: r for r in st["report"]}["survival"]
    assert good["text_sampled"] and good["text_sampled"] > 0
    assert good["text_empty"] == 0
    assert good["status"] == "ok"
    assert not good["issues"]


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
