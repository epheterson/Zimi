"""A hand of thirteen is the same size in every game that deals one: Hearts and Spades share one card width on a phone.

Spades took the table's default (a card one seventh of the width, 45 px at 390) while Hearts gave its hand five columns
(70 px), so the same thirteen cards read smaller in one game than the other.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_hand13_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

WIDTH = "() => Math.round(document.querySelector('.zc-card:not(.zc-off)').getBoundingClientRect().width)"


def test_hearts_and_spades_deal_the_same_size_hand(served, browser):
    widths = {}
    for game in ("hearts", "spades"):
        ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        page.goto("%s/%s.html" % (served, game))
        page.wait_for_function("() => document.querySelectorAll('.zc-card:not(.zc-off)').length >= 13")
        widths[game] = page.evaluate(WIDTH)
        ctx.close()
    assert widths["hearts"] == widths["spades"] >= 60, widths
