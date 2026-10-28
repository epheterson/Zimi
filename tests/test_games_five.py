"""Five Letters in the player's language: /dictionary/five.

A five-letter word of a Wiktionary for the day (the same for everyone on a server, a fresh one for "chance"),
and whether a guess is a word there. The library is tests/games_library_fixture.py: an English and a French
Wiktionary of five-letter words (one with an accent), and a Wikipedia that is no Wiktionary.

Run: pytest tests/test_games_five.py -v
"""

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import games_library_fixture as fx  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import dictionary as dic  # noqa: E402
from zimi import wiki  # noqa: E402


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    base = tmp_path_factory.mktemp("lib")
    fx.build(str(base))
    return base


@pytest.fixture
def library(built, tmp_path, monkeypatch):
    monkeypatch.delenv("ZIMI_APPS", raising=False)
    monkeypatch.setattr(srv, "ZIM_DIR", str(built / "zims"))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    dic._reset_for_tests()
    wiki._reset_for_tests()
    srv.load_cache(force=True)
    return built


EN_WORDS = {w for w in fx.WORDS_EN if len(w) == 5}
FR_WORDS = {dic.fold_letters(w) for w in fx.WORDS_FR if len(w) == 5}


def test_the_days_word_is_one_word_for_everyone(library):
    day = wiki._today().strftime("%Y%m%d")
    first = dic.five_letters("wiktionary", day)
    assert re.fullmatch(r"[a-z]{5}", first["word"])
    assert (
        first["word"] in EN_WORDS
        and first["lang"] == "en"
        and first["zim"] == "wiktionary"
    )
    assert first["blurb"] == fx.WORDS_EN[first["word"]]
    # Asked again, from a cold start: the same word.
    dic._reset_for_tests()
    assert dic.five_letters("wiktionary", day) == first
    # Another day, another draw (over a week of them, more than one word).
    seen = {
        dic.five_letters("wiktionary", "2026110%d" % d)["word"] for d in range(1, 8)
    }
    assert len(seen) > 2


def test_chance_is_a_fresh_word_each_time(library):
    seen = {dic.five_letters("wiktionary", "chance")["word"] for _ in range(25)}
    assert len(seen) > 4 and seen <= EN_WORDS


def test_a_french_word_loses_its_accents_but_keeps_its_title(library):
    # Draws are random: keep drawing until forêt comes up, checking every word on the way.
    for _ in range(2000):
        one = dic.five_letters("wiktionary_fr", "chance")
        assert one["word"] in FR_WORDS
        if one["word"] == "foret":
            break
    assert one["title"] == "forêt" and one["lang"] == "fr"


def test_words_of_other_lengths_are_never_the_answer(library):
    # The fixture also has six-letter words (bridge, garden); none may come back.
    for _ in range(60):
        assert len(dic.five_letters("wiktionary", "chance")["word"]) == 5


def test_a_zim_that_is_not_a_wiktionary_gives_nothing(library):
    assert dic.five_letters("wikipedia", "chance") is None
    assert dic.five_letters("no_such_zim", "chance") is None
    assert dic.is_five_letter_word("wikipedia", "table") is None


def test_a_guess_is_a_word_when_the_wiktionary_has_it(library):
    assert dic.is_five_letter_word("wiktionary", "table") is True
    assert dic.is_five_letter_word("wiktionary", "zzzzz") is False
    assert (
        dic.is_five_letter_word("wiktionary", "arbre") is False
    )  # a French word is not in the English one
    assert dic.is_five_letter_word("wiktionary_fr", "arbre") is True


def test_a_guess_without_accents_finds_the_accented_word(library):
    assert dic.is_five_letter_word("wiktionary_fr", "foret") is True
    assert dic.is_five_letter_word("wiktionary_fr", "foree") is False


def test_a_word_is_defined_by_the_wiktionary_that_has_it(library):
    got = dic.define_five_letter_word("wiktionary", "table")
    assert got["title"] == "table" and got["blurb"], got
    assert dic.define_five_letter_word("wiktionary", "zzzzz") == {}
    assert dic.define_five_letter_word("wiktionary", "TABLE") == {}, "a to z only"
    assert dic.define_five_letter_word("wikipedia", "table") is None


def test_a_guess_that_is_not_five_letters_a_to_z_is_refused(library):
    for bad in ("", "tabl", "tables", "TABLE", "tab1e", "tablé", "ta le"):
        assert dic.is_five_letter_word("wiktionary", bad) is False


# ── through HTTP ───────────────────────────────────────────────────────────


@pytest.fixture
def served(library):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_the_route(served, monkeypatch):
    day = wiki._today().strftime("%Y%m%d")
    status, got = _get(served + "/dictionary/five?zim=wiktionary_fr&day=" + day)
    assert (
        status == 200 and got["lang"] == "fr" and re.fullmatch(r"[a-z]{5}", got["word"])
    )
    assert _get(served + "/dictionary/five?zim=wiktionary_fr&day=" + day) == (200, got)
    assert _get(served + "/dictionary/five?zim=wiktionary&day=chance")[0] == 200
    assert _get(served + "/dictionary/five?zim=wiktionary&check=table") == (
        200,
        {"ok": True},
    )
    assert _get(served + "/dictionary/five?zim=wiktionary&check=zzzzz") == (
        200,
        {"ok": False},
    )
    status, got = _get(served + "/dictionary/five?zim=wiktionary&define=table")
    assert status == 200 and got["title"] == "table" and got["blurb"]
    assert _get(served + "/dictionary/five?zim=wiktionary&define=zzzzz") == (200, {})
    assert _get(served + "/dictionary/five?zim=wikipedia&define=table")[0] == 404
    # Only the days a browser can be on: nobody can make the server draw for a year of them.
    assert _get(served + "/dictionary/five?zim=wiktionary&day=19990101")[0] == 400
    assert _get(served + "/dictionary/five?zim=wiktionary")[0] == 400
    # Not a Wiktionary, or not here at all: not found, and the same answer for both.
    assert _get(served + "/dictionary/five?zim=wikipedia&day=" + day) == (
        404,
        {"error": "not found"},
    )
    assert _get(served + "/dictionary/five?zim=nothing&day=" + day) == (
        404,
        {"error": "not found"},
    )
    assert _get(served + "/dictionary/five?zim=wikipedia&check=table")[0] == 404
    # A server that does not offer Dictionary does not answer for it.
    monkeypatch.setenv("ZIMI_APPS", "wiki,books")
    assert _get(served + "/dictionary/five?zim=wiktionary&day=" + day)[0] == 404


def test_it_is_on_the_rate_limited_routes():
    from zimi import http

    assert any(
        "/dictionary/five".startswith(p) for p in http._RATE_LIMITED_API_PREFIXES
    )


def test_only_a_zim_this_request_may_read_answers(library, monkeypatch):
    monkeypatch.setattr(srv, "zim_allowed", lambda name: name != "wiktionary_fr")
    day = wiki._today().strftime("%Y%m%d")
    assert dic.five_letters("wiktionary_fr", day) is None
    assert dic.is_five_letter_word("wiktionary_fr", "arbre") is None
    assert dic.five_letters("wiktionary", day)["zim"] == "wiktionary"
