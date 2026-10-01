"""Search says when its indexes are not all there yet.

A model searching a library whose title index is still building, or a
source with no full-text index (it matches titles only), took a thin answer
for the whole truth. The lean search now names those sources in one line,
and says nothing when everything is ready; `wait` holds the answer until the
builds finish; the full set lists every source's state and can start a
build; /search carries the same as `incomplete`.

Run: pytest tests/test_index_status.py -v
"""

import os
import sqlite3
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
import zimi.search as search  # noqa: E402
import zimi.server as server  # noqa: E402
from zimi import http as zhttp  # noqa: E402

try:
    import zimi.mcp_server as mcp_server  # noqa: E402
except (ImportError, SystemExit):  # pragma: no cover - depends on the install
    mcp_server = None
needs_mcp = pytest.mark.skipif(mcp_server is None, reason="needs the mcp package")


@pytest.fixture
def library(tmp_path, monkeypatch):
    """wiki (full text) and places (titles only), title indexes built."""
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "wiki_en_2026-09.zim"))
    build_fixture_zim(str(zdir / "places_en_2026-09.zim"), indexing=False)
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    server.load_cache(force=True)
    search._fulltext_known.clear()
    for name, path in server.get_zim_files().items():
        search._build_title_index(name, path)
    yield
    search._fulltext_known.clear()


def building(name, progress=40):
    """Force `name`'s title index to look mid-build, as another process's
    build does: a fresh tmp beside it with its progress in meta."""
    tmp = search._title_index_path(name) + ".tmp"
    conn = sqlite3.connect(tmp)
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    if progress is not None:
        conn.execute("INSERT INTO meta VALUES ('progress', ?)", (str(progress),))
    conn.commit()
    conn.close()
    return tmp


def states(names=None, **kw):
    return {s["zim"]: s for s in search.index_status(names, **kw)}


def test_ready_library_reports_ready(library):
    s = states(check_current=True)
    assert s["wiki"] == {
        "zim": "wiki",
        "title": "ready",
        "progress": None,
        "fulltext": True,
    }
    assert s["places"]["title"] == "ready" and s["places"]["fulltext"] is False
    assert search.index_gaps(["wiki"]) == []


def test_a_build_in_progress_is_seen_with_its_progress(library):
    building("wiki")
    assert states()["wiki"]["title"] == "building"
    assert states()["wiki"]["progress"] == 40
    assert search.index_gaps() == [{"zim": "wiki", "state": "building", "progress": 40}]


def test_an_orphaned_tmp_is_not_a_build(library):
    tmp = building("wiki")
    old = time.time() - search._BUILD_FRESH_S - 60
    os.utime(tmp, (old, old))
    assert states()["wiki"]["title"] == "ready"


def test_missing_and_stale(library):
    os.remove(search._title_index_path("wiki"))
    assert states()["wiki"]["title"] == "missing"
    search._build_title_index("wiki", server.get_zim_files()["wiki"])
    conn = sqlite3.connect(search._title_index_path("wiki"))
    conn.execute("UPDATE meta SET value='0' WHERE key='schema_version'")
    conn.commit()
    conn.close()
    assert states(check_current=True)["wiki"]["title"] == "stale"
    # Without the check a stale index still answers searches: ready.
    assert states()["wiki"]["title"] == "ready"


def test_a_finished_build_leaves_no_progress_behind(library):
    conn = sqlite3.connect(search._title_index_path("wiki"))
    keys = {k for (k,) in conn.execute("SELECT key FROM meta")}
    conn.close()
    assert "progress" not in keys


def test_titles_only_is_named_when_searched_or_answering(library):
    assert search.index_gaps(["places"]) == [{"zim": "places", "state": "titles_only"}]
    # Unscoped and silent there: not listed on every search of the library.
    assert search.index_gaps(None, {"wiki"}) == []
    assert search.index_gaps(None, {"places"}) == [
        {"zim": "places", "state": "titles_only"}
    ]


# ── MCP ──────────────────────────────────────────────────────────────────


@needs_mcp
def test_lean_search_says_nothing_when_all_is_ready(library):
    out = mcp_server.lean_search("water", zim="wiki")
    assert "Water purification" in out
    assert "ncomplete" not in out


@needs_mcp
def test_lean_search_names_a_building_index(library):
    building("wiki")
    out = mcp_server.lean_search("water", zim="wiki")
    assert out.splitlines()[0] == "Incomplete: wiki: title index building 40%"
    assert "Water purification" in out


@needs_mcp
def test_lean_search_names_a_titles_only_source(library):
    out = mcp_server.lean_search("water", zim="places")
    assert out.splitlines()[0] == "Incomplete: places: titles only (no full-text index)"


@needs_mcp
def test_wait_returns_once_the_build_is_done(library):
    tmp = building("wiki")
    threading.Timer(1.0, os.remove, (tmp,)).start()
    t0 = time.monotonic()
    out = mcp_server.lean_search("water", zim="wiki", wait=20)
    took = time.monotonic() - t0
    assert 0.9 <= took < 10, took
    assert "ncomplete" not in out and "Water purification" in out


@needs_mcp
def test_wait_says_when_it_ran_out(library):
    building("wiki", progress=None)
    t0 = time.monotonic()
    out = mcp_server.lean_search("water", zim="wiki", wait=1)
    assert time.monotonic() - t0 < 5
    assert (
        out.splitlines()[0] == "Still incomplete after 1s: wiki: title index building"
    )


@needs_mcp
def test_wait_is_capped(library, monkeypatch):
    asked = []
    monkeypatch.setattr(
        mcp_server, "_wait_for_indexes", lambda n, s: asked.append(s) or True
    )
    mcp_server.lean_search("water", zim="wiki", wait=3600)
    assert asked == [mcp_server.WAIT_MAX_S]


@needs_mcp
def test_full_index_status_lists_every_state(library):
    building("wiki", progress=55)
    out = mcp_server.index_status()
    assert "- wiki: title index building 55%; full text" in out
    assert "- places: title index ready; titles only (no full-text index)" in out
    os.remove(search._title_index_path("places"))
    assert "- places: title index missing;" in mcp_server.index_status("places")


@needs_mcp
def test_full_build_index_builds_a_missing_index(library):
    os.remove(search._title_index_path("places"))
    assert mcp_server.build_index("places").startswith("Started: places.")
    deadline = time.time() + 30
    while time.time() < deadline and states(["places"])["places"]["title"] != "ready":
        time.sleep(0.2)
    assert states(["places"], check_current=True)["places"]["title"] == "ready"
    assert mcp_server.build_index("places") == "Title index ready: places."


@needs_mcp
def test_full_search_carries_the_note(library):
    building("wiki")
    out = mcp_server.search("water", zim="wiki")
    assert "Incomplete: wiki: title index building 40%" in out


# ── HTTP ─────────────────────────────────────────────────────────────────


def test_http_answer_adds_incomplete_without_touching_the_cache(library):
    building("wiki")
    cached = search.search_all("water", limit=5, filter_zim="wiki")
    answer = zhttp._search_answer(cached, "wiki", fast=False)
    assert answer["incomplete"] == [
        {"zim": "wiki", "state": "building", "progress": 40}
    ]
    assert "incomplete" not in cached
    # The fast path is titles by design and asks nothing.
    assert "incomplete" not in zhttp._search_answer(cached, "wiki", fast=True)
    os.remove(search._title_index_path("wiki") + ".tmp")
    assert "incomplete" not in zhttp._search_answer(cached, "wiki", fast=False)
