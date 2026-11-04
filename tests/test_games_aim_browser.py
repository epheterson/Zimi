"""A board point smaller than a fingertip is aimed, then played.

Gomoku's 15 by 15 board gives each crossing 24 px on a phone, under a finger 40 px wide. The first touch rings the
crossing, a second touch on it plays there, a touch elsewhere moves the ring. A mouse click and a 9 by 9 Go point (40 px)
play at once.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_aim_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

STONES = "() => Array.from(__gm.state().board).filter(Boolean).length"


def _gomoku(browser, served, touch):
    ctx = browser.new_context(viewport=VIEW, has_touch=touch, is_mobile=touch)
    page = ctx.new_page()
    page.goto("%s/gomoku.html?debug" % served)
    page.wait_for_function("() => window.__gm && document.querySelectorAll('.gm-pt').length === 225")
    return ctx, page


def _centre(page, i):
    b = page.locator(".gm-pt").nth(i).bounding_box()
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


def test_a_small_point_is_aimed_then_played(served, browser):
    ctx, page = _gomoku(browser, served, True)
    page.touchscreen.tap(*_centre(page, 112))
    assert page.evaluate(STONES) == 0, "one touch on a 24 px point played it"
    assert page.locator(".gm-pt.wk-aim").count() == 1
    page.touchscreen.tap(*_centre(page, 113))
    assert page.evaluate(STONES) == 0 and page.locator(".gm-pt").nth(113).evaluate("e => e.classList.contains('wk-aim')")
    page.touchscreen.tap(*_centre(page, 113))
    page.wait_for_function("() => Array.from(__gm.state().board).filter(Boolean).length >= 1")
    assert page.locator(".wk-aim").count() == 0
    ctx.close()


def test_a_mouse_click_plays_at_once(served, browser):
    ctx, page = _gomoku(browser, served, False)
    page.mouse.click(*_centre(page, 112))
    page.wait_for_function("() => Array.from(__gm.state().board).filter(Boolean).length >= 1")
    ctx.close()


def test_a_point_big_enough_plays_at_once(served, browser):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/go.html" % served)
    page.wait_for_selector(".wk-pt")
    b = page.locator(".wk-pt").nth(40).bounding_box()
    assert b["width"] >= 36
    before = page.evaluate("() => document.getElementById('wk-board').innerHTML.length")
    page.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    page.wait_for_function("(n) => document.getElementById('wk-board').innerHTML.length !== n", arg=before)
    assert page.locator(".wk-aim").count() == 0
    ctx.close()
