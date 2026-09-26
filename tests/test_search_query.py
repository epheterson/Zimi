"""The search grammar (#94): the parser, and the library search that uses it.

The parser cases live in tests/fixtures/search_query_cases.json and are read
by tests/test_search_query.cjs too, so the catalog (JavaScript) and the
server (Python) cannot drift apart.

The search tests run over a real ZIM built here with libzim, because the
point is what libzim itself does with the query: it ignores "-", quotes and
OR entirely (checked below), so every operator is Zimi's to apply.
"""

import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from libzim.search import Query, Searcher
from libzim.reader import Archive

from zimi import query as Q

CASES = os.path.join(os.path.dirname(__file__), "fixtures", "search_query_cases.json")


def _show(term):
    return f'"{term["text"]}"' if term["phrase"] else term["text"]


class TestParser(unittest.TestCase):
    def setUp(self):
        with open(CASES, encoding="utf-8") as f:
            self.cases = json.load(f)

    def test_parse_cases(self):
        for case in self.cases["parse"]:
            with self.subTest(q=case["q"]):
                got = Q.parse_query(case["q"])
                self.assertEqual(
                    [[_show(t) for t in g] for g in got["groups"]], case["groups"]
                )
                self.assertEqual([_show(t) for t in got["exclude"]], case["exclude"])
                self.assertEqual(
                    [[f["key"], f["value"], f["negate"]] for f in got["filters"]],
                    case["filters"],
                )
                self.assertEqual(got["plain"], case["plain"])

    def test_match_cases(self):
        for case in self.cases["match"]:
            with self.subTest(q=case["q"], text=case["text"]):
                self.assertEqual(
                    Q.matches(Q.parse_query(case["q"]), case["text"]), case["match"]
                )

    def test_alternatives_expand_and_cap(self):
        alts = Q.alternatives(Q.parse_query("pet cats OR dogs food"))
        self.assertEqual(
            [Q.term_words(a) for a in alts], ["pet cats food", "pet dogs food"]
        )
        many = Q.alternatives(Q.parse_query("a OR b OR c c2 d OR e OR f"))
        self.assertEqual(len(many), Q.MAX_ALTERNATIVES)
        self.assertEqual(Q.alternatives(Q.parse_query("-ted")), [])


_ARTICLES = [
    (
        "A/Common_law",
        "Common law",
        "The common law of England grew from custom and court rulings.",
    ),
    (
        "A/Law_of_the_sea",
        "Law of the sea",
        "The law of the sea governs ships and common waters.",
    ),
    (
        "A/Contract_law",
        "Contract law",
        "Contract law enforces promises; a law of agreements.",
    ),
    (
        "A/TED_talks",
        "TED talks about law",
        "Talks on law and justice from the TED stage.",
    ),
    ("A/Martial_law", "Martial law", "Martial law replaces civil law in an emergency."),
    ("A/Whale", "Whale", "Whales are marine mammals."),
    ("A/Dolphin", "Dolphin", "Dolphins are marine mammals too."),
]


def _build_zim(path):
    from tests.conftest_zim import _Article
    from libzim.writer import Creator

    with Creator(path).config_indexing(True, "eng") as c:
        c.set_mainpath("A/Whale")
        for p, title, text in _ARTICLES:
            html = f"<html><head><title>{title}</title></head><body><p>{text}</p></body></html>"
            c.add_item(_Article(p, title, html.encode()))
        for k, v in (("Title", "Law test"), ("Language", "eng"), ("Name", "lawtest")):
            c.add_metadata(k, v)


class TestLibraryOperators(unittest.TestCase):
    """search_all over a real ZIM: both the title-index (fast) and the
    full-text phase apply exclusions, phrases, OR and the source filter."""

    @classmethod
    def setUpClass(cls):
        import zimi.server as S
        from zimi import search as Sr

        cls.S, cls.Sr = S, Sr
        cls.tmp = tempfile.mkdtemp()
        cls.zim = os.path.join(cls.tmp, "lawtest_en_2026-01.zim")
        _build_zim(cls.zim)
        cls.name = "lawtest_en"
        cls.files = {cls.name: cls.zim}
        cls.patches = [
            patch.object(S, "get_zim_files", return_value=cls.files),
            patch.object(S, "ZIMI_DATA_DIR", cls.tmp),
            # Sparse results ask did-you-mean, whose vocabulary builds in the
            # background and outlives the temp dir.
            patch.object(Sr, "_maybe_did_you_mean", return_value=None),
            patch.object(
                S,
                "_zim_list_cache",
                [
                    {
                        "name": cls.name,
                        "entries": 7,
                        "language": "en",
                        "title": "Law test",
                    }
                ],
            ),
        ]
        for p in cls.patches:
            p.start()
        Sr._build_title_index(cls.name, cls.zim)

    @classmethod
    def tearDownClass(cls):
        for p in cls.patches:
            p.stop()
        cls.Sr._close_title_db(cls.name)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.Sr._suggest_cache.clear()

    def titles(self, q, fast):
        return [
            r["title"] for r in self.S.search_all(q, limit=10, fast=fast)["results"]
        ]

    def test_libzim_ignores_the_operators(self):
        # Why Zimi applies them itself: libzim's parser treats all of these
        # as plain words, so passing them through was never enough.
        s = Searcher(Archive(self.zim))

        def paths(q):
            r = s.search(Query().set_query(q))
            return set(r.getResults(0, r.getEstimatedMatches()))

        self.assertEqual(paths("law -contract"), paths("law contract"))

    def test_exclusion_both_phases(self):
        for fast in (True, False):
            with self.subTest(fast=fast):
                got = self.titles("law -contract", fast)
                self.assertNotIn("Contract law", got)
                self.assertTrue(any("law" in t.lower() for t in got), got)

    def test_exclusion_is_word_start(self):
        got = self.titles("law -ted", False)
        self.assertNotIn("TED talks about law", got)
        self.assertIn("Common law", got)

    def test_phrase_both_phases(self):
        for fast in (True, False):
            with self.subTest(fast=fast):
                self.assertEqual(self.titles('"common law"', fast), ["Common law"])

    def test_or_both_phases(self):
        for fast in (True, False):
            with self.subTest(fast=fast):
                got = set(self.titles("whale OR dolphin", fast))
                self.assertEqual(got, {"Whale", "Dolphin"})

    def test_hyphenated_word_is_not_an_exclusion(self):
        self.assertFalse(Q.parse_query("e-mail")["exclude"])

    def test_source_filter(self):
        self.assertTrue(self.titles("whale in:lawtest", False))
        self.assertEqual(self.titles("whale in:wikipedia", False), [])
        self.assertEqual(self.titles("whale -in:lawtest", False), [])
        self.assertTrue(self.titles("whale lang:en", False))
        self.assertEqual(self.titles("whale lang:fr", False), [])

    def test_only_exclusions_find_nothing(self):
        for fast in (True, False):
            self.assertEqual(self.titles("-law", fast), [])

    def test_plain_query_unchanged(self):
        for fast in (True, False):
            self.assertIn("Whale", self.titles("whale", fast))


if __name__ == "__main__":
    unittest.main()
