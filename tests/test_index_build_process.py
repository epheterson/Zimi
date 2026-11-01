"""A big ZIM's title and Q-ID indexes are built in a process of their own.

libzim holds the GIL while it reads, so a build on a server thread stalls
every search thread behind it: on the NAS, while the Q-ID index for Russian
Wikipedia was built, the quick search that takes 0.07 s took 2 to 7 s. These
run the child path on a fixture (the size threshold set to zero) and check it
leaves the same index a build in the server would.
"""

import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_nonlatin_redirect import _build  # noqa: E402
from zimi import interlang as _interlang  # noqa: E402
from zimi import search as _search  # noqa: E402
from zimi import server as _server  # noqa: E402


def _meta(db, key):
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


class IsolatedBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-isolated-")
        self.zim = os.path.join(self.tmp, "fixture.zim")
        _build(self.zim)
        self.patches = [
            mock.patch.object(_server, "ZIMI_DATA_DIR", self.tmp),
            mock.patch.object(_search, "_ISOLATE_BUILD_MIN_ENTRIES", 0),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        _search._close_title_db("fixture")
        _interlang._close_qid_db("fixture")
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _isolated(self, kind, build_fn, close_fn):
        closed = []
        with mock.patch.object(_search, "_zim_entry_count", lambda name: 1):
            _search._build_index_isolated(
                kind,
                "fixture",
                self.zim,
                build_fn,
                lambda n: (closed.append(n), close_fn(n)),
            )
        return closed

    def test_title_index_built_in_a_child(self):
        with mock.patch.object(
            _search,
            "_build_title_index",
            side_effect=AssertionError("built in the server"),
        ):
            closed = self._isolated(
                "titles", _search._build_title_index, _search._close_title_db
            )
        db = _search._title_index_path("fixture")
        self.assertTrue(os.path.exists(db))
        self.assertEqual(_meta(db, "schema_version"), _search._TITLE_INDEX_VERSION)
        # The server's pooled connection to the old file is let go.
        self.assertEqual(closed, ["fixture"])

    def test_qid_index_built_in_a_child(self):
        closed = self._isolated(
            "qids", _interlang._build_qid_index, _interlang._close_qid_db
        )
        db = _interlang._qid_index_path("fixture")
        self.assertTrue(os.path.exists(db))
        self.assertEqual(_meta(db, "schema_version"), _interlang._QID_INDEX_VERSION)
        self.assertEqual(closed, ["fixture"])

    def test_a_failed_child_is_an_error(self):
        with self.assertRaises(RuntimeError):
            _search._build_index_isolated(
                "titles",
                "fixture",
                os.path.join(self.tmp, "missing.zim"),
                _search._build_title_index,
                _search._close_title_db,
            )

    def test_a_small_zim_builds_in_this_process(self):
        calls = []
        with mock.patch.object(_search, "_ISOLATE_BUILD_MIN_ENTRIES", 10**9):
            _search._build_index_isolated(
                "titles",
                "fixture",
                self.zim,
                lambda n, p: calls.append(n),
                lambda n: None,
            )
        self.assertEqual(calls, ["fixture"])


if __name__ == "__main__":
    unittest.main()


def test_closing_a_pooled_connection_waits_for_the_query_using_it():
    """An index replaced while a Q-ID lookup is running must not be closed under the lookup (a crash, no traceback)."""
    import threading
    import time

    from zimi import search as _search

    pool, lock, closed = {"z": object()}, threading.Lock(), []

    class Conn:
        def close(self):
            closed.append(time.monotonic())

    pool["z"] = Conn()
    with _search.pooled_db_use(pool, "z"):
        closer = threading.Thread(target=_search._close_pooled_db, args=("z", pool, lock))
        closer.start()
        time.sleep(0.2)
        assert not closed, "closed while a query held the connection"
        released = time.monotonic()
    closer.join(5)
    # After the query let go: Windows' sleep can end a timer tick short of 0.2 s, so the release is the mark.
    assert closed and closed[0] >= released


def test_a_qid_index_built_by_a_child_tells_the_games_links(monkeypatch):
    from zimi import interlang as _interlang

    told = []
    monkeypatch.setattr(_interlang, "_games_note_index_change", lambda qid=None: told.append(qid))
    _interlang._qid_index_built_elsewhere("fixture")
    assert told == [None]
