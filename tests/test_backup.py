"""Handler-level tests for the backup & export hub (v1.8.1, schema v2).

Covers the server half of a backup bundle: `_build_backup_bundle` (device +
admin-only server scope), and the `/manage/backup` POST importer — a two-step
preview→apply that MERGES by default (union by identity, incoming wins) with an
overwrite escape hatch. Per-browser state (bookmarks/history/preferences) is
client-only and never reaches the server, so it isn't exercised here.
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
    monkeypatch.setattr(server, "get_zim_files", lambda: {})
    return data_dir


def _post(handler, body):
    manage.handle_manage_post(handler, urlparse("/manage/backup"), body)
    return handler.status, handler.body


def _apply(handler, body):
    """POST an apply (the two-step's confirm leg)."""
    b = dict(body)
    b["action"] = "apply"
    return _post(handler, b)


# ── Export shape ──


def test_build_bundle_shape(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    bundle = manage._build_backup_bundle()
    assert bundle["schema"] == "zimi-backup"
    assert bundle["schema_version"] == manage._BACKUP_SCHEMA_VERSION
    assert bundle["library"] == []
    assert bundle["collections"] == {"version": 1, "favorites": [], "collections": {}}
    assert bundle["library_layout"] == {
        "overrides": {},
        "section_order": [],
        "sections": [],
    }
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


# ── Import round-trips (apply leg) ──


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
    status, body = _apply(_Handler(), bundle)
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
    status, body = _apply(_Handler(), bundle)
    assert status == 200
    assert "library_layout" in body["applied"]
    layout = server._load_library_layout()
    assert layout["overrides"] == {"wikipedia_en": "Books"}
    assert layout["section_order"] == ["cat:Books"]


def test_import_partial_bundle_applies_only_present(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, body = _apply(
        _Handler(),
        {"schema": "zimi-backup", "library_layout": {"overrides": {"a": "Books"}}},
    )
    assert status == 200
    assert body["applied"] == ["library_layout"]


def test_import_empty_bundle_ok_noop(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, body = _apply(_Handler(), {"schema": "zimi-backup"})
    assert status == 200
    assert body["applied"] == []


# ── Merge rules: union / dedupe / newest-wins ──


def test_favorites_merge_union_and_dedupe(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    server._save_collections({"version": 1, "favorites": ["old"], "collections": {}})
    status, body = _apply(
        _Handler(),
        {
            "schema": "zimi-backup",
            # "old" is a duplicate; "new" is added.
            "collections": {
                "version": 1,
                "favorites": ["old", "new"],
                "collections": {},
            },
        },
    )
    assert status == 200
    # Union preserves the existing entry, appends the new one, drops the dupe.
    assert server._load_collections()["favorites"] == ["old", "new"]
    assert body["preview"]["collections"]["fav_dupes"] == 1


def test_collections_newest_wins_on_conflict(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    server._save_collections(
        {
            "version": 1,
            "favorites": [],
            "collections": {"c": {"label": "current", "updated": 100}},
        }
    )
    # Incoming carries a newer timestamp → it wins.
    _apply(
        _Handler(),
        {
            "schema": "zimi-backup",
            "collections": {
                "version": 1,
                "favorites": [],
                "collections": {"c": {"label": "incoming", "updated": 200}},
            },
        },
    )
    assert server._load_collections()["collections"]["c"]["label"] == "incoming"


def test_collections_older_incoming_loses(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    server._save_collections(
        {
            "version": 1,
            "favorites": [],
            "collections": {"c": {"label": "current", "updated": 300}},
        }
    )
    _apply(
        _Handler(),
        {
            "schema": "zimi-backup",
            "collections": {
                "version": 1,
                "favorites": [],
                "collections": {"c": {"label": "incoming", "updated": 200}},
            },
        },
    )
    assert server._load_collections()["collections"]["c"]["label"] == "current"


def test_layout_overrides_merge_not_replace(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    server._save_library_layout({"overrides": {"a": "Books"}, "section_order": []})
    _apply(
        _Handler(),
        {"schema": "zimi-backup", "library_layout": {"overrides": {"b": "Docs"}}},
    )
    # Merge keeps the existing override AND adds the incoming one.
    assert server._load_library_layout()["overrides"] == {"a": "Books", "b": "Docs"}


def test_overwrite_replaces_favorites(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    server._save_collections({"version": 1, "favorites": ["old"], "collections": {}})
    _post(
        _Handler(),
        {
            "action": "apply",
            "overwrite": True,
            "schema": "zimi-backup",
            "collections": {"version": 1, "favorites": ["new"], "collections": {}},
        },
    )
    assert server._load_collections()["favorites"] == ["new"]


def test_import_favorites_capped(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _apply(
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


# ── Preview-before-apply contract ──


def test_preview_is_default_and_applies_nothing(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    server._save_collections({"version": 1, "favorites": ["keep"], "collections": {}})
    status, body = _post(  # no action → preview
        _Handler(),
        {
            "schema": "zimi-backup",
            "collections": {"version": 1, "favorites": ["new"], "collections": {}},
        },
    )
    assert status == 200
    assert body["status"] == "preview"
    assert body["preview"]["collections"]["fav_added"] == 1
    # Nothing was written — the existing favorites are untouched.
    assert server._load_collections()["favorites"] == ["keep"]


def test_preview_reports_missing_zims(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "get_zim_files", lambda: {"have_it": object()})
    status, body = _post(
        _Handler(),
        {
            "schema": "zimi-backup",
            "library": [
                {"name": "have_it"},
                {"name": "missing_a"},
                {"name": "missing_b"},
            ],
        },
    )
    assert status == 200
    assert body["preview"]["missing_zims"] == 2


# ── Validation ──


def test_import_rejects_foreign_schema(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, body = _apply(_Handler(), {"schema": "something-else"})
    assert status == 400


def test_import_rejects_bad_collections(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, _ = _apply(
        _Handler(), {"schema": "zimi-backup", "collections": {"favorites": "nope"}}
    )
    assert status == 400


def test_import_rejects_bad_layout(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, _ = _apply(
        _Handler(),
        {"schema": "zimi-backup", "library_layout": {"section_order": ["bogus:x"]}},
    )
    assert status == 400


# ── Auth matrix (mirrors library-layout) ──


def test_import_passwordless_public_locked(monkeypatch, tmp_path):
    # A genuine public (non-private-tier) client on a passwordless instance
    # gets the opaque lock — no hint a setup key exists. Only a private-tier
    # peer who could read the log is told about the key (GHSA-5mw2-53vv-9pw6);
    # that path is pinned in test_bootstrap_takeover.
    _setup(monkeypatch, tmp_path, private=False)
    status, body = _apply(_Handler(private=False), {"schema": "zimi-backup"})
    assert status == 403
    assert body["error"] == "public_locked"


# ── Full-server scope: build + admin gate ──


def _seed_server_state(monkeypatch, tmp_path):
    """Give the instance some server-owned state so a server bundle is non-empty."""
    from zimi import library as _lib
    from zimi import p2p
    from zimi import users as _users

    p2p.set_prefs_path(str(tmp_path / "data" / "bt_prefs.json"))
    _users._save_users({"alice": {"name": "alice", "pw": "HASH", "role": "user"}})
    _users.set_public_access("open")
    _lib._save_download_schedule(True, "02:00", "05:00", True, 20)
    p2p.set_pref("seed", False)
    _lib.record_seed("wikipedia_en_2026.zim")


def test_build_server_bundle_includes_hashes_and_policy(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _seed_server_state(monkeypatch, tmp_path)
    bundle = manage._build_backup_bundle(scope="server")
    assert bundle["scope"] == "server"
    # users.json rides along WITH hashes — it's the admin's own backup.
    assert bundle["users"]["alice"]["pw"] == "HASH"
    assert bundle["public_access"]["mode"] == "open"
    assert bundle["schedule"]["upload_restrict"] is True
    assert bundle["bt_prefs"]["seed"] is False
    assert "wikipedia_en_2026.zim" in bundle["seed_intents"]
    # v3 additions — the rest of a full-restore's coverage.
    assert isinstance(bundle["hot_zims"], list)
    assert set(bundle["auto_update"]) == {"enabled", "frequency"}
    assert isinstance(bundle["history"], list)
    assert isinstance(bundle["user_data"], dict)


def test_device_bundle_has_no_server_state(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _seed_server_state(monkeypatch, tmp_path)
    bundle = manage._build_backup_bundle()  # device
    assert bundle["scope"] == "device"
    for k in (
        "users",
        "public_access",
        "schedule",
        "bt_prefs",
        "seed_intents",
        "hot_zims",
        "auto_update",
        "history",
        "user_data",
    ):
        assert k not in bundle


def test_server_export_requires_admin(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(manage, "admin_kind", lambda h: None)  # not an admin
    h = _Handler()
    manage.handle_manage_get(
        h, urlparse("/manage/backup?scope=server"), {"scope": ["server"]}
    )
    assert h.status == 403


def test_server_restore_refuses_non_admin(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _seed_server_state(monkeypatch, tmp_path)
    monkeypatch.setattr(manage, "admin_kind", lambda h: None)
    # A server-scope bundle from a non-admin session is refused in BOTH legs.
    for action in ("preview", "apply"):
        status, body = _post(
            _Handler(),
            {
                "schema": "zimi-backup",
                "scope": "server",
                "action": action,
                "users": {"mallory": {"name": "mallory", "pw": "X", "role": "admin"}},
            },
        )
        assert status == 403
    # And the malicious user was never written.
    from zimi import users as _users

    assert "mallory" not in _users._load_users()


def test_server_restore_merges_users_for_admin(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _seed_server_state(monkeypatch, tmp_path)  # existing user "alice"
    monkeypatch.setattr(manage, "admin_kind", lambda h: "primary")
    status, body = _apply(
        _Handler(),
        {
            "schema": "zimi-backup",
            "scope": "server",
            "users": {"bob": {"name": "bob", "pw": "BHASH", "role": "user"}},
        },
    )
    assert status == 200
    assert "users" in body["applied"]
    from zimi import users as _users

    merged = _users._load_users()
    assert "alice" in merged and "bob" in merged  # union, not replace


def test_device_bundle_ignores_stray_server_keys(monkeypatch, tmp_path):
    """A device bundle carrying server keys must NOT touch server state — the
    scope, not the presence of keys, gates the server path."""
    _setup(monkeypatch, tmp_path)
    _seed_server_state(monkeypatch, tmp_path)
    monkeypatch.setattr(manage, "admin_kind", lambda h: "primary")
    _apply(
        _Handler(),
        {
            "schema": "zimi-backup",  # no scope → device
            "users": {"mallory": {"name": "mallory", "pw": "X", "role": "admin"}},
        },
    )
    from zimi import users as _users

    assert "mallory" not in _users._load_users()


# ── v3 server state: hot list, auto-update, history, per-user data round-trip ──


def test_server_restore_roundtrips_v3_fields(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _seed_server_state(monkeypatch, tmp_path)
    monkeypatch.setattr(manage, "admin_kind", lambda h: "primary")
    monkeypatch.delenv("ZIMI_HOT_ZIMS", raising=False)
    monkeypatch.delenv("ZIMI_AUTO_UPDATE", raising=False)
    monkeypatch.setattr(server, "_auto_update_env_locked", False, raising=False)
    from zimi import library as _lib

    status, body = _apply(
        _Handler(),
        {
            "schema": "zimi-backup",
            "scope": "server",
            "hot_zims": ["wikipedia_en", "gutenberg"],
            "auto_update": {"enabled": True, "frequency": "daily"},
            "history": [{"event": "download", "name": "x"}],
            "user_data": {
                "kid": {"version": 1, "bookmarks": [{"zim": "a", "path": "b"}]}
            },
        },
    )
    assert status == 200
    for k in ("hot_zims", "auto_update", "history", "user_data"):
        assert k in body["applied"]
    assert server.get_hot_zims() == ["wikipedia_en", "gutenberg"]
    assert _lib._load_auto_update_config() == (True, "daily")
    assert server._load_history() == [{"event": "download", "name": "x"}]
    from zimi import users as _users

    assert _users.load_user_data("kid")["bookmarks"] == [{"zim": "a", "path": "b"}]


def test_history_restore_preserves_running_log_without_overwrite(monkeypatch, tmp_path):
    """Merge-mode restore into a NON-empty history is a no-op (a live server's
    real event stream is never duplicated/reordered); overwrite replaces it."""
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(manage, "admin_kind", lambda h: "primary")
    server._save_history([{"event": "existing"}])
    _apply(
        _Handler(),
        {
            "schema": "zimi-backup",
            "scope": "server",
            "history": [{"event": "incoming"}],
        },
    )
    assert server._load_history() == [{"event": "existing"}]  # unchanged
    _post(
        _Handler(),
        {
            "action": "apply",
            "overwrite": True,
            "schema": "zimi-backup",
            "scope": "server",
            "history": [{"event": "incoming"}],
        },
    )
    assert server._load_history() == [{"event": "incoming"}]


def test_hot_zims_env_lock_wins_over_restore(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(manage, "admin_kind", lambda h: "primary")
    monkeypatch.setenv("ZIMI_HOT_ZIMS", "locked_zim")
    status, body = _apply(
        _Handler(),
        {"schema": "zimi-backup", "scope": "server", "hot_zims": ["from_backup"]},
    )
    assert status == 200
    assert "hot_zims" not in body["applied"]  # env-locked → skipped
    assert server.get_hot_zims() == ["locked_zim"]
