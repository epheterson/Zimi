"""The patience games fit a phone and never zoom or scroll sideways.

Each game is opened at 390 and 375 px wide with touch, double-tapped on a card (the move that sends it home, which iOS reads as
a zoom unless touch-action says otherwise) and dragged. After each: the document is no wider than the screen, it has not been
scrolled sideways, no card or pile sits outside the table, and every point of the page is under a touch-action that is not
`auto` (the one value that lets a double tap zoom).
"""

import os
import sys

import pytest

pytest.importorskip("playwright")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_trick_fixtures import browser, served  # noqa: E402,F401

GAMES = ["solitaire", "freecell", "spider", "golf", "pyramid", "tripeaks"]

MEASURE = """
() => {
  const d = document.documentElement, t = document.getElementById('zc-table').getBoundingClientRect(), out = [];
  for (const e of document.querySelectorAll('.zc-card:not(.zc-off), .zc-slot:not([data-quiet])')) {
    const r = e.getBoundingClientRect();
    if (r.width && (r.left < t.left - 1 || r.right > t.right + 1)) out.push(e.className + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  const zoomable = (el) => { for (; el; el = el.parentElement) if (getComputedStyle(el).touchAction !== 'auto') return false; return true; };
  const open = [];
  for (let y = 4; y < innerHeight; y += 60) for (let x = 4; x < innerWidth; x += 50) {
    const e = document.elementFromPoint(x, y);
    if (e && zoomable(e)) open.push(e.tagName + '.' + e.className + '@' + x + ',' + y);
  }
  return { sw: d.scrollWidth, cw: d.clientWidth, sx: scrollX, scale: window.visualViewport ? visualViewport.scale : 1, outside: out, open: open };
}
"""


@pytest.mark.parametrize("width", [390, 375])
@pytest.mark.parametrize("name", GAMES)
def test_the_table_fits_and_a_double_tap_does_not_zoom(browser, served, name, width):
    ctx = browser.new_context(viewport={"width": width, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, name))
    page.wait_for_selector(".zc-card:not(.zc-off)")
    page.wait_for_timeout(1500)

    def check(when):
        m = page.evaluate(MEASURE)
        assert m["sw"] <= m["cw"] and m["sx"] == 0, "%s %s: the page is wider than the screen %s" % (name, when, m)
        assert m["scale"] == 1, "%s %s: the page was zoomed %s" % (name, when, m)
        assert not m["outside"], "%s %s: outside the table %s" % (name, when, m["outside"])
        assert not m["open"], "%s %s: a double tap here can zoom %s" % (name, when, m["open"][:5])

    check("at the deal")
    box = page.locator(".zc-card:not(.zc-off):not(.zc-down)").last.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.touchscreen.tap(x, y)
    page.wait_for_timeout(60)
    page.touchscreen.tap(x, y)
    page.wait_for_timeout(500)
    check("after a double tap")
    box = page.locator(".zc-card:not(.zc-off):not(.zc-down)").first.bounding_box()
    page.mouse.move(box["x"] + 10, box["y"] + 10)
    page.mouse.down()
    page.mouse.move(box["x"] - 60, box["y"] + 80, steps=6)
    page.mouse.up()
    page.wait_for_timeout(500)
    check("after a drag")
    ctx.close()
