"""Chess opens at an easy level the first time, and keeps the player's own choice after that.

A playtester's first game was against Club, which is not an easy level.

Run: pytest tests/test_games_chess_default_browser.py -v
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


def _level_shown(browser, site, settings=None):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True
    )
    if settings:
        ctx.add_init_script(
            "try { localStorage.setItem('zimi.games.chess.settings', %s); } catch (e) {}"
            % json.dumps(json.dumps(settings))
        )
    pg = ctx.new_page()
    pg.goto(site + "chess.html")
    pg.wait_for_selector(".gs-menu-btn")
    pg.wait_for_timeout(500)
    pg.click(".gs-menu-btn")
    pg.click(".gs-sheet:not([hidden]) .gs-newgame")
    pg.wait_for_timeout(300)
    text = " | ".join(pg.evaluate("() => [...document.querySelectorAll('.gs-sheet:not([hidden]) [aria-pressed=\"true\"]')].map((b) => b.textContent.trim())"))
    ctx.close()
    return text


def test_the_first_game_is_against_an_easy_level(browser, site):
    text = _level_shown(browser, site)
    assert "Beginner" in text or "beginner" in text, text


def test_a_players_own_level_is_kept(browser, site):
    text = _level_shown(
        browser, site, {"mode": "cpu", "level": "strong", "side": "first"}
    )
    assert "dvanced" in text, text
    text = _level_shown(
        browser, site, {"mode": "cpu", "level": "club", "side": "first"}
    )
    assert "lub" in text, text
