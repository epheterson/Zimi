"""Switch-to-direct escape hatch: an in-flight BitTorrent download can be
flipped to HTTP-only. Covers the library helper's state machine and the
downloads snapshot surfacing the transitional flag."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402


@pytest.fixture(autouse=True)
def _reset():
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
    return base


def test_switch_bt_download_sets_flag():
    dl = _put_dl("1", _source="bt", bt_peers=2)
    status, code = library._switch_to_direct("1")
    assert (status, code) == ("switching", 200)
    assert dl["switch_direct"] is True


def test_switch_unknown_download_404():
    assert library._switch_to_direct("nope") == ("not_found", 404)


def test_switch_finished_download_rejected():
    _put_dl("1", _source="bt", done=True)
    assert library._switch_to_direct("1") == ("already_done", 400)


def test_switch_non_bt_download_rejected():
    _put_dl("1", _source="http")
    assert library._switch_to_direct("1") == ("not_bt", 400)


def test_snapshot_exposes_switching_flag():
    _put_dl("1", _source="bt")
    library._switch_to_direct("1")
    [d] = library._get_downloads()
    assert d["switching_direct"] is True


def test_snapshot_switching_flag_defaults_false():
    _put_dl("1", _source="bt")
    [d] = library._get_downloads()
    assert d["switching_direct"] is False
