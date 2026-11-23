"""Mahjong in Red: the tile's glyphs stay readable on the red face (both Mahjong games share the tile art).

Blue, green and red ink sit within a few luminance points of the red face, so the shared Red rule sends every ink to near-black and
keeps the cream highlights. Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_mahjong_red_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_games_daily_browser import browser, site  # noqa: E402,F401

PAINTS = """() => {
  const t = document.querySelector('.mj-t svg, .m4-t svg');
  const ink = [...t.querySelectorAll('[fill^="#"], [stroke^="#"]')].filter(e => !/f7f2e4|fff3c4/i.test((e.getAttribute('fill') || '') + (e.getAttribute('stroke') || '')));
  return ink.map(e => [getComputedStyle(e).fill, getComputedStyle(e).stroke]);
}"""


@pytest.mark.parametrize("game, tile", [("mahjong.html", ".mj-t svg"), ("mahjong4.html", ".m4-t svg")])
def test_every_ink_of_a_tile_is_near_black_in_red(browser, site, game, tile):  # noqa: F811
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto(site + game)
    page.wait_for_selector(tile, state="attached", timeout=30000)
    page.evaluate("() => document.documentElement.classList.add('gs', 'night-red')")
    paints = page.evaluate(PAINTS)
    assert paints, "no inked glyph found on a tile"
    for fill, stroke in paints:
        for colour in (fill, stroke):
            if colour in ("none", "rgba(0, 0, 0, 0)"):
                continue
            r, g, b = (int(x) for x in colour[colour.index("(") + 1:colour.index(")")].split(",")[:3])
            assert 0.299 * r + 0.587 * g + 0.114 * b < 40, (colour, paints[:4])
    ctx.close()
