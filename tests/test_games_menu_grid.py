"""The Menu's root: New game is a button of its own (amber, 56px), every other action is an icon tile at least 44px tall, and all of it fits
320 and 390 wide, left to right and right to left.

Run: pytest tests/test_games_menu_grid.py -v
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



def open_menu(browser, base, name, width, locale="en-US"):
    c = browser.new_context(viewport={"width": width, "height": 700}, has_touch=True, is_mobile=True, locale=locale)
    page = c.new_page()
    page.goto(base + "/" + name)
    game_ready(page)
    page.locator(".ar-bar .gs-menu-btn").click()
    page.wait_for_selector(".gs-sheet .gs-newgame")
    return c, page


@pytest.mark.parametrize("name", ["chess.html", "sudoku.html", "wikirace.html", "minesweeper.html"])
@pytest.mark.parametrize("width,locale", [(320, "en-US"), (390, "he-IL")])
def test_new_game_is_its_own_button_and_every_tile_has_an_icon(browser, base, name, width, locale):
    c, page = open_menu(browser, base, name, width, locale)
    new = page.locator(".gs-sheet .gs-newgame").bounding_box()
    assert new["height"] >= 56
    assert page.locator(".gs-sheet .gs-newgame svg.gs-icon").count() == 1
    tiles = page.locator(".gs-sheet .gs-grid .gs-tile")
    assert tiles.count() >= 3
    for i in range(tiles.count()):
        t = tiles.nth(i)
        box = t.bounding_box()
        assert box["height"] >= 44 and box["x"] >= 0 and box["x"] + box["width"] <= width, t.inner_text()
        assert t.locator("svg.gs-icon").count() == 1, "an icon on every action: " + t.inner_text()
    assert page.locator(".gs-sheet .gs-primary, .gs-sheet .gs-newgame").count() == 1, "one amber button"
    c.close()


def test_new_game_is_one_tap_when_nothing_is_under_way(browser, base):
    c, page = open_menu(browser, base, "stacker.html", 390)
    page.locator(".gs-sheet .gs-newgame").click()
    page.wait_for_selector(".gs-sheet", state="hidden")
    c.close()


def test_a_games_own_button_is_a_tile_with_an_icon(browser, base):
    c, page = open_menu(browser, base, "wikirace.html", 390)
    give = page.locator(".gs-sheet .gs-extras .ar-btn")
    assert give.count() >= 1
    assert give.first.locator("svg.gs-icon").count() == 1
    c.close()
