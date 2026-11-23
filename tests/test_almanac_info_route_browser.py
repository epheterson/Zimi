"""A finger can open a place's facts card with the page's top bar set aside (the i button lives in it, unseen): the name in the info corner is the
chip to tap, and the search circle's sheet carries the same i at its head.

Run: pytest tests/test_almanac_info_route_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_bodyinfo_browser import page, served  # noqa: E402,F401

SETTLED = "() => !_ae.fly && !!document.getElementById('ah-info') && !document.getElementById('ah-info').hidden && !!document.getElementById('ah-info').children[0]._open"


def _shut(pg):
    pg.evaluate("_aeCloseInfo(false)")
    pg.wait_for_function("() => !_ae.info", timeout=10_000, polling=50)


def _tap_centre(pg, sel):
    box = pg.evaluate(
        "(s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }",
        sel,
    )
    assert box[2] >= 44 and box[3] >= 44, (sel, box)  # a finger's size
    pg.touchscreen.tap(box[0], box[1])


def test_the_name_in_the_info_corner_opens_the_facts_by_touch(page):
    _shut(page)
    page.evaluate("_aePreset('moon')")
    page.wait_for_function(SETTLED, timeout=120_000, polling=200)
    _tap_centre(page, "#ah-info")
    page.wait_for_function("() => _ae.info === 'moon'", timeout=10_000, polling=50)
    _shut(page)


def test_the_search_sheets_head_carries_the_facts_too(page):
    _shut(page)
    page.evaluate("_aePreset('moon')")
    page.wait_for_function(SETTLED, timeout=120_000, polling=200)
    _tap_centre(page, "#ae-find")
    page.wait_for_selector("#ae-band-name", state="visible", timeout=20_000)
    _tap_centre(page, "#ae-band-name")
    page.wait_for_function("() => _ae.info === 'moon'", timeout=10_000, polling=50)
    _shut(page)
