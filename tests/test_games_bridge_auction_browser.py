"""Bridge's auction sits between West's and East's cards on a phone, never under them.

It was at least 200 px wide and centred, while the side hands stand in from the edges, so at 390 px the two piles
covered both ends of "Deal 1 of 4 · dealer North".

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_bridge_auction_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import browser, served  # noqa: E402,F401
from games_wait import game_ready, quiet  # noqa: E402

OVER = """() => { const a = document.querySelector('.br-auction').getBoundingClientRect();
  return [...document.querySelectorAll('.zc-card:not(.zc-off)')].map(c => c.getBoundingClientRect())
    .filter(r => r.width && r.bottom > a.top && r.top < a.bottom && r.right > a.left && r.left < a.right).length; }"""


@pytest.mark.parametrize("width", [360, 390, 430])
def test_no_card_covers_the_auction(served, browser, width):
    ctx = browser.new_context(viewport={"width": width, "height": 844}, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/bridge.html" % served)
    page.wait_for_function("() => { const a = document.querySelector('.br-auction'); return a && !a.hidden && a.getBoundingClientRect().width > 0; }")
    game_ready(page)   # the deal lands
    quiet(page, 800)
    assert page.evaluate(OVER) == 0
    ctx.close()
