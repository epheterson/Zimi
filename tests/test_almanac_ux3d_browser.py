"""The 3D view's small bugs from the owner's phone and the reviewer's pass (2026-11-10), each as a person meets it.

At a phone's size in headless Chromium: Stand here's Back returns to where the person came from; the Satellites chip turns the
layer on; the owner filter says Unassigned and wraps into labelled rows inside the panel; the Stand HUD's phone button is at the top
right and the Sun's height has no compass letter; a launch's choices each work and stay in the 3D view; a mission opens at its
launch; the chooser's selection is the app's amber and Saturn's thumbnail is whole.

Run: pytest tests/test_almanac_ux3d_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import (
    GL_ARGS,
    READY_MS,
    no_map,
)  # noqa: E402,F401  (no_map is a fixture)

VIEW = {"width": 390, "height": 844}
LA = '{"lat":34.05,"lon":-118.24,"name":"Los Angeles"}'
GROUND_MS = 240_000


def _open(browser, base, view=VIEW):
    ctx = browser.new_context(
        viewport=view,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); localStorage.setItem('zimi_cap', 'full'); } catch (e) {}"
        % LA
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(base + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    return ctx, pg


def _open_3d(pg):
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
        timeout=READY_MS,
        polling=200,
    )


def _stand_up(pg, lat=34.05, lon=-118.24):
    pg.evaluate("([a, o]) => _aeStandAt('earth', a, o)", [lat, lon])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )


@pytest.fixture
def three_d(no_map):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg = _open(br, no_map)
            _open_3d(pg)
            yield pg
        finally:
            br.close()


# ── Back from Stand here ──
def test_back_from_stand_returns_the_3d_view_as_it_was(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    before = pg.evaluate(
        "() => ({ dist: _ae.dist, preset: _ae.preset, target: _ae.target })"
    )
    _stand_up(pg)
    pg.click("#ae-stand-back")
    pg.wait_for_function(
        "() => !_ae.stand && !_ae.standPending && !_ae.fly", timeout=60_000, polling=250
    )  # it flies back out to the view as it was
    after = pg.evaluate(
        "() => ({ dist: _ae.dist, preset: _ae.preset, target: _ae.target, lit: (document.querySelector('#ae-views [aria-pressed=true]') || {}).dataset && document.querySelector('#ae-views [aria-pressed=true]').dataset.aeView })"
    )
    assert (
        abs(after["dist"] - before["dist"]) < 1e-6
        and after["target"] == before["target"]
    ), (before, after)
    assert after["preset"] == "earth" and after["lit"] == "earth", after
    assert not pg.errors, pg.errors


def test_back_from_stand_handed_over_by_a_card_goes_to_the_card(three_d):
    pg = three_d
    pg.evaluate(
        "() => { window.__back = 0; window._osHandoff = { lat: 34.05, lon: -118.24, heading: 180, pitch: 8, back: function () { window.__back++; } }; }"
    )
    assert pg.evaluate("() => _aeStandOpen()") is True
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )
    pg.click("#ae-stand-back")
    pg.wait_for_function(
        "() => !_ae.stand && window.__back === 1", timeout=60_000, polling=250
    )
    assert not pg.errors, pg.errors


# ── Stand's HUD ──
def test_the_phone_button_is_at_the_top_right_of_the_hud(three_d):
    pg = three_d
    _stand_up(pg)
    got = pg.evaluate(
        """() => { var b = document.getElementById('ae-stand-motion'); if (!b) return null; var r = b.getBoundingClientRect();
        return { right: innerWidth - r.right, top: r.top }; }"""
    )
    if got is None:
        pytest.skip("the phone's sensors are not offered in this browser")
    assert got["right"] < 24 and got["top"] < 80, got


def test_the_suns_height_has_no_compass_letter(three_d):
    pg = three_d
    pg.evaluate(
        "() => _aeGoTo(Date.UTC(2026, 5, 21, 20, 0))"
    )  # local noon: the Sun high in the south
    _stand_up(pg)
    pg.wait_for_function(
        "() => /☀/.test(document.getElementById('ae-stand-text').innerText)",
        timeout=30_000,
    )
    text = pg.evaluate("() => document.getElementById('ae-stand-text').innerText")
    sun = [l for l in text.split("\n") if "☀" in l][0]
    import re

    assert re.search(r"☀ \d+° [↑↓]", sun), sun
    assert not re.search(
        r"☀ -?\d+°( [↑↓])? [NESW]", sun
    ), sun  # the height is not followed by a letter: the bearing is, after a dot
    assert re.search(r"· [NESW]+", sun), sun


# ── Satellites ──
def test_the_satellites_chip_turns_the_layer_on(three_d):
    pg = three_d
    assert pg.evaluate("() => _aeSatsAllOn()") is False
    pg.evaluate("() => document.querySelector('#ae-views [data-ae-view=sats]').click()")
    pg.wait_for_function("() => _aeSatsAllOn() === true", timeout=60_000, polling=250)
    assert pg.get_attribute("#ae-sats-btn", "aria-pressed") == "true"


def test_the_owner_filter_says_unassigned_and_the_rows_wrap_inside_the_panel(three_d):
    pg = three_d
    pg.evaluate("() => _aeSatsAllSet(true)")
    pg.wait_for_function(
        "() => typeof _as !== 'undefined' && _as.state === 'ready' && document.getElementById('as-bar') && !document.getElementById('as-bar').hidden",
        timeout=180_000,
        polling=250,
    )
    got = pg.evaluate(
        """() => { var b = document.getElementById('as-bar'), r = b.getBoundingClientRect();
        return { w: r.width, sw: b.scrollWidth, text: b.innerText, rows: b.querySelectorAll('.as-row').length,
                 labels: Array.from(b.querySelectorAll('.as-lab')).map(function (x) { return x.textContent; }),
                 over: Array.from(b.querySelectorAll('button')).filter(function (x) { return x.getBoundingClientRect().right > innerWidth + 1; }).length }; }"""
    )
    assert (
        got["sw"] <= got["w"] + 1 and got["over"] == 0
    ), got  # nothing scrolls sideways
    assert got["rows"] == 3 and len(got["labels"]) == 3, got
    assert "TBD" not in got["text"] and "Unassigned" in got["text"], got


# ── The chooser ──
def test_saturns_whole_ring_is_inside_its_thumbnail_cell():
    import numpy as np
    from PIL import Image

    sheet = np.asarray(
        Image.open(
            os.path.join(
                os.path.dirname(HERE), "zimi", "static", "earth", "go-discs-v1.webp"
            )
        )
    )
    cell = 96
    row, col = divmod(7, 7)  # saturn: AE_GO_DISC_KEYS[7]
    alpha = sheet[row * cell : (row + 1) * cell, col * cell : (col + 1) * cell, 3]
    # not a pixel of the ring on the cell's four edges: it is drawn whole, not cut by the cell
    assert (
        max(alpha[0].max(), alpha[-1].max(), alpha[:, 0].max(), alpha[:, -1].max()) == 0
    )
    assert (alpha > 40).sum() > 600, "and there is a Saturn in it"


def test_the_chooser_marks_the_selected_body_in_amber_and_rims_no_body_in_its_own_colour(
    three_d,
):
    pg = three_d
    pg.click("#ae-go-btn")
    pg.wait_for_selector("#ae-go-groups .ae-go-row", state="visible", timeout=60_000)
    got = pg.evaluate("""() => {
          var cur = document.querySelector('#ae-go-groups .ae-go-row[aria-current=true]');
          var thumb = cur.querySelector('.ae-go-thumb'), amber = getComputedStyle(cur).color;
          var discs = Array.from(document.querySelectorAll('#ae-go-groups .ae-go-disc')).filter(function (d) { return !d.classList.contains('ae-go-ring'); });
          return { ring: getComputedStyle(thumb).boxShadow, amber: amber, n: discs.length,
                   rimmed: discs.filter(function (d) { var c = getComputedStyle(d).backgroundColor; return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; }).length };
        }""")
    assert got["amber"] in got["ring"], got  # the selection ring is the row's own amber
    assert (
        got["n"] > 3 and got["rimmed"] == 0
    ), got  # no disc has a body-coloured backing to show as a stroke


# ── Missions ──
@pytest.mark.parametrize("mission", ["voyager1", "voyager2"])
def test_a_probes_mission_opens_at_its_launch_at_the_earth(three_d, mission):
    pg = three_d
    pg.evaluate("(id) => _aeMissionStart(id)", mission)
    pg.wait_for_function(
        "(id) => _ae.mission && _ae.mission.id === id && _ae.mission.t !== undefined",
        arg=mission,
        timeout=GROUND_MS,
    )
    got = pg.evaluate(
        "() => ({ start: _amMission().start, first: _amMission().phases[0].k, t: _ae.mission.t, body: _amMission().phases[0].cam.body, hud: document.querySelector('.am-hud, #am-hud').innerText })"
    )
    assert (
        got["start"] == 0
        and got["first"] == "alm_ms_ph_launch"
        and got["body"] == "earth"
    ), got
    assert (
        0 <= got["t"] < 3 * 3600
    ), got  # the first seconds of the flight, not days or months in
    assert "T+0:" in got["hud"], got


# ── The hero disc ──
def test_the_hero_disc_stays_put_under_a_drag_until_the_view_can_turn_it(no_map):
    """Before the 3D view is up the disc is a picture: it must not slide under the finger; the drag is kept to turn the Moon by."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg = _open(br, no_map)
            pg.wait_for_selector("#almanac-head .almanac-moon-open", timeout=60_000)
            pg.wait_for_function(
                "() => typeof _aeHandDrag === 'function'", timeout=60_000
            )
            box = "() => { var r = document.querySelector('#almanac-head .almanac-moon-open').getBoundingClientRect(); return [r.x, r.y]; }"
            before = pg.evaluate(box)
            for dx, dy in ((20, 4), (30, 6), (40, 2)):
                pg.evaluate("([x, y]) => _aeHandDrag(x, y)", [dx, dy])
            assert pg.evaluate(box) == before, "the disc moved under the drag"
            assert pg.evaluate("() => _aeWaitDragPx") == {
                "x": 90,
                "y": 12,
            }, "the drag is kept"
            assert not pg.errors, pg.errors
        finally:
            br.close()


# ── The ground's stones ──
def test_the_grounds_stones_are_never_cut_circles_or_a_bare_hemisphere():
    """Eric, 2026-11-10: "crater circles cut in half". The ground shader's stones kept only the nearest one at a point (a stone met by a
    bigger one was cut in half), drew a perfect circle, and rose as a steep hemisphere (half a disc lit, half dark from the side).
    """
    src = open(
        os.path.join(os.path.dirname(HERE), "zimi", "static", "almanac-standgl.js"),
        encoding="utf-8",
    ).read()
    a = src.index("vec2 rocks(vec3 p, float foot)")
    body = src[a : src.index("void main()", a)]
    assert (
        "best" not in body
    ), "only the nearest stone counted: a stone met by a bigger one is cut"
    assert (
        "wob" in body and "vnoise" in body
    ), "the outline is wobbled: no stone is a circle"
    assert "dome * dome" in body, "a soft profile at the ground, not a steep hemisphere"


# ── A grazing Sun on airless ground ──
def test_a_grazing_sun_does_not_blow_the_ground_out_or_draw_the_grids_squares():
    static = os.path.join(os.path.dirname(HERE), "zimi", "static")
    stand = open(os.path.join(static, "almanac-stand.js"), encoding="utf-8").read()
    gl = open(os.path.join(static, "almanac-standgl.js"), encoding="utf-8").read()
    shade = open(
        os.path.join(static, "almanac-terrainshade.js"), encoding="utf-8"
    ).read()
    assert (
        "AE_STAND_EXPOSURE_MU_FLOOR" in stand and "expoG" in stand
    ), "the eye does not open for the sliver of Sun the flat ground gets"
    assert (
        "AE_SHADE_PENUMBRA_CELLS" in shade and "_aeShadeCellOut)" in shade
    ), "a shadow's edge is never sharper than the grid's cell"
    fine = gl[gl.index("float fine(vec3 p, float foot)") : gl.index("vec2 rocks(")]
    assert (
        "cos(a)" in fine
    ), "each octave's lattice is turned: aligned, they drew squares"
    assert (
        "fine(vP + dpx" in gl
    ), "the fine relief's slope is a step along the ground, not a 2 x 2 pixel derivative"


# ── Down to the ground and back up: one path, never a black frame ──
SAMPLE_MS = 100
DARK_MEAN = 6  # the mean of a 0..255 grey over the middle of a daylight frame; a black one is under 1


def _mean(pg):
    import io

    import numpy as np
    from PIL import Image

    im = Image.open(io.BytesIO(pg.screenshot())).convert("L")
    w, h = im.size
    return float(np.asarray(im.crop((w // 5, h // 5, 4 * w // 5, 4 * h // 5))).mean())


LOGGER = """() => { window.__log = []; (function tick() { var st = _ae.stand;
  window.__log.push({ t: performance.now(), a: st ? st.altKm : null, mode: st ? st.mode : null, d: _ae.dist, fly: !!_ae.fly, still: !!document.querySelector('.ae-stand-still') });
  window.__raf = requestAnimationFrame(tick); })(); }"""


def test_the_descent_is_one_path_with_no_black_frame_and_the_ascent_is_the_same_path_back(three_d):
    pg = three_d
    pg.evaluate("() => _aeGoTo(Date.UTC(2026, 5, 21, 20, 0))")  # local noon over Los Angeles
    pg.wait_for_timeout(2500)
    start = pg.evaluate("() => _ae.dist")
    pg.evaluate(LOGGER)
    pg.evaluate("() => _aeStandAt('earth', 34.05, -118.24)")
    frames = []
    while True:  # a screenshot every moment it can take: none may be black
        frames.append(_mean(pg))
        if pg.evaluate("() => !!_ae.stand && _ae.stand.mode === 'ground'") or len(frames) > 120:
            break
    log = pg.evaluate("() => window.__log")
    assert log[-1]["mode"] == "ground", "the descent ended on the ground"
    assert min(frames) > DARK_MEAN, "a black frame in the descent: %s" % [round(f) for f in frames]
    dists = [f["d"] for f in log if f["a"] is None]
    alts = [f["a"] for f in log if f["a"] is not None]
    assert all(b <= a + 1e-9 for a, b in zip(dists, dists[1:])), "the approach only ever comes nearer"
    assert len(alts) > 3 and all(b <= a + 1e-6 for a, b in zip(alts, alts[1:])), "the camera's height only ever falls"
    # and back up, along the same path
    pg.evaluate("() => { window.__log = []; }")
    pg.click("#ae-stand-back")
    frames = []
    while True:
        frames.append(_mean(pg))
        if pg.evaluate("() => !_ae.stand && !_ae.fly") or len(frames) > 120:
            break
    log = pg.evaluate("() => window.__log")
    assert min(frames) > DARK_MEAN, "a black frame in the ascent: %s" % [round(f) for f in frames]
    up = [f["a"] for f in log if f["a"] is not None]
    out = [f["d"] for f in log if f["a"] is None]
    assert len(up) > 3 and all(b >= a - 1e-6 for a, b in zip(up, up[1:])), "the ascent only ever climbs"
    assert all(b >= a - 1e-9 for a, b in zip(out, out[1:])), "and then draws away only"
    end = pg.evaluate("() => ({ dist: _ae.dist, fit: _aeFitDist(AE_FIT_EARTH), pick: !!_ae.pick, preset: _ae.preset })")
    assert end["dist"] >= end["fit"] - 1e-6 and end["pick"] and end["preset"] == "earth", end  # the body whole, the place marked
    assert end["dist"] >= start - 1e-6, (start, end)
    assert not pg.errors, pg.errors
