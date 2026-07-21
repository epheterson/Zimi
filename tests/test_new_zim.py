"""first_seen stamping for the 'New' ZIM badge (#34)."""

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


def _strip_first_seen(cf):
    """Simulate a pre-#34 cache file: drop first_seen from every entry."""
    data = json.load(open(cf))
    for v in data.get("files", {}).values():
        v.pop("first_seen", None)
    json.dump(data, open(cf, "w"))


def test_prefeature_recent_file_backfills_first_seen(tmp_path, monkeypatch):
    """A legacy cache entry (no first_seen) whose ZIM file has a recent mtime
    gets first_seen backfilled from that mtime, and the value is persisted so
    it's computed once."""
    zdir = _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    cf = server._cache_file_path()
    _strip_first_seen(cf)
    zpath = str(zdir / "survival_en_2026-06.zim")
    mtime = os.path.getmtime(zpath)
    server.load_cache(force=False)  # cache hit, no stored first_seen → backfill
    assert _entry(server._zim_list_cache)["first_seen"] == mtime
    # Persisted: the write-back stored the backfilled value.
    persisted = json.load(open(cf))["files"]["survival_en_2026-06.zim"]
    assert persisted["first_seen"] == mtime


def test_prefeature_old_file_backfills_old_mtime(tmp_path, monkeypatch):
    """A legacy entry whose ZIM file is old gets stamped with that old mtime,
    so the 'Recently added' pill naturally won't count it."""
    zdir = _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    cf = server._cache_file_path()
    _strip_first_seen(cf)
    zpath = str(zdir / "survival_en_2026-06.zim")
    old = time.time() - 400 * 86400  # ~13 months ago
    os.utime(zpath, (old, old))
    server.load_cache(force=False)
    fs = _entry(server._zim_list_cache)["first_seen"]
    assert abs(fs - old) < 1.0, "first_seen must track the old file mtime"


def test_prefeature_unreadable_mtime_stays_none(tmp_path, monkeypatch):
    """If the ZIM file's mtime can't be read (vanished mid-scan), the legacy
    entry stays unstamped rather than being flagged 'new'."""
    zdir = _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    cf = server._cache_file_path()
    _strip_first_seen(cf)
    real_getmtime = os.path.getmtime

    def flaky_getmtime(p):
        if p.endswith("survival_en_2026-06.zim"):
            raise OSError("file gone")
        return real_getmtime(p)

    monkeypatch.setattr(server.os.path, "getmtime", flaky_getmtime)
    server.load_cache(force=False)
    assert _entry(server._zim_list_cache).get("first_seen") in (None, 0, "")
