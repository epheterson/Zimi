"""Spider and Klondike open their face-down cards when the table has room, by the same step as the face-up ones.

Spider's five face-down cards sat in 7 px steps at the top of a phone whose table was three quarters empty: a
face-down card took a fixed 0.54 of a face-up step whatever the room.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_spider_open_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401



@pytest.mark.parametrize("game,api,col", [("spider", "ZimiSpider", "c0"), ("solitaire", "ZimiSolitaire", "t6")])
def test_face_down_cards_open_up_with_room(served, browser, game, api, col):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, game))
    page.wait_for_function("() => window.%s && %s.session && %s.session.state" % (api, api, api))
    page.wait_for_timeout(1500)   # the deal lands
    ys = page.evaluate("""([api, col]) => window[api].session.state.piles[col].map(c => {
        const e = document.querySelector('.zc-card[data-id="' + c.id + '"]'); return [c.up, e.getBoundingClientRect().top]; })""", [api, col])
    downs = [b[1] - a[1] for a, b in zip(ys, ys[1:]) if not a[0]]
    assert downs, ys
    face_up_step = page.evaluate("() => { const r = document.querySelector('.zc-card:not(.zc-off)').getBoundingClientRect(); return r.height * ZimiCards.FAN_UP_SHARE; }")
    assert min(downs) >= face_up_step - 1, (downs, face_up_step)
    ctx.close()
