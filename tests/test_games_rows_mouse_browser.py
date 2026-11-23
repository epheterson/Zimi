"""The shelf's rows by mouse alone (discussion #156): at 1367px each row stopped at the right edge with its scrollbar
hidden, and a mouse had no way to the rest. With a pointer that hovers, a chevron at each end pages along the row and the
wheel turns sideways over it; a row ends where the page's content does.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_rows_mouse_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import browser, served  # noqa: E402,F401

ROW = ".ar-world"
# Where the row's last tile is against the row's visible box, and what the chevrons show.
STATE = r"""(sel) => {
  const s = document.querySelector(sel), nav = s.querySelector('.ar-games'), tiles = [...nav.querySelectorAll('.ar-game')].filter(t => t.getClientRects().length);   // the room's tiles: other rooms' are hidden
  const box = nav.getBoundingClientRect(), last = tiles[tiles.length - 1].getBoundingClientRect();
  const shelf = document.querySelector('.ar-shelf').getBoundingClientRect(), pad = parseFloat(getComputedStyle(document.querySelector('.ar-shelf')).paddingRight);
  const shown = (b) => !!b && !b.hidden && getComputedStyle(b).display !== 'none';
  return { lastIn: last.right <= box.right + 1 && last.left >= box.left - 1, prev: shown(s.querySelector('.ar-row-prev')),
    next: shown(s.querySelector('.ar-row-next')), scroll: nav.scrollLeft, rowRight: box.right, shelfRight: shelf.right, pad: pad };
}"""


def _page(browser, served):
    ctx = browser.new_context(
        viewport={"width": 1367, "height": 900}, reduced_motion="reduce"
    )
    page = ctx.new_page()
    page.add_init_script("localStorage.setItem('zimi.games.view','lobby')")
    page.goto("%s/index.html" % served)
    page.wait_for_selector(ROW + " .ar-game")
    page.locator(ROW).scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    return ctx, page


def test_a_mouse_reaches_the_last_tile_of_a_row_by_the_chevron(browser, served):
    ctx, page = _page(browser, served)
    try:
        st = page.evaluate(STATE, ROW)
        assert not st["lastIn"], (
            "the row overflows at 1367px, so this proves something: %s" % st
        )
        assert st["next"] and not st["prev"], st
        # The row ends where the page's content does (the shelf's edge less its gutter), not out in the gutter or short of it.
        assert abs(st["rowRight"] - (st["shelfRight"] - st["pad"])) <= 1, st
        for _ in range(10):
            page.click(ROW + " .ar-row-next")
            page.wait_for_timeout(500)
            st = page.evaluate(STATE, ROW)
            if st["lastIn"]:
                break
        assert st["lastIn"] and not st["next"] and st["prev"], st
        page.click(ROW + " .ar-row-prev")
        page.wait_for_timeout(500)
        assert page.evaluate(STATE, ROW)["scroll"] < st["scroll"]
    finally:
        ctx.close()


def test_the_wheel_turns_sideways_over_a_row(browser, served):
    ctx, page = _page(browser, served)
    try:
        box = page.locator(ROW + " .ar-games").bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        before = page.evaluate("() => scrollY")
        for _ in range(30):
            page.mouse.wheel(0, 200)
            page.wait_for_timeout(60)
            if page.evaluate(STATE, ROW)["lastIn"]:
                break
        st = page.evaluate(STATE, ROW)
        assert st["lastIn"], st
        assert (
            page.evaluate("() => scrollY") == before
        ), "the page stayed put while the row moved"
    finally:
        ctx.close()


def test_touch_keeps_its_swipe_and_no_chevrons(browser, served):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True
    )
    page = ctx.new_page()
    page.goto("%s/index.html" % served)
    page.wait_for_selector(ROW + " .ar-game")
    assert page.locator(".ar-row-btn").count() == 0
    ctx.close()


def test_a_mouse_drag_scrolls_a_row_and_opens_nothing(browser, served):
    ctx, page = _page(browser, served)
    try:
        box = page.locator(ROW + " a.ar-game:visible").first.bounding_box()
        y = box["y"] + box["height"] / 2
        x = box["x"] + 100
        before = page.evaluate(STATE, ROW)["scroll"]
        url = page.url
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x - 100, y, steps=5)
        page.mouse.move(x - 200, y, steps=5)
        page.mouse.up()
        page.wait_for_timeout(300)
        st = page.evaluate(STATE, ROW)
        assert st["scroll"] - before >= 100, st   # snapping settles it on a card
        assert page.url == url, "a drag must not open the card it ended over"
        assert st["prev"], st
    finally:
        ctx.close()


def test_a_click_without_a_drag_still_opens_the_game(browser, served):
    ctx, page = _page(browser, served)
    try:
        href = page.locator(ROW + " a.ar-game:visible").first.get_attribute("href")
        page.click(ROW + " a.ar-game:visible >> nth=0", position={"x": 20, "y": 20})
        page.wait_for_timeout(500)
        assert href.split("?")[0] in page.url, (href, page.url)
    finally:
        ctx.close()
