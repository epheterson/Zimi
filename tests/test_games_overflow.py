"""No game page scrolls sideways on a phone.

Every page in games.json (and the shelf) is opened at 375 wide with touch, then measured three times: after load, after a tap in the
middle of the page (whatever the game makes of it: a card, a cell, a start button), and with the Menu open. Each time the document
is no wider than the screen and has not been scrolled sideways.
"""

import json
import os
import sys

import pytest

pytest.importorskip("playwright")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_trick_fixtures import GAMES, browser, served  # noqa: E402,F401

WIDTH = 375
PAGES = ["index.html"] + sorted({g["path"] for g in json.load(open(os.path.join(GAMES, "games.json"), encoding="utf-8")) if g.get("path")})

MEASURE = """
() => {
  const d = document.documentElement, b = document.body;
  const wide = [];
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    if (r.width && r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('[hidden], svg, canvas')) wide.push(e.tagName + '.' + e.className + ' right=' + Math.round(r.right));
    if (wide.length > 4) break;
  }
  return { sw: Math.max(d.scrollWidth, b.scrollWidth), w: innerWidth, sx: scrollX, wide: wide };
}
"""


@pytest.mark.parametrize("path", PAGES)
def test_the_page_never_scrolls_sideways(browser, served, path):
    ctx = browser.new_context(viewport={"width": WIDTH, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    page = ctx.new_page()
    page.goto("%s/%s" % (served, path))
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)

    def check(when):
        m = page.evaluate(MEASURE)
        assert m["sw"] <= m["w"] and m["sx"] == 0, "%s %s: the page is %dpx wide on a %dpx screen (scrolled %d); wider than the screen: %s" % (path, when, m["sw"], m["w"], m["sx"], m["wide"])

    check("after load")
    page.touchscreen.tap(WIDTH // 2, 420)
    page.wait_for_timeout(700)
    check("after a tap")
    menu = page.locator("#gs-menu, [data-gs-menu], button[aria-label='Menu']").first
    if menu.count() and menu.is_visible():
        menu.tap()
        page.wait_for_timeout(500)
        check("with the Menu open")
    ctx.close()


@pytest.mark.parametrize("width", [375, 390])
def test_canastas_score_strip_fits_with_the_longest_scores(browser, served, width):
    """The strip is clipped, not scrolled, so the page's own width cannot see it run off: each chip must sit inside the screen."""
    ctx = browser.new_context(viewport={"width": width, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    page = ctx.new_page()
    page.goto("%s/canasta.html" % served)
    page.wait_for_function("() => window.ZimiCanasta && ZimiCanasta.session && ZimiCanasta.session.state")
    page.evaluate("() => { const s = ZimiCanasta.session.state; s.scores = [3555, 4755]; s.reds = [[1, 2], [3]]; ZimiCanasta.board.refresh(); }")
    page.wait_for_timeout(600)
    box = page.evaluate("() => { const r = [...document.querySelectorAll('.ct-chip')].map(c => c.getBoundingClientRect()); return [Math.min(...r.map(c => c.left)), Math.max(...r.map(c => c.right)), r.length]; }")
    assert box[2] == 3 and box[0] >= 0 and box[1] <= width, box
    ctx.close()
