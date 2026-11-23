"""The 3D search sheet's one drawer: the band's chevron and gear open the satellites' filters and passes, or the
settings, in one slot under the band; the sheet drops to its search row while it is up.

At a phone's size in headless Chromium. SHEET_SHOTS=<folder> saves a screenshot of each state there.

Run: pytest tests/test_almanac_drawer_browser.py -v
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import no_map  # noqa: E402,F401  (a fixture)
from test_almanac_ux3d_browser import three_d  # noqa: E402,F401  (a fixture)

SHOTS = os.environ.get("SHEET_SHOTS", "")
RECTS = """() => { var r = s => { var e = document.querySelector(s); if (!e) return null; var b = e.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, h: b.height, vis: getComputedStyle(e).visibility !== 'hidden' && !e.hidden && b.height > 0 }; };
  return { band: r('#ae-band'), drawer: r('#ae-drawer'), go: r('#ae-go'), find: r('#ae-go .ae-go-find'), groups: r('#ae-go-groups'),
    bar: r('#as-bar'), set: r('#ae-set'), kind: _aeDrawerKind(), h: innerHeight }; }"""
CHEVRON = "#ae-band [data-ae-drawer=sats]"


def _settled(pg):
    """The picture has glided to the room the band, drawer and sheet leave."""
    pg.wait_for_function(
        "() => Math.abs(_aeInfoShiftTarget() - (_ae.infoShift || 0)) < 1 && Math.abs(_aeGoScaleTarget() - (_ae.goS || 1)) < 0.01",
        timeout=10_000,
        polling=100,
    )


def _shot(pg, name):
    _settled(pg)
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def _open_sheet(pg):
    pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=200)
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)


def test_the_gear_opens_the_settings_in_the_drawer_under_the_band_and_the_sheet_drops_to_its_search_row(
    three_d,
):
    pg = three_d
    _open_sheet(pg)
    before = pg.evaluate(RECTS)
    assert before["drawer"] is None or not before["drawer"]["vis"], before
    pg.click("#ae-band-gear")
    pg.wait_for_selector("#ae-set", state="visible", timeout=10_000)
    pg.wait_for_function("() => !document.getElementById('ae-go').hidden", timeout=5000)
    got = pg.evaluate(RECTS)
    _shot(pg, "03-drawer-settings")
    assert (
        got["kind"] == "set" and got["go"]["vis"]
    ), got  # the sheet stays, under the drawer
    assert (
        got["band"]["bottom"] <= got["drawer"]["top"] + 1
        and got["drawer"]["bottom"] <= got["go"]["top"] + 1
    ), got  # band, drawer, sheet: one under the other
    assert (
        got["go"]["h"] < before["go"]["h"] and not got["groups"]["vis"]
    ), got  # the sheet is its search row
    assert got["drawer"]["h"] <= 0.41 * got["h"], got
    assert pg.get_attribute("#ae-band-gear", "aria-expanded") == "true"
    pg.click("#ae-band-gear")  # the control that opened it shuts it
    pg.wait_for_function(
        "() => document.getElementById('ae-drawer').hidden", timeout=5000
    )
    after = pg.evaluate(RECTS)
    assert after["go"]["h"] >= before["go"]["h"] - 1 and after["groups"]["vis"], after
    assert not pg.errors, pg.errors


def test_the_satellites_chevron_opens_the_filters_in_the_same_drawer_and_the_gear_takes_its_place(
    three_d,
):
    pg = three_d
    _open_sheet(pg)
    pg.click("#ae-band [data-ae-layer=sats]")
    pg.wait_for_selector(CHEVRON, state="visible", timeout=60_000)
    assert (
        pg.evaluate("() => _aeDrawerKind()") == ""
    ), "turning the layer on opens nothing"
    pg.click(CHEVRON)
    pg.wait_for_function(
        "() => document.getElementById('as-bar') && !document.getElementById('as-bar').hidden",
        timeout=60_000,
    )
    got = pg.evaluate(RECTS)
    _shot(pg, "04-drawer-filters")
    assert got["kind"] == "sats", got
    assert (
        pg.evaluate("() => document.getElementById('as-bar').parentNode.id")
        == "ae-drawer"
    )
    assert got["drawer"]["bottom"] <= got["go"]["top"] + 1 and got["bar"]["vis"], got
    assert pg.get_attribute(CHEVRON, "aria-expanded") == "true"
    pg.click("#ae-band-gear")  # one slot: the settings replace the filters
    pg.wait_for_selector("#ae-set", state="visible", timeout=10_000)
    got = pg.evaluate(RECTS)
    assert got["kind"] == "set" and not got["bar"]["vis"], got
    pg.click(CHEVRON)
    pg.wait_for_function(
        "() => document.getElementById('ae-set').hidden", timeout=10_000
    )
    assert pg.evaluate("() => _aeDrawerKind()") == "sats"
    pg.click("#ae-band-out")  # the way out takes the drawer with it
    pg.wait_for_function(
        "() => document.getElementById('ae-drawer').hidden", timeout=5000
    )
    assert pg.evaluate("() => _aeDrawerKind()") == ""
    assert not pg.errors, pg.errors


def test_the_satellites_tile_turns_an_arc_while_loading_and_says_so_when_it_failed_and_a_tap_tries_again(
    three_d,
):
    pg = three_d
    _open_sheet(pg)
    tile = "#ae-band [data-ae-layer=sats]"
    pg.click(tile)
    pg.wait_for_function(
        "() => typeof _as !== 'undefined' && _as.on && _as.state === 'ready'",
        timeout=120_000,
        polling=250,
    )
    pg.evaluate("() => { _as.state = 'loading'; _asSync(); }")
    assert pg.get_attribute(tile, "data-state") == "loading"
    assert pg.get_attribute(tile, "aria-busy") == "true"
    assert (
        pg.evaluate(
            "(s) => getComputedStyle(document.querySelector(s), '::after').animationName",
            tile,
        )
        == "ae-band-spin"
    )
    pg.evaluate(
        "() => { _as.state = 'failed'; _asSync(); window._asTried = 0; var f = _asSatLoad; _asSatLoad = function () { window._asTried++; return f.apply(this, arguments); }; }"
    )
    assert pg.get_attribute(tile, "data-state") == "failed"
    assert "didn't load" in pg.get_attribute(tile, "aria-label")
    pg.click(tile)
    pg.wait_for_function(
        "() => window._asTried >= 1", timeout=10_000
    )  # a tap on a failed layer asks again, it does not switch it off
    assert pg.evaluate("() => _as.on") is True
    pg.wait_for_function("() => _as.state === 'ready'", timeout=120_000, polling=250)
    assert pg.get_attribute(tile, "data-state") is None
    assert not pg.errors, pg.errors
