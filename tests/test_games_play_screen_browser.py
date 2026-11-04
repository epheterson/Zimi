"""The play screen shows play: Liar's Dice's rules live in How to play like every other game's, and Hold'em's chip count
is the status line's, not the bar's (where it cut the name to "Texas H...").

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_play_screen_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401


def _open(browser, served, game):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, game))
    page.wait_for_function("() => document.documentElement.classList.contains('gs-ready')")
    return ctx, page


def test_liars_dice_rules_are_in_how_to_play(served, browser):
    ctx, page = _open(browser, served, "liarsdice")
    assert page.locator(".pl-help").count() == 0
    assert page.evaluate("() => ZimiText.has('help.liarsdice.keys') && /wild/.test(ZimiText.T('help.liarsdice.turn'))")
    ctx.close()


def test_holdem_keeps_its_whole_name(served, browser):
    ctx, page = _open(browser, served, "holdem")
    page.wait_for_timeout(500)
    got = page.evaluate("() => { const h = document.querySelector('.ar-bar h1'); return [parseFloat(getComputedStyle(h).fontSize), document.querySelector('.ar-bar').innerText, h.scrollWidth <= h.clientWidth]; }")
    assert got[0] >= 16 and got[2] and "chips" not in got[1], got   # beside Undo and Menu at 390 px it is a pixel under the bar's 17
    ctx.close()
