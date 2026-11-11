"""Dictionary Bluff in kiwix-serve draws its words from the library's English Wiktionary: the deal never waits (built-in
words first, under 1.2 s), a burst in the idle time asks the server at most 12 times (title suggestions for a word stem, then
pages), and a later round takes a library word with its real definition. A random page of a real Wiktionary is seldom a
usable English word, so the old draw fell back to the built-in words every time.

The kiwix-serve here is the page's own routes: its catalog, /suggest and the pages of a Wiktionary.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_bluff_kiwix_words_browser.py -v
"""

import functools
import http.server
import json
import os
import re
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import GAMES, browser  # noqa: E402,F401

BOOK = "wiktionary_en_all_nopic_2026-02"
CATALOG = (
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Wiktionary</title><language>eng</language><name>wiktionary_en_all</name>'
    '<articleCount>9800000</articleCount><link type="text/html" href="/content/%s" /></entry></feed>'
    % BOOK
)
# English words of different stems, none of them built in, each with an English section and a meaning of its own.
WORDS = {
    "garrulous": "Excessively talkative, especially about trivial things.",
    "querulous": "Given to complaining; peevish, whining, fretful.",
    "perfidious": "Of, relating to, or showing a deliberate breaking of trust; faithless, disloyal; treacherous.",
    "lachrymal": "Of or pertaining to tears or the glands that produce them.",
    "vacillatingly": "In a vacillating manner; uncertainly, waveringly.",
}


def page_html(word):
    return (
        '<html><body><h1>%s</h1><h2 id="English">English</h2><h3 id="Adjective">Adjective</h3><ol><li>%s</li></ol>'
        '<h2 id="Latin">Latin</h2></body></html>' % (word, WORDS[word])
    )


@pytest.fixture(scope="module")
def kiwix_games():
    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

        def translate_path(self, path):
            path = path.split("?")[0]
            return (
                os.path.join(GAMES, path[len("/content/games/") :])
                if path.startswith("/content/games/")
                else "/nonexistent"
            )

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


def test_bluff_deals_at_once_and_takes_library_words_in_a_later_round(
    browser, kiwix_games
):
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    asks = []

    def route(r):
        u = r.request.url
        if "/catalog/v2/entries" in u:
            return r.fulfill(body=CATALOG, content_type="application/atom+xml")
        if "/suggest" in u:
            asks.append(u)
            # Suggestions as the real list gives them: other languages' words and a capitalised title among English ones.
            rows = [
                {"value": w, "label": w, "kind": "path", "path": w}
                for w in ["perspicacia", "perspicaz", "Garrulus"] + list(WORDS)
            ]
            return r.fulfill(body=json.dumps(rows), content_type="application/json")
        m = re.search(r"/content/%s/(.+)$" % BOOK, u)
        if m:
            asks.append(u)
            w = m.group(1)
            return (
                r.fulfill(body=page_html(w), content_type="text/html")
                if w in WORDS
                else r.fulfill(status=404, body="")
            )
        if re.search(r"/(random|health)", u):
            asks.append(u)
            return r.fulfill(status=404, body="")
        return r.continue_()

    page.route(
        re.compile(
            r".*/(catalog/v2/entries|suggest|random|health|content/%s/).*" % BOOK
        ),
        route,
    )
    t0 = time.time()
    page.goto("%s/content/games/bluff.html" % kiwix_games)
    page.wait_for_function(
        "window.__bluff && __bluff.g && __bluff.g.words && __bluff.g.words.length === 3"
    )
    assert (
        time.time() - t0 < 1.2 + 1.0
    )  # the deal does not wait for the library (a second of page load allowed)
    assert page.evaluate("__bluff.dict") == BOOK
    # Round two and three take library words as the burst of round one brings them.
    page.wait_for_function("__bluff.g.words.slice(1).every(w => w.path)", timeout=15000)
    later = page.evaluate("__bluff.g.words.slice(1)")
    for w in later:
        assert (
            w["word"] in WORDS
            and w["real"].rstrip(".").lower() in WORDS[w["word"]].lower()
        ), w
    page.wait_for_timeout(1000)
    library = [u for u in asks if "/suggest" in u or "/content/" in u]
    assert len(library) <= 12, library  # one burst: at most 12 asks of the Wiktionary
    assert not any("/random" in u for u in asks), asks
    ctx.close()
