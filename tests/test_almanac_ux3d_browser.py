"""The 3D view's small bugs from the owner's phone and the reviewer's pass (2026-11-10), each as a person meets it.

At a phone's size in headless Chromium: Stand here's Back returns to where the person came from; the Satellites chip turns the
layer on; the owner filter says Unassigned and wraps into labelled rows inside the panel; the Stand HUD's phone button is at the top
right and the Sun's height has no compass letter; a mission opens at its
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


def _open(browser, base, view=VIEW, dpr=2, routes=(), still=False):
    ctx = browser.new_context(
        reduced_motion="reduce" if still else "no-preference",
        viewport=view,
        device_scale_factor=dpr,
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
    for pattern, handler in routes:
        pg.route(pattern, handler)
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
    # Stand's code loads on first ask, and it gives a ground up after 25 s. A software-GL machine under load draws a ground frame in seconds, and the
    # stall guard holds every move back frame by frame, so the descent never ends. Ask for the code first and lift the give-up; a still page lands at once.
    pg.evaluate("() => _aeStandReady().then(() => { AE_STAND_GIVE_UP_MS = 900000; })")
    pg.evaluate("([a, o]) => _aeStandAt('earth', a, o)", [lat, lon])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )


def _three_d(no_map, still):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg = _open(br, no_map, still=still)
            _open_3d(pg)
            yield pg
        finally:
            br.close()


@pytest.fixture
def three_d(no_map):
    yield from _three_d(no_map, False)


@pytest.fixture
def three_d_still(no_map):
    """The same page with reduced motion on: every move lands at once, so a test of where things stand reaches the ground in seconds."""
    yield from _three_d(no_map, True)


# ── Back from Stand here ──
def test_back_from_stand_returns_the_3d_view_as_it_was(three_d_still):
    pg = three_d_still
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    before = pg.evaluate(
        "() => ({ dist: _ae.dist, preset: _ae.preset, target: _ae.target })"
    )
    _stand_up(pg)
    pg.click("#ae-rim")
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


def test_back_from_stand_handed_over_by_a_card_goes_to_the_card(three_d_still):
    pg = three_d_still
    pg.evaluate(
        "() => { window.__back = 0; window._osHandoff = { lat: 34.05, lon: -118.24, heading: 180, pitch: 8, back: function () { window.__back++; } }; }"
    )
    assert pg.evaluate("() => _aeStandOpen()") is True
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )
    pg.click("#ae-rim")
    pg.wait_for_function(
        "() => !_ae.stand && window.__back === 1", timeout=60_000, polling=250
    )
    assert not pg.errors, pg.errors


# ── Stand's HUD ──
def test_the_grounds_tools_stand_on_the_small_discs_line_above_the_rim(three_d_still):
    pg = three_d_still
    _stand_up(pg)
    got = pg.evaluate(
        """() => { var rim = document.getElementById('ae-rim').getBoundingClientRect();
        return ['ae-stand-drive', 'ae-stand-motion', 'ae-cam', 'ae-locate'].map(function (id) { var b = document.getElementById(id); if (!b || !b.offsetParent) return null;
          var r = b.getBoundingClientRect(); return [id, Math.round(r.width), Math.round(r.bottom), Math.round(r.right)]; }).filter(Boolean).concat([['rim', 0, Math.round(rim.top), Math.round(rim.right)]]); }"""
    )
    rim = got[-1]
    discs = got[:-1]
    assert discs, got
    assert all(d[1] == 44 and d[2] == rim[2] - 16 for d in discs), got   # one size, one line just above the rim's row (nothing floats under the time)
    assert max(d[3] for d in discs) == rim[3], got   # right aligned over the rim's column
    assert len({d[3] for d in discs}) == len(discs), got   # side by side, none on another


def test_the_suns_height_has_no_compass_letter(three_d_still):
    pg = three_d_still
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
    pg.evaluate("() => _aePreset('sats')")
    pg.wait_for_function("() => _aeSatsAllOn() === true", timeout=60_000, polling=250)
    assert pg.get_attribute("#ae-sats-btn", "aria-pressed") == "true"


def test_the_owner_filter_says_unassigned_and_the_rows_wrap_inside_the_panel(three_d):
    pg = three_d
    pg.evaluate("() => _aeSatsAllSet(true)")
    pg.evaluate("() => _aeShowGo(true)")  # its filters are the band's chevron, in the one drawer
    pg.wait_for_function("() => typeof _as !== 'undefined' && _as.state === 'ready'", timeout=180_000, polling=250)
    pg.click("#ae-band [data-ae-drawer=sats]")
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
    np = pytest.importorskip("numpy")
    from PIL import Image

    sheet = np.asarray(
        Image.open(
            os.path.join(
                os.path.dirname(HERE), "zimi", "static", "earth", "go-discs-v2.webp"
            )
        )
    )
    cell = sheet.shape[1] // 7
    area = lambda i: int((sheet[(i // 7) * cell : (i // 7 + 1) * cell, (i % 7) * cell : (i % 7 + 1) * cell, 3] > 128).sum())  # noqa: E731
    saturn, earth, sun = area(7), area(1), area(0)
    # the Sun fills its cell like the Earth; Saturn is the whole ringed planet inside its cell (a smaller ball, the rings out to
    # the edge, none cut off by the round edge): its drawn pixels stay off the cell's border ring
    assert sun > 0.9 * earth and 0.2 * earth < saturn < 0.8 * earth, (saturn, earth, sun)
    cellpix = sheet[(7 // 7) * cell : (7 // 7 + 1) * cell, (7 % 7) * cell : (7 % 7 + 1) * cell, 3]   # Saturn's cell
    ys, xs = np.nonzero(cellpix > 128)
    assert ys.min() >= 2 and xs.min() >= 2 and ys.max() <= cell - 3 and xs.max() <= cell - 3, (ys.min(), xs.min(), ys.max(), xs.max())


def test_the_chooser_marks_the_selected_body_in_amber_and_rims_no_body_in_its_own_colour(
    three_d,
):
    pg = three_d
    pg.click("#ae-find")
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
        "() => ({ start: _amMission().start, first: _amMission().phases[0].k, t: _ae.mission.t, body: _amMission().phases[0].cam.body, hud: document.querySelector('.am-hud, #am-hud').innerText + ' ' + ((document.querySelector('.ae-pin .alm-ck-d') || {}).textContent || '') })"
    )
    assert (
        got["start"] == 0
        and got["first"] == "alm_ms_ph_launch"
        and got["body"] == "earth"
    ), got
    assert (
        0 <= got["t"] < 3 * 3600
    ), got  # the first seconds of the flight, not days or months in
    assert "T+0:" in got["hud"], got   # (the mission's clock stands in the time chip's place: the strip says the events)


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
    """"crater circles cut in half". The ground shader's stones kept only the nearest one at a point (a stone met by a
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

    np = pytest.importorskip("numpy")
    from PIL import Image

    im = Image.open(io.BytesIO(pg.screenshot())).convert("L")
    w, h = im.size
    return float(np.asarray(im.crop((w // 5, h // 5, 4 * w // 5, 4 * h // 5))).mean())


LOGGER = """() => { window.__log = []; (function tick() { var st = _ae.stand;
  window.__log.push({ t: performance.now(), a: st ? st.altKm : null, mode: st ? st.mode : null, d: _ae.dist, fly: !!_ae.fly, still: !!document.querySelector('.ae-stand-still') });
  window.__raf = requestAnimationFrame(tick); })(); }"""


@pytest.mark.local_gate
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
        if pg.evaluate("() => !!_ae.stand && _ae.stand.mode === 'ground'") or len(frames) > 500:
            break
    log = pg.evaluate("() => window.__log")
    assert log[-1]["mode"] == "ground", "the descent ended on the ground"
    assert min(frames) > DARK_MEAN, "a black frame in the descent: %s" % [round(f) for f in frames]
    dists = [f["d"] for f in log if f["a"] is None]
    alts = [f["a"] for f in log if f["a"] is not None]
    assert all(b <= a + 1e-9 for a, b in zip(dists, dists[1:])), "the approach only ever comes nearer"
    assert len(alts) > 3 and all(b <= a + 1e-6 for a, b in zip(alts, alts[1:])), ("the camera's height only ever falls", [(i, x, y) for i, (x, y) in enumerate(zip(alts, alts[1:])) if y > x + 1e-6][:3], alts[:8])
    # and back up, along the same path
    pg.evaluate("() => { window.__log = []; }")
    pg.click("#ae-rim")
    frames = []
    while True:
        frames.append(_mean(pg))
        if pg.evaluate("() => !_ae.stand && !_ae.fly") or len(frames) > 500:
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


def test_with_reduced_motion_the_ground_is_a_cross_fade_not_a_flight(no_map):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block", reduced_motion="reduce")
            ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); localStorage.setItem('zimi_cap', 'full'); } catch (e) {}" % LA)
            pg = ctx.new_page()
            pg.errors = []
            pg.on("pageerror", lambda e: pg.errors.append(str(e)))
            pg.goto(no_map + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function'", timeout=120_000)
            _open_3d(pg)
            pg.evaluate("() => _aeGoTo(Date.UTC(2026, 5, 21, 20, 0))")
            pg.wait_for_timeout(2000)
            pg.evaluate(LOGGER)
            pg.evaluate("() => _aeStandAt('earth', 34.05, -118.24)")
            frames, saw_still = [], False
            while True:
                frames.append(_mean(pg))
                saw_still = saw_still or pg.evaluate("() => !!document.querySelector('.ae-stand-still')")
                if pg.evaluate("() => !!_ae.stand && _ae.stand.mode === 'ground'") or len(frames) > 500:
                    break
            log = pg.evaluate("() => window.__log")
            assert min(frames) > DARK_MEAN, [round(f) for f in frames]
            assert not [f for f in log if f["mode"] == "descend"], "no flight down under reduced motion: the ground at once"
            pg.click("#ae-rim")
            pg.wait_for_function("() => !_ae.stand && !_ae.fly", timeout=60_000, polling=250)
            assert not pg.errors, pg.errors
        finally:
            br.close()


# ── The rim button: the one way in and out ──
@pytest.mark.local_gate
def test_the_rim_button_lands_on_the_body_at_the_middle_and_leaves_again(three_d):
    from hit_area import undersized

    pg = three_d
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.wait_for_function("() => !document.getElementById('ae-rim').hidden && document.getElementById('ae-rim').getAttribute('aria-label') === 'Stand here'", timeout=30_000)   # the body is under the middle once the move has settled
    got = pg.evaluate(
        "() => { var b = document.getElementById('ae-rim'), r = b.getBoundingClientRect(), v = document.getElementById('ae-views').getBoundingClientRect();"
        " return { kind: b.dataset.kind, label: b.getAttribute('aria-label'), right: r.right, vw: innerWidth, rowRight: v.right, left: r.left }; }"
    )
    assert got["kind"] == "enter" and got["label"] == "Stand here", got
    assert got["right"] <= got["vw"] and got["left"] >= got["rowRight"], got  # at the foot's end, clear of the row
    assert not [u for u in undersized(pg, noscroll=True) if "ae-rim" in u], "the rim button gives a finger 44 x 44"
    pg.click("#ae-rim")
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )
    pg.wait_for_function("() => document.getElementById('ae-rim').dataset.kind === 'leave'", timeout=30_000)
    assert pg.get_attribute("#ae-rim", "aria-label") == "Back to orbit"
    pg.click("#ae-rim")
    pg.wait_for_function("() => !_ae.stand && !_ae.standPending && !_ae.fly", timeout=60_000, polling=250)
    assert not pg.errors, pg.errors


def _where_line(pg):
    """The world's sheet opens from search, bottom left (the time capsule holds the time alone)."""
    pg.wait_for_selector("#ae-find", state="visible")
    pg.click("#ae-find")


def test_the_time_bar_is_the_same_bar_on_a_phone_on_its_side(three_d):
    """Landscape: the same date, time and slider as upright (the slider shows when the clock is away from now), between the chips and the tools."""
    from hit_area import top_overlaps

    pg = three_d
    pg.set_viewport_size({"width": 844, "height": 390})
    pg.wait_for_timeout(600)
    pg.evaluate("() => _almClockSetRate(3600)")
    pg.wait_for_timeout(800)
    chip = pg.evaluate("() => document.querySelector('.ae-pin .alm-ck-d').getBoundingClientRect().width > 20")   # collapsed: the date, rate and Now
    pg.evaluate("() => _aePinSet(true)")   # open: the slider
    pg.wait_for_timeout(500)
    got = pg.evaluate(
        """() => { var q = s => document.querySelector(s).getBoundingClientRect(), sl = document.querySelector('.ae-pin .alm-spd');
          return { slider: getComputedStyle(sl).display !== 'none' && q('.ae-pin .alm-spd').width > 120, date: q('.ae-pin .alm-ck-d').width > 20 }; }"""
    )
    got["date"] = got["date"] and chip
    pg.evaluate("() => { _aePinSet(false); _almClockSetRate(1); }")
    assert got["slider"] and got["date"], got
    assert not top_overlaps(pg), top_overlaps(pg)
    assert not pg.errors, pg.errors


def test_the_page_bar_is_not_drawn_in_3d_the_way_out_and_the_search_are_two_44_px_circles_at_the_ends_of_the_time_row(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 690})
    pg.wait_for_timeout(600)
    got = pg.evaluate(
        """() => { var r = id => document.getElementById(id).getBoundingClientRect(), vis = s => { var c = getComputedStyle(document.querySelector(s)); return c.visibility !== 'hidden' && +c.opacity > 0.1; },
          b = r('ae-back'), f = r('ae-fly-btn'), p = r('ae-pin'), d = document.querySelector('.ae-pin .alm-ck-t').getBoundingClientRect();
          return { bar: vis('.topbar'), back: [b.width, b.height, b.left, b.top], find: [f.width, f.height, innerWidth - f.right, f.top],
            date: [d.left >= b.right, d.right <= f.left, Math.abs((d.top + d.height / 2) - (b.top + b.height / 2)) < 4], pinTop: p.top }; }"""
    )
    assert not got["bar"], "the page's own bar is not seen in the 3D view"
    assert got["back"][:2] == [44, 44] and got["find"][:2] == [44, 44] and got["back"][2] == 12 and got["find"][2] == 12 and got["back"][3] == got["find"][3] < 12, got   # inside the capsule, 12 from the edges
    assert all(got["date"]) and got["pinTop"] == 8, got   # the date between the circles, on their centre line, the capsule 8 px from the top edge
    # the search disc (first in the strip) opens the Go sheet from the bottom with its own field; the page's bar stays unseen
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-go", state="visible", timeout=30_000)
    assert pg.evaluate("() => !!document.getElementById('ae-go-q') && getComputedStyle(document.querySelector('.topbar')).visibility === 'hidden' && document.getElementById('ae-go').getBoundingClientRect().bottom > innerHeight - 100")   # (above the row)
    pg.evaluate("() => _aeShowGo(false)")
    # the way out leaves the view
    pg.click("#ae-back")
    pg.wait_for_function("() => !_aeIsOpen", timeout=30_000)
    assert not pg.errors, pg.errors


@pytest.mark.parametrize("dpr", [2, 3])
def test_the_rows_balls_are_round_whole_circles_not_squared_off(no_map, dpr):
    """Pixels, not boxes: the Sun's and the Moon's edge is there at the top, bottom, left and right at the same radius, and just outside it is
    background (a ball clipped flat at its top and bottom reads as squared)."""
    import io

    from PIL import Image
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg = _open(br, no_map, dpr=dpr)
            _open_3d(pg)
            pg.evaluate("() => { _almClockSetRate(0); _aeGoTo(Date.UTC(2026, 10, 24, 15)); _aePreset('moon'); }")   # a full Moon: the row draws its phase
            pg.wait_for_function("() => !_ae.fly && document.querySelectorAll('#ae-chips .ae-disc').length > 2", timeout=60_000)
            pg.add_style_tag(content="*{transition:none!important;animation:none!important}")
            pg.wait_for_timeout(1500)
            boxes = pg.evaluate(
                """() => ['sun', 'moon'].map(k => { var e = document.querySelector('#ae-chips [data-ae-view=' + k + ']'); if (!e) return null; var r = e.getBoundingClientRect(); return { k: k, x: r.left, y: r.top, w: r.width, h: r.height }; }).filter(Boolean)"""
            )
            assert boxes, "the row has the Sun or the Moon"
            img = Image.open(io.BytesIO(pg.screenshot())).convert("L")
            lum = lambda x, y: img.getpixel((int(round(x * dpr)), int(round(y * dpr))))  # noqa: E731
            pill = pg.evaluate("() => document.getElementById('ae-chips').getBoundingClientRect().left")
            boxes = [b for b in boxes if b and b["x"] >= pill - 1]   # a ball scrolled out past the track's start is not on show
            assert boxes, "the Moon is clear of the pill"
            for b in boxes:
                cx, cy, r = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2, b["w"] / 2
                edge = r - 1.5   # 1.5 CSS px inside the circle's edge, at the four extremes and the four diagonals
                d = edge * 0.7071
                ins = [lum(cx, cy - edge), lum(cx, cy + edge), lum(cx - edge, cy), lum(cx + edge, cy)]
                diag = [lum(cx - d, cy - d), lum(cx + d, cy - d), lum(cx - d, cy + d), lum(cx + d, cy + d)]
                outs = [lum(cx, cy - r - 3), lum(cx, cy + r + 3)]
                lit = b["k"] == "sun"   # the Sun is lit all round; the full Moon nearly so (a sliver of its limb is turned from the Sun)
                assert min(ins) > (60 if lit else 15), (b["k"], dpr, "the ball's edge is missing at one of its four extremes: top, bottom, left, right", ins)
                assert not lit or max(ins + diag) - min(ins + diag) < 90, (b["k"], dpr, "the same radius all round, the diagonals as the axes", ins, diag)
                layers = pg.evaluate("(k) => getComputedStyle(document.querySelector('#ae-chips [data-ae-view=' + k + '] .ae-go-disc')).backgroundImage", b["k"])   # (under the Moon's lit canvas)
                assert layers.count("url(") == 1 and "gradient" not in layers, (b["k"], "the ball is the sprite alone: a gradient square under it showed as flat edges", layers)
                assert max(outs) < min(ins), (b["k"], dpr, "nothing of the ball sticks out past its circle", outs)
            assert not pg.errors, pg.errors
            ctx.close()
        finally:
            br.close()


def test_the_rows_discs_are_one_size_with_their_ring_whole(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('sun')")
    pg.wait_for_function("() => !_ae.fly && document.querySelectorAll('#ae-chips .ae-disc').length > 2", timeout=60_000)
    got = pg.evaluate(
        """() => { var d = Array.from(document.querySelectorAll('#ae-chips .ae-disc:not(.ae-disc-find)')), c = document.getElementById('ae-chips').getBoundingClientRect(),
          now = document.querySelector('#ae-chips .ae-disc-now').getBoundingClientRect(), v = document.getElementById('ae-view').getBoundingClientRect(),
          m = {top: 1e9};
          return { sizes: Array.from(new Set(d.map(e => Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)))),
            ringRoom: [now.left - c.left, c.right - now.right, now.top - c.top, c.bottom - now.bottom], mini: m.top - v.top > v.height / 2 }; }"""
    )
    assert len(got["sizes"]) == 1, "every ball is the same size: %s" % got["sizes"]
    assert min(got["ringRoom"]) >= 2, "the orange ring (2 px) has room all round: %s" % got["ringRoom"]
    assert pg.evaluate("() => !!document.getElementById('ae-mini')"), "the minimap is back (bottom left)"
    assert not pg.errors, pg.errors


LIT_DOT = """() => { var g = document.querySelector('#ae-rim .ae-rim-glyph'); if (!g) return null;
  var lit = g.querySelector('.ae-rim-lit'), tf = getComputedStyle(lit).transform;
  return { ground: g.classList.contains('ae-rim-ground'), tf: tf, dim: g.querySelectorAll('.ae-rim-dim').length, paths: g.querySelectorAll('path').length,
    dimOpacity: +getComputedStyle(g.querySelector('.ae-rim-dim')).opacity }; }"""


def test_the_rim_glyph_is_the_arc_and_two_dots_the_lit_one_is_where_you_are_and_it_travels(three_d):
    """C3a: the arc, a dim dot in space (6,6) and a dim one on the ground (16,16), both always drawn; the lit dot is where you are, moves between
    them in the move's time and leaves the dim one behind."""
    pg = three_d
    pg.evaluate(
        "() => { window.__g = { ground: false };"
        " _aeRimModes.unshift({ leave: function () { return __g.ground ? { label: 'Out', svg: AE_RIM_GROUND_SVG, run: function () {} } : null; },"
        " enter: function () { return __g.ground ? null : { label: 'In', svg: AE_RIM_SPACE_SVG, run: function () {} }; } }); _aeRimSync(true); }"
    )
    inn = pg.evaluate(LIT_DOT)
    assert inn["paths"] == 1 and inn["dim"] == 2 and not inn["ground"] and inn["tf"] in ("none", "matrix(1, 0, 0, 1, 0, 0)"), inn   # in space: the space dot is lit
    assert 0.3 < inn["dimOpacity"] < 0.8, inn
    pg.evaluate("() => { window.__n = document.querySelector('#ae-rim .ae-rim-glyph'); __g.ground = true; _aeRimSync(true); }")
    pg.wait_for_timeout(500)
    mid = pg.evaluate(LIT_DOT)
    assert pg.evaluate("() => window.__n === document.querySelector('#ae-rim .ae-rim-glyph')"), "one glyph the whole way: the lit dot travels"
    assert mid["dim"] == 2 and mid["ground"] and mid["tf"] not in ("none", "matrix(1, 0, 0, 1, 0, 0)", "matrix(1, 0, 0, 1, 10, 10)"), "on its way: " + mid["tf"]
    pg.wait_for_function("() => getComputedStyle(document.querySelector('#ae-rim .ae-rim-lit')).transform === 'matrix(1, 0, 0, 1, 10, 10)'", timeout=6000)
    pg.evaluate("() => { __g.ground = false; _aeRimSync(true); }")
    pg.wait_for_function("() => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(document.querySelector('#ae-rim .ae-rim-lit')).transform)", timeout=6000)
    assert not pg.errors, pg.errors


def test_the_rim_lights_the_space_dot_at_the_globe_and_the_ground_dot_standing(three_d):
    pg = three_d
    pg.add_style_tag(content="*{transition:none!important}")
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly && document.getElementById('ae-rim').getAttribute('aria-label') === 'Stand here'", timeout=60_000)
    g = pg.evaluate(LIT_DOT)
    assert not g["ground"] and g["tf"] in ("none", "matrix(1, 0, 0, 1, 0, 0)"), ("globe: the space dot", g)
    _stand_up(pg)
    pg.wait_for_function("() => document.getElementById('ae-rim').dataset.kind === 'leave'", timeout=30_000)
    st = pg.evaluate(LIT_DOT)
    assert st["ground"] and st["tf"] == "matrix(1, 0, 0, 1, 10, 10)", ("standing: the ground dot", st)
    assert not pg.errors, pg.errors


def test_the_row_keeps_its_real_planet_pictures_at_the_sun_even_when_the_device_has_stepped_down(three_d):
    """The Sun's heavy picture can step the capability level down to low; the row at the foot still shows the sprite's real planets (flat
    colours are the Go sheet's low-level saving, not the row's)."""
    pg = three_d
    pg.evaluate("() => { ZimiCap.level = function () { return 'low'; }; _aePreset('sun'); }")
    pg.wait_for_function("() => !_ae.fly && document.querySelectorAll('#ae-chips .ae-disc').length > 4", timeout=60_000)
    got = pg.evaluate(
        """() => Array.from(document.querySelectorAll('#ae-chips .ae-go-disc')).map(d => [d.parentElement.parentElement.getAttribute('data-ae-view'), getComputedStyle(d).backgroundImage.indexOf('go-discs') > -1, !!d.closest('.ae-go-flat')])"""
    )
    assert len(got) > 4 and all(g[1] and not g[2] for g in got), got
    assert not pg.errors, pg.errors


def test_a_sun_that_fills_the_picture_is_drawn_at_most_at_ratio_2_and_a_small_one_at_the_levels_own(no_map):
    """The Sun close up is paid for in every pixel: at a phone's ratio 3 it was enough to step an iPhone's level down. Filling the picture it
    draws at most at AE_SUN_DPR_MAX; moving off, the level's own ratio again."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg = _open(br, no_map, dpr=3)
            _open_3d(pg)
            pg.evaluate("() => _aePreset('sun')")
            pg.wait_for_function("() => !_ae.fly", timeout=120_000)
            ratio = "() => _ae.gl.renderer.getPixelRatio()"
            pg.evaluate("() => { _ae.dist = AE_MIN_DIST_SUN; _ae.dirty = true; _aeKick(); }")
            pg.wait_for_timeout(1500)
            pg.wait_for_function("() => _ae.gl.renderer.getPixelRatio() <= 2", timeout=30_000)
            # (the governor may have stepped below 2 on software GL: the canvas is the ratio it reports, never above 2)
            assert pg.evaluate("() => { var r = _ae.gl.renderer; return r.getPixelRatio() <= 2 && Math.abs(r.domElement.width - r.getPixelRatio() * _ae.w) <= 1; }")
            pg.evaluate("() => _aePreset('earth')")   # the Sun is a small disc again
            pg.wait_for_function("() => Math.abs(_ae.gl.renderer.getPixelRatio() - Math.min(_ae.gl.dpr, ZimiCap.dprCap('earth'))) < 1e-3 && !_ae.sunBig", timeout=30_000)   # (the governor may have taken a step on software GL: the cap, not a fixed 3)
            assert not pg.errors, pg.errors
            ctx.close()
        finally:
            br.close()


def test_the_crafts_failed_and_loading_lines_reach_the_caption_slot(three_d):
    """The lines almanac-earth.js says while a craft model loads or is missing go through _aeShowHint into the one slot."""
    pg = three_d
    for key in ("alm_craft_failed", "alm_craft_loading"):
        pg.evaluate("(k) => _aeShowHint(_aeT(k))", key)
        assert pg.evaluate("(k) => { var h = document.getElementById('ae-hint'); return h.classList.contains('ae-show') && h.textContent === _aeT(k) && _aeCapNow() === _aeT(k); }", key), key
    pg.evaluate("() => _aeHideHint()")
    assert pg.evaluate("() => !document.getElementById('ae-hint').classList.contains('ae-show') || _aeCapNow() !== _aeT('alm_craft_loading')")


def test_the_foot_note_and_offers_are_said_in_the_caption_slot_not_in_a_banner_row(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.evaluate("() => { _ae.dirty = true; _aeKick(); }")
    pg.wait_for_timeout(1500)
    got = pg.evaluate("() => ({ note: document.getElementById('ae-note').textContent.trim(), shown: getComputedStyle(document.querySelector('.ae-bottom .ae-note')).display, cap: _aeCapNow() })")
    assert got["shown"] == "none", got
    if got["note"]:
        assert got["note"] in got["cap"] or got["cap"], got   # the caption says it, unless a more pressing line holds the slot
    assert not pg.errors, pg.errors


def test_one_caption_slot_says_one_line_at_a_time_by_priority_and_a_hint_goes_by_itself(three_d):
    pg = three_d
    assert pg.evaluate("() => !document.getElementById('ae-orient') && !document.getElementById('ae-sunnote') && !document.getElementById('ae-scale')"), "no floating notes of their own"
    pg.evaluate("() => _aePreset('sun')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.evaluate("() => aeCaption('test', 'The Sun', { prio: AE_CAP_PRIO_NOTE })")   # a standing quiet line, standing in for the spots' honesty the caption used to say
    pg.wait_for_function("() => _aeCapNow() === 'The Sun'", timeout=5000)
    pg.evaluate("() => aeCaption('hint', 'A hint', { prio: AE_CAP_PRIO_HINT, ttl: 400 })")
    assert pg.evaluate("() => _aeCapNow()") == "A hint", "the higher line takes the slot"
    pg.wait_for_function("() => document.getElementById('ae-hint').textContent === 'The Sun'", timeout=5000)   # and gives it back when it has gone by itself
    shown = pg.evaluate("() => { var e = document.getElementById('ae-hint'); return [e.classList.contains('ae-show'), e.textContent]; }")
    assert shown[0] and shown[1] == "The Sun", shown
    assert not pg.errors, pg.errors


def test_the_name_pill_opens_the_worlds_sheet_with_its_layers_and_the_right_hand_column_is_gone(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 690})
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly && !document.getElementById('ae-rim').hidden", timeout=60_000)
    pg.evaluate("() => _aePinSet(true)")
    pg.wait_for_timeout(400)
    got = pg.evaluate(
        """() => { var r = id => document.getElementById(id).getBoundingClientRect(), vis = id => { var e = document.getElementById(id), c = getComputedStyle(e); return e.getBoundingClientRect().width > 0 && c.visibility !== 'hidden'; };
          var p = r('ae-find'), rim = r('ae-rim'), ufo = r('ae-fly-btn'), find = r('ae-find');
          return { pill: [p.height >= 44, p.left < 60, p.bottom > innerHeight - 24], column: ['ae-gear', 'ae-sats-btn'].map(vis),
            ufo: [Math.round(ufo.width), Math.round(rim.width), rim.bottom > innerHeight - 24 && rim.right > innerWidth - 24, ufo.top < 30 && ufo.right > innerWidth - 20, vis('ae-fly-btn')] }; }"""
    )
    assert all(got["pill"]) and not any(got["column"]) and got["ufo"] == [44, 44, True, True, True], got   # the UFO is the top bar's right circle; the surface/space circle is bottom right
    you = pg.evaluate("() => { var y = document.getElementById('ae-locate'), u = document.getElementById('ae-rim'); if (y.hidden) return null; var a = y.getBoundingClientRect(), b = u.getBoundingClientRect(); return [Math.round(a.width), a.bottom <= b.top, Math.abs((a.left + a.right) - (b.left + b.right)) < 1]; }")
    assert you in (None, [44, True, True]), ("You stands just above the surface/space button, in its column, one size with it", you)
    pg.evaluate("() => _aePinSet(false)")
    pg.click("#ae-find")   # search opens the world's sheet
    pg.wait_for_selector("#ae-band", state="visible")
    tiles = pg.evaluate("() => Array.from(document.querySelectorAll('#ae-band [data-ae-layer]')).filter(b => !b.hidden).map(b => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed'), Math.round(b.getBoundingClientRect().height)])")
    assert tiles and all(t[2] >= 44 for t in tiles) and not any(t[0] in ("Landmarks", "Orbits") for t in tiles), tiles   # Landmarks and Orbits are the right edge's buttons now, the band keeps Satellites
    assert pg.evaluate("() => document.getElementById('ae-band-name').textContent") == "Earth"   # the place's part, in the band above the sheet
    pg.mouse.click(195, 100)   # a tap outside (the strip above the tall sheet) puts the sheet away
    pg.wait_for_function("() => document.getElementById('ae-go').hidden", timeout=5000)
    assert not pg.errors, pg.errors


@pytest.mark.parametrize("body", ["earth", "moon", "mars"])
def test_the_world_sheet_lists_the_facts_button_and_the_layers_that_are_true_now(three_d, body):
    pg = three_d
    pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", body)
    pg.wait_for_function("(k) => !_ae.fly && !_ae.pendingPreset && _ae.target === k", arg=body, timeout=90_000, polling=200)
    pg.evaluate("() => { document.getElementById('ae-lm-btn').hidden = true; }")   # a stale hidden flag: the sheet reads the state afresh
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-band", state="visible")
    rows = pg.evaluate("() => Array.from(document.querySelectorAll('#ae-band [data-ae-layer]')).filter(b => !b.hidden).map(b => b.getAttribute('aria-label'))")
    assert "Landmarks" not in rows and "Orbits" not in rows, rows   # (the right edge's buttons, not the band's)
    pg.click("#ae-band-name")
    pg.wait_for_function("() => !!_ae.info && document.querySelector('.ae-info.in') && document.getElementById('ae-go').hidden", timeout=5000)
    assert pg.evaluate("() => document.querySelector('.ae-info').getBoundingClientRect().height") > 200
    pg.evaluate("() => _aeCloseInfo(false)")


def test_on_a_surface_the_world_sheet_has_no_orbits_or_landmarks(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('moon')")
    pg.wait_for_function("() => !_ae.fly && _ae.target === 'moon'", timeout=90_000, polling=200)
    pg.evaluate("() => { _ae.standPending = true; }")   # on a surface (the state the ground sets while it is under way)
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-band", state="visible")
    rows = pg.evaluate("() => Array.from(document.querySelectorAll('#ae-band [data-ae-layer]')).filter(b => !b.hidden).map(b => b.getAttribute('aria-label'))")
    assert "Landmarks" not in rows and "Orbits" not in rows, rows
    pg.evaluate("() => { _ae.standPending = false; }")


def test_the_settings_sheet_scrolls_above_the_sheet_and_remove_is_a_small_text_button(three_d):
    pg = three_d
    pg.evaluate("() => _aeShowSettings(true)")
    pg.wait_for_selector("#ae-set", state="visible")
    got = pg.evaluate("""() => { var s = document.getElementById('ae-drawer'), r = s.getBoundingClientRect(), v = document.getElementById('ae-go').getBoundingClientRect();
      return { bottom: r.bottom, stripTop: v.top, overflow: getComputedStyle(s).overflowY }; }""")
    assert got["bottom"] <= got["stripTop"] and got["overflow"] == "auto", got


def test_a_city_name_gives_way_to_the_you_marker(three_d):
    pg = three_d
    pg.evaluate("() => { _ae.fly = null; _aePreset('earth'); }")
    pg.wait_for_function("() => !_ae.fly && _ae.target === 'earth'", timeout=90_000, polling=200)
    pg.evaluate("() => { _aeLmLoad(); }")
    pg.wait_for_function("() => !!_aeLm", timeout=60_000)
    pg.evaluate("() => { _aeLmEarthLoad(); }")
    pg.wait_for_function("() => _aeLm.earth.length > 50", timeout=60_000)
    # You stands exactly on a named place: the name must not be drawn over it.
    pg.evaluate("() => { var r = _aeLm.earth[0]; _ae.you = { lat: r[1], lon: r[2] }; _ae.az = _aeRad(r[2]); _ae.el_ = _aeRad(r[1]); _ae.dirty = true; _aeKick(); }")
    pg.wait_for_timeout(800)
    got = pg.evaluate("""() => { var y = document.getElementById('ae-lbl-you'); if (y.hidden) return { hidden: true };
      var a = y.getBoundingClientRect(); var hits = Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden).filter(b => { var r = b.getBoundingClientRect(); return r.left < a.right && a.left < r.right && r.top < a.bottom && a.top < r.bottom; }).map(b => b.textContent);
      return { hidden: false, hits: hits }; }""")
    assert got.get("hidden") or got["hits"] == [], got
    pg.evaluate("() => { _ae.you = null; }")


def test_the_capsule_shows_the_rate_while_time_runs_and_keeps_now_clear_of_the_time(three_d):
    pg = three_d
    pg.evaluate("() => { _almClockSetRate(3600); }")
    pg.wait_for_function("() => document.querySelector('#ae-pin .alm-ck-r') && document.querySelector('#ae-pin .alm-ck-r').textContent.trim() !== ''", timeout=10_000)
    got = pg.evaluate("""() => { var q = s => document.querySelector('#ae-pin ' + s).getBoundingClientRect(), t = q('.alm-ck-t'), n = q('.alm-ck-now'), r = q('.alm-ck-r'), c = document.getElementById('ae-pin').getBoundingClientRect();
      return { gap: n.left - t.right, rateShown: r.width > 0 && r.height > 0, rateInside: r.left >= c.left && r.right <= c.right, rateText: document.querySelector('#ae-pin .alm-ck-r').textContent.trim() }; }""")
    assert got["gap"] >= 10 and got["rateShown"] and got["rateInside"] and "h/s" in got["rateText"], got
    pg.evaluate("() => { _almClockSetRate(1); }")


def test_a_long_caption_clears_the_corner_column(three_d):
    pg = three_d
    pg.evaluate("() => { _aePreset('earth'); aeCaption('t-long', 'The satellites shown are a few hours old: the newest elements Zimi has, from CelesTrak, kept for when there is no network', { prio: 9, ttl: 60000 }); }")
    pg.wait_for_timeout(800)
    got = pg.evaluate("""() => { var h = document.getElementById('ae-hint').getBoundingClientRect(), hit = [];
      ['ae-fly-btn', 'ae-locate', 'ae-rim', 'ae-cam'].forEach(id => { var e = document.getElementById(id); if (!e || !e.offsetParent) return; var r = e.getBoundingClientRect();
        if (r.width && r.left < h.right && h.left < r.right && r.top < h.bottom && h.top < r.bottom) hit.push(id); });
      return { hit: hit, w: Math.round(h.width), shown: h.width > 0 }; }""")
    assert got["shown"] and got["hit"] == [], got


def test_the_chip_is_one_tap_that_opens_the_capsule_and_a_tap_on_it_or_away_shuts_it(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 690})
    pg.evaluate("() => { _almClockSetRate(1); _aeNow(); }")
    pg.wait_for_function("() => document.querySelector('#ae-pin .alm-clock').classList.contains('alm-ck-live')", timeout=20_000)
    got = pg.evaluate(
        """() => { var root = document.querySelector('#ae-pin .alm-clock'), c = document.querySelector('#ae-pin .alm-pin-clock').getBoundingClientRect(), v = s => { var e = document.querySelector('#ae-pin ' + s); return !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none'; };
          return { time: v('.alm-ck-t'), date: v('.alm-ck-d'), now: v('.alm-ck-now'), rate: v('.alm-ck-r'), slider: v('.alm-spd'), where: !!document.getElementById('ae-where'), h: Math.round(c.height), w: Math.round(c.width), open: document.getElementById('ae-pin').classList.contains('ae-pin-open') }; }"""
    )
    assert got["time"] and got["date"] and not (got["now"] or got["rate"] or got["slider"] or got["where"] or got["open"]) and got["h"] <= 48 and got["w"] < 390 - 2 * (12 + 44 + 6), got   # live: the date and the time, one line between the circles
    pg.mouse.click(195, 30)   # the chip
    pg.wait_for_function("() => document.getElementById('ae-pin').classList.contains('ae-pin-open') && getComputedStyle(document.querySelector('#ae-pin .alm-spd')).display !== 'none'", timeout=10_000)
    assert pg.evaluate("() => !document.getElementById('ae-where') && document.querySelector('#ae-pin .alm-ck-l').getAttribute('aria-expanded') === 'true'"), "open, the capsule is the time alone"
    assert pg.evaluate("() => !document.activeElement || !document.activeElement.classList.contains('ep')"), "no part took its own focus"
    pg.wait_for_timeout(300)   # (the opening takes ~180 ms)
    pg.mouse.click(195, 11)   # on the open capsule's own face: it shuts
    pg.wait_for_function("() => !document.getElementById('ae-pin').classList.contains('ae-pin-open')", timeout=10_000)
    pg.wait_for_timeout(300)
    pg.mouse.click(195, 30)
    pg.wait_for_function("() => document.getElementById('ae-pin').classList.contains('ae-pin-open')", timeout=10_000)
    pg.wait_for_timeout(300)
    pg.mouse.click(195, 400)   # away from it
    pg.wait_for_function("() => !document.getElementById('ae-pin').classList.contains('ae-pin-open')", timeout=10_000)
    assert not pg.errors, pg.errors


CHIP_JS = """() => { var q = s => document.querySelector('#ae-pin ' + s), vis = e => !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none',
  c = q('.alm-pin-clock').getBoundingClientRect(), r = q('.alm-ck-r'), b = document.getElementById('ae-back').getBoundingClientRect(), f = document.getElementById('ae-rim').getBoundingClientRect(), l = q('.alm-ck-l');
  return { d: vis(q('.alm-ck-d')) ? q('.alm-ck-d').textContent : null, t: vis(q('.alm-ck-t')) ? q('.alm-ck-t').textContent : null, rate: vis(r) ? r.textContent.trim() : null,
    arrow: vis(r) && r.querySelector('path') ? r.querySelector('path').getAttribute('d') : null, paused: vis(r) && !!r.querySelector('[role=img]'), now: vis(q('.alm-ck-now')),
    h: Math.round(c.height), clear: c.left >= Math.min(b.right, f.right) && c.right <= Math.max(b.left, f.left),   // (in a right-to-left language the circles swap sides)
     fits: l.scrollWidth <= l.clientWidth + 1, live: q('.alm-clock').classList.contains('alm-ck-live') }; }"""
PAST = "Date.UTC(1969, 6, 20, 20, 17)"


def _chip(pg, js):
    pg.evaluate(js)
    pg.wait_for_timeout(700)
    return pg.evaluate(CHIP_JS)


@pytest.mark.local_gate
def test_the_chip_shows_in_every_state_only_what_that_state_needs(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 844})
    live = _chip(pg, "() => { _almClockSetRate(1); _aeNow(); }")
    assert live["t"] and live["d"] and live["rate"] is None and not live["now"] and live["live"] and live["h"] <= 48 and live["clear"], live   # live: the date and the time
    assert len(live["d"].split()) == 4 and live["d"].split()[-1].isdigit(), live   # "Mon, Nov 16, 2026": a phone has room for the whole date
    run = _chip(pg, "() => { _almClockSetRate(3600); }")
    assert run["d"] and "1969" not in run["d"] and not any(ch.isdigit() and False for ch in run["d"]) and run["t"] and run["rate"] == "1 h/s" and run["arrow"].startswith("M3") and run["now"], run
    assert 2 <= len(run["d"].split()) <= 3 and run["d"].split()[-1].isdigit() and len(run["d"].split()[-1]) <= 2, run   # "Nov 14" or "Tue, Nov 14" as the line has room (the day's name and the time's own width vary): never this year's year
    paused = _chip(pg, "() => { _aeGoTo(%s); _almClockSetRate(0); }" % PAST)
    assert "1969" in paused["d"] and paused["t"] and paused["paused"] and paused["rate"] == "" and paused["now"], paused   # the year, the clock, a pause mark, Now
    back = _chip(pg, "() => { _almClockSetRate(-3600); }")
    assert back["arrow"].startswith("M9") and back["rate"] == "1 h/s" and "1969" in back["d"] and back["now"], back   # in reverse the arrow points back
    pg.evaluate("() => { _almClockSetRate(1); _aeNow(); }")


@pytest.mark.local_gate
def test_the_chips_date_steps_down_to_fit_and_back_up_with_room(three_d):
    pg = three_d
    steps = []
    for w, rate in ((1440, 3600), (390, 1), (330, 1), (390, 3600), (1440, 1)):
        pg.set_viewport_size({"width": w, "height": 844})
        st = _chip(pg, "() => { _aeNow(); _almClockSetRate(%s); }" % rate)
        assert st["t"] and st["h"] <= 48 and st["fits"] and st["clear"], (w, rate, st)   # one line, clear of the circles, whatever it says
        steps.append(len((st["d"] or "").split()))
    # wide and running: the date without its weekday (it shows only at real time); a phone, live: the whole date; narrower: the weekday, day and month; a phone running: the day and
    # month (away from now the date never goes); wide again: the whole date
    assert steps[0] == 3 and steps[1] == 4 and steps[4] == 4 and steps[2] <= 3 and 2 <= steps[3] <= 3, steps   # (how far a step down goes depends on the day's and the time's own widths)
    pg.set_viewport_size({"width": 390, "height": 844})
    pg.evaluate("() => { _almClockSetRate(1); _aeNow(); }")


def test_on_a_wide_screen_the_open_capsule_is_a_pill_between_the_two_circles_and_they_keep_their_glass(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 1440, "height": 900})
    pg.evaluate("() => { _almClockSetRate(3600); _aePinSet(true); }")
    pg.wait_for_timeout(500)
    got = pg.evaluate("""() => { var p = document.getElementById('ae-pin').getBoundingClientRect(), b = document.getElementById('ae-back'), u = document.querySelector('.ae-view .ah-tr'),
        s = document.querySelector('#ae-pin .alm-spd').getBoundingClientRect(), bb = b.getBoundingClientRect(), ub = u.getBoundingClientRect();
      return { w: p.width, mid: p.left + p.width / 2, l: p.left, r: p.right, back: bb.right, ufo: ub.left, slider: s.width, glass: getComputedStyle(b).backgroundColor, line: getComputedStyle(b).borderTopColor }; }""")
    assert got["w"] <= 560 and abs(got["mid"] - 720) <= 1 and got["l"] > got["back"] and got["r"] < got["ufo"] and got["slider"] > 400, got
    assert got["glass"] not in ("rgba(0, 0, 0, 0)", "transparent") and got["line"] != "rgba(0, 0, 0, 0)", got   # each circle its own glass
    pg.set_viewport_size({"width": 390, "height": 844})
    pg.wait_for_function("() => getComputedStyle(document.getElementById('ae-back')).backgroundColor === 'rgba(0, 0, 0, 0)'", timeout=5000, polling=100)   # (the glass fades out: a transition, not a cut)
    phone = pg.evaluate("() => [document.getElementById('ae-pin').getBoundingClientRect().width, getComputedStyle(document.getElementById('ae-back')).backgroundColor]")
    assert phone[0] >= 390 - 2 * 12 - 1 and phone[1] in ("rgba(0, 0, 0, 0)", "transparent"), phone   # a phone keeps one capsule, the circles inside it
    pg.evaluate("() => { _aePinSet(false); _almClockSetRate(1); _aeNow(); }")


VENUS_LIT_JS = """() => { var c = document.querySelector('#ae-chips canvas[data-lit=venus]'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, lit = 0, disc = 0;
  for (var i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { disc++; if (d[i] + d[i + 1] + d[i + 2] > 180) lit++; }
  return lit / disc; }"""
LIT_ON_JS = "(k) => { var c = document.querySelector('#ae-chips canvas[data-lit=' + k + ']'); return !!c && c.classList.contains('ae-lit-on'); }"


def _row_at(pg, ms):
    n = pg.evaluate("() => _ae.rowLitN || 0")
    pg.evaluate("() => { _almClockSetRate(0); _aeGoTo(%s); }" % ms)
    pg.wait_for_function("(n) => (_ae.rowLitN || 0) > n", arg=n, timeout=20_000)
    pg.wait_for_timeout(700)   # (a look already on its way may have read the scene before the date moved: the next one has it)


def test_the_rows_worlds_are_lit_as_they_stand_and_turn_with_the_date(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 1440, "height": 900})
    pg.wait_for_function(LIT_ON_JS, arg="venus", timeout=60_000)   # the maps came and the discs were drawn over the sprite
    _row_at(pg, "Date.UTC(2026, 9, 24, 12)")   # Venus at inferior conjunction: between us and the Sun, its night side to us
    inferior = pg.evaluate(VENUS_LIT_JS)
    _row_at(pg, "Date.UTC(2026, 0, 6, 12)")   # at superior conjunction: beyond the Sun, its whole day side to us
    superior = pg.evaluate(VENUS_LIT_JS)
    assert inferior < 0.05 and superior > 0.85, (inferior, superior)
    earth = "() => { var c = document.querySelector('#ae-chips canvas[data-lit=earth]'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).filter((v, i) => i % 16 === 0).join(','); }"
    a = pg.evaluate(earth)
    _row_at(pg, "Date.UTC(2026, 0, 6, 18)")   # six hours on: the Earth has turned a quarter
    assert pg.evaluate(earth) != a, "the Earth's disc turns with the time"
    # The row's cost: at most AE_ROW_LIT_HZ looks a second, however fast the time runs, and a few milliseconds each.
    pg.evaluate("() => _almClockSetRate(31557600)")
    before = pg.evaluate("() => [_ae.rowLitN || 0, _ae.rowLitMs || 0]")
    pg.wait_for_timeout(4000)
    after = pg.evaluate("() => [_ae.rowLitN || 0, _ae.rowLitMs || 0]")
    looks, ms = after[0] - before[0], after[1] - before[1]
    assert looks <= 4 * 4 + 2 and ms < 400, (looks, ms)
    pg.evaluate("() => { _almClockSetRate(1); _aeNow(); }")
    pg.set_viewport_size({"width": 390, "height": 844})
    assert not pg.errors, pg.errors


def test_from_a_day_a_second_either_way_the_clock_is_dropped_and_returns_when_slow_paused_or_live(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 844})
    for rate, shows in ((86400, False), (-86400, False), (864000, False), (43200, True), (3600, True), (0, True), (1, True)):
        st = _chip(pg, "() => { _aeGoTo(%s); _almClockSetRate(%s); }" % (PAST, rate))
        assert (st["t"] is not None) == shows, (rate, st)
        assert st["d"] and "1969" in st["d"] and st["now"] or rate == 1, (rate, st)
        assert st["h"] <= 66, (rate, st)
    st = _chip(pg, "() => { _aeGoTo(%s); _almClockSetRate(86400); }" % PAST)
    assert st["rate"] == "1 d/s" and st["arrow"].startswith("M3"), st
    pg.evaluate("() => { _almClockSetRate(1); _aeNow(); }")


def test_now_on_the_chip_goes_back_without_opening_the_capsule(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 844})
    st = _chip(pg, "() => { _aeGoTo(%s); _almClockSetRate(3600); }" % PAST)
    assert st["now"], st
    box = pg.evaluate("() => { var r = document.querySelector('#ae-pin .alm-ck-now').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
    pg.mouse.click(box[0], box[1])
    pg.wait_for_function("() => document.querySelector('#ae-pin .alm-clock').classList.contains('alm-ck-live') && _almRate === 1", timeout=15_000)
    assert pg.evaluate("() => !document.getElementById('ae-pin').classList.contains('ae-pin-open') && _almIsLiveNow(_almFocusInstant())")
    assert not pg.errors, pg.errors


def test_the_capsule_opens_and_shuts_in_180_ms_and_not_at_all_under_reduced_motion(three_d):
    pg = three_d
    pg.evaluate("() => { window._almReduceMotion = function () { return false; }; _aePinSet(true); }")
    assert pg.evaluate("() => document.getElementById('ae-pin').classList.contains('ae-pin-growing')")
    pg.wait_for_function("() => !document.getElementById('ae-pin').classList.contains('ae-pin-growing')", timeout=2000)
    pg.keyboard.press("Escape")   # Escape shuts it
    pg.wait_for_function("() => !document.getElementById('ae-pin').classList.contains('ae-pin-open')", timeout=3000)
    pg.evaluate("() => { window._almReduceMotion = function () { return true; }; _aePinSet(true); }")
    assert pg.evaluate("() => { var p = document.getElementById('ae-pin'); return p.classList.contains('ae-pin-open') && !p.classList.contains('ae-pin-growing'); }")
    pg.evaluate("() => { _aePinSet(false); delete window._almReduceMotion; }")


@pytest.mark.parametrize("width", [375, 390])
@pytest.mark.parametrize("lang", ["en", "de", "fr", "pt", "ru", "ar"])
def test_the_chip_fits_between_the_circles_in_the_longest_languages_on_one_line_or_two(no_map, width, lang):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport={"width": width, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script("try { localStorage.setItem('zimi_ui_lang', %r); localStorage.setItem('zimi_almanac_place', %r); localStorage.setItem('zimi_cap', 'full'); } catch (e) {}" % (lang, LA))
            pg = ctx.new_page()
            pg.goto(no_map + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function'", timeout=120_000)
            _open_3d(pg)
            for js in ("() => { _aeGoTo(%s); _almClockSetRate(-3600); }" % PAST, "() => { _almClockSetRate(86400); }", "() => { _almClockSetRate(0); }"):
                st = _chip(pg, js)
                assert st["h"] <= 66 and st["clear"] and st["fits"] and st["now"], (lang, width, js, st)   # never more than two lines, never under a circle, never clipped
        finally:
            br.close()


@pytest.mark.parametrize("width", [375, 390])
def test_the_top_bar_is_back_the_time_chip_and_the_surface_space_button_and_nothing_else(three_d, width):
    pg = three_d
    pg.set_viewport_size({"width": width, "height": 844})
    pg.wait_for_timeout(500)
    got = pg.evaluate(
        """() => Array.from(document.querySelectorAll('#ae-view button, #ae-view .alm-pin-clock')).filter(e => { var r = e.getBoundingClientRect(), c = getComputedStyle(e); return r.width > 4 && r.top < 70 && r.bottom > 0 && c.visibility !== 'hidden' && c.display !== 'none' && +c.opacity > 0.1; })
          .map(e => e.id || e.className.split(' ')[0]).filter((v, i, a) => a.indexOf(v) === i)"""
    )
    assert sorted(got) == ["ae-back", "ae-clock", "ae-fly-btn"], got   # back, the time chip and the UFO (ae-clock is the time chip)
    pg.evaluate("() => _aePreset('jupiter')")   # a gas giant: no surface: the surface/space button is not there
    pg.wait_for_function("() => !_ae.fly && _ae.target === 'jupiter'", timeout=90_000, polling=200)
    pg.wait_for_timeout(500)
    assert pg.evaluate("() => !document.getElementById('ae-rim').hidden"), "a gas giant has no ground, but the button still takes the UFO down to its cloud tops (81c971468)"
    pg.evaluate("() => _aePreset('moon')")
    pg.wait_for_function("() => !_ae.fly && _ae.target === 'moon' && !document.getElementById('ae-rim').hidden", timeout=90_000, polling=200)
    box = pg.evaluate("() => { const r = document.getElementById('ae-rim').getBoundingClientRect(); return [innerWidth - r.right, innerHeight - r.bottom]; }")
    assert box[0] < 24 and box[1] < 24, box   # bottom right


def test_search_is_the_strips_first_disc_the_sheet_opens_from_the_bottom_in_glass_and_the_lit_world_opens_its_sheet(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 844})
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-go", state="visible")
    got = pg.evaluate(
        """() => { var s = document.getElementById('ae-go'), c = getComputedStyle(s), r = s.getBoundingClientRect(), f = document.getElementById('ae-go-q').getBoundingClientRect();
          return { bottom: innerHeight - r.bottom, top: r.top, radius: c.borderTopLeftRadius, blur: c.backdropFilter || c.webkitBackdropFilter, edge: c.borderTopColor, field: f.top >= r.top && f.bottom <= r.bottom, focus: document.activeElement.id }; }"""
    )
    assert got["bottom"] < 80 and got["top"] > 100 and got["radius"] == "22px" and "blur" in got["blur"] and got["field"] and got["focus"] != "ae-go-q", got   # no keyboard on open (a finger raises it); the bottom sheet, the chip's radius language and glass edge
    pg.evaluate("() => _aeShowGo(false)")
    assert pg.evaluate("() => (_aeHudInfoPaint(true), document.querySelector('#ah-info b').textContent)") == "Earth"   # where I am, always in view, bottom left


def test_a_reload_into_the_satellites_view_is_held_black_until_the_view_is_up_and_draws_at_the_canvas_aspect(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 844})
    pg.evaluate("() => _aePreset('sats')")
    pg.wait_for_function("() => !_ae.fly && _ae.target === 'earth'", timeout=90_000, polling=200)
    pg.wait_for_timeout(1500)
    pg.reload(wait_until="commit")
    seen = []
    for _ in range(60):
        try:
            seen.append(pg.evaluate("""() => { var c = document.getElementById('ae-canvas'), open = typeof _aeIsOpen !== 'undefined' && _aeIsOpen, home = document.getElementById('almanac-view');
              return { held: document.documentElement.classList.contains('alm-3d-boot'), open: open, shown: !!home && getComputedStyle(home).visibility !== 'hidden',
                aspect: open && _ae.gl ? [_ae.gl.camera.aspect, c.clientWidth && c.clientWidth / c.clientHeight] : null }; }"""))
        except Exception:
            pass
        pg.wait_for_timeout(100)
        if seen and seen[-1]["open"] and seen[-1]["aspect"] and seen[-1]["aspect"][1]:
            break
    # never the Almanac's own page shown before the view is up
    assert all((not s["shown"]) or s["open"] or not s["held"] for s in seen), seen
    last = seen[-1]
    assert last["open"] and last["aspect"] and abs(last["aspect"][0] - last["aspect"][1]) < 0.01, last   # the first drawn frame is at the canvas's own shape
    pg.wait_for_timeout(1500)
    again = pg.evaluate("() => { var c = document.getElementById('ae-canvas'); return [_ae.gl.camera.aspect, c.clientWidth / c.clientHeight, _aeIsOpen, _ae.preset]; }")
    assert abs(again[0] - again[1]) < 0.01 and again[2] and again[3] == "sats", again


SHEET_OPENERS = {
    "go": "() => _aeShowGo(true)",
    "set": "() => _aeShowSettings(true)",
    "info": "() => _aeOpenInfo('earth')",
    "card": "() => { _ae.place = { kind: 'landmark', name: 'Mount Everest', label: 'Mount Everest', lat: 27.99, lon: 86.93, article: null }; _aeRenderCard(); }",
}


def test_only_one_sheet_is_up_at_a_time_whichever_pair_is_opened(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 844})
    ups = "() => Object.keys(AE_SHEETS).filter(k => AE_SHEETS[k].up())"
    want = lambda k: ["go", "set"] if k == "set" else [k]   # the settings are a drawer under the sheet's band
    for first in SHEET_OPENERS:
        for second in SHEET_OPENERS:
            if first == second:
                continue
            pg.evaluate("() => { Object.keys(AE_SHEETS).forEach(k => { if (AE_SHEETS[k].up()) AE_SHEETS[k].close(); }); }")
            pg.evaluate(SHEET_OPENERS[first])
            pg.wait_for_timeout(120)
            assert pg.evaluate(ups) == want(first), (first, pg.evaluate(ups))
            pg.evaluate(SHEET_OPENERS[second])
            pg.wait_for_timeout(120)
            assert pg.evaluate(ups) == want(second), (first, second, pg.evaluate(ups))   # the one just opened; the first has gone
    pg.evaluate("() => { Object.keys(AE_SHEETS).forEach(k => { if (AE_SHEETS[k].up()) AE_SHEETS[k].close(); }); }")


def test_the_row_is_one_scrolling_strip_of_every_world_with_the_moons_of_the_world_in_view_only(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 390, "height": 690})
    worlds = ["sun", "mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"]
    chips = "() => Array.from(document.querySelectorAll('#ae-chips [data-ae-view]')).map(b => [b.getAttribute('data-ae-view'), b.classList.contains('ae-disc-moon')])"
    for start in ("mercury", "neptune"):
        pg.evaluate("(k) => _aePreset(k)", start)
        pg.wait_for_function("(k) => !_ae.fly && _ae.target === k && !!document.querySelector('#ae-chips [aria-current=true]')", arg=start, timeout=120_000)
        keys = [c[0] for c in pg.evaluate(chips)]
        assert [k for k in keys if k in worlds] == worlds, (start, keys)   # every world in order from the Sun, whichever is lit
        assert pg.evaluate("() => !document.querySelector('#ae-chips [data-ae-find]') && document.getElementById('ae-find').getBoundingClientRect().right <= document.getElementById('ae-chips').getBoundingClientRect().left"), "search stands before the track, not in it"
        for w in worlds:   # each one can be scrolled to and tapped
            hit = pg.evaluate(
                """(w) => { var c = document.getElementById('ae-chips'), b = c.querySelector('[data-ae-view="' + w + '"]'); c.scrollLeft = b.offsetLeft - 16; var r = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
                  return r.left >= cr.left - 1 && r.right <= cr.right + 1 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; }""", w)
            assert hit, (start, w, "reachable by scrolling")
    pg.evaluate("() => _aePreset('jupiter')")
    pg.wait_for_function("() => !_ae.fly && _ae.target === 'jupiter'", timeout=120_000)
    got = pg.evaluate(chips)
    moons = [c[0] for c in got if c[1]]
    assert moons and len(moons) >= 4 and [c[0] for c in got].index(moons[0]) == [c[0] for c in got].index("jupiter") + 1, got   # right after Jupiter, smaller
    pg.evaluate("() => _aePreset('mars')")
    pg.wait_for_function("() => !_ae.fly && _ae.target === 'mars'", timeout=120_000)
    got2 = pg.evaluate(chips)
    assert not any(c[0] in moons for c in got2) and all(w in [c[0] for c in got2] for w in worlds), got2   # Jupiter's moons are gone (Mars's are there)
    assert not pg.errors, pg.errors


def test_the_grid_has_the_labelled_first_row_and_sent_from_earth_as_model_tiles_with_shared_models_once(three_d):
    pg = three_d
    pg.click("#ae-find")
    pg.click("[data-ae-gomode=grid]")
    pg.wait_for_selector("#ae-go-top .ae-go-top3", state="visible", timeout=30_000)
    cells = pg.evaluate("() => Array.from(document.querySelectorAll('#ae-go-top .ae-go-top3 .ae-go-cell')).map(b => [b.getAttribute('data-ae-go'), b.textContent.trim()])")
    assert [c[0] for c in cells] == ["sun", "planets", "spin"], cells
    pg.wait_for_function("() => !!_aeSent && !!document.querySelector('#ae-go-groups .ae-sent-tile')", timeout=60_000)
    got = pg.evaluate(
        """() => { var tiles = Array.from(document.querySelectorAll('#ae-go-groups .ae-sent-tile')), models = {}, dup = 0;
          tiles.forEach(t => { var o = _aeSent.byId[t.hasAttribute('data-ae-go') ? t.getAttribute('data-ae-go').slice(5) : t.getAttribute('data-ae-choose').split(',')[0]]; var k = o.model || o.id; var sec = t.previousElementSibling; if (models[k + '|' + (t.parentElement.previousElementSibling && t.parentElement.previousElementSibling.getAttribute('data-g'))]) dup++; models[k + '|' + (t.parentElement.previousElementSibling && t.parentElement.previousElementSibling.getAttribute('data-g'))] = 1; });
          var shared = tiles.map(t => t.textContent.trim()).filter(x => /\d, \d/.test(x));
          return { n: tiles.length, dup: dup, shared: shared.slice(0, 3), heads: Array.from(document.querySelectorAll('#ae-go-groups .ae-sent-h b')).map(b => +b.textContent), hasPlan: /Plan a flight/.test(document.getElementById('ae-go-groups').innerText) }; }"""
    )
    assert got["n"] > 20 and got["dup"] == 0 and not got["hasPlan"], got   # a model once per place
    assert got["shared"], ("a shared model is one tile with its missions beside it", got)
    assert sum(got["heads"]) >= got["n"], got   # each place says how many
    assert not pg.errors, pg.errors


def test_a_tile_of_several_lists_them_to_choose_which(three_d):
    pg = three_d
    pg.click("#ae-find")
    pg.click("[data-ae-gomode=grid]")
    pg.wait_for_function("() => !!_aeSent && !!document.querySelector('#ae-go-groups .ae-sent-tile[data-ae-choose]')", timeout=60_000)
    tile = pg.locator("#ae-go-groups .ae-sent-tile[data-ae-choose]").first
    ids = tile.get_attribute("data-ae-choose").split(",")
    assert len(ids) > 1, ids
    tile.scroll_into_view_if_needed()
    tile.click()
    rows = pg.evaluate("() => Array.from(document.querySelectorAll('.ae-sent-choose [data-ae-go]')).map(b => b.getAttribute('data-ae-go').slice(5))")
    assert rows == ids, (rows, ids)   # one row each, in the tile's order: the one wanted is a tap away
    assert tile.get_attribute("aria-expanded") == "true"
    tile.click()
    assert pg.locator(".ae-sent-choose").count() == 0, "a second tap closes the list"
    assert not pg.errors, pg.errors


@pytest.mark.parametrize("size", [(390, 690), (844, 390)])
@pytest.mark.parametrize("world", ["earth", "moon", "sun", "jupiter"])
def test_every_control_is_a_finger_and_inside_the_screen_and_no_two_top_controls_cross_in_every_orbit_view(three_d, size, world):
    from hit_area import top_overlaps, undersized

    pg = three_d
    pg.set_viewport_size({"width": size[0], "height": size[1]})
    pg.evaluate("(w) => _aePreset(w)", world)
    pg.wait_for_function("(w) => !_ae.fly && _ae.target === w", arg=world, timeout=120_000)
    pg.wait_for_timeout(1200)
    import re

    short = undersized(pg, skip=".topbar, .ep, .ae-lm", noscroll=True)
    short = [x for x in short if not ("ae-disc" in x and int(re.search(r" (\d+)x\d+ ", x).group(1)) < 40)]   # (a disc cut by the strip's edge shows less than its own 40 px: it is not a target until scrolled in, and Io is such a disc at Jupiter)
    assert not short, "%s %s: %s" % (world, size, "; ".join(short))
    crossed = top_overlaps(pg)
    assert not crossed, "%s %s: %s" % (world, size, "; ".join(crossed))
    outside = pg.evaluate(
        """() => Array.from(document.querySelectorAll('#ae-view button, #ae-view .ae-pin')).filter(e => { var r = e.getBoundingClientRect(), c = getComputedStyle(e);
          return r.width > 0 && c.visibility !== 'hidden' && !e.closest('#ae-chips') && (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1); }).map(e => e.id || e.className)"""
    )
    assert not outside, "%s %s: outside the screen: %s" % (world, size, outside)
    assert not pg.errors, pg.errors


def test_a_spinner_shows_at_the_where_line_only_after_tiles_have_loaded_over_half_a_second(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.evaluate("() => { window.__busy = false; window._aeTilesBusy = () => window.__busy; }")   # (the signal driven by hand: tiles loading or not)
    cls = "() => { _aeWherePaint(); return document.getElementById('ah-info').classList.contains('ae-loading'); }"
    pg.evaluate("() => { window.__busy = true; }")
    assert not pg.evaluate(cls), "not at once"
    pg.wait_for_timeout(700)
    assert pg.evaluate(cls), "after half a second of loading"
    assert pg.evaluate("() => /\\S/.test(document.getElementById('ah-info').textContent) && !/loading|sharpen/i.test(document.getElementById('ah-info').textContent)"), "no words"
    pg.evaluate("() => { window.__busy = false; }")
    assert not pg.evaluate(cls), "gone when the tiles are in"
    assert not pg.errors, pg.errors


def test_no_tile_spins_or_is_asked_for_while_the_server_is_out_of_reach(three_d):
    """Offline, or a tile fetch that got no answer at all: the tiles wait (no spinner, nothing fetched) until the browser is
    online again or a doubling wait has passed; a tile the server answered 404 is only that tile."""
    pg = three_d
    ctx = pg.context
    pg.evaluate(
        "() => { window.__hd0 = _ae.gl.hd; _ae.gl.hd = { man: {}, bodies: [], queue: [], loading: 3, gpu: 0, frame: 0, fresh: [], budget: 0 }; }"
    )
    busy = "() => _aeTilesBusy()"
    assert pg.evaluate(busy), "tiles in flight spin"
    pg.evaluate("() => _aeHdUnreachable(_ae.gl.hd)")
    assert not pg.evaluate(busy), "no answer from the server: no spinner"
    assert pg.evaluate("() => _aeHdAway(_ae.gl.hd) && _ae.gl.hd.away === AE_HD_RETRY_MS"), "waits, then tries again"
    pg.evaluate("() => _aeHdUnreachable(_ae.gl.hd)")
    assert pg.evaluate("() => _ae.gl.hd.away === AE_HD_RETRY_MS"), "a burst of failures inside the wait is one wait"
    pg.evaluate("() => { _ae.gl.hd.waitUntil = 0; _aeHdUnreachable(_ae.gl.hd); }")
    assert pg.evaluate("() => _ae.gl.hd.away === 2 * AE_HD_RETRY_MS"), "a failure after the wait doubles it"
    pg.evaluate("() => { _ae.gl.hd.waitUntil = 0; _ae.gl.hd.away = 0; }")
    ctx.set_offline(True)
    pg.wait_for_function("() => navigator.onLine === false", timeout=10_000)
    assert not pg.evaluate(busy), "offline: no spinner"
    pg.evaluate("() => { _ae.gl.hd.queue = [{ seen: 1e9, pri: 0, n: { tex: {} }, m: { layer: 'x' } }]; _ae.gl.hd.loading = 0; _aeHdPump(_ae.gl); }")
    assert pg.evaluate("() => _ae.gl.hd.loading === 0 && _ae.gl.hd.queue.length === 1"), "offline: nothing is fetched"
    pg.evaluate("() => { _ae.gl.hd.queue = []; _ae.gl.hd.loading = 3; _aeHdUnreachable(_ae.gl.hd); }")
    ctx.set_offline(False)
    pg.wait_for_function("() => navigator.onLine === true && !_aeHdAway(_ae.gl.hd)", timeout=10_000)
    assert pg.evaluate(busy), "back online: the wait is over at once"
    pg.evaluate("() => { _ae.gl.hd = window.__hd0; }")
    assert not pg.errors, pg.errors


def test_the_row_stands_at_the_start_search_first_and_the_rim_button_is_a_disc_at_the_bottom_right(three_d):
    """The discs stand left in the strip (the search disc first); the surface/space button is a 44 circle at the bottom right."""
    pg = three_d
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly && !document.getElementById('ae-rim').hidden", timeout=60_000)
    got = pg.evaluate(
        """() => { var f = document.getElementById('ae-find').getBoundingClientRect(), d = document.querySelector('#ae-chips .ae-disc').getBoundingClientRect(), r = document.getElementById('ae-rim').getBoundingClientRect();
          return { findFirst: f.right <= document.getElementById('ae-chips').getBoundingClientRect().left, w: d.width, rw: r.width, rh: r.height, rimRight: innerWidth - r.right, rimBottom: innerHeight - r.bottom }; }"""
    )
    assert got["findFirst"] and got["w"] == 40 and got["rw"] == 44 and got["rh"] == 44 and got["rimRight"] < 24 and got["rimBottom"] < 24, got


def test_a_registered_mode_leaves_by_the_rim_and_escape_and_owns_the_camera_button(three_d):
    pg = three_d
    pg.evaluate(
        "() => { window.__m = { on: true, out: 0, cam: 0 };"
        " _aeRimRegister({ leave: function () { return __m.on ? { label: 'Land', svg: AE_RIM_GROUND_SVG, run: function () { __m.on = false; __m.out++; } } : null; } });"
        " _aeCamRegister({ active: function () { return __m.on; }, label: 'Camera', svg: AE_RIM_SPACE_SVG, run: function () { __m.cam++; } }); _aeRimSync(true); }"
    )
    pg.wait_for_function("() => !document.getElementById('ae-cam').hidden", timeout=30_000)
    pos = pg.evaluate(
        "() => { var a = document.getElementById('ae-cam').getBoundingClientRect(), b = document.getElementById('ae-rim').getBoundingClientRect(); return { camRight: a.right, rimLeft: b.left, rimTop: b.top, size: [a.width, a.height] }; }"
    )
    assert pos["rimTop"] > 600 and pos["camRight"] <= pos["rimLeft"] and pos["size"] == [44, 44], pos   # the surface/space button is bottom right; the mode's camera button is a smaller glyph in the row to its left
    pg.click("#ae-cam")
    assert pg.evaluate("() => __m.cam") == 1
    assert pg.get_attribute("#ae-rim", "aria-label") == "Land"
    pg.focus("#ae-canvas")
    pg.keyboard.press("Escape")  # one level back: out of the mode, the view stays open
    pg.wait_for_function("() => __m.out === 1", timeout=10_000)
    assert pg.evaluate("() => _aeIsOpen")
    pg.wait_for_function("() => document.getElementById('ae-cam').hidden", timeout=10_000)
    assert not pg.errors, pg.errors


def test_w_a_s_d_while_just_looking_is_the_rim_button(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.wait_for_function("() => !document.getElementById('ae-rim').hidden && document.getElementById('ae-rim').getAttribute('aria-label') === 'Stand here'", timeout=30_000)
    pg.focus("#ae-canvas")
    pg.keyboard.press("w")
    pg.wait_for_function("() => !!_ae.stand || !!_ae.standPending", timeout=60_000, polling=250)
    assert not pg.errors, pg.errors


def test_the_sky_cards_stand_here_and_the_rim_land_on_the_same_ground(three_d):
    """The card's button and the 3D view's rim each lead to the one ground (almanac-stand.js): the card at
    the Almanac's place by its hand-off (_osStandHere into _aeStandOpen), the rim at the middle of the picture (_aeStandAt)."""
    pg = three_d
    figs = pg.evaluate(
        "() => ({ card: (document.querySelector('.alm-sky-stand svg') || {}).innerHTML, rim: ((document.getElementById('ae-rim') || {}).innerHTML || '') })"
    )
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly && !document.getElementById('ae-rim').hidden", timeout=60_000)
    rim = pg.evaluate("() => document.getElementById('ae-rim').innerHTML")
    norm = lambda s: "".join((s or "").split())  # noqa: E731
    assert figs["card"] and "ae-rim-glyph" in rim and norm(rim).count("<path") == 1, (figs, rim)   # the card's figure stands; the rim is the arc and dot
    # The card's way.
    assert pg.evaluate("() => _osStandHere()") is True
    pg.wait_for_function("() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'", timeout=GROUND_MS, polling=250)
    from_card = pg.evaluate("() => ({ key: _ae.stand.key, near: Math.abs(_ae.stand.lat - 34.05) < 0.5 && Math.abs(_ae.stand.lon + 118.24) < 0.5 })")
    pg.click("#ae-rim")  # leave: the same button
    pg.wait_for_function("() => !_ae.stand && !_ae.standPending && !_ae.fly", timeout=60_000, polling=250)
    pg.wait_for_function("() => document.getElementById('ae-rim').dataset.kind === 'enter'", timeout=30_000)
    # The rim's way.
    pg.click("#ae-rim")
    pg.wait_for_function("() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'", timeout=GROUND_MS, polling=250)
    from_rim = pg.evaluate("() => ({ key: _ae.stand.key })")
    assert from_card["key"] == from_rim["key"] == "earth" and from_card["near"], (from_card, from_rim)
    assert not pg.errors, pg.errors


# ── One top for each mode ──
@pytest.mark.parametrize("size", [(390, 844), (1280, 800)])
def test_no_two_top_controls_cross_while_looking_or_standing(three_d, size):
    from hit_area import top_overlaps

    pg = three_d
    pg.set_viewport_size({"width": size[0], "height": size[1]})
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.wait_for_timeout(800)
    assert top_overlaps(pg) == [], "looking"
    _stand_up(pg)
    pg.wait_for_timeout(1500)
    assert top_overlaps(pg) == [], "standing"
    # The ground's own controls stand under the strip, not over it (the layer they are in spans the view, and takes no touch).
    got = pg.evaluate("() => ({ pin: document.getElementById('ae-pin').getBoundingClientRect().bottom, hud: Math.min.apply(null, Array.from(document.querySelectorAll('.ae-stand-hud button')).filter(b => b.offsetParent).map(b => b.getBoundingClientRect().top).concat([9999])) })")
    assert got["hud"] >= got["pin"] - 1, got
    assert not pg.errors, pg.errors


def _touches(cdp, kind, *pts):
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i + 1} for i, (x, y) in enumerate(pts)]})


def test_two_fingers_turning_roll_the_view_about_the_line_of_sight_and_a_pinch_does_not(three_d):
    """Two fingers rotating turn the picture with them, any way up, without moving the distance; a pure pinch spreads the distance and rolls nothing."""
    import math

    pg = three_d
    pg.evaluate("() => { _aeNow(); _aePreset('earth'); }")
    pg.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    pg.wait_for_timeout(600)
    cdp = pg.context.new_cdp_session(pg)
    cx, cy, r = 195, 170, 60   # (in the sky above the Earth: a landmark's label under a finger takes it)

    def pole_angle():   # where the Earth's north pole points on the screen, degrees clockwise from straight up
        return pg.evaluate(
            "() => { var a = _aeProject([0, 0, 0]), b = _aeProject([0, 0, 1.3]); return Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI; }"
        )

    base = pg.evaluate("() => ({ dist: _ae.dist, twist: _ae.twist || 0 })")
    a0 = pole_angle()
    # fingers turn 50 degrees clockwise on the screen, the same spread
    def at(deg):
        t = math.radians(deg)
        return (cx + r * math.cos(t), cy + r * math.sin(t)), (cx - r * math.cos(t), cy - r * math.sin(t))

    _touches(cdp, "touchStart", at(0)[0])   # one finger down, then the second
    _touches(cdp, "touchStart", *at(0))
    for deg in range(5, 55, 5):
        _touches(cdp, "touchMove", *at(deg))
        pg.wait_for_timeout(40)
    _touches(cdp, "touchEnd")
    pg.wait_for_timeout(300)
    after = pg.evaluate("() => ({ dist: _ae.dist, twist: _ae.twist || 0 })")
    a1 = pole_angle()
    assert after["twist"] == pytest.approx(50 - 4, abs=3), after   # (the first 4 degrees are the fingers' wobble)
    assert after["dist"] == pytest.approx(base["dist"], rel=0.02), "turning is not zooming"
    turned = ((a1 - a0 + 540) % 360) - 180
    assert abs(turned - 46) < 6, ("the picture turned with the fingers (clockwise fingers, clockwise picture)", a0, a1)
    # a pinch with the fingers not turning: the distance changes, the roll does not. (Closing, a zoom out: held at the closest stop, a pinch
    # that opens goes on down to the ground since 73f481818, which is a landing, not a roll.)
    _touches(cdp, "touchStart", (cx - 110, cy))
    _touches(cdp, "touchStart", (cx - 110, cy), (cx + 110, cy))
    for k in range(1, 8):
        _touches(cdp, "touchMove", (cx - 110 + 10 * k, cy), (cx + 110 - 10 * k, cy))
        pg.wait_for_timeout(40)
    _touches(cdp, "touchEnd")
    pg.wait_for_timeout(300)
    pinched = pg.evaluate("() => ({ dist: _ae.dist, twist: _ae.twist || 0 })")
    assert pinched["dist"] > after["dist"] * 1.1, ("the pinch zoomed out", after, pinched)
    assert abs(pinched["twist"] - after["twist"]) < 2.5, ("and rolled nothing", after, pinched)
    # a flight takes the picture back to the view's own
    pg.evaluate("() => _aePreset('moon')")
    pg.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    assert pg.evaluate("() => _ae.twist || 0") == 0
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    assert not pg.errors, pg.errors


@pytest.mark.parametrize("label_first", [True, False])
def test_a_finger_on_a_label_still_counts_for_a_twist_and_a_pinch(three_d, label_first):
    """A finger that lands on a label, first or second, is one of the two of a twist or a pinch (the labels take no pointer)."""
    import math

    pg = three_d
    pg.evaluate("() => { _aeNow(); _aePreset('earth'); }")
    pg.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    pg.wait_for_function("() => document.querySelectorAll('#ae-lms .ae-lm:not([hidden])').length > 2", timeout=120_000, polling=250)
    pg.wait_for_timeout(500)
    pts = pg.evaluate(
        """() => { var out = null; Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(function (b) { return !b.hidden; }).some(function (b) {
            var r = b.getBoundingClientRect(), L = [r.left + r.width / 2, r.top + r.height / 2];
            if (!b.offsetParent || L[0] < 10 || L[0] > innerWidth - 10 || L[1] < 150 || L[1] > innerHeight - 200) return false;   // (on the picture: names take no pointer)
            return [[140, 0], [-140, 0], [0, 140], [0, -140], [100, 100], [-100, -100], [100, -100], [-100, 100]].some(function (o) {
              var C = [L[0] + o[0], L[1] + o[1]], el = C[0] > 10 && C[0] < innerWidth - 10 && C[1] > 150 && C[1] < innerHeight - 200 ? document.elementFromPoint(C[0], C[1]) : null;
              if (el && el.id === 'ae-canvas') { out = { label: L, canvas: C }; return true; } return false; }); });
          return out; }"""
    )
    assert pts, "a label with open canvas beside it"
    lab, can = pts["label"], pts["canvas"]
    mid = [(lab[0] + can[0]) / 2, (lab[1] + can[1]) / 2]
    r = math.hypot(lab[0] - can[0], lab[1] - can[1]) / 2
    a0 = math.degrees(math.atan2(lab[1] - mid[1], lab[0] - mid[0]))
    cdp = pg.context.new_cdp_session(pg)

    def at(deg):   # (the label finger, the canvas finger) turned by `deg` clockwise
        t = math.radians(a0 + deg)
        return (mid[0] + r * math.cos(t), mid[1] + r * math.sin(t)), (mid[0] - r * math.cos(t), mid[1] - r * math.sin(t))

    base = pg.evaluate("() => ({ dist: _ae.dist, twist: _ae.twist || 0 })")
    first, second = (0, 1) if label_first else (1, 0)
    _touches(cdp, "touchStart", at(0)[first])
    pg.wait_for_timeout(60)
    _touches(cdp, "touchStart", *([at(0)[0], at(0)[1]] if label_first else [at(0)[1], at(0)[0]]))
    for deg in range(5, 55, 5):
        p = at(deg)
        _touches(cdp, "touchMove", *([p[0], p[1]] if label_first else [p[1], p[0]]))
        pg.wait_for_timeout(40)
    held = pg.evaluate("() => !!(_ae.pinch && _ae.pinch.hold)")
    _touches(cdp, "touchEnd")
    pg.wait_for_timeout(300)
    after = pg.evaluate("() => ({ dist: _ae.dist, twist: _ae.twist || 0, card: !!_ae.lm || !!_ae.pick })")
    # (Two fingers on the globe hold the places under them: the picture turns the whole way with them, no wobble taken off; off it, the first 4 degrees are.)
    assert after["twist"] == pytest.approx(50 if held else 50 - 4, abs=4), ("the twist counted with a finger on a label", base, after)
    # (Held, the places stay under the fingers: turned over a slanting part of the globe that is a little nearer or farther, as the places' own spacing asks.)
    assert after["dist"] == pytest.approx(base["dist"], rel=0.15 if held else 0.03)
    assert not pg.errors, pg.errors


# ── Always show where I am ──
def test_the_world_is_named_top_centre_where_the_strip_is_not_and_the_pill_stays_whole(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('mars')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    got = pg.evaluate(
        """() => { var c = document.getElementById('ae-chips'); c.scrollLeft = c.scrollWidth; var f = document.getElementById('ae-find').getBoundingClientRect(),
        r = document.getElementById('ae-views').getBoundingClientRect(); return { pillInside: f.right <= r.left + 0.5, name: (_aeHudInfoPaint(true), document.querySelector('#ah-info b').textContent) }; }"""
    )
    assert got["pillInside"] and got["name"], got
    shown = pg.evaluate("""() => { var n = document.querySelector('#ah-info b'), r = n.getBoundingClientRect(); return [getComputedStyle(n).display !== 'none', r.left < innerWidth / 2 && r.top > innerHeight / 2, n.textContent.length > 0]; }""")
    assert shown == [True, True, True], shown
    assert not pg.errors, pg.errors


def test_search_lists_each_name_once(three_d):
    pg = three_d
    pg.wait_for_function("() => typeof _aeGoFind === 'function' && _aeLm", timeout=90_000)
    pg.evaluate("() => _aeShowGo(true)")
    got = pg.evaluate(
        """() => ['apollo', 'apollo 11'].map(q => { var i = document.getElementById('ae-go-q'); i.value = q; _aeGoRender();
        return [q, [].map.call(document.querySelectorAll('#ae-go-groups .ae-go-row span:not(.ae-go-thumb)'), e => e.textContent)]; })"""
    )
    for q, names in got:
        low = [x.lower() for x in names if x]   # (the rows' glyph spans carry no text, 27c896cda)
        assert len(low) == len(set(low)), (q, names)
    assert any("\u00b7" in x for x in got[1][1]), got
    assert not pg.errors, pg.errors


def test_the_minimap_opens_the_solar_system_with_a_side_by_side_offer_and_the_sheet_leads_with_them(three_d):
    pg = three_d
    pg.tap("#ae-find")
    pg.wait_for_selector("#ae-go-top .ae-go-top3", state="visible")
    got = pg.evaluate("() => { var t = document.querySelector('#ae-go-top').getBoundingClientRect(), g = document.getElementById('ae-go').getBoundingClientRect(); return { inside: t.bottom <= g.bottom && t.top >= g.top, kb: document.activeElement.id === 'ae-go-q' }; }")
    assert got == {"inside": True, "kb": False}, got   # Solar system and Side by side are on screen the moment the sheet opens, and no keyboard
    pg.evaluate("() => _aeShowGo(false)")
    pg.tap("#ae-mini")
    pg.wait_for_function("() => _ae.preset === 'planets' && !_ae.fly", timeout=60_000)
    assert pg.evaluate("() => (_aeHudInfoPaint(true), document.getElementById('ah-info').hidden)")   # the planets page says nothing bottom left: its picture is its name
    pg.tap("#ae-sbs")
    pg.wait_for_function("() => !!_ae.spin", timeout=60_000)
    assert not pg.errors, pg.errors


def test_dragging_the_mission_slider_through_the_landing_does_not_take_the_mission_away(three_d):
    pg = three_d
    pg.evaluate("() => _aeMissionStart('apollo11')")
    pg.wait_for_function("() => _ae.mission && _ae.mission.id === 'apollo11' && _ae.mission.t !== undefined", timeout=GROUND_MS)
    pg.wait_for_timeout(1500)
    pg.evaluate("() => { window.__handoffs = 0; const was = _amHandoff; _amHandoff = function () { window.__handoffs++; return was.apply(this, arguments); }; }")
    pg.evaluate("() => { const m = _amMission(), i = m.phases.findIndex(p => p.k === m.handoff.phase); _ae.mission.noHandoff = false; _amScrubTo(m, m.phases[i].t + 5); _amPhaseChanged(m, i); }")   # a drag reaches the hand-off's phase
    pg.wait_for_timeout(1500)
    assert pg.evaluate("() => window.__handoffs") == 0, "a drag does not hand the mission over to the site visit"
    pg.wait_for_timeout(1000)   # (the hold is over: playing into the phase hands over as before)
    pg.evaluate("() => { const m = _amMission(), i = m.phases.findIndex(p => p.k === m.handoff.phase); _ae.mission.noHandoff = false; _amPhaseChanged(m, i); }")
    pg.wait_for_function("() => window.__handoffs === 1", timeout=5000)
    assert not pg.errors, pg.errors


def test_scrubbing_away_while_the_hand_off_waits_for_the_site_cancels_it(three_d):
    pg = three_d
    pg.evaluate("() => _aeMissionStart('apollo11')")
    pg.wait_for_function("() => _ae.mission && _ae.mission.id === 'apollo11' && _ae.mission.t !== undefined", timeout=GROUND_MS)
    pg.wait_for_timeout(1500)
    pg.evaluate(
        "() => { window.__visits = 0; window._aeSitesLoad = () => {}; window._aeLmLoad = () => {}; window._asData = {}; window._asDefFor = () => null;"
        " window._amLandingRow = () => [0]; window._aeSiteVisit = () => { window.__visits++; }; window._amBackChip = () => {};"   # (the site's rows arrive after the first poll, as on a slow device)
        " const m = _amMission(), i = m.phases.findIndex(p => p.k === m.handoff.phase); window._amMission = () => m; const row = window._amLandingRow; window._amLandingRow = () => null;"
        " _amHandoff(m, i); _amScrubTo(m, 60); window._amLandingRow = row; }"
    )   # playing into touchdown starts the hand-off; a drag to the launch follows before the site's rows are in
    pg.wait_for_timeout(3000)
    assert pg.evaluate("() => window.__visits") == 0, "the mission was not taken to the site after the user scrubbed away"
    assert not pg.errors, pg.errors


def test_a_moon_is_named_only_in_its_own_planets_view(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('mars')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.wait_for_timeout(2000)
    shown = pg.evaluate("() => AE_MARKED.map(m => m.body).filter(b => { const e = document.getElementById('ae-bm-' + b), p = _aePlanetBody(b); return e && !e.hidden && p && p.parent && p.parent !== 'mars'; })")
    assert shown == [], shown   # no Callisto or Io beside Mars
    assert not pg.errors, pg.errors


def test_a_walk_is_a_persons_true_pace_and_pushing_past_the_ring_runs_time_not_a_faster_person(three_d):
    pg = three_d
    pg.evaluate("() => _aeStandReady()")   # (the ground's script is loaded on first use)
    got = pg.evaluate(
        "() => { const w = { keys: {}, hop: false, jump: 0, vz: 0 }, a = _aeWalkPlan(w, { x: 0, y: 1 }, false, 0, 1, 'earth'), b = _aeWalkPlan(w, { x: 0, y: 1 }, true, 0, 1, 'earth'); return [a.dy, b.dy, AE_WALK_FAST_RATE]; }"
    )
    assert abs(got[0] - 1.4) < 1e-6, got   # 5 km/h
    assert abs(got[1] - 1.4 * got[2]) < 1e-6 and got[2] >= 5, got   # past the ring: time forward at the drive's own fast rate, not a person running 10 km/h
    assert not pg.errors, pg.errors


def test_a_tapped_spot_replaces_you_and_any_tap_away_puts_it_away_without_moving_it(three_d):
    pg = three_d
    pg.evaluate("() => _aeStandReady()")
    pg.evaluate("() => { _ae.you = { lat: 34.05, lon: -118.24 }; _aeFlyTo('earth', _aeFitDist(AE_FIT_EARTH), _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(34.05, -118.24), _ae.scene.gast))); }")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.wait_for_timeout(1000)
    w, h = pg.evaluate("() => [_ae.w, _ae.h]")
    state = "() => [!!_ae.pick, !document.getElementById('ae-lbl-you').hidden]"
    assert pg.evaluate(state) == [False, True]   # You, to start
    pg.evaluate("(p) => _aeStandPick('earth', p[0], p[1])", [w * 0.5, h * 0.55])
    pg.wait_for_timeout(600)
    assert pg.evaluate(state) == [True, False], "a tapped spot replaces You as the marker"
    at = pg.evaluate("() => [_ae.pick.lat, _ae.pick.lon]")
    pg.evaluate("(p) => _aeStandPick('earth', p[0], p[1])", [w * 0.4, h * 0.5])   # a tap away, on the planet
    pg.wait_for_timeout(600)
    assert pg.evaluate(state) == [False, True], "it is put away, not moved"
    pg.evaluate("(p) => _aeStandPick('earth', p[0], p[1])", [w * 0.4, h * 0.5])   # the next tap picks a new spot
    assert pg.evaluate("() => !!_ae.pick")
    assert not pg.errors, pg.errors


def test_a_drag_that_starts_on_a_label_turns_the_globe_and_a_tap_opens_it(three_d):
    page = three_d
    """a drag that starts on a label turns the body exactly as one started on the body would; a tap (no movement past the
    slop) still opens the label, the place it named as it was pressed; Enter on a focused label opens it too."""
    page.evaluate("() => { _aeLmSetLayer(true); _ae.lm = null; _aeRenderCard(); }")
    page.wait_for_function("() => document.querySelectorAll('#ae-lms .ae-lm:not([hidden])').length > 2", timeout=60_000, polling=200)
    page.wait_for_timeout(500)
    lb = "() => { var b = Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(x => !x.hidden && x.offsetParent)[0]; var q = b.getBoundingClientRect(); return [q.left + 12, q.top + q.height / 2, b.textContent]; }"
    x, y, name = page.evaluate(lb)
    az0 = page.evaluate("() => _ae.az")
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(8):
        page.mouse.move(x + 12 * (i + 1), y)
    page.mouse.up()
    assert abs(page.evaluate("() => _ae.az") - az0) > 0.05, "the drag turned the globe"
    assert page.evaluate("() => !_ae.lm"), "and opened nothing"
    page.wait_for_timeout(300)
    x, y, name = page.evaluate(lb)
    page.mouse.click(x, y)
    page.wait_for_function("(n) => _ae.lm && _ae.lm.row && _ae.lm.row[0] === n", arg=name, timeout=10_000)
    page.evaluate("() => { _ae.lm = null; _aeRenderCard(); _aeLmSetLayer(false); }")


def test_the_date_pill_reads_over_the_brightest_thing_behind_it(three_d):
    """The Sun's glow on Mars is nearly white behind the pill: its text must still hold 4.5:1 over a white backdrop."""
    ratio = three_d.evaluate(
        """() => { var pill = document.querySelector('#ae-pin .alm-pin-clock'), txt = document.querySelector('#ae-pin .alm-ck-t');
          var num = s => s.match(/[\\d.]+/g).map(Number), bg = num(getComputedStyle(pill).backgroundColor), fg = num(getComputedStyle(txt).color);
          var a = bg.length > 3 ? bg[3] : 1, over = [0, 1, 2].map(i => bg[i] * a + 255 * (1 - a));
          var lum = c => { var v = c.map(x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }); return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
          var l1 = lum(over), l2 = lum(fg.slice(0, 3)); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); }"""
    )
    assert ratio >= 4.5, ratio


# ── The body's name carries no info glyph (the search sheet's head already has the facts button) ──
def test_the_body_name_in_the_corner_has_no_glyph_after_it(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('mars')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.wait_for_function(
        "() => { var b = document.querySelector('#ah-info > b'); return b && b.textContent.trim() === 'Mars'; }",
        timeout=30_000,
    )
    got = pg.evaluate(
        "() => getComputedStyle(document.querySelector('#ah-info > b'), '::after').content"
    )
    assert got in ("none", "normal", ""), got
    assert not pg.errors, pg.errors


# ── All satellites, from the search sheet's switch ──
SATS_ROW = "#ae-band [data-ae-layer=sats]"
SATS_CV = "#ae-band [data-ae-drawer=sats]"


def test_the_satellites_switch_follows_the_layer_and_offers_its_filters(three_d):
    pg = three_d
    pg.click("#ae-find")
    pg.wait_for_selector(SATS_ROW, timeout=30_000)
    assert pg.get_attribute(SATS_ROW, "aria-pressed") == "false"
    pg.click(SATS_ROW)
    pg.wait_for_function("() => typeof _as !== 'undefined' && _as.on && _as.state === 'ready'", timeout=120_000, polling=250)
    assert pg.get_attribute(SATS_ROW, "aria-pressed") == "true"   # it said off while the layer loaded, then showed them
    assert pg.evaluate("() => _asBarUp()") is False   # turning it on opens nothing: the filters are the chevron's
    pg.evaluate("() => { _as.barOpen = false; _asSyncBar(); }")   # put away
    pg.evaluate("() => _aeShowGo(false)")
    pg.click("#ae-find")
    pg.wait_for_selector(SATS_ROW, timeout=30_000)
    assert pg.get_attribute(SATS_ROW, "aria-pressed") == "true"
    pg.click(SATS_CV)   # the chevron after the tile: the filters
    pg.wait_for_function("() => _asBarUp()", timeout=10_000)
    assert pg.evaluate("() => _as.on") is True
    pg.click(SATS_CV)   # the chevron again puts them away
    pg.wait_for_function("() => !_asBarUp()", timeout=10_000)
    pg.click(SATS_ROW)   # on again with the filters up: the tile turns it off
    pg.wait_for_function("() => !_as.on", timeout=10_000)
    assert pg.get_attribute(SATS_ROW, "aria-pressed") == "false"
    assert not pg.errors, pg.errors


# ── The bodies strip: a planet's moons nearest first ──
def test_the_strip_lists_a_planets_moons_by_distance_from_it(three_d):
    pg = three_d
    got = pg.evaluate(
        """() => ['saturn', 'jupiter'].map(function (p) {
          _aePreset(p);
          var m = _aeMoonsOf(p);
          return { keys: _aeRowKeys().filter(function (k) { return m.some(function (x) { return x.key === k; }); }), a: m.map(function (x) { return x.orbit[0]; }) };
        })"""
    )
    for g in got:
        assert g["keys"], got
        assert g["a"] == sorted(g["a"]), got
    assert got[0]["keys"][0] == "mimas" and got[0]["keys"].index("titan") > got[0]["keys"].index("rhea"), got
    assert not pg.errors, pg.errors


def test_the_strip_fades_at_its_end_only_while_there_is_more_to_scroll(three_d):
    pg = three_d
    js = """() => { var c = document.getElementById('ae-chips');
      return { max: c.scrollWidth - c.clientWidth, out: getComputedStyle(c).getPropertyValue('--ah-out').trim(), end: c.classList.contains('ah-end') }; }"""
    pg.evaluate("() => { document.getElementById('ae-chips').scrollLeft = 0; }")
    pg.wait_for_timeout(400)
    start = pg.evaluate(js)
    assert start["max"] > 4 and not start["end"] and start["out"] == "28px", start
    pg.evaluate("() => { var c = document.getElementById('ae-chips'); c.scrollLeft = c.scrollWidth; }")
    pg.wait_for_timeout(600)
    end = pg.evaluate(js)
    assert end["end"] and end["out"] == "0px", end
    assert not pg.errors, pg.errors


# ── The body's name opens its facts from anywhere around it ──
def test_a_tap_around_the_bodys_name_opens_its_panel(three_d_still):
    """the name was hard to hit. A finger lands a little off it, on any side, and still opens the panel."""
    pg = three_d_still
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    pg.wait_for_function(
        "() => { _aeHudInfoPaint(true); var el = document.getElementById('ah-info'); return !el.hidden && el.classList.contains('ah-has-link'); }",
        timeout=30_000,
    )
    chip = pg.evaluate(
        "() => { var r = document.getElementById('ah-info').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }"
    )
    left, top, right, bottom = chip
    # a finger's slop: 12 px above, 8 off the start side, 6 off the end, 10 under
    for name, (x, y) in {
        "above": ((left + right) / 2, top - 12),
        "start": (left - 8, (top + bottom) / 2),
        "corner": (left - 8, top - 12),
        "end": (right + 6, (top + bottom) / 2),
        "below": ((left + right) / 2, bottom + 10),
    }.items():
        pg.evaluate("() => { if (_ae.info) _aeCloseInfo(true); }")
        pg.wait_for_function("() => !_ae.info", timeout=10_000)
        pg.touchscreen.tap(x, y)
        try:
            pg.wait_for_function("() => _ae.info === 'earth'", timeout=5_000)
        except Exception:
            raise AssertionError("a tap %s the name (%d, %d; chip %r) opened nothing" % (name, x, y, chip))
    assert not pg.errors, pg.errors


OPEN_ROW_JS = """() => { var q = s => document.querySelector('#ae-pin ' + s), mid = e => { var r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; },
  d = q('.alm-ck-d'), t = q('.alm-ck-t'), r = q('.alm-ck-r'), n = q('.alm-ck-now'), l = q('.alm-ck-l'), rr = l.getBoundingClientRect(), p = document.getElementById('ae-pin').getBoundingClientRect(),
  inside = e => { var b = e.getBoundingClientRect(); return b.width > 0 && b.left >= p.left - 1 && b.right <= p.right + 1; };
  return { date: d.textContent, rate: r.textContent.trim(), nowShown: !n.hidden && n.getBoundingClientRect().width > 0, sameLine: Math.abs(mid(r) - mid(n)) < 3 && Math.abs(mid(d) - mid(n)) < 8 && Math.abs(mid(t) - mid(n)) < 8,
    rateNextToNow: Math.abs(r.getBoundingClientRect().right - n.getBoundingClientRect().left) < 24, oneLine: rr.height < 60, inside: [d, t, r, n].every(inside) && l.scrollWidth <= l.clientWidth + 1 }; }"""


@pytest.mark.parametrize("size", [(390, 844), (844, 390), (1440, 900)])
def test_open_the_speed_stands_next_to_now_on_the_dates_line_and_the_weekday_shows_only_in_real_time(three_d, size):
    pg = three_d
    pg.set_viewport_size({"width": size[0], "height": size[1]})
    pg.evaluate("() => { _almClockSetRate(1); _aeNow(); _aePinSet(true); }")
    pg.wait_for_timeout(700)
    real = pg.evaluate(OPEN_ROW_JS)
    assert "," in real["date"] and real["oneLine"], real   # real time: "Sat, Nov 21, 2026", the weekday shown
    pg.evaluate("() => { _almClockSetRate(3600); }")
    pg.wait_for_timeout(700)
    run = pg.evaluate(OPEN_ROW_JS)
    assert run["rate"] == "1 h/s" and run["nowShown"], run
    assert run["sameLine"] and run["rateNextToNow"] and run["oneLine"] and run["inside"], run   # the speed beside Now, not on a line of its own, and nothing wraps or runs out of the capsule
    assert not any(w.rstrip(",") in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun") for w in run["date"].split()), run   # no weekday while time runs
    pg.evaluate("() => { _almClockSetRate(1); _aeNow(); _aePinSet(false); }")
    pg.set_viewport_size({"width": 390, "height": 844})


def test_the_collapsed_chip_drops_the_weekday_while_time_runs_and_shows_it_in_real_time(three_d):
    pg = three_d
    pg.set_viewport_size({"width": 1440, "height": 900})
    live = _chip(pg, "() => { _almClockSetRate(1); _aeNow(); }")
    assert "," in live["d"], live
    run = _chip(pg, "() => { _almClockSetRate(3600); }")
    assert not any(w.rstrip(",") in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun") for w in run["d"].split()) and run["fits"], run
    pg.evaluate("() => { _almClockSetRate(1); _aeNow(); }")
    pg.set_viewport_size({"width": 390, "height": 844})
