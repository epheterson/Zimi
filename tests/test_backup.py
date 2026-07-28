"""Handler-level tests for the backup & export hub (v1.8.1).

Covers the server half of a backup bundle: `_build_backup_bundle` (export
shape) and the `/manage/backup` POST importer that restores collections
(whole-doc replace) and the home library layout. Per-browser state
(bookmarks/history/preferences) is client-only and never reaches the server,
so it isn't exercised here.
"""

import os
import sys
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402


class _Handler:
    def __init__(self, private=True, auth=None):
        self.status = None
        self.body = None
        self._private = private
        self.headers = {}
        if auth is not None:
            self.headers["Authorization"] = auth

    def _json(self, status, body):
        self.status = status
        self.body = body
        return None

    def _is_private_client(self):
        return self._private


def _setup(monkeypatch, tmp_path, *, password_hash="", private=True):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(data_dir))
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: password_hash)
    monkeypatch.setattr(manage, "_get_api_token", lambda: "")
    # No ZIMs on disk in these tests — keep the library list empty + fast.
    monkeypatch.setattr(server, "list_zims", lambda: [])
    return data_dir


def _post(handler, body):
    manage.handle_manage_post(handler, urlparse("/manage/backup"), body)
    return handler.status, handler.body


# ── Export shape ──


def test_build_bundle_shape(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    bundle = manage._build_backup_bundle()
    assert bundle["schema"] == "zimi-backup"
    assert bundle["schema_version"] == manage._BACKUP_SCHEMA_VERSION
    assert bundle["library"] == []
    assert bundle["collections"] == {"version": 1, "favorites": [], "collections": {}}
    assert bundle["library_layout"] == {"overrides": {}, "section_order": []}
    assert "created" in bundle and "zimi_version" in bundle


def test_build_bundle_lists_installed_library(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(
        server,
        "list_zims",
        lambda: [
            {
                "name": "wikipedia_en",
                "file": "wikipedia_en_2026-01.zim",
                "date": "2026-01",
                "language": "eng",
                "article_count": 100,
                "size_bytes": 999,
                "title": "Wikipedia",
            }
        ],
    )
    lib = manage._build_backup_bundle()["library"]
    assert lib == [
        {
            "name": "wikipedia_en",
            "file": "wikipedia_en_2026-01.zim",
            "date": "2026-01",
            "language": "eng",
            "article_count": 100,
            "size_bytes": 999,
            "title": "Wikipedia",
        }
    ]


# ── Import round-trips ──


def test_import_restores_collections(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    bundle = {
        "schema": "zimi-backup",
        "collections": {
            "version": 1,
            "favorites": ["wikipedia_en"],
            "collections": {"survival": {"label": "Survival", "zims": ["a", "b"]}},
        },
    }
    status, body = _post(_Handler(), bundle)
    assert status == 200
    assert "collections" in body["applied"]
    saved = server._load_collections()
    assert saved["favorites"] == ["wikipedia_en"]
    assert saved["collections"]["survival"]["zims"] == ["a", "b"]


def test_import_restores_layout(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    bundle = {
        "schema": "zimi-backup",
        "library_layout": {
            "overrides": {"wikipedia_en": "Books"},
            "section_order": ["cat:Books"],
        },
    }
    status, body = _post(_Handler(), bundle)
    assert status == 200
    assert "library_layout" in body["applied"]
    layout = server._load_library_layout()
    assert layout["overrides"] == {"wikipedia_en": "Books"}
    assert layout["section_order"] == ["cat:Books"]


def test_import_is_whole_doc_replace_for_collections(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    # Seed an existing favorite that the import must overwrite, not merge.
    server._save_collections({"version": 1, "favorites": ["old"], "collections": {}})
    _post(
        _Handler(),
        {
            "schema": "zimi-backup",
            "collections": {"version": 1, "favorites": ["new"], "collections": {}},
        },
    )
    assert server._load_collections()["favorites"] == ["new"]


def test_import_partial_bundle_applies_only_present(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, body = _post(
        _Handler(),
        {"schema": "zimi-backup", "library_layout": {"overrides": {"a": "Books"}}},
    )
    assert status == 200
    assert body["applied"] == ["library_layout"]


def test_import_empty_bundle_ok_noop(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, body = _post(_Handler(), {"schema": "zimi-backup"})
    assert status == 200
    assert body["applied"] == []


# ── Validation ──


def test_import_rejects_foreign_schema(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, body = _post(_Handler(), {"schema": "something-else"})
    assert status == 400


def test_import_rejects_bad_collections(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, _ = _post(
        _Handler(), {"schema": "zimi-backup", "collections": {"favorites": "nope"}}
    )
    assert status == 400


def test_import_rejects_bad_layout(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, _ = _post(
        _Handler(),
        {"schema": "zimi-backup", "library_layout": {"section_order": ["bogus:x"]}},
    )
    assert status == 400


def test_import_favorites_capped(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _post(
        _Handler(),
        {
            "schema": "zimi-backup",
            "collections": {
                "version": 1,
                "favorites": [str(i) for i in range(200)],
                "collections": {},
            },
        },
    )
    assert len(server._load_collections()["favorites"]) == 100


# ── Auth matrix (mirrors library-layout) ──


def test_import_passwordless_public_locked(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path, private=False)
    status, body = _post(_Handler(private=False), {"schema": "zimi-backup"})
    assert status == 403
    assert body["error"] == "public_locked"
