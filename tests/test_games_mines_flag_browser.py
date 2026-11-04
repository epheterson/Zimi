"""Minesweeper's flag reads as a flag, never as the digit 1 beside it.

The pennant was 6 of the icon's 20 units wide on a pole 12 tall with a base: at a cell's size it read as a "1" with a
red tick, on a board of 1s. The pennant is now most of the drawing.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_mines_flag_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

PENNANT = """() => { const svg = document.querySelector('.ms-flagbtn svg'), red = [...svg.querySelectorAll('path')].find(p => p.getAttribute('fill'));
  const b = red.getBBox(), v = svg.viewBox.baseVal; return [b.width / v.width, b.height / v.height]; }"""


def test_the_pennant_is_most_of_the_flag(served, browser):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/minesweeper.html" % served)
    page.wait_for_selector(".ms-flagbtn svg")
    w, h = page.evaluate(PENNANT)
    assert w >= 0.45 and h >= 0.4, (w, h)
    ctx.close()
