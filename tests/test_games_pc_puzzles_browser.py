"""A cleared Same Game gets its win sheet (its status says COMPLETE!, the others say COMPLETED!), and a solved Go Problem comes back to its
sheet after a reload.

Run: pytest tests/test_games_pc_puzzles_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_pc_ends_browser import (
    PHONE,
    END,
    _open,
    base,
    browser,
)  # noqa: E402,F401
from games_wait import shell_ready  # noqa: E402


def test_a_cleared_same_game_board_shows_the_win_sheet(browser, base):
    ctx = browser.new_context(viewport=PHONE, has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    pg.goto(base + "/puzzles/samegame.html#3x3c3s2:1,1,1,1,1,1,1,1,1")
    shell_ready(pg)
    pg.wait_for_timeout(1800)
    box = pg.evaluate(
        "() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }"
    )
    for _ in range(2):  # the first touch selects the group, the second takes it away
        pg.touchscreen.tap(box[0] + box[2] / 2, box[1] + box[3] / 2)
        pg.wait_for_timeout(600)
    pg.wait_for_selector(END, timeout=15000)
    ctx.close()


def test_a_solved_go_problem_comes_back_to_its_sheet_after_a_reload(browser, base):
    pg = _open(browser, base, "goproblems")
    for _ in range(40):
        if pg.locator(END).count():
            break
        if pg.evaluate("() => __gp.thinking()"):
            pg.wait_for_timeout(300)
            continue
        P = pg.evaluate("() => __gp.problem()")
        for p in [r * 19 + c for r in range(P["h"]) for c in range(P["w"])]:
            pg.evaluate("(p) => __gp.play(p)", p)
            pg.wait_for_timeout(100)
            if pg.evaluate("() => __gp.thinking() || __gp.over()"):
                break
        pg.wait_for_timeout(1200)
    pg.wait_for_selector(END, timeout=15000)
    pg.wait_for_timeout(1000)
    pg.reload()
    shell_ready(pg)
    pg.wait_for_selector(END, timeout=15000)
    pg.context.close()
