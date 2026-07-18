"""Cross-ZIM score must be deterministic.

SearXNG integration (#15-4) re-sorts across batches from different engines.
If `_score_result` ever returned different values for the same inputs (e.g.
someone added a time-based or random component), SearXNG's stable ordering
would silently break. Lock the determinism in."""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.search import _score_result  # noqa: E402


class ScoreStabilityTests(unittest.TestCase):
    def test_pure_function_repeated_calls_match(self):
        cases = [
            ("Python programming", ["python"], 0, 100_000, False),
            ("Water purification methods", ["water", "purification"], 2, 50_000, True),
            ("Random article", ["totally", "unrelated"], 5, 10, False),
            ("Exact phrase match here", ["match", "here"], 1, 1_000_000, True),
        ]
        for title, query_words, rank, entry_count, lang_match in cases:
            first = _score_result(title, query_words, rank, entry_count, lang_match)
            for _ in range(20):
                self.assertEqual(
                    _score_result(title, query_words, rank, entry_count, lang_match),
                    first,
                    f"score drifted across repeated calls for {title!r}",
                )
            self.assertIsInstance(first, float)
            self.assertFalse(math.isnan(first))
            self.assertGreaterEqual(first, 0.0)

    def test_score_ordering_is_meaningful(self):
        """Sanity checks on the score components — exact phrase beats partial,
        rank 0 beats rank 10, lang match beats no match. If any of these
        invert, ranking is broken regardless of stability."""
        exact = _score_result(
            "water purification", ["water", "purification"], 0, 1000, False
        )
        partial = _score_result(
            "water and electricity", ["water", "purification"], 0, 1000, False
        )
        self.assertGreater(exact, partial)

        top_rank = _score_result("anything", ["xyz"], 0, 1000, False)
        deep_rank = _score_result("anything", ["xyz"], 100, 1000, False)
        self.assertGreater(top_rank, deep_rank)

        lang = _score_result("water", ["water"], 0, 1000, True)
        no_lang = _score_result("water", ["water"], 0, 1000, False)
        self.assertGreater(lang, no_lang)


if __name__ == "__main__":
    unittest.main()


class TestCrossZimDedup(unittest.TestCase):
    """Same article installed via a bundle AND its subset must appear once,
    from the stronger source (list is pre-sorted by score)."""

    def test_same_title_across_zims_collapses_to_strongest(self):
        from zimi.search import _dedup_results_by_title

        results = [
            {"title": "Solar System", "zim": "wikipedia_en_all", "score": 120.0},
            {"title": "solar system ", "zim": "wikipedia_en_100", "score": 110.0},
            {"title": "Sun", "zim": "wikipedia_en_all", "score": 90.0},
        ]
        deduped = _dedup_results_by_title(results)
        self.assertEqual(len(deduped), 2)
        self.assertEqual(deduped[0]["zim"], "wikipedia_en_all")
        self.assertEqual(deduped[1]["title"], "Sun")

    def test_distinct_titles_survive(self):
        from zimi.search import _dedup_results_by_title

        results = [
            {"title": "Water", "zim": "a", "score": 2},
            {"title": "Water purification", "zim": "b", "score": 1},
        ]
        self.assertEqual(len(_dedup_results_by_title(results)), 2)
