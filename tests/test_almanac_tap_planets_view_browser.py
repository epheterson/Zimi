"""In the Planets view a real tap goes to the body nearest the finger, the Earth on the same terms as the planets.

On 2026-11-21 Venus stands about 18 px from the Earth on a phone: Venus's finger-wide reach used to win over the Earth's,
so a tap on the Earth went to Venus (the Earth is not in AE_PLANETS and ranked below every planet).

Run: pytest tests/test_almanac_tap_planets_view_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

DAY = "Date.UTC(2026, 10, 21, 12)"
SCREEN = """(k) => { var e = _aeProject(_aeBodyPos(k)); return e ? [e.x, e.y] : null; }"""


@pytest.mark.parametrize("key", ["earth", "venus"])
def test_a_tap_on_a_body_close_to_another_in_the_planets_view_is_that_body(served, key):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.evaluate("() => _aeGoTo(%s)" % DAY)
            pg.wait_for_function("() => Math.abs(_aeDisplayMs() - %s) < 1000" % DAY, timeout=60_000, polling=100)
            pg.evaluate("() => _aePreset('planets')")
            pg.wait_for_function("() => !_ae.fly && _ae.preset === 'planets'", timeout=240_000, polling=300)
            pg.wait_for_timeout(800)
            e, v = pg.evaluate(SCREEN, "earth"), pg.evaluate(SCREEN, "venus")
            apart = ((e[0] - v[0]) ** 2 + (e[1] - v[1]) ** 2) ** 0.5
            assert 4 < apart < 33, ("Venus is within its reach of the Earth on the screen", apart)
            x, y = pg.evaluate(SCREEN, key)
            assert pg.evaluate("(p) => _aeBodyAt(p[0], p[1])", [x, y]) == key
            pg.touchscreen.tap(x, y)
            pg.wait_for_function("(k) => _ae.target === k", arg=key, timeout=30_000, polling=200)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
