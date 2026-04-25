"""Tests for the Pro hot-cache (W2.3).

Hot ZIMs are designated by name (env var or hot.json) and get
pre-warmed at startup. Cold ZIMs stay lazy. Aimed at users with
1000+ ZIMs who want fast searches against a small frequently-used
subset without paying the cost of warming everything.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ZIMI_HOT_ZIMS", raising=False)
    yield


# ────────────────────────────────────────────────────────────────────────────
# Env-var parsing
# ────────────────────────────────────────────────────────────────────────────


def test_env_var_simple_csv(monkeypatch):
    monkeypatch.setenv("ZIMI_HOT_ZIMS", "wikipedia_en_top,stackoverflow_en_all")
    assert server.get_hot_zims() == ["wikipedia_en_top", "stackoverflow_en_all"]


def test_env_var_strips_whitespace(monkeypatch):
    monkeypatch.setenv("ZIMI_HOT_ZIMS", "  wiki_en , stack_en ,gutenberg_en ")
    assert server.get_hot_zims() == ["wiki_en", "stack_en", "gutenberg_en"]


def test_env_var_drops_empty_entries(monkeypatch):
    monkeypatch.setenv("ZIMI_HOT_ZIMS", "wiki_en,,,stack_en,")
    assert server.get_hot_zims() == ["wiki_en", "stack_en"]


def test_env_var_unset_returns_empty():
    assert server.get_hot_zims() == []


# ────────────────────────────────────────────────────────────────────────────
# File-based config (~/.zimi/hot.json)
# ────────────────────────────────────────────────────────────────────────────


def test_file_config_loaded(tmp_path, monkeypatch):
    hot_file = tmp_path / "hot.json"
    hot_file.write_text(json.dumps(["wiki_en", "ted_en"]))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    assert server.get_hot_zims() == ["wiki_en", "ted_en"]


def test_env_var_takes_precedence_over_file(tmp_path, monkeypatch):
    hot_file = tmp_path / "hot.json"
    hot_file.write_text(json.dumps(["from_file"]))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ZIMI_HOT_ZIMS", "from_env")
    assert server.get_hot_zims() == ["from_env"]


def test_corrupt_file_falls_back_to_empty(tmp_path, monkeypatch):
    hot_file = tmp_path / "hot.json"
    hot_file.write_text("{not valid json}")
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    assert server.get_hot_zims() == []


def test_set_hot_zims_persists_to_file(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    server.set_hot_zims(["wiki_en", "stack_en"])
    saved = json.loads((tmp_path / "hot.json").read_text())
    assert saved == ["wiki_en", "stack_en"]


def test_set_hot_zims_empty_clears_file(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    server.set_hot_zims(["wiki_en"])
    server.set_hot_zims([])
    saved = json.loads((tmp_path / "hot.json").read_text())
    assert saved == []


def test_set_hot_zims_atomic(tmp_path, monkeypatch):
    """Writing should not leave a half-written file behind."""
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    server.set_hot_zims(["wiki_en"])
    # Atomic-write convention: no .tmp file lingering after success
    assert not (tmp_path / "hot.json.tmp").exists()


# ────────────────────────────────────────────────────────────────────────────
# Validation
# ────────────────────────────────────────────────────────────────────────────


def test_set_hot_zims_rejects_non_string(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    with pytest.raises((TypeError, ValueError)):
        server.set_hot_zims(["wiki_en", 42])


def test_set_hot_zims_dedupes(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    server.set_hot_zims(["wiki_en", "wiki_en", "stack_en"])
    saved = json.loads((tmp_path / "hot.json").read_text())
    assert saved == ["wiki_en", "stack_en"]


# ────────────────────────────────────────────────────────────────────────────
# /manage/hot endpoints
# ────────────────────────────────────────────────────────────────────────────

import zimi.manage as manage  # noqa: E402
from unittest.mock import MagicMock  # noqa: E402


def _fake_handler():
    h = MagicMock()
    captured = {}

    def _json(status, payload):
        captured["status"] = status
        captured["payload"] = payload

    h._json = _json
    h._captured = captured
    return h


def _post(path, body, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_check_manage_auth", lambda h: None)
    h = _fake_handler()
    parsed = MagicMock()
    parsed.path = path
    manage.handle_manage_post(h, parsed, body)
    return h._captured["status"], h._captured["payload"]


def _get(path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_check_manage_auth", lambda h: None)
    h = _fake_handler()
    parsed = MagicMock()
    parsed.path = path
    parsed.query = ""
    manage.handle_manage_get(h, parsed, {})
    return h._captured["status"], h._captured["payload"]


def test_get_hot_endpoint_lists_set(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    server.set_hot_zims(["wiki_en"])
    status, body = _get("/manage/hot", monkeypatch)
    assert status == 200
    assert body["hot_zims"] == ["wiki_en"]
    assert body["env_locked"] is False


def test_get_hot_endpoint_reports_env_locked(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ZIMI_HOT_ZIMS", "wiki_en")
    status, body = _get("/manage/hot", monkeypatch)
    assert status == 200
    assert body["env_locked"] is True


def test_post_hot_endpoint_saves(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        server, "get_zim_files", lambda: {"wiki_en": "/x", "stack_en": "/y"}
    )
    status, body = _post(
        "/manage/hot", {"hot_zims": ["wiki_en", "stack_en"]}, monkeypatch
    )
    assert status == 200
    assert body["saved"] == 2
    assert server.get_hot_zims() == ["wiki_en", "stack_en"]


def test_post_hot_endpoint_drops_unknown_zims(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "get_zim_files", lambda: {"wiki_en": "/x"})
    status, body = _post(
        "/manage/hot", {"hot_zims": ["wiki_en", "doesnt_exist"]}, monkeypatch
    )
    assert status == 200
    assert body["hot_zims"] == ["wiki_en"]


def test_post_hot_endpoint_rejected_when_env_locked(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ZIMI_HOT_ZIMS", "wiki_en")
    status, body = _post("/manage/hot", {"hot_zims": ["other"]}, monkeypatch)
    assert status == 403


def test_post_hot_endpoint_missing_field(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    status, body = _post("/manage/hot", {}, monkeypatch)
    assert status == 400
