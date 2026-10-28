"""The end of a game in ZimiGames, on a phone (390 x 844, standalone, from the games folder as it is):

- a win's title has its exclamation mark, and its beat has confetti in the mark's colours;
- closing the end sheet is never a dead end: the result and a large New game stay on the board, and pressing it starts a new game
  and takes the line away (so does the game's own New game);
- under reduced motion the sheet is there at once, with no confetti;
- a game table's box opens its menu with the game's name alone as the title ("Reset Dominoes?"), and the time as body text.

Run: pytest tests/test_games_end_rest.py -v
"""

import functools
import http.server
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import game_ready, visible  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
VIEW = {"width": 390, "height": 844}
BEAT_WAIT_MS = 6000


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


def open_game(browser, base, page_name, **ctx):
    c = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, **ctx)
    page = c.new_page()
    page.goto(base + "/" + page_name)
    game_ready(page)
    return c, page


def end(page, result="win"):
    page.evaluate(
        "r => ZimiShell.endSheet({ result: r, stats: [['Moves', '24']] })", result
    )


def test_win_has_its_mark_confetti_and_a_rest_that_starts_a_new_game(browser, base):
    c, page = open_game(browser, base, "mancala.html")
    page.evaluate(
        "window.__news = 0; document.querySelectorAll('button').forEach(b => { if (/^new game$/i.test(b.textContent.trim())) b.addEventListener('click', () => window.__news++); })"
    )
    end(page)
    page.wait_for_selector(".gs-m-conf", state="attached")
    assert page.locator(".gs-m-conf").count() >= 30
    visible(page, ".ar-sheet-card h2", BEAT_WAIT_MS)
    assert page.locator(".ar-sheet-card h2").inner_text() == "You won!"
    page.locator(".ar-sheet-actions .ar-btn", has_text="Close").click()
    visible(page, ".gs-rest")
    assert "You won!" in page.locator(".gs-rest p").inner_text()
    btn = page.locator(".gs-rest .gs-rest-new")
    assert btn.bounding_box()["height"] >= 56
    btn.click()
    assert page.locator(".gs-rest").count() == 0
    assert page.evaluate("window.__news") >= 1
    c.close()


def test_a_menu_new_game_takes_the_rest_away(browser, base):
    c, page = open_game(browser, base, "mancala.html")
    end(page, "lose")
    visible(page, ".ar-sheet-card h2", BEAT_WAIT_MS)
    page.wait_for_timeout(700)   # the sheet ignores keys for its first moments
    page.keyboard.press("Escape")
    visible(page, ".gs-rest")
    page.locator(".ar-bar .ar-btn", has_text="Menu").click()
    visible(page, ".gs-sheet .gs-item")
    page.locator(".gs-sheet .gs-item", has_text="New game").first.click()
    visible(page, ".gs-sheet .gs-primary")   # Mancala's New game pane: its options, then Start
    page.locator(".gs-sheet .gs-primary").click()
    page.wait_for_selector(".gs-rest", state="detached")
    c.close()


def test_reduced_motion_has_the_sheet_at_once_and_no_confetti(browser, base):
    c, page = open_game(browser, base, "mancala.html", reduced_motion="reduce")
    end(page)
    visible(page, ".ar-sheet-card h2", 1500)
    assert page.locator(".gs-m-conf").count() == 0
    c.close()


def test_table_box_menu_title_is_the_name_alone(browser, base):
    c = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = c.new_page()
    page.goto(base + "/index.html")
    now = int(time.time() * 1000)
    page.evaluate(
        "n => { localStorage.setItem('zimi.games.recent', JSON.stringify([{path: 'dominoes.html', title: 'Dominoes', at: n - 660000}])); localStorage.setItem('zimi.games.save.dominoes', JSON.stringify({v: 1, at: n, data: {x: 1}})); }",
        now,
    )
    page.goto(base + "/index.html")
    visible(page, "a.ar-box")
    page.evaluate(
        "document.querySelector('a.ar-box').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 300 }))"
    )
    page.locator(".gs-tm-item", has_text="Reset").click()
    visible(page, ".ar-sheet-card h2")
    assert page.locator(".ar-sheet-card h2").inner_text() == "Reset Dominoes?"
    assert "Last played 11 minutes ago" in page.locator(".ar-sheet-card").inner_text()
    c.close()
