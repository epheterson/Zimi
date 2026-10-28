"""The solitaire family's clock counts only the time the game is on screen and in the player's hands.

It waits while the Menu (and Settings inside it) is open and while the page is hidden or its frame is out of view, and picks
up where it stopped. The page runs on a fake clock, so nothing here waits in real time.

Run: pytest tests/test_games_clock.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, savable  # noqa: E402
from test_games_persist_browser import VIEW, browser, served, tap  # noqa: E402,F401

START_AT_MS = 1_700_000_000_000
HIDE = "(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()"
SHOW = "(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()"


def seconds(page):
    return page.evaluate("ZimiSolitaire.session.seconds()")


@pytest.mark.parametrize("hold", ["menu", "settings", "hidden"])
def test_the_clock_waits_while_the_game_is_not_in_hand(served, browser, hold):  # noqa: F811
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.clock.install(time=START_AT_MS)
    page.goto(served + "/solitaire.html")
    game_ready(page, "ZimiSolitaire.session.state")
    tap(page, page.locator('[data-pile="stock"]').last)   # the first move starts the clock
    savable(page)
    page.clock.run_for(3000)
    assert seconds(page) == 3
    if hold == "hidden":
        page.evaluate(HIDE)
    else:
        page.locator(".ar-bar button", has_text="Menu").first.click()
        if hold == "settings":
            page.locator(".gs-item", has_text="Settings").first.click()
    frames(page)
    page.clock.run_for(20000)
    assert seconds(page) == 3, "the clock ran while the game was not in hand"
    if hold == "hidden":
        page.evaluate(SHOW)
    else:
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('.ar-sheet:not([hidden]) .gs-card')")
    frames(page)
    page.clock.run_for(2000)
    assert seconds(page) == 5, "the clock picks up where it stopped"
    ctx.close()
