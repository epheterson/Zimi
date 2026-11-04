"""Mahjong's Zoom makes a tile big enough to tap (44 px wide) on a phone, and scrolls sideways to reach the rest.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_mahjong_zoom.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

TILE = "() => { const r = document.querySelector('.mj-t').getBoundingClientRect(); return [r.width, r.height]; }"


def test_zoom_makes_a_tile_a_tap_target(served, browser):
    ctx = browser.new_context(viewport=VIEW, has_touch=True)
    page = ctx.new_page()
    page.goto("%s/mahjong.html" % served)
    page.wait_for_selector(".mj-t")
    page.wait_for_timeout(300)
    fit_w, _ = page.evaluate(TILE)
    assert fit_w < 44, "the fitted board is the small one"
    page.locator("#mj-zoom").click()
    page.wait_for_timeout(300)
    w, h = page.evaluate(TILE)
    assert w >= 44 and h >= 44, "zoomed tile is %dx%d" % (w, h)
    ctx.close()
