"""Wide Home's top bar: the background is full bleed, the contents sit on the library tiles' column edges
.

Run: pytest tests/test_home_topbar_live.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_home_apps_live import HOME  # noqa: E402
from test_home_layout_live import served  # noqa: E402,F401

EDGES = r"""() => {
  const bar = document.querySelector('.topbar');
  const logo = document.getElementById('logo').getBoundingClientRect();
  const kids = Array.from(bar.children).filter(e => e.offsetParent !== null && e.getBoundingClientRect().width);
  const last = Math.max.apply(null, kids.map(e => e.getBoundingClientRect().right));
  const g = document.querySelector('#output .stats-grid:not(.apps-grid)').getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  return { logoL: logo.left, lastR: last, gridL: g.left, gridR: g.right, barL: b.left, barR: b.right,
    vw: document.documentElement.clientWidth };
}"""


@pytest.mark.parametrize("width", [1280, 1920, 2560])
def test_top_bar_contents_sit_on_the_tiles_edges(served, width):  # noqa: F811
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(color_scheme="dark", viewport={"width": width, "height": 1000})
            pg = ctx.new_page()
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            m = pg.evaluate(EDGES)
            assert m["barL"] == 0 and m["barR"] >= m["vw"] - 1, m
            assert abs(m["logoL"] - m["gridL"]) <= 1, m
            assert abs(m["lastR"] - m["gridR"]) <= 1, m
        finally:
            br.close()
