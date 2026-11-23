"""A probe's trail is held relative to the craft, so it is steady beside it however far from the Sun the craft is.

The GPU keeps a line's points as 32-bit numbers: at Voyager's distance one step is hundreds of kilometres, and a trail kept in
the scene's own coordinates stuttered and slid off the craft when the view turned ("jinky if I rotate").

In headless Chromium at a phone's size.

Run: pytest tests/test_almanac_probe_trail_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401


def test_the_trail_stands_at_the_craft_and_its_points_are_relative_to_it(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            pg.wait_for_function(
                "() => { _aeTracksLoad(); return !!_aeTracks && !!_aeProbePos.voyager1; }",
                timeout=60_000,
                polling=200,
            )
            pg.evaluate("() => _aePreset('voyager1')")
            pg.wait_for_function(
                "() => !_ae.fly && _ae.target === 'voyager1' && _ae.gl.probes && _ae.gl.probes.trails.voyager1 && _ae.gl.probes.trails.voyager1.visible",
                timeout=240_000,
                polling=300,
            )
            got = pg.evaluate(
                """() => { var t = _ae.gl.probes.trails.voyager1, p = _aeProbePos.voyager1, a = t.geometry.attributes.position.array,
                  n = a.length / 3 - 1;
                  return { pos: [t.position.x, t.position.y, t.position.z], probe: p, last: [a[n * 3], a[n * 3 + 1], a[n * 3 + 2]],
                    first: [a[0], a[1], a[2]] }; }"""
            )
            assert (
                max(abs(got["pos"][i] - got["probe"][i]) for i in range(3)) < 1e-6
            ), got
            assert got["last"] == [
                0,
                0,
                0,
            ], got  # the head is at the line's own origin: no 32-bit rounding where the eye is
            assert max(abs(c) for c in got["first"]) > 0, got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_moons_path_shows_where_the_view_stands_on_it_and_not_from_the_earth_close_up(served):
    """With Orbits on, the view at the Moon is on the Moon's path: it shows (it was hidden, the share of the orbit held
    being tiny); from the Earth's side it still fades out (an orbit sixty radii across is not drawn over a close view)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "moon", orbits="always")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            seen = pg.evaluate("() => { _ae.dirty = true; return new Promise(r => setTimeout(() => r(_ae.gl.moonPath.visible && _ae.gl.moonPath.material.opacity), 2500)); }")
            assert seen and seen > 0, seen
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
