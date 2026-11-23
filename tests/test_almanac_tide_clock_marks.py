"""The tide chart's clock marks: its line starts at its dot, and a turn's dot under it steps back.

The line ran the chart's whole height, through the time written over a crest, and the next turn's dot half hid behind the clock's
dot when the clock stood on it. At a phone's width, San Francisco chosen.

Run: pytest tests/test_almanac_tide_clock_marks.py -v
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from almanac_phone_kit import READY_MS, VIEW, browser, served  # noqa: E402,F401  (a served Zimi and a software-GL Chromium)

SF = {"lat": 37.8063, "lon": -122.4659, "name": "San Francisco"}
POLL_MS = 100
DRAWN = "() => !!document.querySelector('#almanac-place .at-section')"
HOUR_MS = 3600 * 1000


def test_the_clock_on_a_turn_leaves_its_time_readable_and_its_dot_whole(browser, served):  # noqa: F811
    try:
        ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, service_workers="block", locale="en-US")
        ctx.add_init_script("sessionStorage.setItem('zimi_almanac_location', %s);" % json.dumps(json.dumps(SF)))
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(DRAWN, polling=POLL_MS, timeout=READY_MS)
        pg.evaluate("_almClockSetRate(0); _almScrubSettle(new Date('2026-10-01T19:00:00Z'))")
        pg.wait_for_function(DRAWN, polling=POLL_MS, timeout=READY_MS)
        # The clock on the turn the curve writes large.
        turn_ms = pg.evaluate(
            """() => { var c = _at.curve, d = document.querySelector('#almanac-place .at-dot.next'), w = document.querySelector('#almanac-place svg[role=img]').viewBox.baseVal.width;
              return Math.round(c.start + (+d.getAttribute('cx')) / w * (c.end - c.start)); }"""
        )
        pg.evaluate("(ms) => _almTravelLive(new Date(ms))", turn_ms)
        got = pg.evaluate(
            """() => { var line = document.getElementById('at-now-line'), dot = document.getElementById('at-now-dot'),
              next = document.querySelector('#almanac-place .at-dot.next');
              return { y1: +line.getAttribute('y1'), cy: +dot.getAttribute('cy'), dotYield: next.classList.contains('at-yield') }; }"""
        )
        assert abs(got["y1"] - got["cy"]) < 0.2, got  # the line starts at the clock's dot
        assert got["dotYield"], got  # the turn's dot is under it: one mark
        # Two hours on, the clock is clear of the turn: its dot is back.
        pg.evaluate("(ms) => _almTravelLive(new Date(ms))", turn_ms + 2 * HOUR_MS)
        assert pg.evaluate("!document.querySelector('#almanac-place .at-dot.next').classList.contains('at-yield')")
        assert not errors, errors
    finally:
        ctx.close()
