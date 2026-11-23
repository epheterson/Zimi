"""Two changes to the 3D search sheet.

Landmarks and Orbits are round buttons stacked on the right edge of the view, right over the locate button, and leave the
sheet's top area (the band keeps Satellites). With the satellites' selector open the sheet is only its search bar, and the Earth
and every satellite shown stand centred in the room above it; browsing the sheet (nothing chosen) moves nothing in the picture.

At a portrait phone, a phone on its side and a desktop, in headless Chromium.

Run: pytest tests/test_almanac_edge_buttons_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import no_map  # noqa: E402,F401  (a fixture)
from test_almanac_ux3d_browser import three_d_still  # noqa: E402,F401  (a fixture)

pytestmark = pytest.mark.timeout(900)

SIZES = {
    "portrait": {"width": 390, "height": 844},
    "landscape": {"width": 844, "height": 390},
    "desktop": {"width": 1280, "height": 800},
}
HIT_PX = 44
OVERLAP_PX = 2
# Everything the two buttons keep clear of: the corner name, the info corner, the foot row, the time chip, the sheet and the rest of the discs.
BOXES = """() => {
  var r = e => { var b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
  var out = {}, shown = e => !!e && !e.hidden && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0';
  ['ae-lm-btn', 'ae-orbits-btn', 'ae-locate', 'ae-rim', 'ae-sats-btn', 'ae-north', 'ae-cam', 'ae-fly-btn', 'ae-find', 'ae-pin', 'ah-info', 'ae-views', 'ae-go', 'ae-band', 'ae-bodyname', 'ae-mini'].forEach(id => {
    var e = document.getElementById(id); out[id] = shown(e) ? r(e) : null;
  });
  out.view = r(document.querySelector('.ae-view'));
  out.under = ['ae-lm-btn', 'ae-orbits-btn'].filter(id => document.getElementById(id).classList.contains('ah-under'));
  return out;
}"""


def _size(pg, name):
    pg.set_viewport_size(SIZES[name])
    pg.wait_for_function(
        "(w) => innerWidth === w && _ae.w === document.querySelector('.ae-view').clientWidth", arg=SIZES[name]["width"], timeout=10_000
    )
    pg.evaluate("() => { _aeHudRender(); _ae.dirty = true; _aeKick(); }")


def _orbit(pg):
    pg.evaluate("() => { _aeShowGo(false); _aePreset('earth'); }")
    pg.wait_for_function("() => !_ae.fly && _aeMode() === 'orbit'", timeout=60_000, polling=200)


def _hit(a, b):
    return a[0] < b[2] - OVERLAP_PX and a[2] > b[0] + OVERLAP_PX and a[1] < b[3] - OVERLAP_PX and a[3] > b[1] + OVERLAP_PX


@pytest.mark.parametrize("size", list(SIZES))
def test_landmarks_and_orbits_stand_on_the_right_edge_over_the_locate_button(three_d_still, size):
    pg = three_d_still
    _size(pg, size)
    _orbit(pg)
    pg.wait_for_function("() => !document.getElementById('ae-locate').hidden", timeout=20_000)
    b = pg.evaluate(BOXES)
    lm, orb, you = b["ae-lm-btn"], b["ae-orbits-btn"], b["ae-locate"]
    assert lm and orb and you, ("the two buttons and the locate button are drawn", b)
    assert lm[2] - lm[0] == orb[2] - orb[0] == you[2] - you[0] == HIT_PX, ("one size, a finger's", b)
    assert abs((lm[0] + lm[2]) / 2 - (you[0] + you[2]) / 2) <= 1 and abs((orb[0] + orb[2]) / 2 - (you[0] + you[2]) / 2) <= 1, ("one column over the locate button", b)
    assert lm[3] <= you[1] and orb[3] <= lm[1] and you[1] - lm[3] <= 16 and lm[1] - orb[3] <= 16, ("stacked just over it, Landmarks then Orbits", b)
    view = b["view"]
    assert lm[0] >= view[0] and orb[1] >= view[1] + HIT_PX and lm[2] <= view[2], ("inside the view and under the top bar", b)
    if size == "portrait":
        assert view[2] - lm[2] <= 16, ("on the right edge", b)
    elif size == "landscape":
        assert view[2] - lm[2] <= 3 * HIT_PX, ("on the right side, over the locate button beside the rim", b)
    for name in ("ae-rim", "ae-sats-btn", "ae-north", "ae-cam", "ae-fly-btn", "ae-find", "ae-pin", "ah-info", "ae-views", "ae-bodyname", "ae-mini"):
        for mine, box in (("lm", lm), ("orbits", orb)):
            assert not b[name] or not _hit(box, b[name]), (name, "overlaps", mine, b)
    probe = pg.evaluate("() => _aeHudProbe().controls.filter(c => c.id === 'ae-lm-btn' || c.id === 'ae-orbits-btn').map(c => [c.id, c.hit, c.round, c.rank])")
    assert sorted(probe) == [["ae-lm-btn", True, True, "minor"], ["ae-orbits-btn", True, True, "minor"]], probe
    assert not pg.errors, pg.errors


def test_the_buttons_toggle_the_layers_and_say_so_to_a_screen_reader(three_d_still):
    pg = three_d_still
    _size(pg, "portrait")
    _orbit(pg)
    for btn, on in (("ae-lm-btn", "_aeLmLayerOn()"), ("ae-orbits-btn", "_aeOrbitsOn()")):
        label = pg.get_attribute("#" + btn, "aria-label")
        assert label and pg.get_attribute("#" + btn, "title") == label, btn
        before = pg.evaluate("() => " + on)
        pg.tap("#" + btn)
        pg.wait_for_function("() => (%s) === %s" % (on, "false" if before else "true"), timeout=10_000)
        assert pg.get_attribute("#" + btn, "aria-pressed") == ("false" if before else "true"), btn
        pg.tap("#" + btn)
        pg.wait_for_function("() => (%s) === %s" % (on, "true" if before else "false"), timeout=10_000)
    assert not pg.errors, pg.errors


def test_the_buttons_go_where_the_locate_button_goes_and_the_sheets_band_keeps_only_satellites(three_d_still):
    pg = three_d_still
    _size(pg, "portrait")
    _orbit(pg)
    pg.evaluate("() => { _aeShowGo(true); }")
    pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)
    tiles = pg.evaluate("() => Array.from(document.querySelectorAll('#ae-band [data-ae-layer]')).filter(b => !b.hidden).map(b => b.getAttribute('data-ae-layer'))")
    assert tiles == ["sats"], tiles
    # The column goes where the locate button goes: put away with the sheet up, back when it goes.
    assert pg.evaluate("() => [document.getElementById('ae-locate').hidden, document.getElementById('ae-lm-btn').hidden, document.getElementById('ae-orbits-btn').hidden]") == [True, True, True]
    pg.evaluate("() => { _aeShowGo(false); }")
    pg.wait_for_function("() => !document.getElementById('ae-lm-btn').hidden && !document.getElementById('ae-orbits-btn').hidden", timeout=10_000)
    # No locate button (the planets page has one, a mode without it does not): no column.
    pg.evaluate("() => _aePreset('planets')")
    pg.wait_for_function("() => !_ae.fly && _aeMode() === 'system'", timeout=60_000, polling=200)
    pg.evaluate("() => _aeHudRender()")
    assert pg.evaluate("() => [document.getElementById('ae-lm-btn').hidden, document.getElementById('ae-orbits-btn').hidden]") == [True, True]
    assert not pg.errors, pg.errors


# ── ──
SATS_ON = """async () => { _aeSatsAllSet(true); }"""
CAMERA = """() => ({ goS: _ae.goS || 1, goX: _ae.goX || 0, shift: _ae.infoShift || 0, proj: Array.from(_ae.gl.camera.projectionMatrix.elements).map(x => Math.round(x * 1e4) / 1e4) })"""
FRAMED = """() => {
  var S = _ae.gl, cam = S.camera, V = S.THREE.Vector3, w = _ae.w, h = _ae.h, cloud = _as.cloud;
  cam.updateMatrixWorld(true); cloud.updateMatrixWorld(true);
  var px = v => { var p = v.project(cam); return [(p.x + 1) / 2 * w, (1 - p.y) / 2 * h]; };
  var earth = px(new V(0, 0, 0)), a = cloud.geometry.attributes, n = _as.data.n, pts = [];
  for (var i = 0; i < n; i++) if (_as.ok[i] && _asVisible(i) && a.aSize.array[i] > 0) pts.push(px(new V(a.position.array[3 * i], a.position.array[3 * i + 1], a.position.array[3 * i + 2]).applyMatrix4(cloud.matrixWorld)));
  var xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), r = id => { var e = document.getElementById(id); if (!e || e.hidden || !e.offsetHeight) return null; var b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
  return { earth: earth, n: pts.length, minX: Math.min.apply(null, xs), maxX: Math.max.apply(null, xs), minY: Math.min.apply(null, ys), maxY: Math.max.apply(null, ys),
    drawer: r('ae-drawer'), go: r('ae-go'), head: r('ae-go-q'), headbox: (function () { var e = document.querySelector('#ae-go .ae-go-head'); if (!e) return null; var b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; })(), find: r('ae-find'), w: w, h: h, shown: _as.shown, reach: _aeGoSatReach() };
}"""


def _sats_ready(pg):
    pg.evaluate(SATS_ON)
    pg.wait_for_function("() => typeof _as !== 'undefined' && _as.on && _as.state === 'ready' && _as.cloud && _as.sampleMs", timeout=180_000, polling=250)


def _settle(pg):
    pg.wait_for_function(
        "() => { _ae.dirty = true; _aeKick(); return Math.abs(_aeInfoShiftTarget() - (_ae.infoShift || 0)) < 0.6 && Math.abs(_aeGoScaleTarget() - (_ae.goS || 1)) < 0.005 && Math.abs(_aeGoShiftXTarget() - (_ae.goX || 0)) < 0.6 && (!_aeGoFrame() || Math.abs(Math.max(_ae.goDist0 || 0, _aeGoFrame().dist) - _ae.dist) <= _ae.dist * 0.01); }",
        timeout=20_000,
        polling=100,
    )
    pg.evaluate("() => { _aeUpdate(_aeDisplayMs()); }")


def _free(f):
    """The room a person sees above the bar and beside the drawer, from the boxes alone."""
    l, t, r, b = 0, HIT_PX + 16, f["w"], f["h"]
    for box in (f["drawer"], f["go"]):
        if not box:
            continue
        if box[2] - box[0] > f["w"] * 0.7:
            if box[1] > f["h"] / 2:
                b = min(b, box[1])
            else:
                t = max(t, box[3])
        else:
            l = max(l, box[2])
    return l, t, r, b


@pytest.mark.parametrize("size", list(SIZES))
def test_with_the_satellites_selector_open_the_sheet_is_its_bar_and_the_earth_and_satellites_stand_centred(three_d_still, size):
    pg = three_d_still
    _size(pg, size)
    _orbit(pg)
    _sats_ready(pg)
    pg.evaluate("() => { _aeShowGo(true); }")
    pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)
    full = pg.evaluate("() => document.getElementById('ae-go').getBoundingClientRect().height")
    pg.click("#ae-band [data-ae-drawer=sats]")
    pg.wait_for_function("() => document.getElementById('as-bar') && !document.getElementById('as-bar').hidden", timeout=60_000)
    _settle(pg)
    if size != "landscape":   # the sheet's own collapse is a transition: on slow drawing it outlasts the camera's settling
        pg.wait_for_function("() => { var g = document.getElementById('ae-go'), h = g && g.querySelector('.ae-go-head'); return !!h && g.getBoundingClientRect().height <= h.getBoundingClientRect().height + 34; }", timeout=20_000)
    f = pg.evaluate(FRAMED)
    if size == "landscape":
        assert f["go"] is None, ("no room for a bar under the drawer on a phone on its side: the drawer has it", f)
    else:
        bar = f["headbox"][3] - f["headbox"][1]
        sheet = f["go"][3] - f["go"][1]
        assert sheet < full / 3 and sheet <= bar + 34, ("the sheet is its search bar and the grab handle above it", sheet, bar, full)
    assert f["n"] > 50 and f["reach"] >= 1, f
    l, t, r, b = _free(f)
    cx, cy = (l + r) / 2, (t + b) / 2
    assert abs(f["earth"][0] - cx) <= 8 and abs(f["earth"][1] - cy) <= 8, ("the Earth is centred in the free room", f["earth"], (cx, cy), (l, t, r, b))
    assert f["minX"] >= l - 1 and f["maxX"] <= r + 1 and f["minY"] >= t - 1 and f["maxY"] <= b + 1, ("every satellite is in it", f, (l, t, r, b))
    assert not pg.errors, pg.errors


def test_a_filter_change_frames_again_and_a_tap_on_the_bar_brings_the_sheet_back(three_d_still):
    pg = three_d_still
    _size(pg, "portrait")
    _orbit(pg)
    _sats_ready(pg)
    pg.evaluate("() => { _aeShowGo(true); }")
    pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)
    full = pg.evaluate("() => document.getElementById('ae-go').getBoundingClientRect().height")
    pg.click("#ae-band [data-ae-drawer=sats]")
    pg.wait_for_function("() => document.getElementById('as-bar') && !document.getElementById('as-bar').hidden", timeout=60_000)
    _settle(pg)
    wide = pg.evaluate("() => ({ reach: _aeGoSatReach(), dist: _ae.dist })")
    # Only the low orbits: the reach is shorter, the Earth is drawn larger.
    pg.evaluate("() => { _as.filter.orbit = { leo: true }; _asApplyFilters(); }")
    pg.wait_for_function("() => _aeGoSatReach() > 0", timeout=5000)
    _settle(pg)
    low = pg.evaluate(FRAMED)
    assert low["reach"] < wide["reach"] and low["n"] > 0, (wide, low["reach"], low["n"])
    assert pg.evaluate("() => _ae.dist") < wide["dist"] * 0.8, ("a shorter reach: the camera comes in, the Earth is drawn larger", wide)
    l, t, r, b = _free(low)
    assert low["minY"] >= t - 1 and low["maxY"] <= b + 1 and low["minX"] >= l - 1 and low["maxX"] <= r + 1, (low, (l, t, r, b))
    pg.tap("#ae-go-q")
    pg.wait_for_function("() => document.getElementById('ae-drawer').hidden && !_ae.el.classList.contains('ae-drawer-up')", timeout=10_000)
    assert pg.evaluate("() => document.getElementById('ae-go').getBoundingClientRect().height") >= full - 1, "the whole sheet is back"
    assert not pg.errors, pg.errors


@pytest.mark.parametrize("preset", ["earth", "planets"])
def test_browsing_the_sheet_leaves_the_picture_where_it_was(three_d_still, preset):
    pg = three_d_still
    _size(pg, "portrait")
    pg.evaluate("(p) => { _aeShowGo(false); _aePreset(p); }", preset)
    pg.wait_for_function("() => !_ae.fly", timeout=60_000, polling=200)
    pg.evaluate("() => { _aeUpdate(_aeDisplayMs()); }")
    before = pg.evaluate(CAMERA)
    pg.evaluate("() => { _aeShowGo(true); }")
    pg.wait_for_selector("#ae-band", state="visible", timeout=30_000)
    pg.wait_for_timeout(600)
    pg.evaluate("() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); }")
    after = pg.evaluate(CAMERA)
    assert after == before, ("opening the sheet to browse moves nothing", before, after)
    pg.evaluate("() => { _aeShowGo(false); }")
    assert not pg.errors, pg.errors
