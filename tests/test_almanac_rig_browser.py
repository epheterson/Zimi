"""The camera rig of the 3D view across modes (almanac-fly.js, almanac-sites.js, almanac-stand.js): a craft being flown outlives
a visit that takes the camera and flies again after it; a clock that was live when a visit began is live when it ends, however long
the visit; beside a giant planet down is the planet (not a nearer moon), the way in ends level at its cloud tops, and a tap on any
world is the way there.

Run: pytest tests/test_almanac_rig_browser.py -v
"""

import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS
PLACE = '{"lat":40.71,"lon":-74.0,"name":"New York"}'
READY_MS = 300_000
STAND_MS = 240_000
LONG_VISIT_MS = (
    10 * 60 * 1000
)  # longer than the tolerance a moment is "now" by (almanac-sites.js AS_NOW_TOL_MS, two minutes)
LIVE_TOL_MS = 5000
IO_SIDE_RE = 20  # Earth radii from Io toward Jupiter: Io's surface is the nearer there, and Jupiter fills the sky
DECK_SHARE = 0.01  # almanac-fly.js AF_DECK_SHARE
LEVEL_SIN = 0.05
SHOTS = os.environ.get("ZIMI_RIG_SHOTS", "")


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("rig")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


@pytest.fixture(scope="module")
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=1,
            has_touch=True,
            is_mobile=True,
            service_workers="block",
        )
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
            % (PLACE, PLACE)
        )
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=READY_MS,
        )
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=READY_MS,
            polling=200,
        )
        pg.evaluate("() => _aeLmLoad()")
        pg.wait_for_function("() => !!_aeLm", timeout=60_000)
        yield pg
        br.close()


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def _at(pg, body):
    """The plain view of a body, nothing else going on."""
    pg.evaluate(
        "() => { if (_ae.site) _aeSiteLeave(true); if (_ae.ship || _ae.shipParked) _afStop(true); _aeNow(); }"
    )
    pg.evaluate("(b) => _aePreset(b)", body)
    pg.wait_for_function(
        "(b) => !_ae.fly && _ae.target === b", arg=body, timeout=READY_MS, polling=250
    )


def _fly(pg):
    pg.evaluate("document.getElementById('ae-fly-btn').click()")
    pg.wait_for_function(
        "() => !!_ae.ship && !!_ae.ship.craft", timeout=READY_MS, polling=100
    )


def _visit(pg, body, name):
    """The landing's card, its Visit button, and the wait until the camera stands on the ground there."""
    # A flight has no card (AH_CORNER.ufo.nocard: the foot is the levers' and the info corner's), so there the visit starts where the card's button does.
    if pg.evaluate("() => !!_ae.ship"):
        pg.evaluate(
            "([b, n]) => new Promise((ok) => _aeWhenSites(() => { _aeSiteVisit(b, _aeLm[b].filter(r => r[0] === n)[0], false); ok(); }))",
            [body, name],
        )
    else:
        pg.evaluate(
            "([b, n]) => _aeLmOpen(b, _aeLm[b].filter(r => r[0] === n)[0])",
            [body, name],
        )
        pg.wait_for_function(
            "() => !!document.getElementById('as-visit')", timeout=120_000, polling=250
        )
        pg.evaluate("document.getElementById('as-visit').click()")
    pg.wait_for_function(
        "() => { var s = _aeSiteState(); return s && s.phase === 'stand' && s.ready; }",
        timeout=STAND_MS,
        polling=500,
    )


def test_a_clock_that_was_live_is_live_again_after_a_long_visit(page):
    _at(page, "moon")
    _visit(page, "moon", "Apollo 11")
    # Ten minutes pass on the ground: the visit's own reckoning of "now" (Date.now) moves on; nothing of the visit is reached into.
    page.evaluate(
        "(ms) => { window.__now = Date.now; Date.now = function () { return window.__now() + ms; }; }",
        LONG_VISIT_MS,
    )
    try:
        page.evaluate("() => _aeSiteLeave()")
        assert not page.evaluate(
            "() => _aeFocusSet()"
        ), "the clock is held at the minute the visit began, not live"
    finally:
        page.evaluate("() => { Date.now = window.__now; }")
    off = page.evaluate("() => _aeDisplayMs() - Date.now()")
    assert abs(off) < LIVE_TOL_MS, "the clock stands %d s from now after the visit" % (
        off / 1000
    )
    page.evaluate("() => _aeNow()")


def test_a_craft_being_flown_is_parked_by_a_visit_and_flies_again_after_it(page):
    _at(page, "moon")
    _fly(page)
    _visit(page, "moon", "Apollo 11")
    assert page.evaluate(
        "() => [!!_ae.ship, !!_ae.shipParked, !!document.getElementById('af-hud')]"
    ) == [
        False,
        True,
        False,
    ], "the visit has the camera: the craft waits, its controls put away"
    _shot(page, "rig-parked-in-visit")
    page.evaluate(
        "() => _aeSiteLeave()"
    )  # every way out ends here; none of them has to bring the craft back
    page.wait_for_function(
        "() => !!_ae.ship && !!_ae.ship.craft && !_ae.shipParked",
        timeout=READY_MS,
        polling=200,
    )
    back = page.evaluate(
        "() => { const b = document.getElementById('ae-fly-btn'); return [_ae.ship.craft.root.visible, !!document.getElementById('af-hud'), b.hidden, b.getAttribute('aria-pressed')]; }"
    )
    assert back == [
        True,
        True,
        False,
        "true",
    ], back  # (whether a card over the view hides the button is the controls layer's to say)
    # The craft is in the picture where it came back (once a frame has placed the camera on it).
    page.wait_for_function(
        "() => { const s = _ae.ship && _aeProject(_ae.ship.pos); return !!s && s.x > 0.1 * _ae.w && s.x < 0.9 * _ae.w && s.y > 0.1 * _ae.h && s.y < 0.9 * _ae.h; }",
        timeout=120_000,
        polling=250,
    )
    _shot(page, "rig-flying-after-visit")
    # Leaving the craft for good is still the button: nothing wakes it afterwards.
    page.evaluate("() => _afStop()")
    page.wait_for_timeout(600)
    assert page.evaluate("() => [!!_ae.ship, !!_ae.shipParked]") == [False, False]
    assert not page.errors, page.errors


def test_beside_jupiter_down_is_jupiter_and_the_way_in_ends_level_at_its_cloud_tops(
    page,
):
    _at(page, "jupiter")
    _fly(page)
    # Between Io and Jupiter, where Io's surface is the nearer of the two (as it often is from Jupiter's own view), facing the planet.
    page.evaluate(
        """(x) => { const B = _afBodies(_ae.scene), j = _afBody(B, 'jupiter'), io = _afBody(B, 'io'), to = _aeNorm(_aeSub(j.pos, io.pos)), p = _aeAdd(io.pos, _aeScale(to, x));
          _afLinkPlace([p[0], p[1], p[2], to[0], to[1], to[2], 0]); _afAdvance(0.1); }""",
        IO_SIDE_RE,
    )
    start = page.evaluate(
        "() => [_afNearest(_afBodies(_ae.scene), _ae.ship.pos).body.key, _ae.ship.near.body.key]"
    )
    assert start == ["io", "jupiter"], start
    page.keyboard.down("c")  # down, held
    try:
        page.evaluate("() => _afAdvance(40)")
    finally:
        page.keyboard.up("c")
    end = page.evaluate(
        """() => { const s = _ae.ship, j = _afBody(_afBodies(_ae.scene), 'jupiter'), rel = _aeSub(s.pos, j.pos), d = _aeLen(rel);
          return { over: s.near.body.key, share: (d - j.r) / j.r, noseDown: -_aeDot(s.view, _aeScale(rel, 1 / d)), landing: !!s.landing, stand: !!(_ae.stand || _ae.standPending) }; }"""
    )
    assert (
        end["over"] == "jupiter" and abs(end["share"] - DECK_SHARE) < 1e-4
    ), end  # it came down to Jupiter, and stopped at the deck
    assert abs(end["noseDown"]) < LEVEL_SIN, (
        "the craft is level with the horizon at the deck",
        end,
    )
    assert (
        not end["landing"] and not end["stand"]
    ), end  # there is no ground to stand on
    page.wait_for_timeout(1500)  # frames, for the picture's own parts
    said = page.evaluate(
        "() => { const h = document.getElementById('ae-hint'); return h && !h.hidden ? h.textContent : ''; }"
    )
    assert (
        "ground" not in said.lower() and "cloud tops" not in said.lower()
    ), said  # no "no ground here" line
    assert page.evaluate(
        "() => document.getElementById('af-find').hidden"
    ), "the horizon fills the picture: nothing points the way to a world"
    assert page.evaluate(
        "() => [...document.querySelectorAll('#af-refs .af-ref')].filter(e => !e.hidden).every(e => !e.textContent.includes(_aeGoName('jupiter')))"
    ), "no tag points at the middle of the world it skims"
    _shot(page, "rig-jupiter-cloud-tops")
    assert not page.errors, page.errors


def test_from_jupiters_own_view_the_lever_alone_ends_over_its_cloud_tops_dome_up(page):
    # The way a person does it: Jupiter's view as it opens, the UFO, the lever held down. The craft starts in front of the camera, a little below the line to
    # the planet's middle, so its own up leans a few degrees toward the planet: levelling the short way round left it upside down, looking at space.
    _at(page, "jupiter")
    _fly(page)
    page.keyboard.down("c")
    try:
        page.evaluate("() => _afAdvance(60)")
        end = page.evaluate(
            """() => { const s = _ae.ship, j = _afBody(_afBodies(_ae.scene), 'jupiter'), rel = _aeSub(s.pos, j.pos), d = _aeLen(rel), away = _aeScale(rel, 1 / d);
              return { share: (d - j.r) / j.r, noseDown: -_aeDot(s.view, away), domeUp: _aeDot(s.up, away), kmS: _aeLen(s.vel) * 6378.137 }; }"""
        )
    finally:
        page.keyboard.up("c")
    assert (
        abs(end["share"] - DECK_SHARE) < 1e-4 and abs(end["noseDown"]) < LEVEL_SIN
    ), end
    assert end["domeUp"] > 0.99, (
        "the craft is the right way up over the clouds: its dome to the sky",
        end,
    )
    assert end["kmS"] < 1, ("held at the deck it stands still, and says so", end)
    page.wait_for_timeout(1500)
    seen = page.evaluate(
        """() => { const s = _ae.ship, P = s.pose, j = _afBody(_afBodies(_ae.scene), 'jupiter'), rel = _aeSub(j.pos, P.pos), d = _aeLen(rel);
          const off = Math.acos(_aeClamp(_aeDot(P.look, _aeScale(rel, 1 / d)), -1, 1)), disc = Math.asin(Math.min(1, j.r / d)), half = _aeRad(P.fov) / 2;
          return { horizonBelowMiddle: off - disc, half: half, upOnScreen: _aeDot(P.up, _aeNorm(_aeSub(s.pos, j.pos))), find: !document.getElementById('af-find').hidden }; }"""
    )
    # The horizon (the planet's limb, `off - disc` from the picture's middle) is inside the picture, the planet under it, and the sky above.
    assert (
        -seen["half"] < seen["horizonBelowMiddle"] < seen["half"]
        and seen["upOnScreen"] > 0.9
        and not seen["find"]
    ), seen
    _shot(page, "rig-jupiter-from-its-view")
    page.evaluate("() => _afStop(true)")
    assert not page.errors, page.errors


def test_a_tap_on_the_world_the_view_is_on_flies_the_craft_there(page):
    _at(page, "jupiter")
    _fly(page)
    # From well outside where the autopilot stops (the view's own distance is about there already).
    page.evaluate(
        "() => { const j = _afBody(_afBodies(_ae.scene), 'jupiter'), p = _aeAdd(j.pos, [0, 0, j.r * 30]); _afLinkPlace([p[0], p[1], p[2], 0, 0, -1, 0]); _afAdvance(0.1); _aeKick(); }"
    )
    page.wait_for_function(
        "() => { const j = _afBody(_afBodies(_ae.scene), 'jupiter'), c = _ae.gl.camera.position, s = _aeProject(j.pos); return !!s && Math.hypot(c.x - j.pos[0], c.y - j.pos[1], c.z - j.pos[2]) > j.r * 25 && _aeBodyAt(s.x, s.y) === 'jupiter'; }",
        timeout=60_000,
        polling=200,
    )
    at = page.evaluate(
        "() => { const s = _aeProject(_aeBodyPos('jupiter')), r = document.getElementById('af-layer').getBoundingClientRect(); return [s.x + r.left, s.y + r.top]; }"
    )
    page.touchscreen.tap(at[0], at[1])
    page.wait_for_function(
        "() => _ae.ship.auto === 'jupiter'", timeout=30_000, polling=100
    )
    page.evaluate("() => _afAdvance(120)")
    assert page.evaluate(
        "() => [_ae.ship.auto, _ae.ship.arrived, _ae.ship.near.body.key]"
    ) == [None, "jupiter", "jupiter"]
    # Arrived, a tap on it is the view's own again (its card), not another flight out to the stop.
    page.wait_for_timeout(500)
    at = page.evaluate(
        "() => { const r = document.getElementById('af-layer').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * 0.3]; }"
    )
    page.touchscreen.tap(at[0], at[1])
    page.wait_for_timeout(400)
    assert page.evaluate("() => _ae.ship.auto") is None
    page.evaluate("() => _afStop(true)")
    assert not page.errors, page.errors


# ── The UFO and the ground: one path from space to standing on it and back ──
# Motion is checked two ways. At every seam (the globe's picture and the ground's, the chase camera and the eye's) the two sides are compared at the same
# instant, which no frame rate can hide. And where frames are sampled, the bound is a speed, so a slow software renderer does not pass or fail by its pace.
HOVER_M = [
    2,
    6,
]  # the craft's middle over the ground it hovers on: almanac-standhost.js AE_RIG_HOVER_M plus its own underside
REGISTER_PX = 0.75  # the globe's picture and the ground's put the same point of the world this near on the screen
SEAM_M = 0.01
GROUND_MS = 300_000

SUNLIT_OVER = """([key, radii]) => { const b = _afBody(_afBodies(_ae.scene), key), sun = _aeNorm(_aeSub(_aeSunShown(_ae.scene), b.pos)), side = _aeNorm(_aeCross(sun, [0, 0, 1])),
  up = _aeNorm(_aeAdd(_aeScale(sun, 0.75), _aeScale(side, 0.66))), p = _aeAdd(b.pos, _aeScale(up, b.r * radii));
  _afLinkPlace([p[0], p[1], p[2], -up[0], -up[1], -up[2], 0]); _afAdvance(0.1); }"""
LOCAL_Z = "() => { const s = _ae.ship, g = s.gnd; return _aeRigLocal(_aeRigFrame(g.key, g.lat, g.lon), s.pos)[2]; }"


def _down_to_the_ground(page, body):
    """Over the sunlit side, the lever held down (in steps of the flight run here, let go between them: the page's own frames run too, and a lever left
    down would set the craft down in them) until a ground is drawn under the craft."""
    _at(page, body)
    _fly(page)
    page.evaluate(SUNLIT_OVER, [body, 1.02])
    # The ground is built while the craft comes down; until it is, the old lowest height holds (the craft is never let into a ground that is not there).
    page.wait_for_function(
        "() => { const s = _ae.ship; s.lever = -1; _afAdvance(0.5); s.lever = 0; return !!s.gnd && s.gnd.live; }",
        timeout=GROUND_MS,
        polling=500,
    )


def _ground_caught_up(page):
    """The ground's picture takes its height from the page's own frames, which a loaded machine runs slowly: the share read once they have followed the craft."""
    return page.wait_for_function(
        "() => { const s = _ae.ship, g = s.gnd, st = g.st, z = _aeRigLocal(_aeRigFrame(g.key, g.lat, g.lon), s.pos)[2] / 1000; return Math.abs(st.altKm - z) < 0.15 * z && Math.abs(st.alpha - _aeStandAlphaAt(g.top, st.altKm)) < 1e-9 ? st.alpha : null; }",
        timeout=120_000,
        polling=250,
    ).json_value()


def test_the_point_under_a_craft_is_the_maps_own_latitude_and_the_frames_convert_both_ways(
    page,
):
    _at(page, "earth")
    page.evaluate("() => _aeStandReady()")
    page.wait_for_function("() => typeof _aeRigFrame === 'function'", timeout=READY_MS)
    # Fly's file is loaded on the button's first press: _afSurface is read from it, so it is asked for here.
    page.evaluate("() => _aeLoadJsOnce(AE_FLY_JS, () => {})")
    page.wait_for_function("() => typeof _afSurface === 'function'", timeout=READY_MS)
    got = page.evaluate(
        """() => { const f = _aeStBodyNow('earth'), fr = _aeRigFrame('earth', 45, 10), up = _aeAdd(fr.origin, _aeScale(fr.u, 0.01)), ll = _aeRigLatLon('earth', up);
          const p = [0.3, -0.2, 0.9], back = _aeRigWorld(fr, _aeRigLocal(fr, p));
          return { lat: ll.lat, lon: ll.lon, local: _aeRigLocal(fr, up), round: Math.hypot(back[0] - p[0], back[1] - p[1], back[2] - p[2]),
            pole: _afSurface({ key: 'earth', r: 1 }, [0, 0, 2], 2), equator: _afSurface({ key: 'earth', r: 1 }, [2, 0, 0], 2) }; }"""
    )
    assert (
        abs(got["lat"] - 45) < 0.01 and abs(got["lon"] - 10) < 0.01
    ), got  # (the angle from the Earth's middle is 44.81 there: 21 km away)
    assert (
        abs(got["local"][0]) < 1
        and abs(got["local"][1]) < 1
        and abs(got["local"][2] - 63781.37) < 1
    ), got  # straight up from the origin is straight up in its frame
    assert got["round"] < 1e-12, got
    assert (
        abs((got["equator"] - got["pole"]) * 6378.137 - 21.385) < 0.01
    ), got  # the flattened globe: the pole's ground is 21.4 km nearer the middle


def test_the_ground_comes_in_by_height_alone_and_registers_with_the_globe(page):
    _down_to_the_ground(page, "moon")
    try:
        page.keyboard.up("c")
        # Lifted back into the band where both pictures show, and left to hang there.
        page.evaluate(
            "() => { const s = _ae.ship, g = s.gnd, fr = _aeRigFrame(g.key, g.lat, g.lon); s.pos = _aeRigWorld(fr, [0, 0, g.top * 1000 * 0.35]); g.liveAt = 0; _afAdvance(0.1); }"
        )
        # (A ground that went live a moment ago is still coming in over AE_RIG_LATE_MS: the picture is read once that is over and height alone decides.)
        page.wait_for_function(
            "() => { const g = _ae.ship.gnd, st = g.st; return st.alpha > 0.05 && st.alpha < 0.95 && !!g.craft && Math.abs(st.alpha - _aeStandAlphaAt(g.top, st.altKm)) < 1e-9; }",
            timeout=120_000,
            polling=250,
        )
        # The chase camera eases to where the lifted craft hangs, and the ground's share follows the camera's height: read it once it has stopped.
        page.wait_for_function(
            "() => { const a = _ae.ship.gnd.st.alpha, n = performance.now(); if (!window.__rigSteady || Math.abs(window.__rigSteady.a - a) > 1e-6) window.__rigSteady = { a, t: n }; return n - window.__rigSteady.t > 800; }",
            timeout=120_000,
            polling=250,
        )
        seen = page.wait_for_function(  # (once a picture has both in it: a point straight under the craft, which the chase camera looks down on)
            """() => { const s = _ae.ship, g = s.gnd, st = g.st, T = _ae.gl.THREE, hc = st.camera, px = (v) => [(v.x + 1) / 2 * _ae.w, (1 - v.y) / 2 * _ae.h];
              const craftG = px(new T.Vector3().copy(g.craft.root.position).project(hc)), m = s.craft.root.position, craftM = _aeProject([m.x, m.y, m.z]);
              const fr = _aeRigFrame(g.key, g.lat, g.lon), c = _aeRigLocal(fr, s.pos), far = [c[0], c[1], 0], farG = px(new T.Vector3(far[0], far[1], far[2]).project(hc)), farM = _aeProject(_aeRigWorld(fr, far));
              if (!craftM || !farM) return null;
              return { craft: Math.hypot(craftG[0] - craftM.x, craftG[1] - craftM.y), ground: Math.hypot(farG[0] - farM.x, farG[1] - farM.y), alpha: st.alpha, by: _aeStandAlphaAt(g.top, st.altKm), inScene: g.craft.root.parent === st.scene }; }""",
            timeout=120_000,
            polling=250,
        ).json_value()
        assert seen["inScene"] and seen["craft"] < REGISTER_PX, (
            "the craft stands at one place in both pictures",
            seen,
        )
        assert seen["ground"] < REGISTER_PX, (
            "a point of the ground stands at one place in both pictures",
            seen,
        )
        assert abs(seen["alpha"] - seen["by"]) < 1e-9, (
            "how much of the picture is the ground's is its height's to say",
            seen,
        )
        _shot(page, "rig-in-the-band")
        # Hanging there: nothing moves on with time (no clock runs the way down).
        a0 = seen["alpha"]
        page.wait_for_timeout(2500)
        assert (
            abs(page.evaluate("() => _ae.ship.gnd.st.alpha") - a0) < 0.02
        ), "the picture goes on changing while the craft hangs still"
        # And it is one path both ways: up thins the ground out, down brings it back.
        page.keyboard.down(" ")
        page.evaluate("() => _afAdvance(0.4)")
        page.keyboard.up(" ")
        up = _ground_caught_up(page)
        page.keyboard.down("c")
        page.evaluate("() => _afAdvance(0.8)")
        page.keyboard.up("c")
        down = _ground_caught_up(page)
        assert up < a0 < down, (up, a0, down)
        assert not page.errors, page.errors
    finally:
        page.keyboard.up("c")
        page.keyboard.up(" ")
        page.evaluate("() => _afStop(true)")


def test_the_craft_sets_down_on_the_ground_it_flew_to_and_lifts_off_from_where_it_stands(
    page,
):
    _down_to_the_ground(page, "moon")
    try:
        # Down to its lowest height over the ground itself (not five kilometres up), and it hovers there.
        page.evaluate(
            "() => { const s = _ae.ship; s.lever = -1; for (let i = 0; i < 400 && !(_aeRigLift(s, s.near.body) > -0.01); i++) _afAdvance(0.05); s.lever = 0; }"
        )
        z = page.evaluate(LOCAL_Z)
        assert HOVER_M[0] < z < HOVER_M[1], ("the craft hovers just over the ground", z)
        page.wait_for_function(
            "() => !!_ae.ship.gnd.craft && _ae.ship.gnd.st.alpha >= 1",
            timeout=120_000,
            polling=250,
        )  # a picture of it, for the camera's last place
        # Held down a moment more it sets down: the very ground that was drawn becomes the ground stood on, and the camera is not cut.
        seam = page.evaluate(
            """() => { const g = _ae.ship.gnd, st = g.st, chase = _aeRigCamNow(st);
              _ae.ship.lever = -1; for (let i = 0; i < 40 && !_ae.stand; i++) _afAdvance(0.05);
              const s = _ae.stand; if (!s) return null;
              s.stepOut.t0 = performance.now(); _aeStandPlaceCamera(s);
              const eye = _aeRigCamNow(s), c = s.parkedCraft.copy.root;
              return { same: s === st, gap: Math.hypot(eye.pos[0] - chase.pos[0], eye.pos[1] - chase.pos[1], eye.pos[2] - chase.pos[2]), turn: 1 - _aeDot(eye.fwd, chase.fwd), fov: Math.abs(eye.fov - chase.fov),
                mode: s.mode, pending: !!_ae.standPending, ship: !!_ae.ship, parked: !!(_ae.shipParked && _ae.shipParked.gnd === g), landed: _ae.shipLanded,
                craft: [c.parent === s.scene, c.visible, c.position.z], walk: [s.walk.x, s.walk.y] }; }"""
        )
        assert seam, "the craft did not set down"
        assert seam["same"] and seam["mode"] == "ground" and not seam["pending"], (
            "the ground was not built again, nor a trip made to orbit",
            seam,
        )
        assert seam["gap"] < SEAM_M and seam["turn"] < 1e-9 and seam["fov"] < 1e-9, (
            "stepping out begins where the camera that followed the craft was",
            seam,
        )
        assert not seam["ship"] and seam["parked"] and seam["landed"] == "moon", seam
        assert (
            seam["craft"][0]
            and seam["craft"][1]
            and HOVER_M[0] < seam["craft"][2] < HOVER_M[1]
        ), ("the craft stands on the ground, in its picture", seam)
        page.keyboard.up("c")
        page.wait_for_function("() => !_ae.stand.stepOut", timeout=120_000, polling=250)
        eye = page.evaluate(
            "() => { const s = _ae.stand, c = s.camera.position, w = s.walk; return [c.x - w.x, c.y - w.y, c.z - w.h]; }"
        )
        assert abs(eye[0]) < 0.01 and abs(eye[1]) < 0.01 and abs(eye[2] - 1.7) < 0.01, (
            "and ends at the eye of someone standing beside it",
            eye,
        )
        _shot(page, "rig-set-down")
        # The Moon goes on a kilometre a second while one stands on it: the craft is where it was left, on its ground.
        page.wait_for_timeout(2500)
        lift = page.evaluate(
            """() => { const st = _ae.stand, g = _ae.shipParked.gnd, c = g.craft.root.position.toArray(), eye = _aeRigCamNow(st);
              document.getElementById('ae-fly-btn').click();
              const s = _ae.ship; if (!s) return null;
              _aeUpdate(_aeDisplayMs());   // the flight's first step, on the scene as it is now
              const fr = _aeRigFrame(g.key, g.lat, g.lon), p = _aeRigLocal(fr, s.pos), cam = _aeRigLocal(fr, s.pose.pos), look = _aeRigDir(fr, s.pose.look);
              return { off: Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]), gap: Math.hypot(cam[0] - eye.pos[0], cam[1] - eye.pos[1], cam[2] - eye.pos[2]), turn: 1 - _aeDot(look, eye.fwd),
                stand: !!_ae.stand, same: s.gnd === g && g.st === st && g.live, parked: !!_ae.shipParked, landed: _ae.shipLanded, hud: !!document.getElementById('af-hud') }; }"""
        )
        assert lift, "the lit button did not lift the craft off"
        assert (
            not lift["stand"]
            and lift["same"]
            and not lift["parked"]
            and not lift["landed"]
            and lift["hud"]
        ), lift
        assert lift["off"] < 0.05, ("the craft lifts off from where it stood", lift)
        assert lift["gap"] < 1.0 and lift["turn"] < 1e-3, (
            "the flight's first picture is the eye's last",
            lift,
        )
        # No timed way up: it hangs where it is until the lever climbs.
        page.evaluate("() => _afAdvance(1)")
        z = page.evaluate(LOCAL_Z)
        assert HOVER_M[0] < z < HOVER_M[1], z
        page.keyboard.down(" ")
        page.evaluate("() => _afAdvance(3)")
        page.keyboard.up(" ")
        assert (
            page.evaluate("() => _ae.ship.near.alt * 6378137") > 100
        ), "the lever climbs away from the ground"
        _shot(page, "rig-lifted-off")
        assert not page.errors, page.errors
    finally:
        page.keyboard.up("c")
        page.keyboard.up(" ")
        page.evaluate("() => { if (_ae.stand) _aeStandDrop(); _afStop(true); }")


def test_a_world_behind_another_is_reached_round_it_in_real_time_and_the_move_is_told(
    page,
):
    _at(page, "earth")
    _fly(page)
    # The Moon asked for from the far side of the Earth, low: straight at it is through the Earth, and a craft that slows as it nears a surface never got past.
    page.evaluate(
        """() => { const B = _afBodies(_ae.scene), m = _afBody(B, 'moon'), away = _aeScale(_aeNorm(m.pos), -1), p = _aeScale(away, 1.3);
          _afLinkPlace([p[0], p[1], p[2], away[0], away[1], away[2], 0]); _afAdvance(0.1); }"""
    )
    go = page.evaluate("() => _aeFlyGoTo('moon')")
    assert go["ok"] and go["seconds"] <= 20, go
    page.wait_for_timeout(300)
    trip = page.evaluate(
        """() => { const B0 = _afBodies(_ae.scene); let least = 1e9, peak = 0, t = 0, mid = null;
          for (; t < 40 && _ae.ship.auto; t += 0.05) { _afAdvance(0.05); const s = _ae.ship; least = Math.min(least, _aeLen(s.pos) - 1); peak = Math.max(peak, _aeLen(s.vel));
            if (!mid && t > 1) mid = JSON.parse(JSON.stringify(_ae.move || null)); }
          return { t: t, arrived: _ae.ship.arrived, least: least, peakKmS: peak * 6378.137, mid: mid, still: _aeLen(_ae.ship.vel) }; }"""
    )
    assert (
        trip["arrived"] == "moon" and trip["t"] <= 20
    ), trip  # seconds, on the craft's own law: the clock was never touched
    assert trip["least"] > 0.1, ("it went round the Earth, not at it", trip)
    assert (
        trip["peakKmS"] > 100000 and trip["still"] == 0
    ), trip  # most of the speed of light on the way, and stopped there
    mv = trip["mid"]
    assert (
        mv
        and mv["vehicle"] == "ufo"
        and mv["from"] == "earth"
        and mv["to"] == "moon"
        and mv["toM"] > 1e8
        and mv["speedMS"] > 0
    ), mv
    assert (
        abs(mv["speedC"] - mv["speedMS"] / 299792458) < 1e-9
        and abs(mv["lightS"] - mv["toM"] / 299792458) < 1e-6
    ), mv  # the speed over light's, and light's own time over what is left
    page.evaluate("() => _afStop(true)")
    assert page.evaluate("() => _ae.move") is None
    assert not page.errors, page.errors


def test_from_the_moons_own_view_the_lever_alone_sets_down_and_the_craft_is_in_the_picture_lit(
    page,
):
    # The way a person does it: the Moon's view as it opens, the UFO, the right lever held down and nothing else. Whatever side it comes down on (the night's too),
    # and however late the ground is built, the craft is there when one stands: in the picture, and bright enough to see by its own lights.
    _at(page, "moon")
    _fly(page)
    page.keyboard.down("c")
    try:
        early = page.evaluate(
            "() => { _afAdvance(8); return [!!_ae.ship, !!(_ae.stand || _ae.standPending)]; }"
        )
        assert early == [True, False], (
            "held at its lowest height before the ground is drawn, the craft waits for it: it is not left behind by the old way down",
            early,
        )
        page.wait_for_function(
            "() => { if (_ae.ship) _afAdvance(0.3); return !!_ae.stand; }",
            timeout=GROUND_MS,
            polling=300,
        )
    finally:
        page.keyboard.up("c")
    page.wait_for_function(
        "() => _ae.stand.live && !_ae.stand.stepOut", timeout=120_000, polling=250
    )
    page.wait_for_timeout(1500)
    box = page.evaluate(
        """() => { const st = _ae.stand, pc = st.parkedCraft, T = _ae.gl.THREE; if (!pc) return null;
          const c = pc.copy.root.position, r = pc.copy.body.scale.x, v = new T.Vector3().copy(c).project(st.camera), e = new T.Vector3(c.x, c.y, c.z + r * 0.4).project(st.camera);
          const edge = new T.Vector3().copy(c).add(new T.Vector3().setFromMatrixColumn(st.camera.matrixWorld, 0).multiplyScalar(r)).project(st.camera);
          const cv = document.getElementById('ae-canvas').getBoundingClientRect();
          return { x: cv.left + (v.x + 1) / 2 * _ae.w, y: cv.top + (1 - v.y) / 2 * _ae.h, half: Math.abs(edge.x - v.x) / 2 * _ae.w, ahead: v.z < 1, w: _ae.w, h: _ae.h, top: cv.top, parked: !!(_ae.shipParked && _ae.shipLanded) }; }"""
    )
    assert box and box["parked"] and box["ahead"], (
        "a craft stands on the ground it came down to",
        box,
    )
    assert box["half"] > 20, ("and is big enough in the picture to be seen", box)
    assert (
        box["x"] - box["half"] >= 0
        and box["x"] + box["half"] <= box["w"]
        and box["top"] < box["y"] < box["top"] + box["h"]
    ), ("all of it in the picture", box)
    shot = page.screenshot(
        clip={
            "x": box["x"] - box["half"],
            "y": box["y"] - box["half"] * 0.3,
            "width": box["half"] * 2,
            "height": box["half"] * 0.6,
        }
    )
    try:
        import io

        from PIL import Image
    except ImportError:
        Image = None
    if Image:
        px = list(Image.open(io.BytesIO(shot)).convert("L").getdata())
        bright = sum(1 for v in px if v > 110) / len(px)
        assert bright > 0.02, (
            "its own lights show it, on the night side too (share of bright pixels across its rim: %.3f)"
            % bright
        )
    _shot(page, "rig-moon-set-down-craft")
    page.evaluate("() => { if (_ae.stand) _aeStandDrop(); _afStop(true); }")
    assert not page.errors, page.errors


def test_flown_on_low_the_ground_is_built_again_under_the_craft_with_its_hills_where_they_were(
    page,
):
    _down_to_the_ground(page, "moon")
    try:
        page.keyboard.up("c")
        page.evaluate(
            "() => { for (let i = 0; i < 400 && !(_aeRigLift(_ae.ship, _ae.ship.near.body) > -0.01); i++) { _ae.ship.lever = -1; _afAdvance(0.05); } _ae.ship.lever = 0; }"
        )
        page.wait_for_function(
            "() => !!_ae.ship.gnd.craft", timeout=120_000, polling=250
        )
        first = page.evaluate(
            "() => { const g = _ae.ship.gnd; window.__st0 = g.st; return [g.lat, g.lon]; }"
        )
        # Level, half a kilometre on: past where the ground round its first middle is fine.
        page.evaluate(
            "() => { const s = _ae.ship, g = s.gnd; s.view = g.fr.n.slice(); s.up = g.fr.u.slice(); _afThrottleSet(s, 1); }"
        )
        seam = page.wait_for_function(
            """() => { const s = _ae.ship, g = s.gnd, drop = _aeRigLift(s, s.near.body);
              if (drop < -1) s.pos = _aeAdd(s.pos, _aeScale(g.fr.u, (drop + 0.5) / 6378137));   // (kept low over the hills it crosses: level flight does not follow the ground down)
              const before = -_aeRigLift(s, s.near.body), was = g.st; _afAdvance(0.5);
              if (g.st === was) return null;
              return { before: before, after: -_aeRigLift(s, s.near.body), off: Math.hypot(..._aeRigLocal(g.fr, s.pos).slice(0, 2)), lat: g.lat, lon: g.lon, lift: g.liftM, next: !!g.next, live: g.live }; }""",
            timeout=GROUND_MS,
            polling=300,
        ).json_value()
        assert (
            [seam["lat"], seam["lon"]] != first and seam["live"] and not seam["next"]
        ), seam
        assert seam["off"] < 250, ("the new ground's middle is under the craft", seam)
        assert abs(seam["after"] - seam["before"]) < 2, (
            "and the craft is as high over the ground as it was: the hills did not jump (half a second of flight over them lies between the two readings)",
            seam,
        )
        page.evaluate("() => _afThrottleSet(_ae.ship, 0)")
        page.wait_for_function(
            "() => !!_ae.ship.gnd.craft && _ae.ship.gnd.craft.root.parent === _ae.ship.gnd.st.scene",
            timeout=120_000,
            polling=250,
        )  # drawn in the new one
        assert page.evaluate("() => !window.__st0.scene"), "the old ground was let go"
        assert not page.errors, page.errors
    finally:
        page.keyboard.up("c")
        page.evaluate("() => { delete window.__st0; _afStop(true); }")


def test_the_surface_and_space_button_turns_the_move_back_at_any_height(page):
    _at(page, "moon")
    page.evaluate("() => _aeStandAt('moon', 10, 20)")
    page.wait_for_function(
        "() => !!_ae.stand && _ae.stand.live && _ae.stand.mode === 'descend'",
        timeout=GROUND_MS,
        polling=100,
    )
    # Part way down the fall, the button (its own function) is pressed: the view climbs from the height it is at. It used to start that climb from the ground.
    up = page.evaluate(
        """() => { const st = _ae.stand, t = performance.now(); st.t0 = t - 1200; _aeStandView(st, t); const before = [st.altKm, st.pitch];
          _aeStandCloseNow(); _aeStandView(st, performance.now());
          return { mode: st.mode, before: before, after: [st.altKm, st.pitch], eye: AE_STAND_EYE_M / 1000 }; }"""
    )
    assert up["mode"] == "ascend" and up["before"][0] > up["eye"] * 100, up
    assert (
        abs(up["after"][0] / up["before"][0] - 1) < 0.02
        and abs(up["after"][1] - up["before"][1]) < 0.02
    ), ("turned back in the air, the view goes on from where it is", up)
    # And pressed again on the way up, it falls again from there.
    down = page.evaluate(
        """() => { const st = _ae.stand, t = performance.now(); st.t0 = t - 500; _aeStandView(st, t); const before = st.altKm;
          _aeStandCloseNow(); _aeStandView(st, performance.now());
          return { mode: st.mode, before: before, after: st.altKm, fading: !!st.fading }; }"""
    )
    assert (
        down["mode"] == "descend"
        and not down["fading"]
        and abs(down["after"] / down["before"] - 1) < 0.02
    ), down
    page.wait_for_function(
        "() => !!_ae.stand && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )
    assert (
        abs(page.evaluate("() => _ae.stand.altKm") - 0.0017) < 1e-6
    ), "and it ends standing on the ground"
    page.evaluate("() => _aeStandDrop()")
    assert not page.errors, page.errors


def test_a_walk_and_a_drive_tell_their_move_in_the_crafts_own_shape(page):
    _at(page, "moon")
    page.evaluate("() => _aeStandAt('moon', 10, 20)")
    page.wait_for_function(
        "() => !!_ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )
    walk = page.evaluate(
        """() => { const st = _ae.stand, w = _aeStandWalkOf(st); w.keys.f = true; let t = performance.now();
          for (let i = 0; i < 40; i++) { t += 50; _aeStandWalkStep(st, t); }
          const m = JSON.parse(JSON.stringify(_ae.move)); w.keys.f = false; return { m: m, went: Math.hypot(w.x, w.y) }; }"""
    )
    m = walk["m"]
    assert (
        m["vehicle"] == "walk"
        and m["near"] == "moon"
        and m["to"] is None
        and m["toM"] is None
    ), m
    assert (
        0.5 < m["speedMS"] < 3
        and abs(m["coveredM"] - walk["went"]) < 0.05
        and walk["went"] > 0.5
    ), walk  # a walking pace, and the ground covered
    assert (
        abs(m["place"]["lat"] - 10) < 0.01
        and abs(m["place"]["lon"] - 20) < 0.01
        and (m["place"]["lat"], m["place"]["lon"]) != (10, 20)
    ), m
    assert set(m) == {
        "vehicle",
        "from",
        "to",
        "near",
        "nearM",
        "toM",
        "speedMS",
        "speedC",
        "lightS",
        "place",
        "coveredM",
    }, sorted(m)
    page.evaluate("() => _aeStandDrop()")
    assert page.evaluate("() => _ae.move") is None
    assert not page.errors, page.errors


RIM_WHEN = {
    "pending": "() => !!_ae.standPending",
    "falling": "() => !!_ae.stand && _ae.stand.live && _ae.stand.mode === 'descend'",
    "climbing": "() => !!_ae.stand && _ae.stand.mode === 'ascend' && !_ae.stand.fading",
    "flying back": "() => !_ae.standPending && !_ae.stand && !!_ae.fly",
    "now": "() => true",
}


@pytest.mark.parametrize(
    "taps",
    [
        ["now", "pending"],
        ["now", "pending", "flying back"],
        ["now", "falling", "climbing"],
        ["now", "pending", "flying back", "pending"],
    ],
    ids=lambda t: "-".join(t).replace(" ", "_"),
)
def test_the_surface_button_ends_on_the_ground_after_an_odd_number_of_presses_and_where_it_began_after_an_even_one(
    page, taps
):
    """Whenever the presses land: before the fall has begun (the flight down, the ground still being built), in the fall, in the climb, on the way back."""
    page.evaluate(
        "() => { if (_ae.stand || _ae.standPending) _aeStandDrop(); if (_ae.ship || _ae.shipParked) _afStop(true); _ae.standUndo = null; }"
    )
    _at(page, "moon")
    page.wait_for_timeout(500)
    start = page.evaluate("() => [_ae.dist, _ae.az]")
    for when in taps:
        page.wait_for_function(RIM_WHEN[when], timeout=GROUND_MS, polling=30)
        page.wait_for_function(
            "() => { _aeRimSync(true); const r = document.getElementById('ae-rim'); return !r.hidden && !!r.dataset.kind; }",
            timeout=30_000,
            polling=50,
        )
        box = page.evaluate(
            "() => { const r = document.getElementById('ae-rim').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }"
        )
        page.touchscreen.tap(box[0], box[1])
        page.wait_for_timeout(
            300
        )  # (a way down is asked for and begins a moment later)
    page.wait_for_timeout(800)
    page.wait_for_function(
        "() => !_ae.fly && !_ae.standPending && (!_ae.stand || _ae.stand.mode === 'ground')",
        timeout=GROUND_MS,
        polling=250,
    )
    end = page.evaluate(
        "() => ({ stand: !!_ae.stand, ship: !!_ae.ship, dist: _ae.dist, az: _ae.az })"
    )
    if len(taps) % 2:
        assert end["stand"] and not end["ship"], (taps, end)
    else:
        assert (
            not end["stand"]
            and not end["ship"]
            and abs(end["dist"] / start[0] - 1) < 0.01
            and abs(end["az"] - start[1]) < 0.02
        ), (taps, start, end)
    page.evaluate("() => { if (_ae.stand) _aeStandDrop(); }")
    assert not page.errors, page.errors
