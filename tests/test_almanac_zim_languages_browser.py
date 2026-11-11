"""The Almanac's ZIM speaks Zimi's ten languages: the browser's language picks the strings (English under any that is missing),
<html lang> and dir follow (Arabic and Hebrew right to left), dates and numbers go through the language, and no raw key shows.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_almanac_zim_languages_browser.py -v
"""

import functools
import http.server
import os
import sys
import tempfile
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import browser  # noqa: E402,F401

from zimi import almanacstage  # noqa: E402

RAW_KEY = r"\b(alm|gr|ae|env|save)_[a-z0-9_]{3,}\b"
# locale -> (html lang, dir, what the first tile's label must not be: the English one)
CASES = [
    ("de-DE", "de", ""),
    ("he-IL", "he", "rtl"),
    ("zh-CN", "zh", ""),
    ("ar-EG", "ar", "rtl"),
    ("en-US", "en", ""),
    ("sv-SE", "en", ""),
]
ENGLISH_FIRST_TILE = "ILLUMINATED"


@pytest.fixture(scope="module")
def served():
    tmp = tempfile.mkdtemp(prefix="zimi-alm-lang-")
    almanacstage.stage(tmp, community=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield {"base": "http://127.0.0.1:%d" % httpd.server_address[1], "dir": tmp}
    httpd.shutdown()


def test_all_ten_languages_are_packed_in(served):
    for lang in almanacstage.LANGUAGES:
        assert (
            os.path.getsize(os.path.join(served["dir"], "i18n", lang + ".json")) > 1000
        ), lang
    assert len(almanacstage.LANGUAGES) == 10


@pytest.mark.parametrize("locale,lang,direction", CASES)
def test_the_page_follows_the_browsers_language(
    browser, served, locale, lang, direction
):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, locale=locale, service_workers="block"
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(served["base"] + "/index.html")
    page.wait_for_selector("#almanac-head .alm-card", timeout=120_000)
    page.wait_for_timeout(1500)
    assert page.evaluate("document.documentElement.lang") == lang
    assert page.evaluate("document.documentElement.dir") == direction
    first = page.evaluate(
        "document.querySelector('#almanac-head .alm-card .alm-card-lbl').innerText.trim()"
    )
    assert (first.upper() == ENGLISH_FIRST_TILE) == (lang == "en"), first
    view = "document.getElementById('almanac-view').innerText"
    assert (
        page.evaluate("(re => (%s.match(new RegExp(re, 'g')) || []))" % view, RAW_KEY)
        == []
    )
    assert (
        page.evaluate(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        <= 0
    )
    assert not errors, errors
    ctx.close()


def test_a_language_in_the_address_wins(browser, served):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, locale="en-US", service_workers="block"
    )
    page = ctx.new_page()
    page.goto(served["base"] + "/index.html#lang=de")
    page.wait_for_selector("#almanac-head .alm-card", timeout=120_000)
    assert page.evaluate("document.documentElement.lang") == "de"
    ctx.close()
