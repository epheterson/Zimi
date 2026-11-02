"""Loopy: an edge not yet drawn is a faint neutral guide, so the lines the player draws stand out (it was drawn in amber, as heavy as a line).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_loopy_palette.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401


def test_loopys_unknown_edges_are_neutral(served, browser):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto("%s/puzzles/loopy.html" % served)
    page.wait_for_function("window.colours && colours[2]")
    unknown = page.evaluate("colours[2]")
    r, g, b = (int(unknown[i:i + 2], 16) for i in (1, 3, 5))
    assert max(r, g, b) - min(r, g, b) < 12 and min(r, g, b) > 0xc0, "unknown edges are %s, not a faint grey" % unknown
    ctx.close()
