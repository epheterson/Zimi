"""Tests for the /manage/catalog ui_languages filter (W2.4)."""

import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402

_FAKE_ITEMS = [
    {"name": "wiki_en", "language": "en"},
    {"name": "wiki_fr", "language": "fr"},
    {"name": "wiki_de", "language": "de"},
    {"name": "wiki_es", "language": "es"},
    {"name": "ted_en", "language": "en"},
]


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_check_manage_auth", lambda h: None)
    monkeypatch.setattr(
        server,
        "_fetch_kiwix_catalog",
        lambda q, lang, count, start: (len(_FAKE_ITEMS), list(_FAKE_ITEMS), None),
    )
    yield


def _get_catalog(query_params):
    """Invoke the manage GET handler with given query params (dict of str → list)."""
    h = MagicMock()
    captured = {}

    def _json(status, payload):
        captured["status"] = status
        captured["payload"] = payload

    h._json = _json
    parsed = MagicMock()
    parsed.path = "/manage/catalog"
    manage.handle_manage_get(h, parsed, query_params)
    return captured["status"], captured["payload"]


def test_no_filter_returns_all():
    status, body = _get_catalog({})
    assert status == 200
    assert body["total"] == 5
    assert len(body["items"]) == 5


def test_single_language_filter():
    status, body = _get_catalog({"ui_languages": ["en"]})
    assert status == 200
    assert body["total"] == 2
    assert {it["language"] for it in body["items"]} == {"en"}


def test_multi_language_filter_union():
    status, body = _get_catalog({"ui_languages": ["en,fr"]})
    assert status == 200
    assert {it["language"] for it in body["items"]} == {"en", "fr"}
    assert body["total"] == 3


def test_unknown_language_returns_empty():
    status, body = _get_catalog({"ui_languages": ["xx"]})
    assert status == 200
    assert body["items"] == []
    assert body["total"] == 0


def test_filter_handles_whitespace_and_case():
    status, body = _get_catalog({"ui_languages": [" EN , Fr "]})
    assert status == 200
    assert {it["language"] for it in body["items"]} == {"en", "fr"}


def test_empty_filter_returns_all():
    status, body = _get_catalog({"ui_languages": [""]})
    assert status == 200
    assert body["total"] == 5
