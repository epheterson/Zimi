"""Defects a phone-path pass found in the 3D view and the Almanac, each held in a real browser.

On the shipped files, served by Zimi, in headless Chromium with software GL at an iPhone's size (390 x 844, touch,
mobile), through the same page and server as test_almanac_phone_defects_browser. One test per defect, named for it.

Run: pytest tests/test_almanac_phonefix_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_almanac_phone_defects_browser import (
    READY_MS,
    _page,
    browser,
    served,
)  # noqa: E402,F401

OPEN = "() => typeof _aeIsOpen !== 'undefined' && _aeIsOpen && _aeReady() && !_ae.fly"


def _open_3d(pg, target="earth"):
    pg.wait_for_function("() => typeof _aeLoadThree === 'function'", timeout=60_000)
    pg.evaluate("(t) => openAlmanacEarth({ target: t })", target)
    pg.wait_for_function(OPEN, timeout=READY_MS, polling=200)


def _pinch(ctx, pg, cx, cy, d0, d1, steps=10):
    """Two fingers on the screen, from d0 px apart to d1, as a phone sends them."""
    cdp = ctx.new_cdp_session(pg)
    pts = lambda d: [
        {"x": cx - d / 2, "y": cy, "id": 1},
        {"x": cx + d / 2, "y": cy, "id": 2},
    ]  # noqa: E731
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pts(d0)})
    for i in range(1, steps + 1):
        cdp.send(
            "Input.dispatchTouchEvent",
            {"type": "touchMove", "touchPoints": pts(d0 + (d1 - d0) * i / steps)},
        )
        pg.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()


def test_pinching_out_of_the_planets_view_closes_it_without_an_error(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _open_3d(pg)
        pg.click("[data-ae-view='planets']")
        pg.wait_for_function(
            "() => !_ae.fly && _ae.preset === 'planets'", timeout=60_000, polling=200
        )
        for _ in range(6):
            _pinch(ctx, pg, 195, 420, 300, 60)
            pg.wait_for_timeout(300)
            if not pg.evaluate("_aeIsOpen"):
                break
        assert pg.evaluate("_aeIsOpen") is False, "the pull-out closed the view"
        assert not errors, errors
    finally:
        ctx.close()


CHOSEN_MS = 1717243200000  # 2024-06-01T12:00:00Z, a date the reader picked before the mission
FOCUS = "() => ({ set: !!_almFocus, ms: _almFocusInstant().getTime(), rate: _almRate, now: Date.now() })"


def _fly_apollo_and_go_back(pg):
    pg.evaluate("_aeMissionStart('apollo11')")
    pg.wait_for_function("() => !!(_ae.mission && _almFocusInstant().getFullYear() === 1969)", timeout=60_000, polling=200)
    pg.click("#back-btn")
    pg.wait_for_function("() => !_aeIsOpen", timeout=20_000, polling=100)
    pg.wait_for_timeout(500)
    return pg.evaluate(FOCUS)


def test_leaving_a_mission_puts_the_almanac_back_at_now(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _open_3d(pg)
        got = _fly_apollo_and_go_back(pg)
        assert got["set"] is False, got  # live again, not a chosen date
        assert abs(got["ms"] - got["now"]) < 60_000, got
        assert got["rate"] == 1, got
        assert "1969" not in pg.inner_text("#almanac-head")
        assert not errors, errors
    finally:
        ctx.close()


def test_leaving_a_mission_puts_back_the_date_the_reader_chose(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function("() => typeof _almScrubSettle === 'function'", timeout=60_000)
        pg.evaluate("(ms) => _almScrubSettle(new Date(ms))", CHOSEN_MS)
        _open_3d(pg)
        got = _fly_apollo_and_go_back(pg)
        assert got["set"] is True, got
        assert abs(got["ms"] - CHOSEN_MS) < 60_000, got
        assert not errors, errors
    finally:
        ctx.close()
