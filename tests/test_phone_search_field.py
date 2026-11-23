"""The phone's search box keeps its room, and its suggestions use the screen's width.

At 390px the box was 202px on Home, 166 on results and 127 in an article (the source's mark and slash beside it), and the
history and filter pills opened clipped inside a dropdown the box's width.

Run: pytest tests/test_phone_search_field.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_reader_view_address import served  # noqa: E402,F401  (the one-article library)

BOX = "() => document.getElementById('q').getBoundingClientRect().width"
MIN_BOX = 120  # px: the box in an article, with Back, History, Save, Saved and the menu beside it (it was 85)


def test_the_box_keeps_its_room_in_an_article_and_the_pills_get_the_screen(served):  # noqa: F811
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            pg = ctx.new_page()
            pg.goto(served + "/")
            pg.wait_for_function("() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0", timeout=30000)
            home = pg.evaluate(BOX)
            pg.evaluate("() => openArticle('plainread', 'A/index')")
            pg.wait_for_function("() => document.body.classList.contains('reading')", timeout=30000)
            pg.wait_for_timeout(500)
            assert pg.evaluate(BOX) >= MIN_BOX, (home, pg.evaluate(BOX))
            # Focus: the history and pills sheet is the screen wide, nothing clipped.
            pg.tap("#q")
            pg.wait_for_selector("#suggest-dropdown", state="visible", timeout=5000)
            rect = pg.evaluate("() => { var r = document.getElementById('suggest-dropdown').getBoundingClientRect(); return [r.left, r.right]; }")
            assert rect == [0, 390], rect
        finally:
            br.close()
