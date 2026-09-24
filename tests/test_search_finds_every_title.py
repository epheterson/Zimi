"""Every title in a ZIM can be found by searching for it, through the server.

Search broke in ways no lower-level test saw. 1.10.2 stopped sending a quick
search with no title-index match to libzim's suggestions (they were slow), and
the title index had never held redirects, so an article's other names found
nothing: "العائلة اللغوية" for "أسرة لغات" (#86, found by a user comparing
with Kiwix). The index was right about what it held, and the search was right
about using it; together they lost every redirect.

So these tests hold the promise itself, end to end: a real server, a real ZIM
with articles and redirects in four scripts, the title index built the way
startup builds it, and HTTP /search asked for every title. And libzim's own
suggestions are the oracle for what "can be found" means: whatever they find
for a query by the start of a title, Zimi's quick search must find too.
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import _Article  # noqa: E402

ZIM = "titles"

# (path, title, body) for articles; long enough to be real pages.
ARTICLES = [
    ("A/Language_family", "Language family"),
    ("A/Water_purification", "Water purification"),
    ("A/Albert_Einstein", "Albert Einstein"),
    ("A/أسرة_لغات", "أسرة لغات"),
    ("A/Языковая_семья", "Языковая семья"),
    ("A/语系", "语系"),
]
# (path, title, target path): an article's other names.
REDIRECTS = [
    ("A/Language_families", "Language families", "A/Language_family"),
    ("A/Purifying_water", "Purifying water", "A/Water_purification"),
    ("A/Einstein", "Einstein", "A/Albert_Einstein"),
    ("A/العائلة_اللغوية", "العائلة اللغوية", "A/أسرة_لغات"),
    ("A/أسر_اللغات", "أسر اللغات", "A/أسرة_لغات"),
    ("A/عائلة_لغوية", "عائلة لغوية", "A/أسرة_لغات"),
    ("A/Семья_языков", "Семья языков", "A/Языковая_семья"),
    ("A/语言系属", "语言系属", "A/语系"),
]


def _build(path):
    from libzim.writer import Creator

    with Creator(path).config_indexing(True, "eng") as c:
        c.set_mainpath(ARTICLES[0][0])
        for p, title in ARTICLES:
            body = (
                "<html><head><title>%s</title></head><body><h1>%s</h1><p>%s</p></body></html>"
                % (title, title, "Text of the article. " * 20)
            ).encode()
            c.add_item(_Article(p, title, body))
        for p, title, target in REDIRECTS:
            c.add_redirection(p, title, target, {})
        c.add_metadata("Title", "Every title")
        c.add_metadata("Language", "eng")
        c.add_metadata("Description", "articles and their other names")


class SearchFindsEveryTitle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        import zimi
        from zimi import search

        cls._tmp = tempfile.mkdtemp(prefix="zimi-every-title-")
        cls._zim = os.path.join(cls._tmp, ZIM + ".zim")
        _build(cls._zim)
        os.environ["ZIM_DIR"] = cls._tmp
        zimi.ZIM_DIR = cls._tmp
        zimi.ZIMI_DATA_DIR = os.path.join(cls._tmp, ".zimi")
        os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
        zimi.load_cache()
        # The way startup builds them: all indexes, through the same entry.
        search._build_all_title_indexes()
        assert os.path.exists(search._title_index_path(ZIM)), "no title index was built"
        search._suggest_cache_clear()
        cls._srv = ThreadingHTTPServer(("127.0.0.1", 0), zimi.ZimHandler)
        threading.Thread(target=cls._srv.serve_forever, daemon=True).start()
        cls._base = "http://127.0.0.1:%d" % cls._srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        from zimi import search

        cls._srv.shutdown()
        search._close_title_db(ZIM)
        search._suggest_cache_clear()
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _paths(self, q, fast):
        url = "%s/search?%s" % (
            self._base,
            urllib.parse.urlencode({"q": q, "limit": 50, "fast": int(fast)}),
        )
        with urllib.request.urlopen(url) as resp:
            body = json.load(resp)
        return {r["path"] for r in body.get("results", [])}

    def test_every_title_finds_its_entry_in_the_quick_search(self):
        missing = []
        for path, title, *_ in ARTICLES + REDIRECTS:
            if path not in self._paths(title, fast=True):
                missing.append(title)
        self.assertEqual(missing, [], "titles the quick search cannot find")

    def test_every_title_is_found_by_search_as_the_page_runs_it(self):
        """The page asks the quick search and then the full one; what a person
        sees is the two together."""
        missing = []
        for path, title, *_ in ARTICLES + REDIRECTS:
            if path not in self._paths(title, fast=True) | self._paths(
                title, fast=False
            ):
                missing.append(title)
        self.assertEqual(missing, [], "titles a person searching cannot find")

    def _libzim_gaps(self, prefix_only):
        """{query: [paths]} libzim's suggestions find and the quick search does
        not. With prefix_only, only suggestions whose title starts with the
        query count: the quick search's promise today."""
        from libzim.reader import Archive
        from libzim.suggestion import SuggestionSearcher

        archive = Archive(self._zim)
        searcher = SuggestionSearcher(archive)
        queries = [t for _, t, *_ in ARTICLES + REDIRECTS]
        queries += sorted({t.split()[0] for t in queries})  # first words alone
        gaps = {}
        for q in queries:
            s = searcher.suggest(q)
            oracle = set(s.getResults(0, s.getEstimatedMatches()))
            if prefix_only:
                oracle = {p for p in oracle if archive.get_entry_by_path(p).title.lower().startswith(q.lower())}
            lost = oracle - self._paths(q, fast=True)
            if lost:
                gaps[q] = sorted(lost)
        return gaps

    def test_whatever_libzim_suggests_by_its_start_the_quick_search_finds(self):
        self.assertEqual(self._libzim_gaps(prefix_only=True), {}, "libzim suggests these and Zimi's quick search does not")

    @unittest.expectedFailure
    def test_whatever_libzim_suggests_anywhere_the_quick_search_finds(self):
        """Not yet: libzim matches a word anywhere in a title, stemmed
        ("Einstein" finds "Albert Einstein", "Language families" finds
        "Language family"); the quick search matches titles that start with
        the first word, and the full search behind it finds the rest. When the
        quick search matches words anywhere, this passes and the marker goes."""
        self.assertEqual(self._libzim_gaps(prefix_only=False), {})


class ASearchBeforeTheIndexIsNotKept(unittest.TestCase):
    """A search in the seconds before startup built a ZIM's title index was
    answered from the no-index fallback, and the quick search's cache kept
    that answer for 15 minutes after the index was ready. The release gate
    found it: its first search for an article's other name came in early."""

    def setUp(self):
        import zimi
        from zimi import search

        self.tmp = tempfile.mkdtemp(prefix="zimi-early-search-")
        _build(os.path.join(self.tmp, ZIM + ".zim"))
        os.environ["ZIM_DIR"] = self.tmp
        zimi.ZIM_DIR = self.tmp
        zimi.ZIMI_DATA_DIR = os.path.join(self.tmp, ".zimi")
        os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
        zimi.load_cache()
        search._close_title_db(ZIM)
        search._suggest_cache_clear()

    def tearDown(self):
        from zimi import search

        search._close_title_db(ZIM)
        search._suggest_cache_clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_index_answers_once_it_is_built(self):
        """Through HTTP: the server caches whole responses too, and the first
        version of this fix, tested one layer down, missed that cache."""
        from http.server import ThreadingHTTPServer

        import zimi
        from zimi import search

        srv = ThreadingHTTPServer(("127.0.0.1", 0), zimi.ZimHandler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = "http://127.0.0.1:%d/search?%s" % (
                srv.server_address[1],
                urllib.parse.urlencode({"q": "Purifying water", "limit": 20, "fast": 1}),
            )

            def paths():
                with urllib.request.urlopen(url) as resp:
                    return {r["path"] for r in json.load(resp).get("results", [])}

            paths()  # before the index: the fallback's answer, cached
            search._build_all_title_indexes()
            self.assertIn("A/Purifying_water", paths())
        finally:
            srv.shutdown()


class QuickSearchStaysOnTheIndex(unittest.TestCase):
    """The quick search's multi-word query reads the prefix index and the table
    only for matches. Reading 200 table rows per ZIM took 4 to 7 s on the NAS
    for a word not in the page cache; this pins the plan, not a timing."""

    def test_the_multi_word_query_scans_the_covering_index(self):
        import sqlite3

        from zimi import search

        tmp = tempfile.mkdtemp(prefix="zimi-plan-")
        try:
            db = os.path.join(tmp, "t.db")
            conn = sqlite3.connect(db)
            conn.execute(
                "CREATE TABLE titles (path TEXT PRIMARY KEY, title TEXT, title_lower TEXT)"
            )
            conn.execute("CREATE INDEX idx_prefix ON titles(title_lower)")
            conn.commit()
            seen = []
            conn.set_trace_callback(seen.append)
            real = search._get_title_db
            search._get_title_db = lambda name: conn
            try:
                search._title_index_search("t", "store rice long")
            finally:
                search._get_title_db = real
            multi = [s for s in seen if "JOIN titles" in s]
            self.assertEqual(len(multi), 1, seen)
            plan = " | ".join(
                r[-1] for r in conn.execute("EXPLAIN QUERY PLAN " + multi[0])
            )
            self.assertIn("COVERING INDEX idx_prefix", plan)
            conn.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
