"""Playtest batch 3: language fallback, end sheets, keypads, hints and labels found on a 390 x 844 phone.

One test per finding; each failed on the code before its fix. Screenshots go to GAMES_SHOT_DIR when set.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_batch3_browser.py -v
"""

import functools
import glob
import http.server
import os
import re
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, shell_ready, truthy, visible  # noqa: E402,F401
from test_games_persist_browser import GAMES as SHIPPED_GAMES, VIEW, browser  # noqa: E402,F401

GAMES = os.environ.get("GAMES_ROOT") or SHIPPED_GAMES   # GAMES_ROOT: the games folder of another commit, to see a test fail there


@pytest.fixture(scope="module")
def served():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()

SHOT_DIR = os.environ.get("GAMES_SHOT_DIR")


def open_game(browser, served, path, query="", lang=None, ready=True, **ctx):
    ctx.setdefault("reduced_motion", "reduce")
    c = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, device_scale_factor=2, **ctx)
    page = c.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.goto("%s/%s%s%s" % (served, path, query, ("#lang=" + lang) if lang else ""))
    if ready:
        shell_ready(page)
    return c, page


def shot(page, name):
    if SHOT_DIR:
        page.screenshot(path=os.path.join(SHOT_DIR, name + ".png"))


# 1. A language with no text file speaks English throughout (Flags in Japanese: English strings, Japanese country names).
def test_shipped_language_list_matches_the_text_files():
    files = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(GAMES, "text", "*.json")))
    src = open(os.path.join(GAMES, "text.js"), encoding="utf-8").read()
    listed = re.search(r"var SHIPPED = \[([^\]]*)\]", src).group(1)
    assert sorted(re.findall(r"'(\w+)'", listed)) == files


@pytest.mark.parametrize("lang,expect", [("ja", "en"), ("ko", "en"), ("fr", "fr"), ("pt-BR", "pt-br")])
def test_a_language_without_a_text_file_is_english_everywhere(browser, served, lang, expect):
    c, page = open_game(browser, served, "flags.html", lang=lang)
    got = page.evaluate("() => [ZimiText.lang, document.documentElement.lang, GamesLib.uiLang(), GamesLib.countryName('Turkey')]")
    assert got[:3] == [expect, expect, expect.split("-")[0]], got
    if expect == "en":
        assert got[3] == "Turkey", got
    shot(page, "01-flags-%s" % lang)
    c.close()
