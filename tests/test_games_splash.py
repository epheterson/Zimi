"""The start splash: an arcade game opens on its art, name, one Play and the line that says how it starts; a tap, Play or a key
ends it at once, it is not drawn again after a game, and it fits 320, 390 and a desktop, left to right and right to left.

Run: pytest tests/test_games_splash.py -v
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



def open_game(browser, base, name, width=390, height=844, **ctx):
    c = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500, is_mobile=width < 500, **ctx)
    page = c.new_page()
    page.goto(base + "/" + name)
    game_ready(page)
    page.wait_for_selector(".gs-splash")
    return c, page


@pytest.mark.parametrize("width,height,locale", [(320, 568, "en-US"), (390, 844, "en-US"), (1200, 800, "en-US"), (390, 844, "he-IL")])
def test_the_splash_fits_and_has_one_primary(browser, base, width, height, locale):
    c, page = open_game(browser, base, "snake.html", width, height, locale=locale)
    card = page.locator(".gs-sp-card").bounding_box()
    assert card["x"] >= 0 and card["x"] + card["width"] <= width
    assert card["y"] >= 56 and card["y"] + card["height"] <= height
    play = page.locator(".gs-sp-play").bounding_box()
    assert play["height"] >= 44
    assert page.locator(".gs-splash .gs-primary").count() == 1
    assert page.locator(".gs-splash h2").inner_text() == page.evaluate("ZimiText.T('game.snake.title')")
    c.close()


def test_play_ends_the_splash_and_starts_the_game(browser, base):
    c, page = open_game(browser, base, "snake.html")
    page.locator(".gs-sp-play").click()
    page.wait_for_selector(".gs-splash", state="detached", timeout=500)
    assert page.locator(".ar-bar #sn-pause, .ar-bar [id$='pause']").first.is_enabled()
    c.close()


def test_a_key_ends_the_splash(browser, base):
    c, page = open_game(browser, base, "snake.html", 1200, 800)
    page.keyboard.press("ArrowRight")
    page.wait_for_selector(".gs-splash", state="detached", timeout=500)
    c.close()


def test_reduced_motion_has_no_entrance(browser, base):
    c, page = open_game(browser, base, "snake.html", reduced_motion="reduce")
    assert page.evaluate("getComputedStyle(document.querySelector('.gs-sp-card')).animationName") == "none"
    c.close()
