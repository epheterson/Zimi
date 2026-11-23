"""The beach scene's clouds and helicopter in a real browser, at a phone's width.

On the shipped files, served by Zimi, in headless Chromium, San Francisco
chosen as the place: no skin of the live sky draws an invented cloud at any
hour (the cloud deck was removed on 2026-11-11: a place and a day are not weather).
Set ZIMI_SHOTS to a folder to keep a screenshot of each hour.

Run: pytest tests/test_almanac_skyscene_browser.py -v
"""

import base64
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.test_almanac_live_sky_browser import (  # noqa: E402,F401
    DAY,
    NIGHT,
    _almanac,
    _settle,
    browser,
    served,
)

SUNSET = "2026-10-01T02:00:00Z"  # just after sunset in San Francisco: the Sun a few degrees down
DUSK = "2026-10-01T02:25:00Z"  # the Sun about 5 degrees down
HOURS = {"day": DAY, "sunset": SUNSET, "dusk": DUSK, "night": NIGHT}
SHOTS = os.environ.get("ZIMI_SHOTS")


def _clouds(pg):
    return pg.evaluate(
        "() => _skyState.bodies.filter((b) => b.type === 'cloud').map((b) => ({ lit: b.lit, h: b.h, rho: b.rho, x: b.x, y: b.y }))"
    )


def _shot(pg, name):
    """The sky canvas as drawn, read from the canvas itself (a page screenshot waits on a frame the GPU sky may be slow to give)."""
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        url = pg.evaluate("() => _skyState.canvas.toDataURL('image/png')")
        with open(os.path.join(SHOTS, name + ".png"), "wb") as f:
            f.write(base64.b64decode(url.split(",", 1)[1]))


def test_the_live_sky_draws_no_invented_clouds_at_any_hour(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        for name, iso in HOURS.items():
            _settle(pg, iso)
            pg.wait_for_timeout(300)
            assert _clouds(pg) == [], name
            _shot(pg, name)
        assert not errors, errors
    finally:
        ctx.close()


def test_the_true_horizon_skin_keeps_the_sky_clean(browser, served):
    ctx, pg, errors = _almanac(browser, served, horizon=True)
    try:
        _settle(pg, SUNSET)
        assert _clouds(pg) == []
        assert not errors, errors
    finally:
        ctx.close()
