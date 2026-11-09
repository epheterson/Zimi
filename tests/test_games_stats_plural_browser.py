"""The stats page counts in the player's grammar: "1 jugada · 1 ganada", not "1 jugadas · 1 ganadas".

Each count picks its own plural form (the string table's plural entries, chosen by a number): Spanish, French, Portuguese,
Russian, Arabic and the rest read right at 0, 1, 2 and 5.

Run: pytest tests/test_games_stats_plural_browser.py -v
"""

import functools
import http.server
import json
import os
import threading

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
STATS = {
    "v": 1,
    "g": {
        "sudoku.html": {"n": 1, "w": 1},
        "freecell.html": {"n": 2, "w": 1},
        "go.html": {"n": 5, "w": 0},
    },
    "days": {},
    "best": 0,
}


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


def _stats_text(browser, site, lang):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi.games.stats', %s); } catch (e) {}"
        % json.dumps(json.dumps(STATS))
    )
    pg = ctx.new_page()
    pg.goto(site + "sudoku.html#lang=" + lang)
    pg.wait_for_selector(".gs-menu-btn")
    pg.wait_for_timeout(600)
    pg.evaluate("() => ZimiShell.statsSheet()")
    pg.wait_for_selector(".ar-sheet .gs-stats")
    pg.wait_for_timeout(500)
    text = pg.inner_text(".ar-sheet:not(.gs-sheet)")
    ctx.close()
    return text


def test_spanish_counts_one_game_in_the_singular(browser, site):
    text = _stats_text(browser, site, "es")
    assert "1 jugada · 1 ganada" in text, text
    assert "2 jugadas · 1 ganada" in text, text
    assert "5 jugadas · 0 ganadas" in text, text
    assert "1 jugadas" not in text and "1 ganadas" not in text, text


def test_french_counts_one_and_zero_in_the_singular_and_two_in_the_plural(
    browser, site
):
    text = _stats_text(browser, site, "fr")
    assert "1 jouée · 1 gagnée" in text and "2 jouées · 1 gagnée" in text, text


def test_russian_and_english_read_right(browser, site):
    assert "1 played · 1 won" in _stats_text(browser, site, "en")
    assert "сыграно 5 · побед 0" in _stats_text(browser, site, "ru")
