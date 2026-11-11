"""Five of Tatham's puzzles solved by touch on a 390 px phone from a known game: the win sheet comes up, and New game then gives a
fresh board with no sheet. (Flip, the sixth, needs its lit squares read off the canvas: see scripts/games_bot/flipsolve.py.)

Net 2x2 and Twiddle 2x2 are crafted one move from solved; Mines 4x4 seed 5 (after the first touch one corner square is safe by the
numbers); Towers and Unequal 3x3 seed 1 are solved from their clues, the digits typed on the page's keypad.

Run: pytest tests/test_games_puzzles_solved_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_pc_ends_browser import PHONE, base, browser  # noqa: E402,F401
from games_wait import shell_ready  # noqa: E402

SHEET = ".ar-sheet:not([hidden])"
KEY_X = {"1": 77, "2": 129, "3": 181}


def canvas_box(pg):
    return pg.evaluate(
        "() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }"
    )


def fill(pg, cells, keys_y, cols, rows):
    """cells: digits row-major ('.' for a given), typed by touching the square and then the keypad."""
    for i, d in enumerate(cells):
        if d == ".":
            continue
        pg.touchscreen.tap(cols[i % 3], rows[i // 3])
        pg.wait_for_timeout(200)
        pg.touchscreen.tap(KEY_X[d], keys_y)
        pg.wait_for_timeout(200)


def tap_in(pg, fx, fy, times):
    x, y, w, h = canvas_box(pg)
    for _ in range(times):
        pg.touchscreen.tap(x + w * fx, y + h * fy)
        pg.wait_for_timeout(350)


CASES = [
    # name, id, how to play it
    ("net", "2x2:2c16", lambda pg: tap_in(pg, 0.27, 0.27, 3)),
    ("twiddle", "2x2n2:3,1,4,2", lambda pg: tap_in(pg, 0.5, 0.5, 1)),
    ("mines", "4x4n3#5", None),
    ("towers", "3#1", lambda pg: fill(pg, "231123312", 546, (132, 195, 258), (267, 330, 393))),
    ("unequal", "3#1", lambda pg: fill(pg, ".31123312", 510, (96, 195, 294), (195, 294, 393))),
]


@pytest.mark.parametrize("name,gid,play", CASES, ids=[c[0] for c in CASES])
def test_a_puzzle_solved_by_touch_wins_and_new_game_starts_fresh(
    browser, base, name, gid, play
):
    ctx = browser.new_context(
        viewport=PHONE,
        has_touch=True,
        is_mobile=True,
        device_scale_factor=2,
        reduced_motion="reduce",
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto("%s/puzzles/%s.html#%s" % (base, name, gid))
    shell_ready(pg)
    pg.wait_for_timeout(2500)
    if name == "mines":
        x, y, w, h = canvas_box(pg)
        pg.touchscreen.tap(
            x + w * 0.5, y + h * 0.5
        )  # the first touch lays the mines and opens the left three columns
        pg.wait_for_timeout(800)
        pg.touchscreen.tap(
            x + w * 0.713, y + h * 0.286
        )  # the numbers 1, 2, 3 beside the last column leave this one square safe
    else:
        play(pg)
    pg.wait_for_selector(SHEET, timeout=15000)
    assert "You won" in pg.inner_text(SHEET)
    pg.get_by_role("button", name="New game").first.click()
    pg.wait_for_function(
        "() => !document.querySelector('.ar-sheet:not([hidden])')", timeout=15000
    )
    pg.wait_for_timeout(1500)
    assert not pg.locator(SHEET).count()
    assert not errors, errors
    ctx.close()
