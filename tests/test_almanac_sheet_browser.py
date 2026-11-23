"""The 3D view's layers and its search sheet: one list of layers, the GPS constellation being one of them,
the band over a split view, the sheet's states.

At a phone's size in headless Chromium. SHEET_SHOTS=<folder> saves a screenshot of each state there.

Run: pytest tests/test_almanac_sheet_browser.py -v
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import no_map  # noqa: E402,F401  (a fixture)
from test_almanac_ux3d_browser import three_d  # noqa: E402,F401  (a fixture)

SHOTS = os.environ.get("SHEET_SHOTS", "")
DRAWN = """() => { var S = _ae.gl, n = S.sats.geometry.drawRange.count, gps = 0;
  _ae.positions.forEach(p => { var s = _ae.sats.list[p.idx]; if (!s.iss && !s.craft) gps++; });   // (the station and the telescopes are their own dots, not the GPS layer's)
  return { points: n, gps: gps, rings: S.gpsRings.geometry.drawRange.count }; }"""
FRAME = "() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); }"
RECTS = """() => { var r = s => { var e = document.querySelector(s); if (!e) return null; var b = e.getBoundingClientRect(), c = getComputedStyle(e);
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height, vis: c.visibility !== 'hidden' && c.opacity !== '0' && !e.hidden }; };
  return { band: r('#ae-band'), go: r('#ae-go'), find: r('#ae-find'), row: r('#ae-views'), name: r('#ae-band-name'), canvas: r('#ae-canvas'), shift: _ae.infoShift || 0, h: innerHeight, w: innerWidth }; }"""


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def test_every_layer_is_one_entry_of_the_list_and_its_tile_in_the_band_says_the_same(
    three_d,
):
    pg = three_d
    ids = pg.evaluate("() => AE_LAYERS.map(L => L.btn)")
    assert ids == ["ae-lm-btn", "ae-orbits-btn", "ae-sats-btn"], ids
    assert (
        pg.evaluate("(ids) => ids.filter(i => document.getElementById(i))", ids) == ids
    )  # the corner's buttons are made from it
    pg.evaluate("() => { _aeShowGo(true); }")
    pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)
    tiles = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#ae-band [data-ae-layer]')).filter(b => !b.hidden).map(b => b.getAttribute('data-ae-layer'))"
    )
    assert tiles == ["sats"], tiles   # Landmarks and Orbits stand on the right edge (tests/test_almanac_edge_buttons_browser.py)
    # A tile writes through the list: the layer, the corner's button and the tile agree.
    pg.click("#ae-band [data-ae-layer=sats]")
    pg.wait_for_function("() => _aeSatsAllOn() === true", timeout=60_000)
    assert pg.get_attribute("#ae-sats-btn", "aria-pressed") == "true"
    assert pg.get_attribute("#ae-band [data-ae-layer=sats]", "aria-pressed") == "true"
    assert not pg.errors, pg.errors


def test_the_gps_constellation_shows_with_satellites_and_not_without(three_d):
    pg = three_d
    pg.wait_for_function(
        "() => _ae.sats && _ae.sats.list && _ae.sats.list.length > 5",
        timeout=120_000,
        polling=250,
    )
    assert pg.evaluate("() => _aeSatsAllOn()") is False
    pg.evaluate(FRAME)
    off = pg.evaluate(DRAWN)
    assert off["gps"] == 0 and off["rings"] == 0, off
    pg.evaluate("() => _aeSatsAllSet(true)")
    pg.wait_for_function("() => _aeSatsAllOn() === true", timeout=60_000, polling=250)
    pg.evaluate(FRAME)
    on = pg.evaluate(DRAWN)
    assert on["gps"] > 5 and on["rings"] > 0, on
    pg.evaluate("() => _aeSatsAllSet(false)")
    pg.wait_for_function("() => _aeSatsAllOn() === false", timeout=60_000, polling=250)
    pg.evaluate(FRAME)
    again = pg.evaluate(DRAWN)
    assert again["gps"] == 0 and again["rings"] == 0, again
    assert not pg.errors, pg.errors


def test_search_splits_the_view_the_band_over_the_picture_and_the_sheet_over_the_planets_row(
    three_d,
):
    pg = three_d
    pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=200)
    _shot(pg, "01-closed")
    before = pg.evaluate("() => [_ae.infoShift || 0, _ae.goS || 1, _ae.goX || 0]")
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)
    pg.wait_for_timeout(600)
    assert pg.evaluate("() => [_ae.infoShift || 0, _ae.goS || 1, _ae.goX || 0]") == before  # browsing: the picture stays where it was
    got = pg.evaluate(RECTS)
    _shot(pg, "02-open")
    band, go = got["band"], got["go"]
    assert (
        band["vis"] and band["h"] == 44 and band["top"] < 20
    ), got  # the band is the top row
    assert (
        abs(go["bottom"] - got["h"]) < 1.5
        and go["left"] == 0
        and go["right"] == got["w"]
    ), got  # the sheet is the foot, edge to edge
    assert (
        band["bottom"] < go["top"] and go["top"] - band["bottom"] >= 60
    ), got  # the picture is the room between them: the tall sheet leaves a strip of the view under the band (about 80 px)
    # the planets row is under the sheet: a touch at its middle lands on the sheet, not the row
    assert pg.evaluate(
        "() => { var r = document.getElementById('ae-views').getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 2)); return !!e && !!e.closest('#ae-go') || !e.closest('#ae-views'); }"
    )
    assert got["find"]["vis"] and got["find"]["top"] > 0.8 * got["h"], got  # the search circle stays at the foot as the sheet's X; the rest of the corner is the band's now
    assert (
        pg.evaluate("() => document.getElementById('ae-band-name').textContent")
        == "Earth"
    )
    pg.click("#ae-band-out")
    pg.wait_for_function("() => document.getElementById('ae-go').hidden", timeout=5000)
    pg.wait_for_function(
        "() => document.getElementById('ae-band').hidden && !_ae.el.classList.contains('ae-go-up')",
        timeout=5000,
    )
    assert pg.evaluate(RECTS)["find"]["vis"]
    assert not pg.errors, pg.errors
