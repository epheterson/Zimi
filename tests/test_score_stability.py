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
