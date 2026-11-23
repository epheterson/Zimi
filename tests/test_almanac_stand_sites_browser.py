"""A landing site and Stand here are one experience (almanac-standhost.js): the visit's models, rocks and rover stand on the
ground of Stand here (its terrain, its sky, the Sun and the other bodies in it), the site's camera orbits the lander or chases
the rover, and eye level is a second camera of the same visit, turned by a finger or the phone. Headless Chromium at a phone's
size, software GL.

Run: pytest tests/test_almanac_stand_sites_browser.py -v
"""

import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 300_000
STAND_MS = 300_000


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("standsites")
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
    env.undo()


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
            # Chromium now has iOS's permission ask, and a headless one answers no: answer yes, as a tap would.
            "DeviceOrientationEvent.requestPermission = function () { return Promise.resolve('granted'); };"
            % (PLACE, PLACE)
        )
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.on(
            "console",
            lambda m: (
                pg.errors.append(m.text[:400])
                if m.type == "error" and "THREE" in m.text
                else None
            ),
        )
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=240_000,
        )
        pg.evaluate("() => openAlmanacEarth({ target: 'moon' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=READY_MS,
            polling=200,
        )
        pg.evaluate("() => _aeLmLoad()")
        pg.wait_for_function("() => !!_aeLm", timeout=60_000)
        yield pg
        br.close()


def _visit(pg, body, name, drive=False):
    pg.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    pg.evaluate("() => _aeNow()")
    pg.evaluate("(b) => _aePreset(b)", body)
    pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=250)
    pg.evaluate(
        "([b, n]) => _aeLmOpen(b, _aeLm[b].filter(r => r[0] === n)[0])", [body, name]
    )
    pg.wait_for_function(
        "() => !!document.getElementById('as-visit')", timeout=120_000, polling=250
    )
    pg.evaluate(
        "(id) => document.getElementById(id).click()",
        "as-drive" if drive else "as-visit",
    )
    pg.wait_for_function(
        "() => { var s = _aeSiteState(); return s && s.phase === 'stand' && s.ready; }",
        timeout=STAND_MS,
        polling=500,
    )
    pg.wait_for_function(
        "() => _ae.site && _ae.site.host && _ae.site.host.live",
        timeout=STAND_MS,
        polling=500,
    )


def test_a_visit_is_drawn_on_the_ground_of_stand_here(page):
    _visit(page, "moon", "Apollo 17")
    s = page.evaluate(
        """() => { var st = _ae.site, g = st.host.st; return { inScene: g.scene.children.indexOf(st.group) >= 0, patchHidden: st.ground.visible === false,
          terrainHere: !!st.terrainHere, metre: st.shared.metre.value, sky: !!g.sky, ground: !!g.ground, sprites: g.sprites.length, objs: g.fr ? g.fr.objs.length : 0 }; }"""
    )
    assert s["inScene"] and s["patchHidden"] and s["terrainHere"], s
    assert (
        s["metre"] == 1
        and s["sky"]
        and s["ground"]
        and s["sprites"] > 10
        and s["objs"] >= 10
    ), s
    assert not page.errors, page.errors


def test_the_models_and_the_rover_stand_on_the_grounds_terrain(page):
    """The site's one height is the ground's: levelled at the lander, the terrain's own beyond, the body's curve in it."""
    _visit(page, "moon", "Apollo 17")
    h = page.evaluate(
        """() => { var st = _ae.site, h0 = _aeTerrainHeight(st.body, st.lat, st.lon, 0).h, flat = [st.flatFrom || AS_FLAT_FROM_M, st.flatTo || AS_FLAT_TO_M];
          return { at0: _asGroundAt(st, 0, 0, false), near: _asGroundAt(st, 5, 5, false), far: _asGroundAt(st, 600, 200, true),
            want: _aeTerrainLocal(st.body, st.lat, st.lon, h0, 600, 200, Math.hypot(600, 200) * AS_TERRAIN_LOD_PER_M, flat) }; }"""
    )
    assert (
        abs(h["at0"]) < 0.05 and abs(h["near"]) < 0.1
    ), "level where the lander stands"
    assert abs(h["far"] - h["want"]) < 1e-6, "beyond that the ground's own height"
    parts = page.evaluate(
        "() => _aeSiteState().parts.map(function (p) { return [p.model, p.z, p.ground]; })"
    )
    # A wheel's centre is a wheel radius over the ground it touches, the lander's rest are on it.
    assert parts and all(
        abs(p[1] - p[2]) < (0.5 if p[0].endswith("wheel") else 0.2) or p[0] == "saturn5"
        for p in parts
    ), [p for p in parts if abs(p[1] - p[2]) >= 0.2]


def test_eye_level_is_a_camera_of_the_visit_and_the_phone_turns_it(page):
    _visit(page, "moon", "Apollo 17")
    page.wait_for_function(
        "() => !document.getElementById('as-eye').hidden", timeout=60_000, polling=250
    )
    page.evaluate("() => document.getElementById('as-eye').click()")
    page.wait_for_function("() => _ae.site.eye && _ae.site.eye.on", timeout=30_000)
    cam = page.evaluate(
        """() => { var st = _ae.site; _aeKick(); return { height: _asCameraLocal(st, 0.016).pos[2] - _asGroundAt(st, st.eye.x, st.eye.y, false), away: Math.hypot(st.eye.x - st.focusXY[0], st.eye.y - st.focusXY[1]) }; }"""
    )
    assert abs(cam["height"] - 1.7) < 0.05 and cam["away"] > 5, cam
    page.evaluate("() => _aeHostEyeLook(_ae.site, 100, 0)")
    assert page.evaluate("() => _ae.site.eye.yaw") != 0
    page.wait_for_function(
        "() => !document.getElementById('as-motion').hidden",
        timeout=30_000,
        polling=250,
    )
    assert page.evaluate("() => _aeHostMotionToggle(_ae.site)")
    page.evaluate(
        "() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 90, beta: 90, gamma: 0, absolute: true }))"
    )
    page.wait_for_function(
        "() => { _aeKick(); var y = (_ae.site.eye.yaw * 180 / Math.PI % 360 + 360) % 360; return Math.abs(y - 270) < 6; }",
        timeout=60_000,
        polling=500,
    )
    page.evaluate("() => document.getElementById('as-eye').click()")
    page.wait_for_function("() => !_ae.site.eye.on", timeout=30_000)
    assert not page.errors, page.errors


def _finger(page, id_):
    """A real touch on the middle of a button."""
    x, y = page.evaluate(
        "(id) => { var b = document.getElementById(id).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }",
        id_,
    )
    page.touchscreen.tap(x, y)


def test_the_whole_site_and_the_eye_buttons_say_what_they_did(page):
    """two discs by the rim did nothing he could see; each now answers in words in the caption slot."""
    _visit(page, "moon", "Apollo 17")
    page.wait_for_function(
        "() => !document.getElementById('as-eye').hidden", timeout=60_000, polling=250
    )
    page.evaluate(
        "() => { _ae.site.tapped = 'alm_site_p_lander'; _asEyeSync(_ae.site); }"
    )
    page.wait_for_function(
        "() => !document.getElementById('as-whole').hidden", timeout=30_000
    )
    _finger(page, "as-whole")
    page.wait_for_function(
        "() => /whole/i.test((document.getElementById('ae-hint') || {}).innerText || '')",
        timeout=30_000,
    )
    _finger(page, "as-eye")
    page.wait_for_function(
        "() => /stand on the ground/i.test((document.getElementById('ae-hint') || {}).innerText || '')",
        timeout=30_000,
    )
    _finger(page, "as-eye")
    page.wait_for_function(
        "() => /above the site/i.test((document.getElementById('ae-hint') || {}).innerText || '')",
        timeout=30_000,
    )
    assert not page.errors, page.errors


def test_a_rover_drives_on_the_ground_and_the_visit_ends_cleanly(page):
    _visit(page, "mars", "Curiosity", drive=True)
    w = page.evaluate(
        "() => _aeSiteState().rover.wheels.map(function (w) { return Math.abs(w.z - w.ground - 0.3) < 0.35; })"
    )
    assert w and all(w), "the wheels stand on the ground's heights"
    page.evaluate("() => _aeSiteLeave()")
    page.wait_for_function("() => !_ae.site", timeout=30_000)
    left = page.evaluate(
        "() => ({ ratio: _ae.gl.renderer.getPixelRatio() <= _ae.gl.dpr, clear: _ae.gl.renderer.getClearAlpha() })"
    )
    assert left["clear"] == 0, "the orbit view's see-through canvas is back"
    assert not page.errors, page.errors


def test_the_lunar_module_has_its_ascent_stage_from_landing_to_liftoff(page):
    """Two stages on one footprint: both at the landing, only the descent stage after the liftoff, nothing before the landing."""
    _visit(page, "moon", "Apollo 11")
    shown = """() => { var s = _ae.site; return s.def.parts.map(function (p, i) { return [p.m, !!s.siteParts[i] && s.siteParts[i].holder.visible]; }); }"""

    def at(delta_from, key):
        page.evaluate("([k, d]) => _aeGoTo(_ae.site.def[k] + d)", [key, delta_from])
        page.wait_for_function(
            "([k, d]) => Math.abs(_aeDisplayMs() - (_ae.site.def[k] + d)) < 60000",
            arg=[key, delta_from],
            timeout=30_000,
            polling=250,
        )
        page.wait_for_timeout(1500)
        return dict(page.evaluate(shown))

    landed = at(600_000, "ms")
    assert landed["lm"] and landed["lm-ascent"], landed
    after = at(3_600_000, "liftoff")
    assert after["lm"] and not after["lm-ascent"], after
    before = at(-86_400_000, "ms")
    assert not before["lm"] and not before["lm-ascent"] and not before["flag"], before
    fp = page.evaluate(
        "() => { var p = _ae.site.def.parts; var a = p.filter(x => x.m === 'lm')[0], b = p.filter(x => x.m === 'lm-ascent')[0]; return [a.x === b.x, a.y === b.y, a.h === b.h]; }"
    )
    assert fp == [
        True,
        True,
        True,
    ], "the ascent stage stands on the descent stage's footprint"
    assert not page.errors, page.errors


def test_walking_at_a_site_on_foot_with_the_keys(page):
    """W S A D (and the arrows, Left and Right turning), Space jumps in the Moon's gravity, Shift runs: a key to walk with puts the eye on the ground at
    the site, and the eye stays on the ground wherever it walks."""
    _visit(page, "moon", "Apollo 17")
    page.wait_for_function(
        "() => !document.getElementById('as-eye').hidden", timeout=60_000, polling=250
    )
    page.evaluate("() => { document.activeElement && document.activeElement.blur(); }")
    page.keyboard.down("w")
    page.wait_for_function("() => _ae.site.eye && _ae.site.eye.on", timeout=30_000)
    p0 = page.evaluate("() => [_ae.site.eye.x, _ae.site.eye.y]")
    page.wait_for_function(
        "(p) => Math.hypot(_ae.site.eye.x - p[0], _ae.site.eye.y - p[1]) > 0.8",
        arg=p0,
        timeout=30_000,
        polling=100,
    )
    page.keyboard.up("w")
    yaw = page.evaluate("() => _ae.site.eye.yaw")
    page.keyboard.down("ArrowLeft")
    page.wait_for_function(
        "(y) => _ae.site.eye.yaw < y - 0.2", arg=yaw, timeout=30_000, polling=100
    )
    page.keyboard.up("ArrowLeft")
    page.keyboard.down(" ")
    page.wait_for_function("() => _ae.site.eye.jump > 0.2", timeout=30_000, polling=30)
    page.keyboard.up(" ")
    page.wait_for_function(
        "() => _ae.site.eye.jump === 0", timeout=180_000, polling=200
    )
    h = page.evaluate(
        "() => { var st = _ae.site; return _asCameraLocal(st, 0.016).pos[2] - _asGroundAt(st, st.eye.x, st.eye.y, false); }"
    )
    assert abs(h - 1.7) < 0.05, h
    assert not page.errors, page.errors


def test_the_facts_sheet_is_the_grounds_body_and_sits_over_the_hud(page):
    _visit(page, "moon", "Apollo 14")
    page.evaluate(
        "() => { _ae.arrived = 'phobos'; _aeMarkInfoBtn(); }"
    )  # an earlier arrival, left over
    assert page.evaluate("() => _aeFactsKey()") == "moon"
    page.evaluate("() => _aeOpenInfo(_aeFactsKey())")
    page.wait_for_function(
        "() => { var r = document.getElementById('ae-info').getBoundingClientRect(); return r.top < innerHeight - 100; }",
        timeout=20_000,
    )
    out = page.evaluate("""() => {
          var el = document.getElementById('ae-info'), b = el.getBoundingClientRect(), bad = [];
          for (var y = b.top + 12; y < b.bottom - 4; y += 24) for (var x = 12; x < innerWidth - 40; x += 24) {
            var e = document.elementFromPoint(x, y);
            if (e && !el.contains(e)) bad.push((e.id || e.className || e.tagName) + '@' + x + ',' + Math.round(y));
          }
          return { name: el.querySelector('h2').textContent, bad: bad.slice(0, 6) };
        }""")
    assert out["name"] == "Moon"
    assert out["bad"] == []
    page.evaluate("() => _aeCloseInfo(false)")


def test_a_tap_on_the_ground_is_a_walk_there_at_a_persons_pace_with_a_step_in_it(page):
    """taps went only a few metres and the view slid there fast. Anywhere in sight, at 5 km/h, a step at a time."""
    _visit(page, "moon", "Apollo 17")
    page.wait_for_function(
        "() => !document.getElementById('as-eye').hidden", timeout=60_000, polling=250
    )
    page.evaluate("() => document.getElementById('as-eye').click()")
    page.wait_for_function("() => _ae.site.eye && _ae.site.eye.on", timeout=30_000)
    got = page.evaluate("""() => {
        var st = _ae.site, e = st.eye, out = {};
        e.x = 0; e.y = 0; e.yaw = 0; e.v = 0; e.gait = 0; e.gaitAmp = 0; e.goto = null; e.run = false; st.input.sx = st.input.sy = 0; e.keys = {};
        // anywhere in sight, not a few metres: the place asked for is the place walked to
        out.asked = _aeHostWalkTo(st, 30, 900) && [e.goto.x, e.goto.y];
        // the way the person walks: ahead at a person's pace, the head up and down a step at a time
        e.goto = { x: 0, y: 60 };
        var rises = [], y5 = 0, y3 = 0;
        for (var i = 1; i <= 100; i++) {   // five seconds, a frame in twenty
          _aeHostEyeWalk(st, e, 0.05);
          rises.push(_aeHostGait(e).rise);
          if (i === 60) y3 = e.y;
          if (i === 100) y5 = e.y;
        }
        out.pace = (y5 - y3) / 2;
        var crossings = 0;
        for (var k = 1; k < rises.length; k++) if ((rises[k - 1] < 0) !== (rises[k] < 0)) crossings++;
        out.steps = e.gait; out.crossings = crossings; out.bob = [Math.min.apply(null, rises), Math.max.apply(null, rises)];
        // behind it: the head turns first, no ground covered meanwhile
        e.x = 0; e.y = 0; e.yaw = 0; e.v = 0; e.goto = { x: 0, y: -30 };
        _aeHostEyeWalk(st, e, 0.05);
        out.turnFirst = [e.y === 0, Math.abs(e.yaw) > 0.01];
        // a key takes the walk back
        e.keys = { f: true }; _aeHostEyeWalk(st, e, 0.05); e.keys = {};
        out.keyTook = e.goto === null;
        // a long way runs time, not a faster person: no gait there
        e.x = 0; e.y = 0; e.yaw = 0; e.v = 1; e.gaitAmp = 1; e.goto = { x: 0, y: 900 };
        for (var j = 0; j < 40; j++) _aeHostEyeWalk(st, e, 0.05);
        out.far = [e.gaitAmp < 0.05, e.y / 2];
        // it stops at the place
        e.x = 0; e.y = 0; e.yaw = 0; e.v = 0; e.gaitAmp = 0; e.goto = { x: 0, y: 5 };
        for (var m = 0; m < 400 && e.goto; m++) _aeHostEyeWalk(st, e, 0.05);
        out.arrived = [e.goto === null, Math.abs(e.y - 5) < 0.6];
        e.goto = null;
        return out;
      }""")
    assert got["asked"] == [30, 900], got
    assert 1.2 < got["pace"] < 1.5, got  # 5 km/h is 1.39 m/s
    assert (
        abs(got["crossings"] - 2 * got["steps"]) <= 4 and got["steps"] > 5
    ), got  # the head rises and falls once a step
    assert got["bob"][0] < -0.015 and got["bob"][1] > 0.015, got
    assert got["turnFirst"] == [True, True] and got["keyTook"] is True, got
    assert (
        got["far"][0] and got["far"][1] > 3
    ), got  # (m/s, covering ground: time runs, and it is not a gait)
    assert got["arrived"] == [True, True], got
    # a real touch on the ground in sight is that walk
    page.evaluate("() => { var e = _ae.site.eye; e.goto = null; e.x = 0; e.y = 0; }")
    page.touchscreen.tap(195, 560)
    page.wait_for_function(
        "() => !!_ae.site.eye.goto || _ae.site.eye.y !== 0 || _ae.site.eye.x !== 0",
        timeout=60_000,
        polling=250,
    )
    assert not page.errors, page.errors


def test_a_walk_shows_where_it_is_going_and_a_tapped_thing_is_walked_up_to_not_past(
    page,
):
    """a pillar of light over the place walked to; a tap on a thing stops short of it."""
    _visit(page, "moon", "Apollo 17")
    page.wait_for_function(
        "() => !document.getElementById('as-eye').hidden", timeout=60_000, polling=250
    )
    page.evaluate("() => document.getElementById('as-eye').click()")
    page.wait_for_function("() => _ae.site.eye && _ae.site.eye.on", timeout=30_000)
    got = page.evaluate("""() => new Promise(function (done) {
        var st = _ae.site, e = st.eye, out = {};
        e.x = 0; e.y = 0; e.yaw = 0; e.v = 0; e.goto = null; e.keys = {}; st.input.sx = st.input.sy = 0;
        var part = st.siteParts.map(function (sp) { return sp.body || sp; }).filter(function (p) { return Math.hypot(p.x, p.y) > 8; })[0];
        out.part = !!part;
        _aeHostWalkTo(st, part.x, part.y, part.size * 0.5 + AE_TAPWALK_STANDOFF_M);
        var gap = Math.hypot(e.goto.x - part.x, e.goto.y - part.y), full = Math.hypot(part.x, part.y);
        out.standoff = [gap, part.size * 0.5 + AE_TAPWALK_STANDOFF_M, full];
        var tries = 0;
        (function look() {
          if (st.autoMark && st.autoMark.visible) {
            out.mark = [st.autoMark.position.x, st.autoMark.position.y, part.x, part.y];
            e.goto = null; _aeHostWalkMark(st);
            out.gone = st.autoMark.visible === false;
            return done(out);
          }
          if (++tries > 100) { out.mark = null; return done(out); }
          setTimeout(look, 100);
        })();
      })""")
    assert got["part"], got
    assert (
        abs(got["standoff"][0] - got["standoff"][1]) < 0.01
        and got["standoff"][2] > got["standoff"][1]
    ), got
    assert (
        got["mark"]
        and abs(got["mark"][0] - got["mark"][2]) < 0.01
        and abs(got["mark"][1] - got["mark"][3]) < 0.01
    ), got
    assert got["gone"] is True, got
    assert not page.errors, page.errors


def test_the_sites_name_in_the_corner_opens_the_sites_own_sheet_not_the_moons(page):
    """at Chandrayaan-3 the corner's name opened the Moon's facts; it opens what landed there and when."""
    _visit(page, "moon", "Chandrayaan-3")
    page.wait_for_function(
        "() => document.getElementById('ah-info') && !document.getElementById('ah-info').hidden",
        timeout=60_000,
        polling=250,
    )
    page.evaluate("() => document.getElementById('ah-info').click()")
    page.wait_for_function(
        "() => _ae.info && document.getElementById('ae-info').classList.contains('in')",
        timeout=10_000,
    )
    got = page.evaluate(
        "() => ({ key: _ae.info, text: document.getElementById('ae-info').innerText })"
    )
    assert got["key"] == "site-facts", got
    for word in ("Chandrayaan-3", "Vikram", "Pragyan", "Landed", "2023", "Moon"):
        assert word in got["text"], got
    page.evaluate("() => _aeCloseInfo(false)")
    assert not page.errors, page.errors


def test_gold_foil_detail_fades_octave_by_octave_before_it_can_shimmer(page):
    """the lander's foil swam as the view moved: crinkle finer than ~3 px and a 0.1 m grain with no fade at all."""
    _visit(page, "moon", "Chandrayaan-3")
    got = page.evaluate("""() => {
        var foil = AE_CRAFT_GLSL_SURFACE.split('kd > 1.5 && kd < 2.5')[1].split('kd > 2.5')[0];
        var noisy = foil.split('\\n').filter(function (l) { return /aeVnv?\\(po/.test(l); });
        return { noisy: noisy, fades: (foil.match(/aeOctave\\(/g) || []).length, compiled: !_ae.gl.renderer.info.programs || _ae.gl.renderer.info.programs.length > 0 };
      }""")
    assert got["fades"] >= 4, got
    for line in got["noisy"]:
        assert (
            "w1 *" in line or "w2 *" in line or "w3 *" in line or "w4 *" in line
        ), line
    assert got["compiled"], got
    assert not page.errors, page.errors
