"""A card table runs to the foot of the screen. On an iPhone the home indicator's strip (--safe-b, 34 px) was body padding, so
the page colour showed there: a white band under Blackjack. The felt fills it now, every card game alike.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_card_table_foot_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import browser, served  # noqa: E402,F401

FOOT = """inset => { document.documentElement.style.setProperty('--safe-b', inset);
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() =>
    r([20, 195, 370].map(x => document.elementFromPoint(x, innerHeight - 2).tagName.toLowerCase()))))); }"""


@pytest.mark.parametrize("game", ["blackjack", "solitaire", "hearts"])
def test_the_felt_reaches_the_foot(browser, served, game):
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, game))
    page.wait_for_selector(".gs-ready .zc-table")
    page.wait_for_timeout(500)
    for inset in ("0px", "34px"):
        bottom = page.evaluate(FOOT, inset)
        assert "body" not in bottom and "html" not in bottom, (inset, bottom)
    ctx.close()
