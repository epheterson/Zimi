"""The Games shelf inside Zimi on a desktop, in its Index view: no empty band above the page (the settings button sits beside
the room, at the head of the rail), and the room's pill clears the first type under it.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_shelf_rail_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_final_fixes import _shelf, chromium, playwright_driver, zimi  # noqa: E402,F401

BOXES = """() => { const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
  const h = document.querySelector('.ar-shelf > header');
  return { header: h ? getComputedStyle(h).display : 'none', body: r('.sh-body'), pick: r('.sh-room-pick'), opt: r('.sh-opt'), nav: r('.sh-nav'), rail: r('.sh-rail') }; }"""


@pytest.mark.parametrize("width", [1280, 1000])
def test_the_rail_starts_at_the_top_and_its_pill_clears_the_types(chromium, zimi, width):
    ctx, page, f = _shelf(chromium, zimi, viewport={"width": width, "height": 800}, view="index", touch=False)
    b = f.evaluate(BOXES)
    assert b["header"] == "none"                                   # nothing holds a band open above the rail
    assert b["body"]["top"] < 24, b
    assert b["nav"]["top"] - b["pick"]["bottom"] >= 8, b           # the pill does not rest on the type list
    assert b["pick"]["top"] < b["opt"]["bottom"] and b["opt"]["top"] < b["pick"]["bottom"], b   # the button is on the pill's line
    assert b["opt"]["right"] <= b["rail"]["right"] + 12, b          # and over the rail, not out in the games' column
    ctx.close()
