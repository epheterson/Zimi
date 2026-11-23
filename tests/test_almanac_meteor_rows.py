"""A meteor shower's row: its countdown is one line ("33 days", never "33" over "days"), and the Moon's mark stays with its word.

At a phone's width, the rows of the Almanac's Meteor Showers. 
Run: pytest tests/test_almanac_meteor_rows.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from almanac_phone_kit import READY_MS, VIEW, browser, served  # noqa: E402,F401  (a served Zimi and a software-GL Chromium)

ROWS = """() => Array.from(document.querySelectorAll('#almanac-meteors .almanac-eclipse-row')).map(r => {
  var u = r.querySelector('.almanac-eclipse-until'), m = r.querySelector('.almanac-eclipse-moon'), lh = parseFloat(getComputedStyle(u).lineHeight) || 16;
  return { until: u.textContent, untilLines: Math.round(u.getBoundingClientRect().height / lh),
           moonLines: Math.round(m.getBoundingClientRect().height / (parseFloat(getComputedStyle(m).lineHeight) || 16)) };
})"""


def test_every_shower_row_keeps_its_countdown_on_one_line(browser, served):  # noqa: F811
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, service_workers="block", locale="en-US")
    try:
        pg = ctx.new_page()
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function("() => document.querySelectorAll('#almanac-meteors .almanac-eclipse-row').length >= 3", timeout=READY_MS)
        rows = pg.evaluate(ROWS)
        assert rows and all(r["untilLines"] == 1 and r["moonLines"] == 1 for r in rows), rows
    finally:
        ctx.close()
