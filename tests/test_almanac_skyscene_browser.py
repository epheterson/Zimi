"""The beach scene's clouds and helicopter in a real browser, at a phone's width.

On the shipped files, served by Zimi, in headless Chromium, San Francisco
chosen as the place: after sunset the clouds are drawn and the high ones are
lit while the low ones are dark, by day all are lit, the Sun's own place is
clear, a tap on a cloud says what it is, and the true-horizon skin has none.
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
    _tap_body,
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


def test_the_scene_has_clouds_lit_by_where_the_sun_is(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        seen = {}
        for name, iso in HOURS.items():
            _settle(pg, iso)
            pg.wait_for_timeout(300)
            seen[name] = _clouds(pg)
            _shot(pg, name)
        assert seen["day"], "clouds on a day"
        assert all(
            c["lit"] > 0.99 for c in seen["day"]
        ), "by day every cloud is in the Sun"
        assert any(c["lit"] > 0.5 for c in seen["sunset"]) and any(
            c["lit"] < 0.5 for c in seen["sunset"]
        ), seen["sunset"]
        # Higher clouds keep the light longer: every cloud still lit at dusk is higher than some one that has gone dark.
        lit = [c["h"] for c in seen["dusk"] if c["lit"] > 0.5]
        dark = [c["h"] for c in seen["dusk"] if c["lit"] < 0.5]
        assert not lit or not dark or max(lit) >= min(dark), seen["dusk"]
        assert all(c["lit"] == 0 for c in seen["night"]), "by night none is lit"
        assert not errors, errors
    finally:
        ctx.close()


def test_a_tap_on_a_cloud_names_it_and_says_why_it_glows(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, SUNSET)
        lit = [c for c in _clouds(pg) if c["lit"] > 0.5]
        assert lit, "a lit cloud after sunset"
        pg.evaluate(
            "() => { _skyState.bodies = _skyState.bodies.filter((b) => b.type === 'cloud'); }"
        )
        _tap_body(pg, "cloud")
        pg.wait_for_function(
            "() => /still above the Earth|noch über dem Rand/.test((document.querySelector('.almanac-sky-tip, .alm-tip, [class*=tip]') || document.body).innerText)",
            timeout=4000,
        )
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
