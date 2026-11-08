"""On every card table the score chips have their own row: the hand across from you starts below them.

The chips are 28 px tall from the table's padding, but the row kept for them was 26 px, so the north hand's cards
slid 2 px under the chips (and under the ring round whoever is to play).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_table_chips_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401
from games_wait import game_ready, quiet  # noqa: E402

GAP = """() => { const chips = document.querySelector('.ct-scores').getBoundingClientRect();
  const top = Math.min(...[...document.querySelectorAll('.zc-card:not(.zc-off)')].map(c => c.getBoundingClientRect()).filter(r => r.width).map(r => r.top));
  return top - chips.bottom; }"""


@pytest.mark.parametrize("game", ["hearts", "spades", "canasta", "gin", "bridge", "euchre"])
def test_the_north_hand_starts_below_the_chips(served, browser, game):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, game))
    page.wait_for_function("() => document.querySelector('.ct-scores .ct-chip') && document.querySelectorAll('.zc-card:not(.zc-off)').length > 4")
    game_ready(page)   # the deal lands
    quiet(page, 900)
    assert page.evaluate(GAP) >= 2
    ctx.close()
