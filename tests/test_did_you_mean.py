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
        self._patch = mock.patch.object(_search, "_title_index_dir", lambda: self.tmp)
        self._patch.start()
        # Isolate the on-disk vocab cache too — _vocab_build_worker (used by
        # _ensure_vocab) now checks disk before scanning, and it must never
        # touch the real ZIMI_DATA_DIR cache during a test.
        self._patch_cache = mock.patch.object(
            _search,
            "_vocab_cache_path",
            lambda: os.path.join(self.tmp, "dym_vocab.json"),
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
        self._patch_dir = mock.patch.object(_search, "_title_index_dir", lambda: self.tmp)
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
            with mock.patch.object(_search, "_title_index_dir", lambda: empty_dir):
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
        with mock.patch.object(_search, "_title_index_dir", lambda: missing):
            with self.assertLogs(_search.log.name, level="INFO") as cm:
                vocab = _search._build_vocab()
        self.assertEqual(vocab, {})
        self.assertTrue(any("vocab" in msg.lower() for msg in cm.output))


class VocabStrideSamplingTests(unittest.TestCase):
    """A file bigger than the row cap is sampled across its WHOLE length
    (stride, not a contiguous prefix) — a file at or under the cap is read
    in full, same as before stride sampling existed."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-stride-")
        self._patch_dir = mock.patch.object(_search, "_title_index_dir", lambda: self.tmp)
        self._patch_dir.start()
        _search._reset_vocab()

    def tearDown(self):
        self._patch_dir.stop()
        _search._reset_vocab()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_large_file_samples_across_whole_file(self):
        # 20 rows (rowid 1-20), cap patched to 5 → k = ceil(20/5) = 4 →
        # sampled rowid % 4 == 0, i.e. rowid {4,8,12,16,20} → 0-indexed
        # rows {3,7,11,15,19}. Each distinguishing word is duplicated within
        # its own title so it survives the final singleton prune regardless
        # of stride, isolating the sampling behavior under test.
        titles = [f"RowWord{i:03d} RowWord{i:03d} Common" for i in range(20)]
        _make_title_index(self.tmp, "wikipedia", titles)
        with mock.patch.object(_search, "_VOCAB_MAX_ROWS_PER_FILE", 5):
            vocab = _search._build_vocab()
        for i in (3, 7, 11, 15, 19):
            self.assertIn(f"rowword{i:03d}", vocab)
        # Never sampled...
        for i in (0, 1, 2, 4, 5, 6, 18):
            self.assertNotIn(f"rowword{i:03d}", vocab)
        # ...and critically, the LAST row (19) is present — a contiguous
        # prefix scan bounded to 5 rows could never have reached it.
        self.assertIn("rowword019", vocab)

    def test_small_file_stride_is_one_full_scan(self):
        # File well under the cap → k=1 → every row read, exactly like a
        # plain unfiltered scan (no sampling gaps).
        titles = ["Alpha Alpha", "Bravo Bravo", "Charlie Charlie"]
        _make_title_index(self.tmp, "wikipedia", titles)
        with mock.patch.object(_search, "_VOCAB_MAX_ROWS_PER_FILE", 1000):
            vocab = _search._build_vocab()
        self.assertIn("alpha", vocab)
        self.assertIn("bravo", vocab)
        self.assertIn("charlie", vocab)

    def test_stride_helper_k_one_for_small_table(self):
        db_path = _make_title_index(self.tmp, "small", ["Only Only Title"])
        conn = sqlite3.connect(db_path)
        try:
            self.assertEqual(_search._vocab_stride(conn, 1000), 1)
        finally:
            conn.close()

    def test_stride_helper_k_scales_with_row_count(self):
        db_path = _make_title_index(self.tmp, "big", [f"T{i}" for i in range(1000)])
        conn = sqlite3.connect(db_path)
        try:
            self.assertEqual(_search._vocab_stride(conn, 100), 10)
        finally:
            conn.close()

    def test_stride_helper_falls_back_to_one_on_empty_table(self):
        db_path = _make_title_index(self.tmp, "empty", [])
        conn = sqlite3.connect(db_path)
        try:
            self.assertEqual(_search._vocab_stride(conn, 100), 1)
        finally:
            conn.close()


class VocabLossyCountingTests(unittest.TestCase):
    """Hitting the word cap sweeps out singletons instead of freezing the
    vocab — words seen later in the scan can still be counted, and only a
    truly unproductive sweep (saturation) stops the scan for good."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-dym-lossy-")
        self._patch_dir = mock.patch.object(_search, "_title_index_dir", lambda: self.tmp)
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

    def test_cap_evicts_but_never_stops_the_scan(self):
        # THE coverage-promise regression guard. Five singleton words fill a
        # word cap of 5; the 5th admission triggers a tiered sweep. Unlike the
        # old saturation-stop, the scan MUST continue — so "later", which
        # appears (three times, to clear the final singleton prune) only in a
        # row read AFTER the eviction, must land in the vocab. This is exactly
        # the "mitochondria only shows up once the later indexes are scanned"
        # case, in miniature.
        titles = [
            "Aaa",
            "Bbb",
            "Ccc",
            "Ddd",
            "Eee",  # 5th distinct singleton → hits cap of 5, triggers eviction
            "Later Later Later",  # read only after the sweep — must be admitted
        ]
        _make_title_index(self.tmp, "wikipedia", titles)
        with (
            mock.patch.object(_search, "_VOCAB_MAX_WORDS", 5),
            mock.patch.object(_search, "_VOCAB_FETCH_BATCH_SIZE", 1),
        ):
            vocab = _search._build_vocab()
        # The singletons were swept (and pruned) — but the post-eviction word
        # was still counted, proving the scan did not stop.
        self.assertEqual(vocab.get("later"), 3)

    def test_admissions_freeze_when_eviction_cannot_free_room(self):
        # A vocab of nothing but high-count words: the sweep can't free the
        # required room even at the top tier, so NEW words stop being admitted
        # — but existing words keep counting and every row is still read.
        # 19 words pre-seeded to a count above every eviction tier, then a new
        # word appears after the cap is hit; it must be refused admission,
        # while an already-known word seen again afterward must still increment.
        titles = [f"W{i:02d} W{i:02d} W{i:02d} W{i:02d}" for i in range(19)]
        titles.append("Newword")  # 20th distinct → hits cap, can't free → frozen
        titles.append("W00")  # already known → must still be counted (5th time)
        _make_title_index(self.tmp, "wikipedia", titles)
        with (
            mock.patch.object(_search, "_VOCAB_MAX_WORDS", 20),
            mock.patch.object(_search, "_VOCAB_EVICT_MAX_TIER", 3),
            mock.patch.object(_search, "_VOCAB_FETCH_BATCH_SIZE", 1),
        ):
            vocab = _search._build_vocab()
        self.assertNotIn("newword", vocab)  # admission frozen
        self.assertEqual(
            vocab.get("w00"), 5
        )  # existing word still counted after freeze

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
            mock.patch.object(_search, "_title_index_dir", lambda: self.index_dir),
            mock.patch.object(_search, "_vocab_cache_path", lambda: self.cache_path),
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

    def test_prior_version_cache_on_disk_invalidated_by_version_bump(self):
        # The exact real-world case behind the 1.8.1 coverage promise: a cache
        # from the previous builder (the saturating-cap algorithm that dropped
        # spread-thin words) already sitting on disk when the current code
        # starts up. It must not be loaded — the algorithm producing "words"
        # changed, even though the indexes on disk did not — so production
        # re-scans once and picks up the previously-missing words.
        with mock.patch.object(
            _search, "_VOCAB_BUILDER_VERSION", _search._VOCAB_BUILDER_VERSION - 1
        ):
            prior_sig = _search._vocab_signature(self.index_dir)
            _search._vocab_cache_save({"python": 4}, prior_sig)
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
        self._patch_dir = mock.patch.object(_search, "_title_index_dir", lambda: self.tmp)
        self._patch_dir.start()
        self._patch_cache = mock.patch.object(
            _search,
            "_vocab_cache_path",
            lambda: os.path.join(self.tmp, "dym_vocab.json"),
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
                mock.patch.object(_search, "_title_index_dir", lambda: empty),
                mock.patch.object(
                    _search,
                    "_vocab_cache_path",
                    lambda: os.path.join(empty, "dym_vocab.json"),
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


class EditDistanceTests(unittest.TestCase):
    """The bounded Levenshtein used to verify trigram candidates."""

    def test_zero_distance(self):
        self.assertEqual(_search._edit_distance_le2("photo", "photo"), 0)

    def test_one_and_two(self):
        self.assertEqual(_search._edit_distance_le2("photo", "photto"), 1)  # 1 insert
        self.assertEqual(
            _search._edit_distance_le2("fotosynthesis", "photosynthesis"), 2
        )

    def test_caps_at_three(self):
        # Far-apart strings never report a real distance, just the >2 sentinel.
        self.assertEqual(_search._edit_distance_le2("cat", "elephant"), 3)
        self.assertEqual(_search._edit_distance_le2("abcdefg", "hijklmn"), 3)

    def test_length_gap_short_circuits(self):
        self.assertEqual(_search._edit_distance_le2("ab", "abcde"), 3)


class TrigramIndexTests(unittest.TestCase):
    """The trigram inverted index only covers long words and finds
    distance-2 corrections an exhaustive edit-2 scan would skip for length."""

    def tearDown(self):
        _search._trigram_index = None

    def test_index_only_holds_long_words(self):
        vocab = {"photosynthesis": 10, "cat": 5, "python": 3, "database": 7}
        idx = _search._build_trigram_index(vocab)
        # "database" (8) and "photosynthesis" (14) are indexed; "cat"/"python"
        # (< _TRIGRAM_MIN_LEN) are not.
        indexed = {w for posting in idx.values() for w in posting}
        self.assertIn("photosynthesis", indexed)
        self.assertIn("database", indexed)
        self.assertNotIn("cat", indexed)
        self.assertNotIn("python", indexed)

    def test_trigrams_helper(self):
        self.assertEqual(_search._trigrams("abcd"), {"abc", "bcd"})
        self.assertEqual(_search._trigrams("ab"), {"ab"})  # short-circuit

    def test_long_word_distance2_correction(self):
        # THE dist-2 promise case: "fotosynthesis" -> "photosynthesis" (two
        # edits, 13/14 chars — too long for the exhaustive edit-2 path).
        vocab = {
            "photosynthesis": 100,
            "photosynthetic": 20,
            "mitochondria": 50,
            "encyclopedia": 80,
        }
        _search._rebuild_trigram_index(vocab)
        self.assertEqual(
            _search._best_correction("fotosynthesis", vocab), "photosynthesis"
        )

    def test_long_word_correction_via_did_you_mean(self):
        vocab = {"photosynthesis": 100, "chlorophyll": 40}
        _search._rebuild_trigram_index(vocab)
        deadline = time.monotonic() + 1.0
        self.assertEqual(
            _search._did_you_mean("fotosynthesis", vocab, deadline),
            "photosynthesis",
        )

    def test_long_word_no_index_fails_soft(self):
        # No trigram index (never built) → long-word dist-2 is simply skipped,
        # never raising, returning None.
        _search._trigram_index = None
        vocab = {"photosynthesis": 100}
        self.assertIsNone(_search._best_correction("fotosynthesis", vocab))

    def test_frequency_breaks_ties_among_near_long_words(self):
        # Two long vocab words are each EXACTLY distance 2 from the typo (the
        # two-char suffix differs), and distance 2 from each other, so neither
        # is reachable by the distance-1 path — the trigram path must choose,
        # and the far more common one wins.
        vocab = {"helloworldaa": 900, "helloworldbb": 3}
        _search._rebuild_trigram_index(vocab)
        out = _search._best_correction("helloworldxx", vocab)
        self.assertEqual(out, "helloworldaa")  # frequency wins the tie

    def test_index_caps_to_highest_count_long_words(self):
        # With the per-index word cap lowered, only the highest-count long
        # words are indexed — a rare long word is excluded, a common one kept —
        # so query latency stays flat as the vocab's low-count tail grows.
        vocab = {
            "photosynthesis": 500,  # common → indexed
            "electroencephalography": 3,  # rare long word → dropped by the cap
            "biodiversity": 400,  # common → indexed
        }
        with mock.patch.object(_search, "_TRIGRAM_MAX_INDEX_WORDS", 2):
            idx = _search._build_trigram_index(vocab)
        indexed = {w for posting in idx.values() for w in posting}
        self.assertIn("photosynthesis", indexed)
        self.assertIn("biodiversity", indexed)
        self.assertNotIn("electroencephalography", indexed)

    def test_reset_clears_trigram_index(self):
        _search._rebuild_trigram_index({"photosynthesis": 5})
        self.assertIsNotNone(_search._trigram_index)
        _search._reset_vocab()
        self.assertIsNone(_search._trigram_index)


if __name__ == "__main__":
    unittest.main()
