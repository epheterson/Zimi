"""A square you may move to is tile-sized, and the same for either player (Walls steps, Polyominoes first pieces).

The marker used to be the smallest thing on the board: a 5px dot in Walls, a 7px speck for your start in Polyominoes beside a
15px ring for Zimi's (the hint dot's size beat the ring's).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_markers_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, shell_ready  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

MIN_SHARE = 0.6  # of the tile's width
RING = """els => els.map(b => {
  const t = b.getBoundingClientRect().width, a = getComputedStyle(b, '::after');
  return {cls: b.className, tile: t, ring: parseFloat(a.width), border: parseFloat(a.borderTopWidth)};
})"""


def open_page(browser, served, name):
    ctx = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce"
    )
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, name))
    shell_ready(page)
    frames(page, 4)
    return ctx, page


def test_walls_steps_are_rings_most_of_a_tile(browser, served):
    ctx, page = open_page(browser, served, "walls")
    rings = page.eval_on_selector_all(
        ".wl-board button.hint",
        RING,
    )
    assert rings, "no marked square to step to"
    for r in rings:
        assert r["ring"] >= MIN_SHARE * r["tile"] and r["border"] >= 2, r
    ctx.close()


def test_polyominoes_starts_look_the_same_for_both_players(browser, served):
    ctx, page = open_page(browser, served, "polyominoes")
    rings = page.eval_on_selector_all(
        ".po-board button.start",
        RING,
    )
    assert len(rings) == 2
    for r in rings:
        assert r["ring"] >= MIN_SHARE * r["tile"], r
    assert (
        abs(rings[0]["ring"] - rings[1]["ring"]) < 0.5
        and rings[0]["border"] == rings[1]["border"]
    ), rings
    ctx.close()
