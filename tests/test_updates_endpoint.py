"""Tests for /manage/updates listing endpoint.

Surfaces the per-ZIM update detail behind the "N remaining" count so the UI
can drill in.
"""

import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402

_FAKE_UPDATES = [
    {
        "name": "wikipedia_en_top",
        "installed_file": "wikipedia_en_top_2024-01.zim",
        "installed_date": "2024-01",
        "latest_date": "2024-04",
        "download_url": "https://download.kiwix.org/zim/wikipedia_en_top_2024-04.zim.meta4",
        "title": "Wikipedia (en) — Top",
        "size_bytes": 1_500_000_000,
    },
    {
        "name": "ted_en_business",
        "installed_file": "ted_en_business_2023-06.zim",
        "installed_date": "2023-06",
        "latest_date": "2024-04",
        "download_url": "https://download.kiwix.org/zim/ted_en_business_2024-04.zim.meta4",
        "title": "TED Business",
        "size_bytes": 200_000_000,
    },
]


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_check_manage_auth", lambda h: None)
    monkeypatch.setattr(server, "_check_updates", lambda: list(_FAKE_UPDATES))
    yield


def _get(path):
    h = MagicMock()
    captured = {}

    def _json(status, payload):
        captured["status"] = status
        captured["payload"] = payload

    h._json = _json
    parsed = MagicMock()
    parsed.path = path
    manage.handle_manage_get(h, parsed, {})
    return captured["status"], captured["payload"]


def test_updates_endpoint_returns_count():
    status, body = _get("/manage/updates")
    assert status == 200
    assert body["count"] == 2


def test_updates_endpoint_returns_detail_list():
    status, body = _get("/manage/updates")
    assert status == 200
    items = body["updates"]
    assert len(items) == 2
    # Every item has the fields the UI needs
    for item in items:
        for required in (
            "name",
            "installed_date",
            "latest_date",
            "download_url",
            "title",
            "size_bytes",
        ):
            assert required in item


def test_updates_endpoint_no_updates_returns_empty(monkeypatch):
    monkeypatch.setattr(server, "_check_updates", lambda: [])
    status, body = _get("/manage/updates")
    assert status == 200
    assert body["count"] == 0
    assert body["updates"] == []


def test_check_updates_alias_returns_same_shape():
    status_a, body_a = _get("/manage/updates")
    status_b, body_b = _get("/manage/check-updates")
    assert status_a == status_b == 200
    assert body_a == body_b
