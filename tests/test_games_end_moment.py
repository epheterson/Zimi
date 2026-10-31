"""A loss is a real moment, still dignified (phone, 390 x 844): the board goes quiet under a veil, a ring closes in and the pebble
settles, then the sheet says "You lost" with what happened; nothing confetti. A tap skips it; reduced motion has the sheet at once.

Run: pytest tests/test_games_end_moment.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import game_ready, visible  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")
VIEW = {"width": 390, "height": 844}
SHOT_DIR = os.environ.get("GAMES_SHOT_DIR")


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


def lose(browser, base, **ctx):
    c = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, **ctx)
    page = c.new_page()
    page.goto(base + "/mancala.html")
    game_ready(page)
    page.evaluate("ZimiShell.endSheet({ result: 'lose', text: 'Zimi took 31 of 48 seeds.', stats: [['Seeds', '17']] })")
    return c, page


def test_a_loss_has_its_moment_then_the_sheet(browser, base):
    c, page = lose(browser, base)
    page.wait_for_selector(".gs-moment-lose", state="attached")
    assert page.locator(".gs-m-conf").count() == 0, "dignified: no confetti"
    assert page.locator(".ar-sheet-card").count() == 0, "the sheet waits for the moment"
    page.wait_for_timeout(700)
    if SHOT_DIR:
        page.screenshot(path=os.path.join(SHOT_DIR, "loss-moment-390.png"))
    visible(page, ".ar-sheet-card h2", 3000)
    assert page.locator(".ar-sheet-card h2").inner_text() == "You lost"
    assert "Zimi took 31" in page.locator(".ar-sheet-card").inner_text()
    assert page.locator(".ar-sheet-actions .gs-primary").inner_text() == "New game"
    if SHOT_DIR:
        page.screenshot(path=os.path.join(SHOT_DIR, "loss-sheet-390.png"))
    c.close()


def test_a_tap_skips_the_loss_moment(browser, base):
    c, page = lose(browser, base)
    page.wait_for_selector(".gs-moment-lose", state="attached")
    page.wait_for_timeout(600)   # past the grace for the taps that made the move
    page.mouse.click(195, 400)
    visible(page, ".ar-sheet-card h2", 500)
    c.close()


def test_reduced_motion_has_no_loss_moment(browser, base):
    c, page = lose(browser, base, reduced_motion="reduce")
    visible(page, ".ar-sheet-card h2", 1500)
    assert page.locator(".gs-moment-lose").count() == 0
    c.close()
