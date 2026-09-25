"""The article whose title is what you typed comes first.

Found on the NAS library: `Albert Einstein` put "List of things named after
Albert Einstein" first and left English Wikipedia's "Albert Einstein" out of
the results altogether. Three things lined up: the full search asks each ZIM's
Xapian index, which ranks the list above the article and cuts off at the
limit; the quick title pass scans titles starting with the first word
alphabetically and runs out of rows among the thousands of "Albert ..."
before it reaches "Albert Einstein"; and the scorer gave any title containing
the phrase the same score as the title that is the phrase.
"""

import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import search as _search  # noqa: E402
from zimi import server as _server  # noqa: E402

ARTICLE = ("Albert_Einstein", "Albert Einstein")
LIST = ("List_of_things_named_after_Albert_Einstein", "List of things named after Albert Einstein")


def _title_index(path, titles):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE titles (path TEXT PRIMARY KEY, title TEXT, title_lower TEXT)")
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.executemany("INSERT INTO titles VALUES (?,?,?)", [(p, t, t.lower()) for p, t in titles])
    conn.execute("CREATE INDEX idx_prefix ON titles(title_lower)")
    conn.commit()
    conn.close()


class ExactTitleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-exact-")
        self.db = os.path.join(self.tmp, "wikipedia.db")
        # Far more "Albert ..." titles ahead of Einstein than any scan reads.
        albert = [(f"Albert_A{i:04d}", f"Albert A{i:04d}") for i in range(3000)]
        _title_index(self.db, albert + [ARTICLE, LIST, ("Einstein_ring", "Einstein ring")])
        self.patches = [
            mock.patch.object(_server, "_title_index_path", lambda name: self.db),
        ]
        for p in self.patches:
            p.start()
        _search._close_title_db("wikipedia")

    def tearDown(self):
        _search._close_title_db("wikipedia")
        for p in self.patches:
            p.stop()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_title_that_is_the_query_outscores_one_that_contains_it(self):
        exact = _search._score_result("Albert Einstein", ["albert", "einstein"], 5, 1_000_000)
        containing = _search._score_result(LIST[1], ["albert", "einstein"], 0, 1_000_000)
        self.assertGreater(exact, containing)

    def test_the_quick_title_pass_finds_the_exact_title_first(self):
        results = _search._title_index_search("wikipedia", "Albert Einstein", limit=5)
        self.assertTrue(results)
        self.assertEqual(results[0]["path"], ARTICLE[0])

    def test_the_full_search_includes_the_exact_title(self):
        """Xapian returned only the list; the article still leads."""
        with (
            mock.patch.object(_server, "get_zim_files", lambda: {"wikipedia": "/nowhere/wikipedia.zim"}),
            mock.patch.object(_server, "_zim_list_cache", [{"name": "wikipedia", "entries": 1_000_000, "language": "en"}]),
            mock.patch.object(_search, "_get_fts_archive", lambda name: (object(), threading.Lock())),
            mock.patch.object(
                _search, "search_zim", lambda *a, **k: [{"path": LIST[0], "title": LIST[1], "snippet": ""}]
            ),
            mock.patch.object(_search, "_search_places", lambda *a, **k: []),
        ):
            result = _search.search_all("Albert Einstein", limit=5)
        paths = [r["path"] for r in result["results"]]
        self.assertIn(ARTICLE[0], paths)
        self.assertEqual(paths[0], ARTICLE[0])


if __name__ == "__main__":
    unittest.main()


class QuickSearchCandidatesTests(unittest.TestCase):
    """The quick search looks through the titles that start with the first
    word for the others. It read 200 table rows per ZIM to do it (4 to 5 s
    over the NAS's 78 ZIMs for a first word not in the page cache), and a
    match past the 200th never showed. It now filters on the prefix index
    and reads the table only for matches."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-quick-")
        self.db = os.path.join(self.tmp, "wikipedia.db")
        many = [(f"Albert_A{i:04d}", f"Albert A{i:04d}") for i in range(1500)]
        _title_index(self.db, many + [("Albert_zebra_stripes", "Albert zebra stripes")])
        self.patch = mock.patch.object(_server, "_title_index_path", lambda name: self.db)
        self.patch.start()
        _search._close_title_db("wikipedia")

    def tearDown(self):
        _search._close_title_db("wikipedia")
        self.patch.stop()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_match_past_the_old_window_is_found(self):
        titles = [r["title"] for r in _search._title_index_search("wikipedia", "albert stripes")]
        self.assertEqual(titles, ["Albert zebra stripes"])

    def test_every_other_word_must_be_in_the_title(self):
        self.assertEqual(_search._title_index_search("wikipedia", "albert stripes tiger"), [])
