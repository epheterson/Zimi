"""Red night mode in Reader View's menu: the switch's knob and the four theme swatches
were drawn white and cream (fixed colours), not in the mode's reds.

Real server on a fixture ZIM, the reader at 390 px, the Red theme on.
"""

import os
import re
import sys

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_readaloud_main_page_live import (
    PHONE,
    zimi,
)  # noqa: E402,F401  (the server fixture)

SCREENSHOT = os.environ.get("ZIMI_SHOT")
COLOURS = """() => [...document.querySelectorAll('#topbar-menu .rv-knob, #topbar-menu .rv-sw-dot')].map(
  e => { const c = getComputedStyle(e); return [e.className, c.backgroundColor, c.backgroundImage]; })"""


def test_reader_views_menu_has_no_white_or_cream_in_red_mode(zimi):
    with sync_playwright() as p:
        b = p.chromium.launch()
        try:
            ctx = b.new_context(**PHONE)
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_app_theme', 'red'); } catch (e) {}"
            )
            pg = ctx.new_page()
            pg.goto(zimi + "/?a=wikipedia_pt_test%2FA%2FArtigo", wait_until="load")
            pg.wait_for_function(
                "() => typeof readerOpen !== 'undefined' && readerOpen", timeout=30000
            )
            pg.wait_for_timeout(1000)
            pg.click(".topbar-more")
            pg.click("#tbm-readerview")  # Reader View on: its swatches join the menu
            pg.wait_for_selector("#topbar-menu.visible .rv-sw-dot")
            colours = pg.evaluate(COLOURS)
            if SCREENSHOT:
                pg.screenshot(path=SCREENSHOT)
            assert len(colours) >= 5, colours
            for cls, bg, img in colours:
                for r, g, bl in re.findall(
                    r"rgba?\((\d+), (\d+), (\d+)", bg + " " + img
                ):
                    assert int(g) <= 40 and int(bl) <= 40, (cls, bg, img)
        finally:
            b.close()
