"""Playtest batch 2, the findings that live in Zimi's own page around a game (the reader header).

These run against a real server with the games ZIM built from the working tree.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_batch2_zimi_browser.py -v
"""

import os
import sys
import urllib.parse

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_final_fixes import PHONE, browser, zimi  # noqa: E402,F401

LOCALES = [
    "en-US",
    "es-ES",
    "fr-FR",
    "de-DE",
    "pt-BR",
    "ru-RU",
    "zh-CN",
    "ar",
    "he",
    "hi-IN",
]
TITLE = """() => { const e = document.getElementById('game-title');
  return { text: e.textContent, wide: e.scrollWidth > e.clientWidth + 1, tall: e.scrollHeight > e.clientHeight + 1, nowrap: getComputedStyle(e).whiteSpace === 'nowrap',
           ellipsis: getComputedStyle(e).textOverflow === 'ellipsis' }; }"""


# 3 and 4. One rule for the header's game name in every language: it steps down to fit on one line, and a name that still does
# not fit ends in an ellipsis; it is never cut dead ("Backgamm") and these short names never take two lines.
@pytest.mark.parametrize("game", ["backgammon.html", "gin.html", "fourinarow.html"])
def test_the_header_title_is_one_line_in_every_language(browser, zimi, game):
    problems = []
    for locale in LOCALES:
        ctx = browser.new_context(
            viewport=PHONE, has_touch=True, is_mobile=True, locale=locale
        )
        page = ctx.new_page()
        page.goto(
            zimi["url"] + "/?a=" + urllib.parse.quote("zimi_games/" + game, safe="")
        )
        page.locator("#reader.open").wait_for(timeout=60000)
        page.wait_for_function(
            "() => document.body.classList.contains('game-page') && document.getElementById('game-title').textContent.length > 2",
            timeout=60000,
        )
        page.wait_for_function(
            "() => document.getElementById('game-act-btn') && !document.getElementById('game-act-btn').hidden || true"
        )
        page.wait_for_timeout(800)
        t = page.evaluate(TITLE)
        if not t["nowrap"] or (t["wide"] and not t["ellipsis"]) or t["tall"]:
            problems.append((locale, t))
        ctx.close()
    assert not problems, problems
