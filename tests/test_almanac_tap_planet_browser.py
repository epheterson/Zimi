"""A tap on a planet is the planet's, never its moon's ("never take me to its moon. It's always the planet first").

Seen from the Moon's side of the Earth from far off, the Moon stands in front of the Earth within a finger's width of it:
the nearer to the camera won, which was the Moon.

Run: pytest tests/test_almanac_tap_planet_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

TAP = """(dist) => {
  _ae.fly = null; _ae.hand = null; _ae.preset = null; _ae.target = 'earth'; _ae.dist = dist;
  var azel = _aeAzElOf(_ae.scene.moon);
  _ae.az = azel.az; _ae.el_ = azel.el;
  _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(true);
  var s = _aeProject(_aeBodyPos('earth'));
  var m = _aeProject(_aeBodyPos('moon'));
  return { hit: _aeBodyAt(s.x, s.y), apart: Math.hypot(s.x - m.x, s.y - m.y) };
}"""


def test_a_tap_over_the_earth_and_its_moon_is_the_earths(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            r = pg.evaluate(TAP, 600)
            assert r["apart"] < 30, ("the Moon is within a finger of the Earth", r)
            assert r["hit"] == "earth", r
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
