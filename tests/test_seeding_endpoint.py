"""Handler-level tests for /manage/seeding honesty (v1.7.2).

Errored or file-missing seeds must be SHOWN (snag field), not hidden,
and must not pollute the traffic totals. purge_stopped keeps errored
results visible while clearing finished ones.
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


def test_purge_stopped_keeps_errors_visible(monkeypatch):
    calls = []

    backend = p2p.Aria2Backend.__new__(p2p.Aria2Backend)

    def fake_rpc(method, params, timeout=5.0):
        calls.append((method, params))
        if method == "aria2.tellStopped":
            return [
                {"gid": "g-done", "status": "complete"},
                {"gid": "g-err", "status": "error"},
                {"gid": "g-removed", "status": "removed"},
            ]
        return None

    backend._rpc = fake_rpc
    backend.purge_stopped()
    removed = [p[0] for m, p in calls if m == "aria2.removeDownloadResult"]
    assert removed == ["g-done", "g-removed"], "errored result must stay visible"
