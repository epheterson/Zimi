"""Hex fits the phone, and a solved Chess Puzzle comes back to its sheet after a reload.

Run: pytest tests/test_games_pc_fit_browser.py -v
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


def test_hex_fits_the_phone_without_scrolling(browser, base):
    for w, h in ((390, 844), (375, 667)):
        ctx = browser.new_context(
            viewport={"width": w, "height": h}, has_touch=True, is_mobile=True
        )
        pg = ctx.new_page()
        pg.goto(base + "/hex.html")
        shell_ready(pg)
        pg.wait_for_timeout(500)
        over = pg.evaluate("() => document.documentElement.scrollHeight - innerHeight")
        assert over <= 1, "hex at %dx%d is %d px taller than the screen" % (w, h, over)
        ctx.close()


def _solve_by_touch(pg):
    for _ in range(8):
        if pg.locator(END).count():
            return
        p = pg.evaluate("() => __cp.puzzle()")
        st = pg.evaluate("() => __cp.step()")
        if st >= len(p["moves"]):
            return
        u = p["moves"][st]
        for sq in (u[0:2], u[2:4]):
            i = pg.evaluate(
                "(sq) => [...document.querySelectorAll('.bg-sq')].findIndex(e => (e.getAttribute('aria-label') || '').toLowerCase().startsWith(sq))",
                sq,
            )
            pg.locator(".bg-sq").nth(i).tap()
            pg.wait_for_timeout(150)
        pg.wait_for_timeout(1200)


def test_chess_puzzles_solved_sheet_and_new_bar_come_back_after_a_reload(browser, base):
    pg = _open(browser, base, "chesspuzzles")
    _solve_by_touch(pg)
    pg.wait_for_selector(END, timeout=15000)
    pg.wait_for_timeout(1000)
    pg.reload()
    shell_ready(pg)
    pg.wait_for_selector(END, timeout=15000)
    pg.evaluate(
        "() => { const b = [...document.querySelectorAll('%s button')].find(x => !x.classList.contains('gs-primary')); b.click(); }"
        % END
    )
    pg.wait_for_selector(".gs-rest-new", timeout=5000)
    pg.context.close()


def test_chess_puzzles_load_asks_for_nothing_missing(browser, base):
    """The shell asks the server for the day (/games-day); a plain file server has none, and nothing else may 404."""
    ctx = browser.new_context(viewport=PHONE, has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    bad = []
    pg.on(
        "response",
        lambda r: (
            bad.append(r.url)
            if r.status >= 400 and not r.url.endswith("/games-day")
            else None
        ),
    )
    pg.goto(base + "/chesspuzzles.html")
    shell_ready(pg)
    pg.wait_for_timeout(1500)
    assert not bad, bad
    ctx.close()
