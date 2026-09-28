"""The details builder ZimiTube and the Bookshelf share (zimi/details.py).

A ZIM is built once however many ask at once; a build that fails is tried
again at the next start rather than kept as done; a version bump reads the
ZIM again; and the files 1.11 wrote are taken as they are, in the same
places: an upgrade must not read all of English Gutenberg's 60,000 book
heads again (half an hour on the NAS).

Run: pytest tests/test_details.py -v
"""

import json
import os
import sqlite3
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from zimi import books, search, tube  # noqa: E402
from zimi.details import DetailsBuilder  # noqa: E402

import test_books  # noqa: E402
import test_tube  # noqa: E402

KIND = "detailtest"
ROWS = [("a", "alpha"), ("b", "beta")]


@pytest.fixture(autouse=True)
def _nothing_outlives_its_test():
    yield
    tube._reset_for_tests()
    books._reset_for_tests()
    search._background_ok(KIND, KIND)


@pytest.fixture
def zim(tmp_path, monkeypatch):
    """One video ZIM, ``detailtest``, and its (name, path)."""
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(
        str(zdir / f"{KIND}.zim"), {"Scraper": "youtube2zim 3.5.0", "Name": KIND}
    )
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    return KIND, srv.get_zim_files()[KIND]


class _Kind:
    """A details kind of the tests' own, over the video ZIMs: its build
    counts its runs, and can be held at a gate or made to fail halfway."""

    def __init__(self, version="1"):
        self.runs = 0
        self.gate = threading.Event()
        self.gate.set()
        self.fail = False
        self.kept = []
        self.builder = DetailsBuilder(
            KIND,
            zims="video",
            label="Test",
            what="test details",
            version=version,
            table="words",
            columns=("id TEXT PRIMARY KEY", "word TEXT"),
            build=self.build,
            load=dict,
            lock=threading.Lock(),
            on_keep=lambda *a: self.kept.append(a),
        )

    def build(self, name, path):
        self.runs += 1
        self.gate.wait(30)
        # Failing halfway: a row too short for the table, once the file is
        # begun.
        rows = [("a",)] if self.fail else ROWS
        return self.builder.write(name, path, srv.open_archive(path), rows)


def _until(cond, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return
        time.sleep(0.01)
    raise AssertionError("timed out")


def test_a_zim_is_built_once_however_many_ask_at_once(zim):
    name, path = zim
    k = _Kind()
    k.gate.clear()
    try:
        start = threading.Barrier(8)

        def ask():
            start.wait()
            k.builder.request(name)

        askers = [threading.Thread(target=ask) for _ in range(8)]
        for t in askers:
            t.start()
        for t in askers:
            t.join()
        _until(lambda: k.runs == 1)
        # Asked again while it builds, and the startup worker's pass: neither
        # starts a second build, and the pass does not wait for the first.
        k.builder.request(name)
        k.builder.build_all()
        assert [t.name for t in threading.enumerate()].count(f"{KIND}-details") == 1
        assert k.kept == []
    finally:
        k.gate.set()
    assert k.builder.wait()
    assert k.runs == 1
    assert k.builder.kept(name, path) == dict(ROWS)
    assert k.builder.current(name, path)
    # Asked for once it is built: the file is current, so it is kept, not
    # read again.
    k.builder.request(name)
    assert k.builder.wait()
    assert k.runs == 1 and len(k.kept) == 2


def test_a_failed_build_is_tried_again_not_kept_as_done(zim, caplog):
    name, path = zim
    k = _Kind()
    k.fail = True
    with caplog.at_level("WARNING", logger="zimi"):
        k.builder.request(name)
        assert k.builder.wait()
    assert k.runs == 1
    # Nothing waits for it (kept empty), and nothing says it is done: no
    # file, not even a half-written one, and Manage lists the failure.
    assert k.builder.kept(name, path) == {}
    assert not os.path.exists(k.builder.path(name))
    assert not os.path.exists(k.builder.path(name) + ".tmp")
    assert not k.builder.current(name, path)
    assert {"kind": KIND, "name": name} in search.background_failures()
    assert any(
        r.levelname == "WARNING"
        and r.getMessage().startswith(f"Test: test details of {name} failed: ")
        for r in caplog.records
    )
    # The next start (or the next ask) builds it again.
    k.fail = False
    k.builder.request(name)
    assert k.builder.wait()
    assert k.runs == 2
    assert k.builder.kept(name, path) == dict(ROWS)
    assert k.builder.current(name, path)
    assert {"kind": KIND, "name": name} not in search.background_failures()


def test_a_version_bump_reads_the_zim_again(zim):
    name, path = zim
    v1 = _Kind("1")
    v1.builder.build_one(name)
    v1.builder.build_one(name)
    assert v1.runs == 1
    v2 = _Kind("2")
    assert not v2.builder.current(name, path)
    v2.builder.build_one(name)
    assert v2.runs == 1 and v2.builder.current(name, path)
    assert v2.builder.kept(name, path) == dict(ROWS)
    assert not v1.builder.current(name, path)


# ── the files 1.11 wrote ───────────────────────────────────────────────────
# As 1.11's build_details wrote them, spelled out here rather than written by
# the code under test: <data dir>/<kind>/<name>.db, the table, then meta.

VIDEOS_1_11 = "CREATE TABLE videos (id TEXT PRIMARY KEY, description TEXT, speaker TEXT, date TEXT)"
BOOKS_1_11 = "CREATE TABLE books (id INTEGER PRIMARY KEY, creators TEXT, subjects TEXT, created TEXT, cover INTEGER, path TEXT)"
META_1_11 = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"


def _file_1_11(kind, name):
    return os.path.join(srv.ZIMI_DATA_DIR, kind, f"{name}.db")


def _write_as_1_11(kind, name, create, insert, rows):
    zim_path = srv.get_zim_files()[name]
    db = _file_1_11(kind, name)
    os.makedirs(os.path.dirname(db), exist_ok=True)
    conn = sqlite3.connect(db)
    conn.execute(create)
    conn.execute(META_1_11)
    conn.executemany(insert, rows)
    conn.executemany(
        "INSERT INTO meta VALUES (?, ?)",
        [
            ("schema_version", "1"),
            ("zim_mtime", str(os.path.getmtime(zim_path))),
            ("built_at", str(time.time())),
            ("entry_count", str(len(rows))),
            ("zim_uuid", str(srv.open_archive(zim_path).uuid)),
        ],
    )
    conn.commit()
    conn.close()
    with open(db, "rb") as f:
        return db, f.read()


def _unread(monkeypatch, module):
    runs = []
    monkeypatch.setattr(module, "build_details", lambda *a: runs.append(a))
    return runs


def test_video_details_1_11_wrote_are_current_and_served_as_they_are(
    tmp_path, monkeypatch
):
    name = test_tube._yt3_library(tmp_path, monkeypatch, "yt3old")
    db, written = _write_as_1_11(
        "tube",
        name,
        VIDEOS_1_11,
        "INSERT INTO videos VALUES (?, ?, ?, ?)",
        [("eRsGyueVLvQ", "Described by 1.11.", "Blender Studio", "2010-09-30")],
    )
    runs = _unread(monkeypatch, tube)
    assert tube._builder.path(name) == db
    assert tube._builder.current(name, srv.get_zim_files()[name])
    tube.build_all_details()
    assert runs == []
    with open(db, "rb") as f:
        assert f.read() == written
    rows = {r["id"]: r for r in tube.videos_for(name)}
    assert rows["eRsGyueVLvQ"]["description"] == "Described by 1.11."


def test_book_records_1_11_wrote_are_current_and_served_as_they_are(
    tmp_path, monkeypatch
):
    test_books._library(tmp_path, monkeypatch, test_books.LIBRARY[:1], details=False)
    name = "gutenberg_la"
    db, written = _write_as_1_11(
        "books",
        name,
        BOOKS_1_11,
        "INSERT INTO books VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                227,
                json.dumps([["Vergilius", -80, -10]]),
                json.dumps(["Written down by 1.11"]),
                "1990-01-01",
                1,
                "",
            )
        ],
    )
    runs = _unread(monkeypatch, books)
    assert books._builder.path(name) == db
    books.build_all_details()
    assert runs == []
    with open(db, "rb") as f:
        assert f.read() == written
    b = books.book(name, 227)
    assert b["subjects"] == ["Written down by 1.11"] and b["born"] == -80
    assert books.home()["details"] is True


def _tube_library(tmp_path, monkeypatch):
    return tube, test_tube._yt3_library(tmp_path, monkeypatch, "yt3new"), VIDEOS_1_11


def _books_library(tmp_path, monkeypatch):
    test_books._library(tmp_path, monkeypatch, test_books.LIBRARY[:1], details=False)
    return books, "gutenberg_la", BOOKS_1_11


@pytest.mark.parametrize("library", [_tube_library, _books_library])
def test_a_new_build_writes_the_file_1_11_wrote(tmp_path, monkeypatch, library):
    module, name, create = library(tmp_path, monkeypatch)
    module.build_all_details()
    conn = sqlite3.connect(_file_1_11(module._builder.kind, name))
    try:
        tables = dict(
            conn.execute("SELECT name, sql FROM sqlite_master WHERE type='table'")
        )
        meta = {k for (k,) in conn.execute("SELECT key FROM meta")}
        count = conn.execute(f"SELECT COUNT(*) FROM {create.split()[2]}").fetchone()[0]
    finally:
        conn.close()
    assert tables == {create.split()[2]: create, "meta": META_1_11}
    assert meta == {
        "schema_version",
        "zim_mtime",
        "built_at",
        "entry_count",
        "zim_uuid",
    }
    assert count > 0
