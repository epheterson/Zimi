"""Find it in the sky, from the solar system, in a real browser.

A planet's tip in the orrery carries a small magnifier: a tap opens the sky
from the place, aimed at that planet (Find's chip says where it is). The
Earth, where we stand, has none.

Run: pytest tests/test_almanac_orrery_find_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.test_almanac_live_sky_browser import (  # noqa: E402,F401
    DAY,
    _almanac,
    _settle,
    browser,
    served,
)


def test_a_planets_tip_finds_it_in_the_sky(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, DAY)
        pg.evaluate("() => _orreryShowBody('Mars')")
        btn = pg.locator("#orrery-tooltip [data-orr-find='planet:Mars']")
        btn.wait_for(state="visible", timeout=5000)
        assert btn.get_attribute("aria-label") == pg.evaluate("t('sky_find_btn')")
        btn.click()
        pg.wait_for_selector("#almanac-look", timeout=15000)
        pg.wait_for_function(
            "() => window.AlmanacFind && window.AlmanacFind.current() && window.AlmanacFind.current().id === 'planet:Mars'",
            timeout=15000,
        )
        assert (
            pg.evaluate("document.getElementById('orrery-tooltip').style.display")
            == "none"
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_the_earth_has_no_find_button(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, DAY)
        pg.evaluate("() => _orreryShowBody('Earth')")
        pg.wait_for_selector("#orrery-tooltip", state="visible", timeout=5000)
        assert pg.locator("#orrery-tooltip [data-orr-find]").count() == 0
        assert not errors, errors
    finally:
        ctx.close()
