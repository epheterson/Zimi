"""The UFO button is always there: over a site, in a drive and on the Earth's ground it takes the craft up from where you are.

Run: pytest tests/test_almanac_ufo_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_almanac_sites_browser as base  # noqa: E402

base.GL_ARGS.append("--disable-accelerated-2d-canvas")
served = base.served
page = base.page

SHIP_MS = 300_000


def _button(pg):
    return pg.evaluate(
        "() => { const b = document.getElementById('ae-fly-btn'), r = b.getBoundingClientRect(); return { hidden: b.hidden, w: r.width, h: r.height, mode: _aeMode() }; }"
    )


def test_ufo_button_in_a_drive_takes_the_craft_up(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    b = _button(page)
    assert b["mode"] == "drive" and not b["hidden"] and b["w"] >= 44 and b["h"] >= 44, b
    page.evaluate("document.getElementById('ae-fly-btn').click()")
    page.wait_for_function("() => !!_ae.ship && !_ae.site", timeout=SHIP_MS, polling=500)
    assert page.evaluate("() => document.getElementById('ae-fly-btn').getAttribute('aria-pressed')") == "true"


def test_ufo_button_on_a_visit_takes_the_craft_up(page):
    page.evaluate("() => { if (_ae.ship) _afStop(true); }")   # (the page is shared: the last test left the craft flying)
    base._visit(page, "moon", "Apollo 15")
    assert not _button(page)["hidden"], _button(page)
    page.evaluate("document.getElementById('ae-fly-btn').click()")
    page.wait_for_function("() => !!_ae.ship && !_ae.site", timeout=SHIP_MS, polling=500)


def test_called_rover_does_not_wait_overhead_forever(page):
    """a rover called up waits for the camera to come down; if the visit never reaches 'stand' (time travel) it falls anyway."""
    page.evaluate("() => { if (_ae.ship) _afStop(true); }")
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate(
        "() => { const st = _ae.site; st.eye0 = {}; st.phase = 'drop'; st.t0 = performance.now() + 1e9;"
        " st.rover.airborne = true; st.rover.vz = 0; st.rover.z += 30; st.calledAt = performance.now() - 60000; }"
    )
    page.wait_for_function("() => _ae.site && _ae.site.rover.vz < 0", timeout=20000, polling=200)
