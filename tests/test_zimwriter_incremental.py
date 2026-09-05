"""Bookmark export must not starve the server when it finishes.

The export used to end with ``load_cache(force=True)`` under ``_zim_lock`` —
a full re-open + re-scan of EVERY archive in the library while holding the one
lock every libzim request needs. Exporting three bookmarks off a big library
on a network mount therefore froze every reader for as long as the rescan
took, the same failure the post-download path already removed. These tests pin
the replacement: incremental per-file registration, with the full rescan kept
only as the fallback.
"""

import os
import sys
import time

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as server  # noqa: E402
import zimi.zimwriter as zw  # noqa: E402


def _bookmarks(n=2):
    return [
        {"zim": "survival", "path": f"A/Doc{i}", "title": f"Doc {i}"} for i in range(n)
    ]


def _setup_library(tmp_path, monkeypatch):
    """A real ZIM_DIR with one small ZIM already scanned into the live caches."""
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "existing_en_2026-01.zim"))
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    server._zim_files_cache = None
    server._zim_list_cache = None
    server.load_cache(force=True)
    return zdir


def _run_export(payload, timeout=60):
    """Start an export and wait for its worker thread to settle."""
    started, msg = zw.start_export(payload)
    assert started, msg
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = zw.get_export_state()
        if state["phase"] in ("done", "error"):
            return state
        time.sleep(0.05)
    raise AssertionError("export did not finish")


# ---------------------------------------------------------------------------
# End to end: a real export lands in the live library without a rescan
# ---------------------------------------------------------------------------


def test_export_registers_without_full_rescan(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch)
    gen_before = server._cache_generation

    real_extract = server._extract_zim_metadata
    extracted = []

    def counting_extract(name, path):
        extracted.append(name)
        return real_extract(name, path)

    monkeypatch.setattr(server, "_extract_zim_metadata", counting_extract)

    def no_rescan(force=False):
        raise AssertionError("the export finalize must not rescan the library")

    monkeypatch.setattr(server, "load_cache", no_rescan)

    state = _run_export(_bookmarks())
    assert state["phase"] == "done", state.get("error")
    assert len(state["files"]) == 1

    out_name = state["files"][0]
    # Exports land on the Created shelf (<zim_dir>/created), beside captures.
    assert os.path.exists(str(zdir / "created" / out_name))
    # Only the exported file was opened for metadata — the existing ZIM was
    # left alone, which is exactly what the full rescan failed to do.
    assert len(extracted) == 1
    short = server._zim_short_name(out_name)
    assert extracted == [short]
    assert short in server._zim_files_cache
    entry = next(z for z in server._zim_list_cache if z["name"] == short)
    assert entry["file"] == out_name
    assert entry["entries"] not in (None, "?")
    # The existing ZIM is still registered — the splice replaces nothing else.
    assert "existing" in server._zim_files_cache
    # ETag / interlang invalidation still fires for the new ZIM.
    assert server._cache_generation == gen_before + 1


def test_export_of_two_folders_registers_both(tmp_path, monkeypatch):
    _setup_library(tmp_path, monkeypatch)

    def no_rescan(force=False):
        raise AssertionError("the export finalize must not rescan the library")

    monkeypatch.setattr(server, "load_cache", no_rescan)

    state = _run_export(
        [
            {"name": "trip-notes", "title": "Trip notes", "bookmarks": _bookmarks(1)},
            {"name": "recipes", "title": "Recipes", "bookmarks": _bookmarks(2)},
        ]
    )
    assert state["phase"] == "done", state.get("error")
    assert sorted(state["files"]) == ["recipes.zim", "trip-notes.zim"]
    for name in ("recipes", "trip-notes"):
        assert name in server._zim_files_cache


# ---------------------------------------------------------------------------
# Wiring: incremental first, one forced rescan only as fallback
# ---------------------------------------------------------------------------


def _stub_result_caches(monkeypatch):
    cleared = []
    monkeypatch.setattr(server, "_search_cache_clear", lambda: cleared.append("search"))
    monkeypatch.setattr(
        server, "_suggest_cache_clear", lambda: cleared.append("suggest")
    )
    return cleared


def test_register_exports_never_rescans_on_success(monkeypatch):
    _stub_result_caches(monkeypatch)
    registered = []
    monkeypatch.setattr(
        server,
        "register_zim_file",
        lambda path, removed_files=(): registered.append(path) or True,
    )

    def no_rescan(force=False):
        raise AssertionError(
            "load_cache must not run when incremental registration succeeds"
        )

    monkeypatch.setattr(server, "load_cache", no_rescan)
    zw._register_exports(["/zims/a.zim", "/zims/b.zim"])
    assert registered == ["/zims/a.zim", "/zims/b.zim"]


def test_register_exports_falls_back_when_register_fails(monkeypatch):
    _stub_result_caches(monkeypatch)
    monkeypatch.setattr(
        server, "register_zim_file", lambda path, removed_files=(): False
    )
    rescans = []
    monkeypatch.setattr(server, "load_cache", lambda force=False: rescans.append(force))
    zw._register_exports(["/zims/a.zim"])
    assert rescans == [True]


def test_register_exports_falls_back_when_register_raises(monkeypatch):
    _stub_result_caches(monkeypatch)

    def boom(path, removed_files=()):
        raise RuntimeError("disk went away")

    monkeypatch.setattr(server, "register_zim_file", boom)
    rescans = []
    monkeypatch.setattr(server, "load_cache", lambda force=False: rescans.append(force))
    zw._register_exports(["/zims/a.zim"])
    assert rescans == [True]


def test_register_exports_rescans_once_for_several_failures(monkeypatch):
    _stub_result_caches(monkeypatch)
    monkeypatch.setattr(
        server, "register_zim_file", lambda path, removed_files=(): False
    )
    rescans = []
    monkeypatch.setattr(server, "load_cache", lambda force=False: rescans.append(force))
    zw._register_exports(["/zims/a.zim", "/zims/b.zim", "/zims/c.zim"])
    assert rescans == [True]  # one rescan covers the whole library, not one per file


def test_register_exports_clears_stale_result_caches(monkeypatch):
    cleared = _stub_result_caches(monkeypatch)
    monkeypatch.setattr(
        server, "register_zim_file", lambda path, removed_files=(): True
    )
    monkeypatch.setattr(server, "load_cache", lambda force=False: None)
    zw._register_exports(["/zims/a.zim"])
    assert cleared == ["search", "suggest"]
