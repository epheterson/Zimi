"""A seeded random pick is the same pick every time.

Book of the Day asks for `/random?zim=gutenberg&seed=<MMDD>`, so every browser
sees the same book all day. On the NAS five identical calls gave four books:
most of Gutenberg's entries are not pages, so the eight random indices missed,
and the prefix fallback shuffled its candidates with the unseeded module RNG.
"""

import os
import random
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import search as _search  # noqa: E402


class _Item:
    mimetype = "text/html"


class _Entry:
    is_redirect = False

    def __init__(self, path):
        self.path = path
        self.title = path

    def get_item(self):
        return _Item()


class _Archive:
    """No entries reachable by index, so every pick goes to the prefix fallback."""

    entry_count = 0
    article_count = 0

    def get_entry_by_path(self, path):
        return _Entry(path)


class _Suggestion:
    def __init__(self, prefix):
        self.paths = [f"{prefix}_book_{i}" for i in range(30)]

    def getEstimatedMatches(self):
        return len(self.paths)

    def getResults(self, start, count):
        return self.paths[start : start + count]


class _Searcher:
    def __init__(self, archive):
        pass

    def suggest(self, prefix):
        return _Suggestion(prefix)


def test_the_prefix_fallback_follows_the_seed():
    with mock.patch.object(_search, "SuggestionSearcher", _Searcher):
        picks = {
            _search.random_entry(_Archive(), rng=random.Random(922))["path"]
            for _ in range(6)
        }
    assert len(picks) == 1, picks
