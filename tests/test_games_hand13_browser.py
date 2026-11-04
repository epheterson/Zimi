"""Every hand is one size: the card games share Hearts' card width on a phone, and a hand narrows only when it would not fit one row.

Spades took the table's default (a card one seventh of the width, 45 px at 390) while Hearts gave its hand five columns
(70 px), so the same thirteen cards read smaller in one game than the other.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_hand13_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

WIDTH = "() => Math.round(document.querySelector('.zc-card:not(.zc-off)').getBoundingClientRect().width)"


HANDS = ("hearts", "spades", "crazyeights", "gin", "euchre", "durak", "cribbage", "bigtwo", "belote")


def test_every_card_game_deals_the_same_size_hand(served, browser):
    widths = {}
    for game in HANDS:
        ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        page.goto("%s/%s.html" % (served, game))
        page.wait_for_function("() => document.querySelectorAll('.zc-card:not(.zc-off)').length >= 5")
        page.wait_for_timeout(600)
        widths[game] = page.evaluate(WIDTH)
        ctx.close()
    assert widths["hearts"] >= 60 and all(w == widths["hearts"] for w in widths.values()), widths


def test_a_hand_too_long_for_one_row_narrows(served, browser):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto("%s/spades.html" % served)
    page.wait_for_function("() => window.ZimiTable && ZimiTable.handCols")
    cols = page.evaluate("() => [ZimiTable.handCols(13, 390, 8, 5), ZimiTable.handCols(20, 390, 8, 5), ZimiTable.handCols(60, 390, 8, 5)]")
    assert cols[0] == 5 and 5 < cols[1] <= 8 and cols[2] == 8, cols
    ctx.close()
