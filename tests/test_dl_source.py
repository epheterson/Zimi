"""Tests that download serialization exposes a `source` field so the
UI can show whether BT or HTTP was used."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath("/Users/elp/Repos/zimi/tests/_a"))))

import zimi.library as library  # noqa: E402
import zimi.server as server  # noqa: E402


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    with library._download_lock:
        library._active_downloads.clear()
        library._download_queue.clear()
        library._download_counter = 0
    yield
    with library._download_lock:
        library._active_downloads.clear()
        library._download_queue.clear()


def _put_dl(dl_id, **overrides):
    base = {
        "filename": "x.zim",
        "url": "https://x/x.zim",
        "dest": "/tmp/x.zim",
        "started": 0.0,
        "total_bytes": 100,
        "downloaded_bytes": 50,
        "done": False,
        "error": None,
        "is_update": False,
        "mirrors": [],
    }
    base.update(overrides)
    library._active_downloads[dl_id] = base


def test_source_defaults_to_http():
    _put_dl("1")
    [d] = library._get_downloads()
    assert d["source"] == "http"


def test_source_bt_when_marked():
    _put_dl("1", _source="bt", bt_peers=3)
    [d] = library._get_downloads()
    assert d["source"] == "bt"
    assert d["bt_peers"] == 3


def test_source_http_when_marked():
    _put_dl("1", _source="http")
    [d] = library._get_downloads()
    assert d["source"] == "http"
    assert d.get("bt_peers", 0) == 0
