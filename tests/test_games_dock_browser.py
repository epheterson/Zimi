"""The primary action sits in one place in every game: docked at the bottom safe area of a touch screen, the board centred above it.

A page whose children include a row holding a .gs-primary button (or a row marked .gs-dock) docks it (games.css, "The primary
action is where the thumb is"). Here: the action's bottom edge, at 390x844 and 360x740, is the same for every game.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_dock_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, shell_ready  # noqa: E402
from test_games_persist_browser import browser, served  # noqa: E402,F401

SIZES = [(390, 844), (360, 740)]
DOCK_GAP = 16  # the row's own bottom padding, below the buttons
TOLERANCE = 1.5
# page, the primary action
GAMES = [
    ("pig", "#pg-roll"),
    ("shutthebox", "#st-roll"),
    ("tenthousand", "#tt-roll"),
    ("whoisit", "#wi-guess"),
    ("walls", "#wl-place"),
    ("fourfold", "#ff-give"),
    ("polyominoes", "#po-place"),
    ("carrom", "#cr-shoot"),
    ("hnefatafl", "#wk-hint"),
    ("colortrail", "#ct-draw"),
    ("courtier", "#cr-play"),
    ("backgammon", "#wk-hint"),
    ("ur", "#ur-roll"),
]


def action_bottom(browser, served, page_name, selector, size, scroll=False):
    ctx = browser.new_context(
        viewport={"width": size[0], "height": size[1]},
        has_touch=True,
        is_mobile=True,
        reduced_motion="reduce",
    )
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, page_name))
    shell_ready(page)
    page.wait_for_selector(selector, state="attached")
    frames(page, 4)
    box = page.eval_on_selector(
        selector,
        "e => { const r = e.getBoundingClientRect(); return {b: r.bottom, h: innerHeight, sh: document.documentElement.scrollHeight}; }",
    )
    ctx.close()
    return box


@pytest.mark.parametrize("size", SIZES, ids=lambda s: "%dx%d" % s)
def test_every_primary_action_docks_at_the_bottom(browser, served, size):
    found = {}
    for name, selector in GAMES:
        r = action_bottom(browser, served, name, selector, size)
        found[name] = r
    off = {
        n: r["b"] - (r["h"] - DOCK_GAP)
        for n, r in found.items()
        if abs(r["b"] - (r["h"] - DOCK_GAP)) > TOLERANCE
    }
    assert not off, "action bottom edge off the dock by (px): %s; all: %s" % (
        off,
        found,
    )
