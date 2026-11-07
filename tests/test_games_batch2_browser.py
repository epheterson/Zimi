"""Playtest batch 2: the end sheets, header and board fixes found on a 390 x 844 phone.

One test per finding; each failed on the code before its fix. Screenshots go to GAMES_SHOT_DIR when set.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_batch2_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, visible  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

SHOT_DIR = os.environ.get("GAMES_SHOT_DIR")


def open_game(browser, served, name, query="?debug", lang=None, **ctx):
    c = browser.new_context(
        viewport=VIEW,
        has_touch=True,
        is_mobile=True,
        device_scale_factor=2,
        reduced_motion="reduce",
        **ctx,
    )
    page = c.new_page()
    page.goto(
        "%s/%s.html%s%s" % (served, name, query, ("#lang=" + lang) if lang else "")
    )
    game_ready(page)
    return c, page


def shot(page, name):
    if SHOT_DIR:
        page.screenshot(path=os.path.join(SHOT_DIR, name + ".png"))


# 1. Checkers: the end sheet names the side that has no move, not the winner.
@pytest.mark.parametrize(
    "turn,man,expect",
    [
        (
            2,
            57,
            "Zimi has no move.",
        ),  # white to move with no white men: the person (red) won
        (
            1,
            1,
            "You have no move.",
        ),  # a red man on the far row cannot move: the person lost
    ],
)
def test_checkers_names_the_side_with_no_move(browser, served, turn, man, expect):
    c, page = open_game(browser, served, "checkers")
    page.evaluate(
        "([turn, man]) => { const b = new Int8Array(64); b[man] = 1; __ck.set(b, turn); }",
        [turn, man],
    )
    visible(page, ".ar-sheet-card h2", 4000)
    text = page.locator(".ar-sheet-card").inner_text()
    assert expect in text, text
    assert ("You won" in text) == (turn == 2), text
    shot(page, "01-checkers-" + ("won" if turn == 2 else "lost"))
    c.close()
