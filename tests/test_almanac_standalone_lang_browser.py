"""The Almanac read outside Zimi (kiwix-serve, Kiwix JS) takes the browser's language: nothing hands it one there.

The staged page is served from a plain static server, the way a ZIM reader serves it: no Zimi shell, no ``#lang`` in the
address. The page takes the first of the browser's languages that is one of Zimi's ten, English otherwise, and sets
``dir`` for Arabic and Hebrew. A server that drops the strings' request while it is busy (kiwix-serve has four threads)
must not leave a French reader on an English page.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_almanac_standalone_lang_browser.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

pytestmark = pytest.mark.browser

PLACE_BUTTON = {"fr": "Ma position", "ar": "موقعي", "en": "My location"}


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def page_url(tmp_path_factory):
    from zimi import almanacstage

    dest = str(tmp_path_factory.mktemp("almanac"))
    almanacstage.stage(dest)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Quiet, directory=dest))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/index.html" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    sync_playwright = pytest.importorskip("playwright.sync_api").sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def _open(browser, url, locale, flaky_strings=False):
    ctx = browser.new_context(locale=locale)
    page = ctx.new_page()
    if flaky_strings:
        seen = []

        def route(r):
            seen.append(1)
            return r.abort() if len(seen) == 1 else r.continue_()

        page.route("**/i18n/almanac/fr.json", route)
    page.goto(url)
    page.wait_for_function("() => document.body.innerText.length > 200 && !document.getElementById('alm-veil')", timeout=60000)
    state = page.evaluate("() => ({lang: document.documentElement.lang, dir: document.documentElement.dir || '', text: document.body.innerText})")
    ctx.close()
    return state


@pytest.mark.parametrize("locale,lang,direction", [("fr-FR", "fr", ""), ("ar", "ar", "rtl"), ("sv-SE", "en", ""), ("pt-BR", "pt", ""), ("zh-Hant-TW", "zh", "")])
def test_standalone_page_follows_browser_language(browser, page_url, locale, lang, direction):
    s = _open(browser, page_url, locale)
    assert s["lang"] == lang
    assert s["dir"] == direction
    if lang in PLACE_BUTTON:
        assert PLACE_BUTTON[lang] in s["text"]
    if lang != "en":
        assert PLACE_BUTTON["en"] not in s["text"]


def test_one_dropped_strings_request_does_not_leave_english(browser, page_url):
    s = _open(browser, page_url, "fr-FR", flaky_strings=True)
    assert PLACE_BUTTON["fr"] in s["text"]
    assert PLACE_BUTTON["en"] not in s["text"]
