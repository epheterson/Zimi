"""The 3D search sheet opens tall on the first tap, and the UFO's levers step aside while it is up.

"Tapping the search key should open that view up way more." On a portrait phone the sheet used to stop under a square picture of the
body (418 of 844 px); it now opens to nearly the whole height, leaving a strip of the 3D view under the band.

"We showed satellite settings with UFO open and it didn't behave properly." The ship's two levers, its hint and its name tags are
not part of the corner's buttons, so the sheet's rule (the view's own controls and the clock hide while it is up) missed them: with the satellites'
filters or the settings open the sheet drops to its search row and the levers stood in the picture, live, in the middle of the screen.

Run: pytest tests/test_almanac_sheet_ufo_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import GL_ARGS, no_map  # noqa: E402,F401  (no_map is a fixture)
from test_almanac_ux3d_browser import _open, _open_3d  # noqa: E402

PHONE = {"width": 390, "height": 844}
LANDSCAPE = {"width": 844, "height": 390}
DESKTOP = {"width": 1440, "height": 900}
BAND_BOTTOM_PX = 52

SHEET = """() => { var g = document.getElementById('ae-go').getBoundingClientRect(), b = document.getElementById('ae-band').getBoundingClientRect();
  return { vh: innerHeight, top: g.top, h: g.height, bandBottom: b.bottom }; }"""
SHIP_CHROME = """() => Array.from(document.querySelectorAll('.af-lever, .af-hint, #af-refs')).map(function (e) {
  var cs = getComputedStyle(e), b = e.getBoundingClientRect();
  return { id: e.id || e.className, shown: cs.visibility !== 'hidden' && cs.opacity !== '0' && b.height > 0, touch: cs.pointerEvents !== 'none' && cs.visibility !== 'hidden' };
}).filter(function (x) { return x.shown || x.touch; })"""


def _session(no_map, view):
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    br = pw.chromium.launch(args=GL_ARGS)
    ctx, pg = _open(br, no_map, view=view, dpr=3)
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    _open_3d(pg)
    return pw, br, pg


def _first_tap(pg):
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)
    pg.wait_for_timeout(1000)  # (the sheet's own glide)
    return pg.evaluate(SHEET)


@pytest.mark.parametrize(
    "name,view,least",
    [("phone", PHONE, 0.8), ("landscape", LANDSCAPE, 0.9), ("desktop", DESKTOP, 0.8)],
)
def test_the_first_tap_on_search_opens_the_sheet_to_nearly_the_whole_view(
    no_map, name, view, least
):
    pw, br, pg = _session(no_map, view)
    try:
        got = _first_tap(pg)
        assert got["h"] >= least * got["vh"], got  # (it was 49% on the phone, 78% on a desktop)
        if name != "landscape":  # (there the band stands beside the sheet)
            assert got["top"] >= got["bandBottom"] - 1, got  # under the band, a strip of the view above it
        assert not pg.errors, pg.errors
    finally:
        br.close()
        pw.stop()


def test_a_portrait_phone_keeps_a_strip_of_the_view_above_the_tall_sheet(no_map):
    pw, br, pg = _session(no_map, PHONE)
    try:
        got = _first_tap(pg)
        assert got["top"] - BAND_BOTTOM_PX >= 40, got  # the sheet still reads as a sheet over the scene
    finally:
        br.close()
        pw.stop()


def test_the_satellites_filters_and_settings_with_the_ufo_out_hide_the_ships_levers_and_close_with_the_ship_still_out(
    no_map,
):
    pw, br, pg = _session(no_map, PHONE)
    try:
        pg.evaluate("() => enterFly()")
        pg.wait_for_function("() => !!(_ae.ship && _ae.ship.craft)", timeout=60_000)
        pg.wait_for_timeout(500)
        flying = pg.evaluate(SHIP_CHROME)
        assert any(x["id"] == "af-lever" and x["shown"] for x in flying), flying  # the levers are there to hide
        pg.click("#ae-find")
        pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)
        pg.click("#ae-band [data-ae-layer=sats]")
        pg.wait_for_selector("#ae-band [data-ae-drawer=sats]", state="visible", timeout=60_000)
        pg.click("#ae-band [data-ae-drawer=sats]")
        pg.wait_for_function("() => _aeDrawerKind() === 'sats'", timeout=10_000)
        pg.wait_for_timeout(600)
        assert pg.evaluate(SHIP_CHROME) == [], "filters: the ship's levers show over the picture"
        pg.click("#ae-band-gear")
        pg.wait_for_function("() => _aeDrawerKind() === 'set'", timeout=10_000)
        pg.wait_for_timeout(600)
        assert pg.evaluate(SHIP_CHROME) == [], "settings: the ship's levers show over the picture"
        pg.click("#ae-find")  # the X: the interface comes back as it was, the UFO still out
        pg.wait_for_function("() => document.getElementById('ae-go').hidden", timeout=10_000)
        pg.wait_for_timeout(600)
        after = pg.evaluate(SHIP_CHROME)
        assert any(x["id"] == "af-lever" and x["shown"] for x in after), after
        assert pg.evaluate("() => !!_ae.ship && document.getElementById('ae-fly-btn').getAttribute('aria-pressed')") == "true"
        assert not pg.errors, pg.errors
    finally:
        br.close()
        pw.stop()
