"""Handler-level tests for /manage/seeding honesty (v1.7.2).

Errored or file-missing seeds must be SHOWN (snag field), not hidden,
and must not pollute the traffic totals.
"""

import os
import sys
import types
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.p2p as p2p  # noqa: E402
import zimi.server as server  # noqa: E402


class _Handler:
    def __init__(self):
        self.status = None
        self.body = None
        self.headers = {}

    def _json(self, status, body):
        self.status = status
        self.body = body

    def _is_private_client(self):
        return True


class _Backend:
    def __init__(self, managed):
        self.managed = managed

    def list_managed(self):
        return self.managed


def _call_seeding(monkeypatch, managed, tmp_path):
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: True)
    monkeypatch.setattr(p2p, "peek_backend", lambda: _Backend(managed))
    h = _Handler()
    manage.handle_manage_get(h, urlparse("/manage/seeding"), {})
    assert h.status == 200
    return h.body


def test_snagged_seeds_are_shown_not_hidden(tmp_path, monkeypatch):
    healthy = tmp_path / "good_2026-06.zim"
    healthy.write_bytes(b"x" * 10)
    managed = [
        {
            "gid": "g-ok",
            "status": "active",
            "files": [{"path": str(healthy)}],
            "completedLength": "100",
            "uploadLength": "50",
            "connections": "3",
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "infoHash": "aa",
        },
        {
            "gid": "g-err",
            "status": "error",
            "errorMessage": "tracker exploded",
            "files": [{"path": str(tmp_path / "bad_2026-06.zim")}],
            "completedLength": "100",
            "uploadLength": "70",
            "connections": "0",
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "infoHash": "bb",
        },
        {
            "gid": "g-gone",
            "status": "active",
            "files": [{"path": str(tmp_path / "vanished_2026-06.zim")}],
            "completedLength": "100",
            "uploadLength": "10",
            "connections": "0",
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "infoHash": "cc",
        },
    ]
    body = _call_seeding(monkeypatch, managed, tmp_path)
    by_gid = {t["id"]: t for t in body["torrents"]}
    assert len(by_gid) == 3, "snagged seeds must be listed, not hidden"
    assert by_gid["g-ok"]["snag"] == ""
    assert by_gid["g-err"]["snag"] == "tracker exploded"
    assert by_gid["g-gone"]["snag"] == "file missing"
    # Totals count only the healthy seed
    assert body["totals"]["uploaded"] == 100 * 0 + 50
    assert body["totals"]["downloaded"] == 100


def test_inflight_download_not_listed_as_seed(tmp_path, monkeypatch):
    """list_managed() includes downloading torrents; the seeding view must
    exclude a .zim that's still downloading, or it double-cards against the
    Downloads tab (the 'showed up twice' bug)."""
    downloading = tmp_path / "gutenberg_en_all_2026-07.zim"
    downloading.write_bytes(b"x" * 5)
    seeding = tmp_path / "wikipedia_en_2026-06.zim"
    seeding.write_bytes(b"x" * 10)
    managed = [
        {
            "gid": "g-dl",
            "status": "active",
            "files": [{"path": str(downloading)}],
            "completedLength": "40",
            "totalLength": "100",  # half done — a download, not a seed
            "uploadLength": "0",
            "connections": "2",
            "downloadSpeed": "500",
            "uploadSpeed": "0",
            "seeder": "false",
            "infoHash": "dd",
        },
        {
            "gid": "g-seed",
            "status": "active",
            "files": [{"path": str(seeding)}],
            "completedLength": "100",
            "totalLength": "100",
            "uploadLength": "50",
            "connections": "3",
            "downloadSpeed": "0",
            "uploadSpeed": "200",
            "seeder": "true",
            "infoHash": "ee",
        },
    ]
    body = _call_seeding(monkeypatch, managed, tmp_path)
    ids = {t["id"] for t in body["torrents"]}
    assert ids == {"g-seed"}, "in-flight download must not appear as a seed"


def test_seed_reports_uploaded_and_cap_goal(tmp_path, monkeypatch):
    """Per-seed payload carries lifetime uploaded + the cap goal (cap x size)
    so the panel can render 'X of Y'. Personal (non-mirror) seed."""
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    seeding = tmp_path / "wikipedia_en_2026-06.zim"
    seeding.write_bytes(b"x" * 10)
    managed = [
        {
            "gid": "g-seed",
            "status": "active",
            "files": [{"path": str(seeding)}],
            "completedLength": "1000",
            "totalLength": "1000",
            "uploadLength": "600",
            "connections": "3",
            "seeder": "true",
            "infoHash": "ee",
        }
    ]
    body = _call_seeding(monkeypatch, managed, tmp_path)
    assert body["mirror"] is False
    t = body["torrents"][0]
    assert t["file_size_bytes"] == 1000
    assert t["cumulative_uploaded_bytes"] == 600  # no ledger → session upload
    assert t["cap_bytes"] == 2000  # 2.0 x 1000
    assert t["mirror"] is False


def test_mirror_seed_has_no_cap(tmp_path, monkeypatch):
    """Mirror mode lifts the cap: cap_bytes is 0 and mirror flag is set."""
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: True)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    seeding = tmp_path / "wikipedia_en_2026-06.zim"
    seeding.write_bytes(b"x" * 10)
    managed = [
        {
            "gid": "g-mirror",
            "status": "active",
            "files": [{"path": str(seeding)}],
            "completedLength": "1000",
            "totalLength": "1000",
            "uploadLength": "5000",
            "connections": "9",
            "seeder": "true",
            "infoHash": "ff",
        }
    ]
    body = _call_seeding(monkeypatch, managed, tmp_path)
    assert body["mirror"] is True
    t = body["torrents"][0]
    assert t["cap_bytes"] == 0
    assert t["mirror"] is True
    assert t["cumulative_uploaded_bytes"] == 5000


def test_seed_cumulative_prefers_ledger(tmp_path, monkeypatch):
    """Cumulative upload comes from the ledger (survives restarts) when it
    exceeds the current session's uploadLength."""
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    from zimi import library as _lib

    monkeypatch.setattr(
        _lib,
        "seed_ledger_snapshot",
        lambda: {"wikipedia_en_2026-06.zim": {"uploaded": 9000, "origin": "download"}},
    )
    seeding = tmp_path / "wikipedia_en_2026-06.zim"
    seeding.write_bytes(b"x" * 10)
    managed = [
        {
            "gid": "g-seed",
            "status": "active",
            "files": [{"path": str(seeding)}],
            "completedLength": "1000",
            "totalLength": "1000",
            "uploadLength": "600",  # this session only
            "connections": "1",
            "seeder": "true",
            "infoHash": "gg",
        }
    ]
    body = _call_seeding(monkeypatch, managed, tmp_path)
    t = body["torrents"][0]
    assert t["cumulative_uploaded_bytes"] == 9000  # ledger wins over session


def test_seed_age_comes_from_ledger_intent(tmp_path, monkeypatch):
    """The seed card's age line uses the ledger's `added` intent timestamp;
    a seed with no ledger entry reports 0 so the client hides the age."""
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 2.0)
    from zimi import library as _lib

    monkeypatch.setattr(
        _lib,
        "seed_ledger_snapshot",
        lambda: {
            "wikipedia_en_2026-06.zim": {
                "uploaded": 0,
                "origin": "download",
                "added": 1753000000.7,
            }
        },
    )
    ledgered = tmp_path / "wikipedia_en_2026-06.zim"
    ledgered.write_bytes(b"x" * 10)
    unledgered = tmp_path / "wiktionary_fr_2026-06.zim"
    unledgered.write_bytes(b"x" * 10)
    row = {
        "status": "active",
        "completedLength": "1000",
        "totalLength": "1000",
        "uploadLength": "0",
        "connections": "0",
        "seeder": "true",
    }
    managed = [
        dict(row, gid="g-led", files=[{"path": str(ledgered)}], infoHash="aa"),
        dict(row, gid="g-raw", files=[{"path": str(unledgered)}], infoHash="bb"),
    ]
    body = _call_seeding(monkeypatch, managed, tmp_path)
    by_gid = {t["id"]: t for t in body["torrents"]}
    assert by_gid["g-led"]["added"] == 1753000000  # int() of the ledger float
    assert by_gid["g-raw"]["added"] == 0
