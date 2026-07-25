#!/usr/bin/env python3
"""'Did you mean' spelling correction — offline, title-vocabulary driven.

The vocabulary is built from the same SQLite title indexes search uses (a
`titles` table with a `title_lower` column). These tests stand up a synthetic
index with that real schema, then exercise vocab build, edit-distance matching,
the sparse-result trigger in search_all, the time budget, and fail-soft paths.
"""

import json
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
    "JavaScript frameworks",  # 2nd occurrence — survives the final singleton prune
    "Asyncio in Python",
    "Asyncio patterns",  # 2nd occurrence — survives the final singleton prune
    "Café culture",  # accented — should ASCII-fold to "cafe"
    "Café menu",  # 2nd occurrence — survives the final singleton prune
    "Machine learning",
]


class VocabBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-")
        _make_title_index(self.tmp, "wikipedia", TITLES)
        self._patch = mock.patch.object(_search, "_TITLE_INDEX_DIR", self.tmp)
        self._patch.start()
        # Isolate the on-disk vocab cache too — _vocab_build_worker (used by
        # _ensure_vocab) now checks disk before scanning, and it must never
        # touch the real ZIMI_DATA_DIR cache during a test.
        self._patch_cache = mock.patch.object(
            _search, "_VOCAB_CACHE_PATH", os.path.join(self.tmp, "dym_vocab.json")
        )
        self._patch_cache.start()
        _search._reset_vocab()

    def tearDown(self):
        self._patch.stop()
        self._patch_cache.stop()
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

    def test_ensure_vocab_builds_async_and_caches(self):
        # The build is non-blocking: the first call kicks off a daemon builder
        # and returns None immediately; once joined, the cached dict is stable.
        self.assertIsNone(_search._ensure_vocab())
        _search._join_vocab_build()
        v1 = _search._ensure_vocab()
        v2 = _search._ensure_vocab()
        self.assertIsNotNone(v1)
        self.assertIs(v1, v2)
        self.assertIn("python", v1)

    def test_ensure_vocab_single_builder(self):
        # Concurrent-ish calls must not spawn multiple builder threads.
        _search._ensure_vocab()
        t1 = _search._vocab_builder_thread
        _search._ensure_vocab()
        t2 = _search._vocab_builder_thread
        self.assertIs(t1, t2)
        _search._join_vocab_build()


class VocabSizeOrderTests(unittest.TestCase):
    """_build_vocab scans indexes largest-file-first, not alphabetically."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-size-")
        # "aaa" sorts first alphabetically but stays tiny (1 title).
        _make_title_index(self.tmp, "aaa", ["Small Only"])
        # "zzz" sorts last alphabetically but is the big index (many titles)
        # — real libraries need this one scanned first when budget is tight.
        _make_title_index(self.tmp, "zzz", [f"Big Title {i}" for i in range(200)])
        self._patch_dir = mock.patch.object(_search, "_TITLE_INDEX_DIR", self.tmp)
        self._patch_dir.start()
        _search._reset_vocab()

    def tearDown(self):
        self._patch_dir.stop()
        _search._reset_vocab()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_scans_largest_file_first_under_tight_budget(self):
        # Fake a clock: deadline = 0 + 100. Four "in-budget" ticks are enough
        # for _build_vocab to open+drain one small-row-count file (the outer
        # loop check, two inner while-loop checks); everything after returns
        # a value far past the deadline, so a second file is never opened.
        ticks = iter([0, 1, 2, 3] + [10_000] * 50)
        with (
            mock.patch.object(_search, "_VOCAB_BUILD_BUDGET_S", 100),
            mock.patch.object(_search.time, "monotonic", lambda: next(ticks)),
        ):
            vocab = _search._build_vocab()
        # The big file (size-sorted first) got scanned...
        self.assertIn("big", vocab)
        self.assertIn("title", vocab)
        # ...the small, alphabetically-first file did not.
        self.assertNotIn("small", vocab)
        self.assertNotIn("only", vocab)


class VocabLoggingTests(unittest.TestCase):
    """The vocab build always logs its outcome at info, including empty."""

    def test_empty_build_logs_at_info(self):
        empty_dir = tempfile.mkdtemp(prefix="zimi-dym-emptylog-")
        try:
            with mock.patch.object(_search, "_TITLE_INDEX_DIR", empty_dir):
                with self.assertLogs(_search.log.name, level="INFO") as cm:
                    vocab = _search._build_vocab()
            self.assertEqual(vocab, {})
            self.assertTrue(any("vocab" in msg.lower() for msg in cm.output))
            self.assertTrue(any("0/0" in msg for msg in cm.output))
        finally:
            import shutil

            shutil.rmtree(empty_dir, ignore_errors=True)

    def test_missing_dir_logs_at_info(self):
        missing = "/nonexistent/zimi-dym-path-xyz"
        with mock.patch.object(_search, "_TITLE_INDEX_DIR", missing):
            with self.assertLogs(_search.log.name, level="INFO") as cm:
                vocab = _search._build_vocab()
        self.assertEqual(vocab, {})
        self.assertTrue(any("vocab" in msg.lower() for msg in cm.output))


class VocabRowCapTests(unittest.TestCase):
    """A single file's row scan is capped, so one giant index can't starve
    every other index out of the time budget."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-rowcap-")
        # 20 titles, each contributing a unique numbered word — repeated
        # within the same title so it survives the final singleton prune
        # (count 2 from one row, not 1), isolating the row-cap behavior from
        # the separate singleton-pruning behavior under test elsewhere.
        titles = [f"RowWord{i:03d} RowWord{i:03d} Common" for i in range(20)]
        _make_title_index(self.tmp, "wikipedia", titles)
        self._patch_dir = mock.patch.object(_search, "_TITLE_INDEX_DIR", self.tmp)
        self._patch_dir.start()
        _search._reset_vocab()

    def tearDown(self):
        self._patch_dir.stop()
        _search._reset_vocab()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_per_file_row_cap_limits_contribution(self):
        # A tiny fetch batch size (5) plus a tiny row cap (5) means only the
        # first 5 rows of the file are ever read — the rest of the file's
        # words must not appear, even though nothing else stopped the scan.
        with (
            mock.patch.object(_search, "_VOCAB_FETCH_BATCH_SIZE", 5),
            mock.patch.object(_search, "_VOCAB_MAX_ROWS_PER_FILE", 5),
        ):
            vocab = _search._build_vocab()
        # Common to all 20 titles → present regardless of the cap.
        self.assertIn("common", vocab)
        # Rows 0-4 got scanned...
        self.assertIn("rowword000", vocab)
        self.assertIn("rowword004", vocab)
        # ...rows past the cap did not.
        self.assertNotIn("rowword010", vocab)
        self.assertNotIn("rowword019", vocab)


class VocabLossyCountingTests(unittest.TestCase):
    """Hitting the word cap sweeps out singletons instead of freezing the
    vocab — words seen later in the scan can still be counted, and only a
    truly unproductive sweep (saturation) stops the scan for good."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-lossy-")
        self._patch_dir = mock.patch.object(_search, "_TITLE_INDEX_DIR", self.tmp)
        self._patch_dir.start()
        _search._reset_vocab()

    def tearDown(self):
        self._patch_dir.stop()
        _search._reset_vocab()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_eviction_sweep_keeps_frequent_drops_singletons(self):
        # Row 0 gives "common" a count of 2 up front. Rows 1-5 are five
        # distinct singleton words, so the 5th insertion hits a word cap of
        # 5 and triggers a sweep: "common" (count>=2) must survive it, the
        # four singletons must not.
        titles = ["Common Common", "Aaa", "Bbb", "Ccc", "Ddd", "Eee"]
        _make_title_index(self.tmp, "wikipedia", titles)
        with mock.patch.object(_search, "_VOCAB_MAX_WORDS", 5):
            vocab = _search._build_vocab()
        self.assertEqual(vocab.get("common"), 2)
        for w in ("aaa", "bbb", "ccc", "ddd"):
            self.assertNotIn(w, vocab)

    def test_saturation_stops_the_scan(self):
        # 19 words pre-seeded to count 2 (via a duplicate within each row's
        # own title), then a 20th, brand-new singleton word hits a word cap
        # of 20. It's the ONLY singleton in the vocab at that moment, so the
        # sweep frees just 1 — under the 10% (of 20 = 2) saturation
        # threshold. That must stop the scan outright: a further row after
        # the trigger must never be read.
        titles = [f"W{i:02d} W{i:02d}" for i in range(19)]
        titles.append("Trigger")  # 20th distinct word, count 1 → hits the cap
        titles.append("ShouldNeverAppear ShouldNeverAppear")  # must not be read
        _make_title_index(self.tmp, "wikipedia", titles)
        with (
            mock.patch.object(_search, "_VOCAB_MAX_WORDS", 20),
            mock.patch.object(_search, "_VOCAB_EVICT_MIN_FRACTION", 0.10),
            mock.patch.object(_search, "_VOCAB_FETCH_BATCH_SIZE", 1),
        ):
            vocab = _search._build_vocab()
        for i in range(19):
            self.assertEqual(vocab.get(f"w{i:02d}"), 2)
        self.assertNotIn("trigger", vocab)
        self.assertNotIn("shouldneverappear", vocab)

    def test_final_prune_drops_remaining_singletons(self):
        # No cap pressure here — this isolates the end-of-scan prune from
        # the mid-scan eviction sweep tested above.
        titles = ["Repeated Repeated", "Oneoff Word"]
        _make_title_index(self.tmp, "wikipedia", titles)
        vocab = _search._build_vocab()
        self.assertEqual(vocab.get("repeated"), 2)
        self.assertNotIn("oneoff", vocab)  # count 1 → pruned
        self.assertNotIn("word", vocab)  # count 1 → pruned


class VocabCachePersistenceTests(unittest.TestCase):
    """The vocab is persisted to disk and reloaded instead of rescanned,
    as long as its signature still matches the title indexes on disk."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-cache-")
        self.index_dir = os.path.join(self.tmp, "titles")
        _make_title_index(self.index_dir, "wikipedia", TITLES)
        self.cache_path = os.path.join(self.tmp, "dym_vocab.json")
        self._patches = [
            mock.patch.object(_search, "_TITLE_INDEX_DIR", self.index_dir),
            mock.patch.object(_search, "_VOCAB_CACHE_PATH", self.cache_path),
        ]
        for p in self._patches:
            p.start()
        _search._reset_vocab()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        _search._reset_vocab()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_signature_changes_when_index_touched(self):
        sig1 = _search._vocab_signature(self.index_dir)
        # Touch: append a row, changing size and mtime.
        db_path = os.path.join(self.index_dir, "wikipedia.db")
        conn = sqlite3.connect(db_path)
        conn.execute("INSERT INTO titles VALUES ('A/999','New Thing','new thing')")
        conn.commit()
        conn.close()
        sig2 = _search._vocab_signature(self.index_dir)
        self.assertNotEqual(sig1, sig2)

    def test_cache_invalidated_after_index_change(self):
        built = _search._build_vocab()
        sig = _search._vocab_signature(self.index_dir)
        _search._vocab_cache_save(built, sig)
        self.assertIsNotNone(_search._vocab_cache_load())
        # Touch the index — cache is now stale and must be rejected.
        db_path = os.path.join(self.index_dir, "wikipedia.db")
        conn = sqlite3.connect(db_path)
        conn.execute("INSERT INTO titles VALUES ('A/999','New Thing','new thing')")
        conn.commit()
        conn.close()
        self.assertIsNone(_search._vocab_cache_load())

    def test_builder_version_bump_invalidates_cache(self):
        # Save a cache under an older builder version — as if it were left
        # over from round 2's algorithm — with the underlying indexes
        # completely unchanged. The current (newer) version must still
        # reject it: the signature folds in _VOCAB_BUILDER_VERSION.
        with mock.patch.object(_search, "_VOCAB_BUILDER_VERSION", 1):
            old_sig = _search._vocab_signature(self.index_dir)
            _search._vocab_cache_save({"stale": 99}, old_sig)
        # Back to the real (current) version — same indexes, different sig.
        self.assertIsNone(_search._vocab_cache_load())

    def test_round_trip_avoids_rebuild(self):
        # Build once and persist, exactly as _vocab_build_worker would.
        built = _search._build_vocab()
        sig = _search._vocab_signature(self.index_dir)
        _search._vocab_cache_save(built, sig)
        _search._reset_vocab()  # simulate a fresh process: in-memory state gone

        # Prove the next build path never re-scans: if it did, this raises.
        def _fail_if_called():
            raise AssertionError("cache miss — _build_vocab should not run")

        with mock.patch.object(_search, "_build_vocab", _fail_if_called):
            self.assertIsNone(_search._ensure_vocab())
            _search._join_vocab_build()
            vocab = _search._ensure_vocab()
        self.assertIsNotNone(vocab)
        self.assertIn("python", vocab)
        self.assertEqual(vocab, built)

    def test_corrupted_cache_falls_back_to_clean_rebuild(self):
        os.makedirs(self.tmp, exist_ok=True)
        with open(self.cache_path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        self.assertIsNone(_search._vocab_cache_load())
        # And the worker path recovers by rebuilding rather than raising.
        _search._ensure_vocab()
        _search._join_vocab_build()
        vocab = _search._ensure_vocab()
        self.assertIsNotNone(vocab)
        self.assertIn("python", vocab)

    def test_cache_persisted_after_fresh_build(self):
        self.assertFalse(os.path.exists(self.cache_path))
        _search._ensure_vocab()
        _search._join_vocab_build()
        self.assertTrue(os.path.exists(self.cache_path))
        with open(self.cache_path, encoding="utf-8") as f:
            data = json.load(f)
        self.assertIn("python", data["words"])
        self.assertEqual(data["sig"], _search._vocab_signature(self.index_dir))


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

    def test_freq_ratio_corrects_known_typo(self):
        # "einstien" is itself in vocab (the typo appears in some titles) but
        # is vastly outnumbered by the correctly-spelled "einstein".
        vocab = {"einstien": 1, "einstein": 100}
        self.assertEqual(
            _search._best_correction(
                "einstien", vocab, freq_ratio=_search._DYM_FREQ_RATIO
            ),
            "einstein",
        )

    def test_freq_ratio_leaves_common_words_alone(self):
        # Both spellings are common; the ratio guard must not "correct" one
        # into the other.
        vocab = {"water": 5000, "waiter": 400}
        self.assertIsNone(
            _search._best_correction("water", vocab, freq_ratio=_search._DYM_FREQ_RATIO)
        )

    def test_no_freq_ratio_keeps_legacy_behavior(self):
        # Without freq_ratio, an in-vocab word is never touched.
        self.assertIsNone(_search._best_correction("python", self.vocab))

    def test_did_you_mean_corrects_in_vocab_typo_via_frequency(self):
        vocab = {"einstien": 1, "einstein": 100, "theory": 50}
        deadline = time.monotonic() + 1.0
        out = _search._did_you_mean("einstien theory", vocab, deadline)
        self.assertEqual(out, "einstein theory")

    def test_did_you_mean_leaves_common_word_uncorrected(self):
        vocab = {"water": 5000, "waiter": 400}
        deadline = time.monotonic() + 1.0
        self.assertIsNone(_search._did_you_mean("water", vocab, deadline))

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

    def test_accented_query_never_mangles(self):
        # "café" must never become a hybrid like "cafeé". A clean "cafe" or
        # None are both acceptable; a mangled accent-glued token is not.
        deadline = time.monotonic() + 1.0
        vocab = {"cafe": 5, "python": 10}
        out = _search._did_you_mean("café", vocab, deadline)
        self.assertIn(out, (None, "cafe"))

    def test_cyrillic_query_no_suggestion_no_crash(self):
        deadline = time.monotonic() + 1.0
        self.assertIsNone(_search._did_you_mean("привет", self.vocab, deadline))

    def test_cjk_query_no_suggestion_no_crash(self):
        deadline = time.monotonic() + 1.0
        self.assertIsNone(_search._did_you_mean("日本語", self.vocab, deadline))

    def test_mixed_ascii_and_accented_only_sane_output(self):
        # The ASCII typo gets corrected; the accented token is left verbatim,
        # never fused with a correction fragment.
        deadline = time.monotonic() + 1.0
        vocab = {"python": 10, "cafe": 5}
        out = _search._did_you_mean("pyhton café", vocab, deadline)
        self.assertEqual(out, "python café")
        self.assertNotIn("cafeé", out)


class SearchAllTriggerTests(unittest.TestCase):
    """search_all attaches did_you_mean only on the full path when total < 3."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-sa-")
        _make_title_index(self.tmp, "wikipedia", TITLES)
        self._patch_dir = mock.patch.object(_search, "_TITLE_INDEX_DIR", self.tmp)
        self._patch_dir.start()
        self._patch_cache = mock.patch.object(
            _search, "_VOCAB_CACHE_PATH", os.path.join(self.tmp, "dym_vocab.json")
        )
        self._patch_cache.start()
        _search._reset_vocab()
        # No ZIMs loaded → search returns 0 results, exercising the sparse path.
        self._patches = [
            mock.patch.object(_search._srv, "get_zim_files", lambda: {}),
            mock.patch.object(_search._srv, "_zim_list_cache", []),
            mock.patch.object(_search._srv, "_detect_query_language", lambda q: ""),
        ]
        for p in self._patches:
            p.start()
        # The vocab build is now async; prime it synchronously so the sparse-path
        # assertions don't race the background builder.
        _search._vocab = _search._build_vocab()

    def tearDown(self):
        self._patch_dir.stop()
        self._patch_cache.stop()
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

    def test_results_ge_min_no_suggestion(self):
        # Stub the full FTS path to yield _DYM_MIN_RESULTS results so the
        # gate skips DYM.
        fake_lock = mock.MagicMock()
        fake_lock.__enter__ = lambda *a: None
        fake_lock.__exit__ = lambda *a: False
        results = [
            {"title": f"Zzz {i}", "path": f"A/{i}", "snippet": ""}
            for i in range(_search._DYM_MIN_RESULTS)
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
        self.assertEqual(out["total"], _search._DYM_MIN_RESULTS)
        self.assertNotIn("did_you_mean", out)

    def test_fail_soft_with_no_indexes(self):
        # Point the vocab at an empty dir → empty vocab → no suggestion, no error.
        empty = tempfile.mkdtemp(prefix="zimi-dym-empty-")
        try:
            with (
                mock.patch.object(_search, "_TITLE_INDEX_DIR", empty),
                mock.patch.object(
                    _search, "_VOCAB_CACHE_PATH", os.path.join(empty, "dym_vocab.json")
                ),
            ):
                _search._reset_vocab()
                result = _search.search_all("pyhton", fast=False)
            self.assertNotIn("did_you_mean", result)
        finally:
            import shutil

            shutil.rmtree(empty, ignore_errors=True)


class BudgetTests(unittest.TestCase):
    def test_maybe_did_you_mean_respects_monotonic(self):
        vocab = {"python": 1}
        with mock.patch.object(_search, "_ensure_vocab", lambda: vocab):
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
