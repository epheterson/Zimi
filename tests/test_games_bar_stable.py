"""The bar never shifts: Undo has its place from the first frame (disabled until a move), so Menu sits at the same x before
and after the first move, and a bar title localizes whenever it is the game's title, however the markup spells it.

Run: pytest tests/test_games_bar_stable.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import game_ready  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")


@pytest.fixture(scope="module")
def base():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        for kind in (p.webkit, p.chromium):
            try:
                b = kind.launch()
            except Exception:
                continue
            yield b
            b.close()
            return
        pytest.skip("no browser installed")


def open_game(browser, base, name, width=390, **ctx):
    c = browser.new_context(viewport={"width": width, "height": 844}, has_touch=True, is_mobile=True, **ctx)
    page = c.new_page()
    page.goto(base + "/" + name)
    game_ready(page)
    return c, page


def menu_x(page):
    return page.locator(".ar-bar .gs-menu-btn").bounding_box()["x"]


@pytest.mark.parametrize("width", [320, 390])
def test_undo_is_reserved_so_menu_does_not_move_on_the_first_move(browser, base, width):
    c, page = open_game(browser, base, "draughts.html", width)
    undo = page.locator(".ar-bar #wk-undo")
    assert undo.is_visible() and undo.is_disabled(), "Undo is there from the start, disabled"
    before = menu_x(page)
    page.evaluate("document.getElementById('wk-undo').disabled = false")
    page.wait_for_timeout(100)
    assert undo.is_enabled()
    assert menu_x(page) == before
    c.close()


def test_the_game_title_localizes_without_a_workaround_key(browser, base):
    c, page = open_game(browser, base, "draughts.html", 390)
    assert page.locator(".ar-bar h1").inner_text() == "International Draughts"
    c.close()
    c = browser.new_context(viewport={"width": 390, "height": 844}, locale="fr-FR")
    page = c.new_page()
    page.goto(base + "/draughts.html")
    game_ready(page)
    fr = page.evaluate("ZimiText.T('game.draughts.title')")
    assert page.locator(".ar-bar h1").inner_text() == fr != "International Draughts"
    c.close()


def test_a_title_spelled_with_a_straight_apostrophe_still_localizes(browser, base):
    c = browser.new_context(viewport={"width": 390, "height": 844}, locale="fr-FR")
    page = c.new_page()
    page.goto(base + "/holdem.html")
    game_ready(page)
    fr = page.evaluate("ZimiText.T('game.holdem.title')")
    assert page.locator(".ar-bar h1").inner_text() == fr
    c.close()
