"""A question finds the article written in another form of its words.

The regression sweep (2026-11-04): "how to purify water" listed six
Gutenberg trial books and never the Survival ZIM's "Water purification".
The question's words reached the index as "purify water", and the index
stems "purify" and "purification" apart, so the one article about it did
not match at all; what did match were books that happen to say both words.
The index is now asked for the family of each word a question inflects ("purif*"),
and the title scorer counts "purification" as the "purify" asked for.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
from zimi import search as _search  # noqa: E402


def _words(q):
    return [w.lower() for w in _search._clean_query(q).split() if w.lower() not in _search.STOP_WORDS]


def test_the_question_reaches_the_article_in_another_form(tmp_path):
    from libzim.reader import Archive
    from libzim.search import Query, Searcher

    path = build_fixture_zim(str(tmp_path / "survival.zim"))
    q = "how to purify water"
    hits = Searcher(Archive(path)).search(Query().set_query(_search._index_query(q, _search._clean_query(q))))
    assert "A/Water" in list(hits.getResults(0, 10))


def test_the_title_that_answers_outranks_a_book_that_mentions_the_words():
    words = _words("how to purify water")
    answer = _search._score_result("Water purification", words, 3, 2_000)
    book = _search._score_result("Reports of Trials for Murder by Poisoning", words, 0, 80_000)
    assert answer > book, (answer, book)


def test_a_name_is_not_widened():
    """Only a question is: "Purify" typed alone, or a name, stays as typed."""
    for q in ("Purifying Fire", "water purification"):
        assert _search._index_query(q, _search._clean_query(q)) == _search._clean_query(q)


def test_short_and_doubled_s_words_stay_whole():
    q = "how do cats cross glass"
    asked = _search._index_query(q, _search._clean_query(q)).split()
    assert "cats" in asked and "glass" in asked, asked
