"""History-driven self-heal for 'New' badges on already-UPDATED ZIMs.

Before the dated-filename inherit fix, an update arriving under a new filename
re-stamped first_seen=now and left updated_at unset, so the ZIM badged 'New'
instead of 'Updated'. The persistent event history records the real update, so
we re-flag such ZIMs 'Updated' from that authority. It must never misfire on a
genuine fresh install (which has no 'updated' event).
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
import zimi.server as server  # noqa: E402


def _setup(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "osm_en_2026-07.zim"))
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    return zdir


def _entry(zims):
    return next(z for z in zims if z["name"] == "osm")


def _write_history(events):
    with open(server._history_file_path(), "w", encoding="utf-8") as f:
        json.dump(events, f)


def _poison_new(cf):
    """Simulate a pre-fix mis-stamp: recent first_seen, no updated_at."""
    data = json.load(open(cf))
    for v in data["files"].values():
        v["first_seen"] = time.time() - 2 * 86400
        v.pop("updated_at", None)
    json.dump(data, open(cf, "w"))


def test_history_reflags_mis_stamped_update_as_updated(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    cf = server._cache_file_path()
    _poison_new(cf)
    install = time.time() - 200 * 86400
    update = time.time() - 2 * 86400
    _write_history(
        [
            {
                "event": "updated",
                "ts": update,
                "filename": "osm_en_2026-07.zim",
                "name": "osm",
            },
            {
                "event": "download",
                "ts": install,
                "filename": "osm_en_2026-05.zim",
                "name": "osm",
            },
        ]
    )
    server.load_cache(force=False)
    e = _entry(server._zim_list_cache)
    assert e["updated_at"] == update, "updated_at must come from the update event"
    assert (
        abs(e["first_seen"] - install) < 1.0
    ), "first_seen must fall back to the install event"
    assert e["updated_at"] > e["first_seen"], "badge must now read 'Updated'"


def test_heal_persists_to_disk_cache(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    cf = server._cache_file_path()
    _poison_new(cf)
    update = time.time() - 3 * 86400
    _write_history(
        [
            {
                "event": "updated",
                "ts": update,
                "name": "osm",
                "filename": "osm_en_2026-07.zim",
            }
        ]
    )
    server.load_cache(force=False)
    persisted = json.load(open(cf))["files"]["osm_en_2026-07.zim"]
    assert persisted["updated_at"] == update
    assert persisted["first_seen"] < persisted["updated_at"]


def test_update_only_history_still_orders_stamps(tmp_path, monkeypatch):
    """When the only recorded event is the update (install predates history),
    first_seen is nudged just below updated_at so the badge still reads 'Updated'."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    cf = server._cache_file_path()
    _poison_new(cf)
    update = time.time() - 1 * 86400
    _write_history(
        [
            {
                "event": "updated",
                "ts": update,
                "name": "osm",
                "filename": "osm_en_2026-07.zim",
            }
        ]
    )
    server.load_cache(force=False)
    e = _entry(server._zim_list_cache)
    assert e["updated_at"] == update
    assert e["first_seen"] < e["updated_at"]


def test_fresh_install_never_reflagged(tmp_path, monkeypatch):
    """A genuine fresh install has only a 'download' event — the heal must leave
    it 'New' (updated_at unset), never invent an update."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    _write_history(
        [
            {
                "event": "download",
                "ts": time.time() - 86400,
                "name": "osm",
                "filename": "osm_en_2026-07.zim",
            }
        ]
    )
    server.load_cache(force=False)
    e = _entry(server._zim_list_cache)
    assert e.get("updated_at") in (None, 0, ""), "a fresh install must stay 'New'"


def test_no_history_is_noop(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    e = _entry(server._zim_list_cache)
    assert e.get("updated_at") in (None, 0, "")  # nothing to heal, nothing invented


def test_correctly_updated_zim_left_untouched(tmp_path, monkeypatch):
    """A ZIM already correctly flagged 'Updated' (updated_at > first_seen) is not
    disturbed even though the history also records its update."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    cf = server._cache_file_path()
    data = json.load(open(cf))
    fs = time.time() - 100 * 86400
    ua = time.time() - 5 * 86400
    for v in data["files"].values():
        v["first_seen"] = fs
        v["updated_at"] = ua
    json.dump(data, open(cf, "w"))
    _write_history(
        [
            {
                "event": "updated",
                "ts": time.time() - 5 * 86400,
                "name": "osm",
                "filename": "osm_en_2026-07.zim",
            }
        ]
    )
    server.load_cache(force=False)
    e = _entry(server._zim_list_cache)
    assert abs(e["first_seen"] - fs) < 1.0, "existing first_seen preserved"
    assert abs(e["updated_at"] - ua) < 1.0, "existing updated_at preserved"
