"""The shelf's section chips are drawn 28 px tall; on a touch screen each answers a finger 44 px tall.

The chip's own hit area reached 4 px past it, and the row's sideways scroller clipped anything further, so a tap a
few pixels off a chip missed it.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_chip_reach_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

REACH = """() => { const c = [...document.querySelectorAll('.sh-chip')].filter(e => e.getBoundingClientRect().height)[1], r = c.getBoundingClientRect(), x = r.left + r.width / 2;
  const hits = y => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('.sh-chip') === c); };
  return { h: r.height, above: hits(r.top - 7.5), below: hits(r.bottom + 7.5) }; }"""


def test_a_chip_answers_a_finger_44px_tall(served, browser):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".sh-chip")
    got = page.evaluate(REACH)
    assert got["h"] < 44 and got["above"] and got["below"], got
    ctx.close()
