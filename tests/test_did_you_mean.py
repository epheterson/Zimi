#!/usr/bin/env python3
"""'Did you mean' spelling correction — offline, title-vocabulary driven.

The vocabulary is built from the same SQLite title indexes search uses (a
`titles` table with a `title_lower` column). These tests stand up a synthetic
index with that real schema, then exercise vocab build, edit-distance matching,
the sparse-result trigger in search_all, the time budget, and fail-soft paths.
"""

import os
import sqlite3
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tempfile  # noqa: E402

from zimi import search as _search  # noqa: E402


def _make_title_index(dir_path, name, titles):
    """Write a minimal title index matching the real schema."""
    os.makedirs(dir_path, exist_ok=True)
    db_path = os.path.join(dir_path, f"{name}.db")
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE titles (path TEXT PRIMARY KEY, title TEXT, title_lower TEXT)"
    )
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    rows = [(f"A/{i}", t, t.lower()) for i, t in enumerate(titles)]
    conn.executemany("INSERT INTO titles VALUES (?,?,?)", rows)
    conn.commit()
    conn.close()
    return db_path


TITLES = [
    "Python (programming language)",
    "Python bytecode",
    "History of Python",
    "JavaScript",
    "Asyncio in Python",
    "Café culture",  # accented — should ASCII-fold to "cafe"
    "Machine learning",
]


class VocabBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-")
        _make_title_index(self.tmp, "wikipedia", TITLES)
        self._patch = mock.patch.object(_search, "_TITLE_INDEX_DIR", self.tmp)
        self._patch.start()
        _search._reset_vocab()

    def tearDown(self):
        self._patch.stop()
        _search._reset_vocab()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_vocab_contains_title_words_lowercased(self):
        vocab = _search._build_vocab()
        self.assertIn("python", vocab)
        self.assertIn("javascript", vocab)
        self.assertIn("asyncio", vocab)
        # frequency: "python" appears in 4 titles
        self.assertGreaterEqual(vocab["python"], 4)

    def test_vocab_ascii_folds_accents(self):
        vocab = _search._build_vocab()
        self.assertIn("cafe", vocab)

    def test_vocab_skips_short_fragments(self):
        vocab = _search._build_vocab()
        # "of", "in" are < 3 chars and must not appear
        self.assertNotIn("of", vocab)
        self.assertNotIn("in", vocab)

    def test_get_vocab_caches(self):
        v1 = _search._get_vocab()
        v2 = _search._get_vocab()
        self.assertIs(v1, v2)


class CorrectionTests(unittest.TestCase):
    def setUp(self):
        self.vocab = {"python": 10, "javascript": 3, "asyncio": 2, "machine": 5}

    def test_edit_distance_1_hit(self):
        self.assertEqual(_search._best_correction("pyhton", self.vocab), "python")

    def test_in_vocab_word_not_corrected(self):
        self.assertIsNone(_search._best_correction("python", self.vocab))

    def test_frequency_breaks_ties(self):
        # both one edit away from "cat"? use a crafted vocab
        vocab = {"cot": 1, "cut": 9}
        self.assertEqual(_search._best_correction("cit", vocab), "cut")

    def test_no_candidate_returns_none(self):
        self.assertIsNone(_search._best_correction("zzzzzzzz", self.vocab))

    def test_multiword_correction(self):
        deadline = time.monotonic() + 1.0
        out = _search._did_you_mean("pyhton asyncio", self.vocab, deadline)
        self.assertEqual(out, "python asyncio")

    def test_no_correction_returns_none(self):
        deadline = time.monotonic() + 1.0
        self.assertIsNone(_search._did_you_mean("python machine", self.vocab, deadline))

    def test_empty_vocab_returns_none(self):
        deadline = time.monotonic() + 1.0
        self.assertIsNone(_search._did_you_mean("pyhton", {}, deadline))

    def test_budget_bail_returns_none(self):
        # A deadline already in the past forces a silent bail.
        past = time.monotonic() - 1.0
        self.assertIsNone(_search._did_you_mean("pyhton", self.vocab, past))


class SearchAllTriggerTests(unittest.TestCase):
    """search_all attaches did_you_mean only on the full path when total < 3."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-sa-")
        _make_title_index(self.tmp, "wikipedia", TITLES)
        self._patch_dir = mock.patch.object(_search, "_TITLE_INDEX_DIR", self.tmp)
        self._patch_dir.start()
        _search._reset_vocab()
        # No ZIMs loaded → search returns 0 results, exercising the sparse path.
        self._patches = [
            mock.patch.object(_search._srv, "get_zim_files", lambda: {}),
            mock.patch.object(_search._srv, "_zim_list_cache", []),
            mock.patch.object(_search._srv, "_detect_query_language", lambda q: ""),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        self._patch_dir.stop()
        for p in self._patches:
            p.stop()
        _search._reset_vocab()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_sparse_full_search_suggests(self):
        result = _search.search_all("pyhton", fast=False)
        self.assertEqual(result["total"], 0)
        self.assertEqual(result.get("did_you_mean"), "python")

    def test_fast_path_never_suggests(self):
        result = _search.search_all("pyhton", fast=True)
        self.assertNotIn("did_you_mean", result)

    def test_no_correction_absent_field(self):
        result = _search.search_all("python", fast=False)
        # "python" is a real vocab word → no suggestion, field omitted.
        self.assertNotIn("did_you_mean", result)

    def test_results_ge_3_no_suggestion(self):
        # Stub the full FTS path to yield 3 results so the gate skips DYM.
        fake_lock = mock.MagicMock()
        fake_lock.__enter__ = lambda *a: None
        fake_lock.__exit__ = lambda *a: False
        results = [
            {"title": "Zzz One", "path": "A/1", "snippet": ""},
            {"title": "Zzz Two", "path": "A/2", "snippet": ""},
            {"title": "Zzz Three", "path": "A/3", "snippet": ""},
        ]
        with (
            mock.patch.object(
                _search._srv, "get_zim_files", lambda: {"wikipedia": "/fake.zim"}
            ),
            mock.patch.object(
                _search._srv,
                "_zim_list_cache",
                [{"name": "wikipedia", "entries": 100, "language": "en"}],
            ),
            mock.patch.object(
                _search, "_get_fts_archive", lambda name: (object(), fake_lock)
            ),
            mock.patch.object(_search, "search_zim", lambda *a, **k: results),
        ):
            out = _search.search_all("pyhton", fast=False)
        self.assertEqual(out["total"], 3)
        self.assertNotIn("did_you_mean", out)

    def test_fail_soft_with_no_indexes(self):
        # Point the vocab at an empty dir → empty vocab → no suggestion, no error.
        empty = tempfile.mkdtemp(prefix="zimi-dym-empty-")
        try:
            with mock.patch.object(_search, "_TITLE_INDEX_DIR", empty):
                _search._reset_vocab()
                result = _search.search_all("pyhton", fast=False)
            self.assertNotIn("did_you_mean", result)
        finally:
            import shutil

            shutil.rmtree(empty, ignore_errors=True)


class BudgetTests(unittest.TestCase):
    def test_maybe_did_you_mean_respects_monotonic(self):
        vocab = {"python": 1}
        with mock.patch.object(_search, "_get_vocab", lambda: vocab):
            # First call sets the deadline; the next (the per-word budget check
            # inside _did_you_mean) jumps past it → silent bail.
            seq = iter([100.0, 200.0])

            def fake_mono():
                try:
                    return next(seq)
                except StopIteration:
                    return 200.0

            with mock.patch.object(_search.time, "monotonic", fake_mono):
                out = _search._maybe_did_you_mean("pyhton")
        self.assertIsNone(out)


class McpPassthroughTests(unittest.TestCase):
    """The MCP search tool surfaces did_you_mean when the core returns it."""

    def _run(self, fake_result):
        import zimi.mcp_server as mcp_server
        import zimi.server as server

        with mock.patch.object(server, "search_all", lambda *a, **k: fake_result):
            return mcp_server.search("pyhton")

    def test_no_results_passes_suggestion(self):
        out = self._run({"results": [], "total": 0, "did_you_mean": "python"})
        self.assertIn("Did you mean 'python'?", out)

    def test_with_results_passes_suggestion(self):
        out = self._run(
            {
                "results": [{"title": "T", "zim": "z", "path": "A/1", "snippet": ""}],
                "total": 1,
                "elapsed": 0.1,
                "did_you_mean": "python",
            }
        )
        self.assertIn("Did you mean 'python'?", out)

    def test_absent_suggestion_not_shown(self):
        out = self._run(
            {
                "results": [{"title": "T", "zim": "z", "path": "A/1", "snippet": ""}],
                "total": 1,
                "elapsed": 0.1,
            }
        )
        self.assertNotIn("Did you mean", out)


if __name__ == "__main__":
    unittest.main()
