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
import unittest.mock
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

    def test_exclude_cases(self):
        # #94: "-wiki doesn't seem to work". MediaWiki goes; Sabdkosh
        # ("Wiktionary in Fiji Hindi Language") stays, since wik-tionary
        # does not contain "wiki"; and -ted still keeps "United States".
        for case in self.cases["exclude"]:
            with self.subTest(term=case["term"], text=case["text"]):
                parsed = Q.parse_query("-" + case["term"])
                self.assertEqual(Q.excluded(parsed, case["text"]), case["excluded"])

    def test_alternatives_add_up_so_every_word_is_searched(self):
        def words(q, cap=Q.MAX_SEARCHES):
            return [Q.term_words(a) for a in Q.alternatives(Q.parse_query(q), cap)]

        self.assertEqual(
            words("pet cats OR dogs food"), ["pet cats food", "pet dogs food"]
        )
        # Five alternatives are five searches: the fifth was never searched
        # while the chip listed it.
        self.assertEqual(words("a OR b OR c OR d OR e"), ["a", "b", "c", "d", "e"])
        # Two ORs: each word first, then the rest of the combinations.
        self.assertEqual(
            words("cats OR dogs food OR toys"),
            ["cats food", "dogs food", "cats toys", "dogs toys"],
        )
        many = words("a OR b OR c c2 d OR e OR f")
        self.assertEqual(many[:5], ["a c2 d", "b c2 d", "c c2 d", "a c2 e", "a c2 f"])
        self.assertLessEqual(len(many), Q.MAX_SEARCHES)
        self.assertEqual(Q.alternatives(Q.parse_query("-ted")), [])

    def test_past_the_budget_the_alternatives_left_out_are_named(self):
        parsed = Q.parse_query(
            " OR ".join("w%d" % i for i in range(Q.MAX_SEARCHES + 2))
        )
        alts = Q.alternatives(parsed)
        self.assertEqual(len(alts), Q.MAX_SEARCHES)
        self.assertEqual(
            [t["text"] for t in Q.unsearched(parsed, alts)],
            ["w%d" % Q.MAX_SEARCHES, "w%d" % (Q.MAX_SEARCHES + 1)],
        )
        small = Q.parse_query("a OR b")
        self.assertEqual(Q.unsearched(small, Q.alternatives(small)), [])

    def test_a_suggestion_mends_the_words_and_keeps_the_operators(self):
        import time

        from zimi import search as Sr

        vocab = {"python": 10, "javascript": 3, "asyncio": 2, "cafe": 4}
        got = Sr._did_you_mean(
            'pyhton -javascrpt "asynico" OR cafee lang:en in:pyhton',
            vocab,
            time.monotonic() + 1,
        )
        self.assertEqual(got, 'python -javascrpt "asyncio" OR cafe lang:en in:pyhton')


class TestLangFilter(unittest.TestCase):
    """lang: in the library means what it means in the catalog: the same
    cases (the fixture's "lang", which test_search_query.cjs runs through
    the catalog's filter) over the one language table."""

    def test_lang_cases(self):
        from zimi import search as Sr
        from zimi import server as S

        with open(CASES, encoding="utf-8") as f:
            cases = json.load(f)["lang"]
        for case in cases:
            zims = [{"name": "z", "language": case["language"]}]
            for neg in (False, True):
                with (
                    self.subTest(case=case, negate=neg),
                    patch.object(S, "_zim_list_cache", zims),
                ):
                    parsed = {
                        "filters": [
                            {"key": "lang", "value": case["value"], "negate": neg}
                        ]
                    }
                    kept = Sr._filter_sources(parsed, ["z"]) == ["z"]
                    self.assertEqual(kept, case["match"] != neg)

    def test_one_table_for_both_sides(self):
        from zimi import http as H
        from zimi import server as S

        with open(S.LANG_CODES_PATH, encoding="utf-8") as f:
            table = json.load(f)
        self.assertEqual(S._ISO639_3_TO_1, table)
        self.assertGreater(len(table), 150, "every language with a two-letter code")
        # The client's is the same table, put in as app.js is served; the
        # file itself carries none of its own.
        served = json.dumps(table, separators=(",", ":"), sort_keys=True)
        self.assertIn("const _LANG3TO2 = %s;" % served, H.APP_JS_REWRITTEN)
        with open(
            os.path.join(os.path.dirname(H.__file__), "static", "app.js"),
            encoding="utf-8",
        ) as f:
            src = f.read()
        self.assertIn("const _LANG3TO2 = " + H._LANG_CODES_MARK + ";", src)
        self.assertNotIn("bul:'bg'", src)
        # Two letters back to three (a new ZIM's metadata) is one answer each.
        self.assertEqual(len(set(table.values())), len(table))


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

    def test_every_alternative_of_a_long_or_is_searched(self):
        # The fifth is what only it finds: Common law.
        q = "whale OR dolphin OR martial OR contract OR common"
        for fast in (True, False):
            with self.subTest(fast=fast):
                got = set(self.titles(q, fast))
                self.assertLessEqual(
                    {"Whale", "Dolphin", "Martial law", "Contract law", "Common law"},
                    got,
                )

    def test_an_or_past_the_budget_says_what_it_left_out(self):
        words = [
            "whale",
            "dolphin",
            "martial",
            "contract",
            "sea",
            "common",
            "ted",
            "talks",
            "law",
            "zebra",
        ]
        out = self.S.search_all(" OR ".join(words), limit=10, fast=False)
        self.assertEqual(out["unsearched"], words[Q.MAX_SEARCHES :])
        self.assertNotIn("unsearched", self.S.search_all("whale OR dolphin", limit=10))

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


class TestPlacesAndSuggestions(unittest.TestCase):
    """What the full search adds beside the results, for an operator query:
    places from every alternative, and a suggestion that keeps the operators."""

    def setUp(self):
        from zimi import search as Sr
        from zimi import server as S

        self.Sr = Sr
        lock = unittest.mock.MagicMock()
        places = {
            "paris": [{"name": "Paris", "lat": 48.9, "lng": 2.4, "score": 5}],
            "rome": [{"name": "Rome", "lat": 41.9, "lng": 12.5, "score": 4}],
            "texas": [{"name": "Paris, Texas", "lat": 33.7, "lng": -95.6, "score": 3}],
        }
        self.patches = [
            patch.object(S, "get_zim_files", return_value={"osm": "/fake.zim"}),
            patch.object(
                S,
                "_zim_list_cache",
                [
                    {
                        "name": "osm",
                        "title": "Map",
                        "entries": 9,
                        "language": "en",
                        "map_search": True,
                    }
                ],
            ),
            patch.object(Sr, "_get_fts_archive", return_value=(object(), lock)),
            patch.object(Sr, "search_zim", return_value=[]),
            patch.object(Sr, "_title_index_exact", return_value=[]),
            patch(
                "zimi.mapsearch.search_places",
                side_effect=lambda archive, q, limit=8: [
                    p for w in q.split() for p in places.get(w, [])
                ],
            ),
            # A sparse search asks for a suggestion: from this vocabulary,
            # not one built in the background from the machine's own data.
            patch.object(
                Sr,
                "_ensure_vocab",
                return_value={"python": 10, "asyncio": 2, "cafe": 4},
            ),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_places_come_from_every_alternative(self):
        out = self.Sr.search_all("paris OR rome", fast=False)
        names = [p["name"] for g in out.get("places", []) for p in g["places"]]
        self.assertEqual(names, ["Paris", "Rome"])
        out = self.Sr.search_all("paris texas -texas", fast=False)
        names = [p["name"] for g in out.get("places", []) for p in g["places"]]
        self.assertEqual(names, ["Paris"], "an exclusion leaves its place out")

    def test_a_sparse_operator_search_suggests_the_same_search_mended(self):
        out = self.Sr.search_all(
            'pyhton -javascrpt "asynico" OR cafee lang:en', fast=False
        )
        self.assertEqual(
            out.get("did_you_mean"), 'python -javascrpt "asyncio" OR cafe lang:en'
        )


if __name__ == "__main__":
    unittest.main()
