"""/bestanswer against a real ZIM, served: the card's whole path.

A small real library (articles written for the questions below) behind a real
server. What is held here: a question gets the sentence that answers, quoted
exactly as the article has it; a keyword search and a question the library
cannot answer get no card and cost no reading; the same question twice reads
once; and the card never sits on the search's path.
"""

import json
import os
import sys
import threading
import urllib.parse
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.server as srv
    from conftest_zim import build_answer_fixture_zim, build_wiki_fixture_zim
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("best")
    zdir = tmp / "zims"
    zdir.mkdir()
    build_answer_fixture_zim(str(zdir / "wiki_en_test.zim"))
    build_wiki_fixture_zim(str(zdir / "almanac_en_test.zim"))  # a second source
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR, os.environ.get("ZIMI_OFFLINE"))
    os.environ["ZIMI_OFFLINE"] = "1"
    srv.ZIM_DIR = str(zdir)
    srv.ZIMI_DATA_DIR = str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    srv.load_cache(force=True)
    httpd = srv.ZimiHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv._search_cache_clear()
    from zimi import bestanswer

    bestanswer.cache_clear()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old[0], old[1]
    if old[2] is None:
        os.environ.pop("ZIMI_OFFLINE", None)
    else:
        os.environ["ZIMI_OFFLINE"] = old[2]


def _ask(served, q, extra=""):
    url = served + "/bestanswer?q=" + urllib.parse.quote(q) + extra
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read())


@pytest.fixture(autouse=True)
def fresh():
    import zimi.server as srv
    from zimi import bestanswer

    srv._search_cache_clear()
    bestanswer.cache_clear()


def test_a_question_gets_the_sentence_that_answers(served):
    got = _ask(served, "how to purify water")
    a = got["answer"]
    assert a["title"] == "Water purification"
    assert (
        "boil it for one minute" in a["sentence"]
        or "Water purification is" in a["sentence"]
    )
    assert a["zim"] == "wiki_en_test" and a["path"] == "A/Water_purification"

    got = _ask(served, "who painted the mona lisa")
    assert got["answer"]["title"] == "Mona Lisa"
    assert "Leonardo da Vinci" in got["answer"]["sentence"]


def test_a_german_question_gets_the_german_sentence(served):
    a = _ask(served, "wer hat die Mona Lisa gemalt")["answer"]
    assert a["title"] == "Mona Lisa (Gemälde)"
    assert "Leonardo da Vinci gemalt" in a["sentence"]


def test_the_quote_is_the_articles_own_text(served):
    """It never writes a word: before + sentence + after is a stretch of the
    article's chunks, character for character (ellipses aside)."""
    a = _ask(served, "who painted the mona lisa")["answer"]
    path = urllib.parse.quote(a["path"])
    with urllib.request.urlopen(
        served + "/chunks?zim=%s&path=%s&size=4000&overlap=0" % (a["zim"], path)
    ) as r:
        text = "".join(c["text"] for c in json.loads(r.read())["chunks"])
    assert a["sentence"] in text
    assert a["before"].strip("…") in text
    assert a["after"].strip("…") in text


def test_a_keyword_search_gets_no_card_and_reads_nothing(served, monkeypatch):
    import zimi.search as search

    def boom(*a, **k):
        raise AssertionError("a keyword search must not read an article")

    monkeypatch.setattr(search, "_read_article_raw", boom)
    for q in ("water purification", "mona lisa", "paris"):
        assert _ask(served, q) == {"answer": None}


def test_a_question_the_library_cannot_answer_gets_no_card(served):
    assert _ask(served, "who won the football world cup in 1998") == {"answer": None}
    assert _ask(served, "why is the sky blue") == {"answer": None}


def test_the_same_question_twice_reads_once(served, monkeypatch):
    import zimi.search as search

    real = search._read_article_raw
    reads = []

    def counting(zim, path):
        reads.append(path)
        return real(zim, path)

    monkeypatch.setattr(search, "_read_article_raw", counting)
    first = _ask(served, "how to purify water")
    n = len(reads)
    assert n >= 1
    assert _ask(served, "how to purify water") == first
    assert _ask(served, "How to purify water  ") == first
    assert len(reads) == n


def test_the_search_does_not_carry_or_wait_for_the_card(served):
    """/search is the card's input, not its host: same body whether or not a
    card was ever asked for."""
    url = (
        served + "/search?q=" + urllib.parse.quote("how to purify water") + "&limit=10"
    )
    with urllib.request.urlopen(url) as r:
        body = json.loads(r.read())
    assert "answer" not in body and body["results"]


def test_missing_query_is_a_400(served):
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(served + "/bestanswer")
    assert e.value.code == 400


def test_a_scope_to_a_zim_that_is_not_here_gets_no_card(served):
    assert _ask(served, "how to purify water", "&zim=nope") == {"answer": None}


def test_concurrent_cards_and_searches_do_not_crash(served):
    """libzim is not thread-safe; the card reads under the same lock."""
    errors = []

    def go(i):
        try:
            q = ["how to purify water", "who painted the mona lisa"][i % 2]
            _ask(served, q + " " * (i % 3))
            urllib.request.urlopen(
                served + "/search?q=" + urllib.parse.quote(q) + "&limit=10"
            ).read()
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=go, args=(i,)) for i in range(16)]
    [t.start() for t in ts]
    [t.join(60) for t in ts]
    assert not errors
