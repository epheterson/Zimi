"""Spider and Klondike keep their face-down cards a sliver, whatever the room: enough to count them, nothing to read.

They used to open up to the face-up step when the table had room, so a column of six backs and one face stood three card
heights tall for one playable card (phone solitaire apps show backs at 0.07 to 0.16 of a card). Room goes to the face-up
fan instead: on a fresh deal there is room, so the backs must stay between DOWN_MIN and DOWN_MAX of a card's height.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_spider_open_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401
from games_wait import game_ready, quiet  # noqa: E402



DOWN_MIN, DOWN_MAX = 0.05, 0.14


@pytest.mark.parametrize("game,api,col", [("spider", "ZimiSpider", "c0"), ("solitaire", "ZimiSolitaire", "t6")])
def test_face_down_cards_stay_a_sliver_with_room(served, browser, game, api, col):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, game))
    page.wait_for_function("() => window.%s && %s.session && %s.session.state" % (api, api, api))
    game_ready(page)   # the deal lands
    quiet(page, 1500)
    ys = page.evaluate("""([api, col]) => window[api].session.state.piles[col].map(c => {
        const e = document.querySelector('.zc-card[data-id="' + c.id + '"]'); return [c.up, e.getBoundingClientRect().top]; })""", [api, col])
    downs = [b[1] - a[1] for a, b in zip(ys, ys[1:]) if not a[0]]
    assert downs, ys
    ch = page.evaluate("() => document.querySelector('.zc-card:not(.zc-off)').getBoundingClientRect().height")
    assert all(ch * DOWN_MIN <= d <= ch * DOWN_MAX for d in downs), (downs, ch)
    ctx.close()
