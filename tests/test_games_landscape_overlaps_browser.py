"""A phone on its side (844x390): what the older card games lay on the table does not lie over the tray of choices or each other.

Bridge's bid grid stays inside the table (it ran up under the bar), Gin's piles and Durak's played cards stand right of the tray,
Koi-Koi's captured strip does not cover the table row, Cribbage's crib and starter stand either side of the board, Teen Patti's and
Blackjack's chips are not under the tray.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_landscape_overlaps_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready  # noqa: E402
from test_games_persist_browser import browser, served  # noqa: E402,F401

LANDSCAPE = {"width": 844, "height": 390}

RECT = "(sel) => [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }).map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })"


def open_game(browser, served, name):
    ctx = browser.new_context(
        viewport=LANDSCAPE, has_touch=True, is_mobile=True, reduced_motion="reduce"
    )
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, name))
    game_ready(page)
    frames(page, 6)
    return ctx, page


def rects(page, sel):
    return page.evaluate(RECT, sel)


def overlap(a, b):
    return a[0] < b[2] - 1 and b[0] < a[2] - 1 and a[1] < b[3] - 1 and b[1] < a[3] - 1


def test_bridge_bid_grid_stays_inside_the_table(browser, served):
    ctx, page = open_game(browser, served, "bridge")
    page.wait_for_selector(".br-box:not([hidden]) .br-bid", timeout=30000)
    frames(page, 3)
    box = rects(page, ".br-box")[0]
    table = rects(page, "#zc-table")[0]
    assert box[1] >= table[1] - 1 and box[3] <= table[3], (box, table)
    ctx.close()


def test_gin_piles_are_not_under_the_tray(browser, served):
    ctx, page = open_game(browser, served, "gin")
    page.wait_for_selector(".ct-panel:not([hidden]) .ct-choice", timeout=30000)
    frames(page, 3)
    panel = rects(page, ".ct-panel:not([hidden])")[0]
    for pile in ("stock", "discard"):
        for r in rects(page, '.zc-card[data-pile="%s"]' % pile):
            assert not overlap(r, panel), (pile, r, panel)
    ctx.close()


def test_koikoi_strip_is_clear_of_the_table_row(browser, served):
    ctx, page = open_game(browser, served, "koikoi")
    frames(page, 4)
    pills = rects(page, ".kk-pill")
    table = rects(page, ".zc-card")
    assert pills and table
    for r in table:
        for pill in pills:
            assert not overlap(r, pill), (r, pill)
    status = rects(page, ".ct-status")[0]
    for r in table:
        assert not overlap(r, status), (r, status)
    ctx.close()


def test_cribbage_crib_and_starter_are_clear_of_the_status_line(browser, served):
    ctx, page = open_game(browser, served, "cribbage")
    frames(page, 4)
    status = rects(page, ".ct-status")[0]
    for pile in ("starter", "crib"):
        for r in rects(page, '.zc-card[data-pile="%s"]' % pile):
            assert not overlap(r, status), (pile, r, status)
    ctx.close()


def test_chips_are_not_under_the_tray(browser, served):
    for name in ("teenpatti", "blackjack"):
        ctx, page = open_game(browser, served, name)
        page.wait_for_selector(".ct-panel:not([hidden]) .ct-choice", timeout=30000)
        page.wait_for_selector(".ct-pile:not(:empty)", timeout=30000)
        frames(page, 3)
        panel = rects(page, ".ct-panel:not([hidden])")[0]
        for r in rects(page, ".ct-pile:not(:empty)"):
            assert not overlap(r, panel), (name, r, panel)
        ctx.close()
