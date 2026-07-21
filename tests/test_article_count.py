"""Real article count in the metadata cache (libzim article_count).

The field is additive over `entries` (all user entries): computed at cache
build, passed through /list, and absent for caches written before the field
existed (the UI then falls back to `entries`).
"""

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


def test_fresh_scan_computes_article_count(tmp_path, monkeypatch):
    """A full scan stores the libzim article_count as its own field, alongside
    (not replacing) the raw entry count."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    e = _entry(server._zim_list_cache)
    assert isinstance(e.get("article_count"), int)
    assert e["article_count"] > 0
    # The fixture has 3 front articles and no redirects, so article_count and
    # entries coincide; article_count must never exceed the user entry count.
    assert e["article_count"] <= e["entries"]


def test_article_count_persisted_and_survives_cache_hit(tmp_path, monkeypatch):
    """The field is written to disk and returned unchanged on a cache hit
    (no archive re-open)."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    fresh = _entry(server._zim_list_cache)["article_count"]
    # It must be in the persisted cache too.
    data = json.load(open(server._cache_file_path()))
    stored = next(iter(data["files"].values())).get("article_count")
    assert stored == fresh
    server.load_cache(force=False)  # cache hit
    assert _entry(server._zim_list_cache)["article_count"] == fresh


def test_list_passthrough(tmp_path, monkeypatch):
    """/list (list_zims) surfaces the field from the loaded cache."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    e = _entry(server.list_zims())
    assert isinstance(e.get("article_count"), int)


def test_prefeature_cache_has_no_article_count(tmp_path, monkeypatch):
    """A ZIM cached before this field existed keeps working: the cache hit
    carries no article_count, so the UI falls back to entries."""
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    cf = server._cache_file_path()
    data = json.load(open(cf))
    for v in data.get("files", {}).values():
        v.pop("article_count", None)
    json.dump(data, open(cf, "w"))
    server.load_cache(force=False)  # cache hit, no stored article_count
    e = _entry(server._zim_list_cache)
    assert "article_count" not in e
    assert e["entries"] > 0  # fallback field still present
