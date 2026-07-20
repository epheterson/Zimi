"""first_seen stamping for the 'New' ZIM badge (#34)."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
import zimi.server as server  # noqa: E402


def _setup(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "survival_en_2026-06.zim"))
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    return zdir


def _entry(zims):
    return next(z for z in zims if z["name"] == "survival")


def test_brand_new_zim_gets_first_seen(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)  # full scan, no disk cache
    e = _entry(server._zim_list_cache)
    assert e.get("first_seen"), "a freshly-scanned ZIM must be stamped"


def test_first_seen_carried_forward_on_cache_hit(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)  # stamps + persists
    stamped = _entry(server._zim_list_cache)["first_seen"]
    assert stamped
    server.load_cache(force=False)  # reads disk cache → cache hit
    assert _entry(server._zim_list_cache)["first_seen"] == stamped


def test_brand_new_zim_has_no_updated_at(tmp_path, monkeypatch):
    """A fresh install is 'New', never 'Updated' — updated_at stays unset."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    assert _entry(server._zim_list_cache).get("updated_at") in (None, 0, "")


def test_changed_zim_gets_updated_at(tmp_path, monkeypatch):
    """A known ZIM whose file changed on disk is stamped updated_at (the
    'Updated' badge) while keeping its original first_seen."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    first_seen = _entry(server._zim_list_cache)["first_seen"]
    assert first_seen
    # Simulate the file changing: corrupt the cached mtime/size so the next
    # scan misses on an already-known ZIM and re-reads the archive.
    cf = server._cache_file_path()
    data = json.load(open(cf))
    for v in data["files"].values():
        v["mtime"] = 1.0
        v["size"] = 123
    json.dump(data, open(cf, "w"))
    server.load_cache(force=False)
    e = _entry(server._zim_list_cache)
    assert e.get("updated_at"), "a changed known ZIM must be stamped updated_at"
    assert e["first_seen"] == first_seen, "first_seen must survive the update"


def test_prefeature_cache_entry_is_not_new(tmp_path, monkeypatch):
    """A ZIM already in a cache written before this feature (no first_seen)
    must NOT be retroactively flagged new."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    # Strip first_seen from the persisted cache to simulate a pre-feature file.
    cf = server._cache_file_path()
    data = json.load(open(cf))
    for v in data.get("files", {}).values():
        v.pop("first_seen", None)
    json.dump(data, open(cf, "w"))
    server.load_cache(force=False)  # cache hit, no stored first_seen
    assert _entry(server._zim_list_cache).get("first_seen") in (None, 0, "")
