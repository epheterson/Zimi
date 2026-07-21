"""Handler-level tests for library layout: per-ZIM category overrides + home
section order (#37).

Covers the /manage/library-layout write path (round-trips, validation, the
auth matrix) and the fail-soft read of a corrupt library_layout.json.
"""

import json
import os
import sys
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402


class _Handler:
    """Minimal stand-in for ZimHandler — enough for the auth challenge and
    the JSON responder the endpoint uses."""

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
    return data_dir


def _post(handler, body):
    manage.handle_manage_post(handler, urlparse("/manage/library-layout"), body)
    return handler.status, handler.body


# ── Round-trips ──


def test_override_round_trip(monkeypatch, tmp_path):
    data_dir = _setup(monkeypatch, tmp_path)
    status, body = _post(_Handler(), {"overrides": {"wikipedia_en": "Books"}})
    assert status == 200
    assert body["overrides"] == {"wikipedia_en": "Books"}
    # Persisted and reloadable
    layout = server._load_library_layout()
    assert layout["overrides"] == {"wikipedia_en": "Books"}
    assert (data_dir / "library_layout.json").exists()


def test_override_merge_and_clear(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _post(_Handler(), {"overrides": {"a": "Books", "b": "Medical"}})
    # Merge a new key without dropping existing ones
    status, body = _post(_Handler(), {"overrides": {"c": "Education"}})
    assert status == 200
    assert body["overrides"] == {"a": "Books", "b": "Medical", "c": "Education"}
    # Empty value clears just that entry (revert to heuristic)
    _, body = _post(_Handler(), {"overrides": {"a": ""}})
    assert body["overrides"] == {"b": "Medical", "c": "Education"}


def test_order_round_trip(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    order = ["cat:Books", "col:survival", "cat:Wikimedia"]
    status, body = _post(_Handler(), {"section_order": order})
    assert status == 200
    assert body["section_order"] == order
    assert server._load_library_layout()["section_order"] == order


def test_order_replaces_not_merges(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _post(_Handler(), {"section_order": ["cat:Books", "cat:Medical"]})
    _, body = _post(_Handler(), {"section_order": ["cat:Wikimedia"]})
    assert body["section_order"] == ["cat:Wikimedia"]


def test_override_and_order_are_independent(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _post(_Handler(), {"overrides": {"z": "Books"}})
    # Posting only section_order must not wipe the overrides
    _, body = _post(_Handler(), {"section_order": ["cat:Books"]})
    assert body["overrides"] == {"z": "Books"}
    assert body["section_order"] == ["cat:Books"]


# ── Auth matrix ──


def test_auth_passwordless_private_ok(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path, password_hash="", private=True)
    status, _ = _post(_Handler(private=True), {"overrides": {"a": "Books"}})
    assert status == 200


def test_auth_passwordless_public_locked(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path, password_hash="", private=False)
    status, body = _post(_Handler(private=False), {"overrides": {"a": "Books"}})
    assert status == 403
    assert body["error"] == "public_locked"


def test_auth_wrong_password_401(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path, password_hash="salt$deadbeef", private=True)
    monkeypatch.setattr(manage, "_verify_password", lambda cand, stored: False)
    status, body = _post(
        _Handler(private=True, auth="Bearer nope"), {"overrides": {"a": "Books"}}
    )
    assert status == 401
    assert body["error"] == "unauthorized"


def test_auth_correct_password_ok(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path, password_hash="salt$deadbeef", private=True)
    monkeypatch.setattr(manage, "_verify_password", lambda cand, stored: cand == "pw")
    status, _ = _post(
        _Handler(private=True, auth="Bearer pw"), {"overrides": {"a": "Books"}}
    )
    assert status == 200


# ── Validation ──


def test_empty_payload_400(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, body = _post(_Handler(), {})
    assert status == 400


def test_overrides_not_a_dict_400(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, _ = _post(_Handler(), {"overrides": ["not", "a", "dict"]})
    assert status == 400


def test_overrides_non_string_value_400(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, _ = _post(_Handler(), {"overrides": {"a": 123}})
    assert status == 400


def test_order_bad_prefix_400(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, _ = _post(_Handler(), {"section_order": ["bogus:Books"]})
    assert status == 400


def test_order_not_a_list_400(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    status, _ = _post(_Handler(), {"section_order": "cat:Books"})
    assert status == 400


def test_overrides_too_many_400(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    big = {str(i): "Books" for i in range(server._LAYOUT_MAX_OVERRIDES + 1)}
    status, _ = _post(_Handler(), {"overrides": big})
    assert status == 400


# ── Fail-soft read ──


def test_corrupt_layout_reads_as_empty(monkeypatch, tmp_path):
    data_dir = _setup(monkeypatch, tmp_path)
    (data_dir / "library_layout.json").write_text("{ this is not json")
    layout = server._load_library_layout()
    assert layout == {"overrides": {}, "section_order": []}


def test_missing_layout_reads_as_empty(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    assert server._load_library_layout() == {"overrides": {}, "section_order": []}


def test_wrong_shape_layout_reads_as_empty(monkeypatch, tmp_path):
    data_dir = _setup(monkeypatch, tmp_path)
    (data_dir / "library_layout.json").write_text(json.dumps([1, 2, 3]))
    assert server._load_library_layout() == {"overrides": {}, "section_order": []}
