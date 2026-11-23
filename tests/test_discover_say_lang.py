"""The Discover card's Say speaks the language the server knows, not the
guess a client makes from a file name.

A Wiktionary or Wikiquote write the word or quote of the day in their own
language.  The Random endpoint /random?zim=...&day=... (which the Discover
strip reads for the day's cards) carries that language on the card, so the
card's Say button reads it back and speaks it, the same way the Dictionary
does.

Run: pytest tests/test_discover_say_lang.py -v
"""

import datetime
import json
import os
import sys
import threading
import urllib.request

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from zimi import wiki  # noqa: E402

# A real English Wiktionary entry: the headword line, a Noun sense with a
# definition, so the word of the day is judicable from its HTML.
_WORD = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "fixtures",
    "discover_i18n",
    "wikt_en_kettle.html",
)

DAY = datetime.date(2026, 9, 25)


def _wiktionary_zim(path):
    """A one-article English Wiktionary (the word "kettle"), named without a
    language in its file name as Simple English builds are."""
    from conftest_zim import _Article
    from libzim.writer import Creator

    with open(_WORD, encoding="utf-8") as f:
        page = f.read()
    with Creator(path).config_indexing(False, "eng") as creator:
        creator.set_mainpath("kettle")
        creator.add_item(_Article("kettle", "kettle", page.encode("utf-8")))
        for key, value in (
            ("Scraper", "mwoffliner 1.14.0"),
            ("Title", "wiktionary_en_simple_all"),
            ("Name", "wiktionary_en_simple_all"),
            ("Language", "eng"),
            ("Description", "fixture"),
        ):
            creator.add_metadata(key, value)
    return path


@pytest.fixture
def served(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    _wiktionary_zim(str(zdir / "wiktionary_en_simple_all_2026-07.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    wiki._reset_for_tests()
    srv.load_cache(force=True)
    monkeypatch.setattr(wiki, "_today", lambda: DAY)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _random(url, name):
    try:
        with urllib.request.urlopen(
            url + "/random?zim=" + name + "&day=" + DAY.strftime("%Y%m%d") + "&seed=1",
            timeout=15,
        ) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_the_discover_word_of_the_day_carries_the_word_zims_language(served):
    """A Wiktionary named without a language code still says its word in the
    language its metadata names: the discover card carries lang "en", and the
    client need not guess it from the file name."""
    status, card = _random(served, "wiktionary_en_simple_all")
    assert status == 200, card
    assert card["lang"] == "en", card
    # The language rides with the word itself, not a stale client guess.
    assert card["zim"] == "wiktionary_en_simple_all"
    assert card["path"]