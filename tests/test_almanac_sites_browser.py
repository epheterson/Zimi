"""The landing sites of the 3D view on a rendered page (almanac-sites*.js): the models stand where the landmarks put the
landings, the ground is lit by the Sun's real direction, the rover drives and keeps its wheels on the ground, the launch
leaves the pad, and the route's rover is where the route says. Headless Chromium at a phone's size, software GL (a frame
takes about a second, so the physics is run on its fixed step through the page's own test hooks; what is drawn is checked
by the state and by one screenshot a test).

Run: pytest tests/test_almanac_sites_browser.py -v
"""

import json
import math
import os
import re
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 300_000
STAND_MS = 240_000
SHOTS = os.environ.get(
    "ZIMI_SITE_SHOTS", ""
)  # a folder to keep the screenshots in (else they are not saved)
DEG_TOL = 2e-3  # about 60 m on the Moon: the flags and parked rovers stand tens of metres from the lander
MIN_M_PER_DEG = 29000  # a degree of the Moon, the smallest body a site is on (Mars: 59,000): the offsets of parts, in degrees
SITE_JSON = os.path.join(ROOT, "zimi", "static", "earth", "sites-v1.json")
LM_JSON = os.path.join(ROOT, "zimi", "static", "earth", "landmarks-v1.json")


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("sites")
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
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=240_000,
        )
        pg.evaluate("(t) => openAlmanacEarth({ target: t })", "moon")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=READY_MS,
            polling=200,
        )
        pg.evaluate("() => _aeLmLoad()")
        pg.wait_for_function("() => !!_aeLm", timeout=60_000)
        pg.errors = errors
        yield pg
        br.close()


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def _visit(pg, body, name, drive=False, at=None):
    """Leave any site, go to the body (at the instant `at`, else now), press the card's button for `name` and wait until it
    stands on the ground."""
    pg.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    pg.evaluate("(ms) => { if (ms === null) _aeNow(); else _aeGoTo(ms); }", at)
    pg.evaluate("(b) => _aePreset(b)", body)
    pg.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)   # a flight is real seconds at a few frames a second on software GL
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
    return pg.evaluate("() => _aeSiteState()")


def _landmark(body, name):
    with open(LM_JSON, encoding="utf-8") as fh:
        return [r for r in json.load(fh)[body] if r[0] == name][0]


def _site(name):
    with open(SITE_JSON, encoding="utf-8") as fh:
        return [s for s in json.load(fh)["sites"] if s["name"] == name][0]


def _close(a, b):
    return abs(a - b) < DEG_TOL


def test_the_card_of_a_landing_offers_a_visit_and_a_drive(page):
    page.evaluate(
        "() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }"
    )
    page.evaluate(
        "() => _aeLmOpen('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0])"
    )
    page.wait_for_function(
        "() => !!document.getElementById('as-visit') && !!document.getElementById('as-drive')",
        timeout=120_000,
        polling=250,
    )
    # The visit is the card's one solid word, "See it", so it is named by its text, not an aria-label.
    assert (
        page.evaluate("() => document.getElementById('as-visit').textContent.trim()")
        == "See it"
    )
    _shot(page, "card")


@pytest.mark.parametrize(
    "body,name",
    [
        ("moon", "Apollo 11"),
        ("moon", "Apollo 17"),
        ("moon", "Chang'e 4"),
        ("mars", "Viking 1"),
        ("mars", "Curiosity"),
        ("mars", "Perseverance"),
        ("mars", "InSight"),
    ],
)
def test_every_model_stands_at_the_latitude_and_longitude_of_its_landing(
    page, body, name
):
    """The part's place, taken back from the scene through the body's turn, is the landmark's own latitude and longitude."""
    st = _visit(page, body, name)
    row = _landmark(body, name)
    assert st["body"] == body and st["name"] == name
    assert len(st["parts"]) >= 1
    for p in st["parts"]:
        # A part stands as far from the landing as the data puts it (an ALSEP is 190 m off): that many degrees more.
        tol = DEG_TOL + math.hypot(p["x"], p["y"]) / MIN_M_PER_DEG
        assert abs(p["lat"] - row[1]) < tol and abs(p["lon"] - row[2]) < tol * 1.5, "%s %s at %.5f, %.5f, the landing is %.5f, %.5f" % (
            name,
            p["model"],
            p["lat"],
            p["lon"],
            row[1],
            row[2],
        )
        if p["model"].endswith("-wheel"):
            assert (
                0.2 < p["z"] - p["ground"] < 0.45
            ), "a wheel's hub is its radius over the ground"
        elif p["model"] != "saturn5":
            assert abs(p["z"] - p["ground"]) < 0.12, (
                "%s stands on the ground there" % p["model"]
            )
    _shot(page, "site-" + name.replace(" ", "").replace("'", ""))


def test_the_ground_is_lit_by_the_suns_real_direction(page):
    """At Apollo 11's touchdown the Sun stood about 14 degrees up in the east: the sine of that, from the scene itself."""
    st = _visit(page, "moon", "Apollo 11", at=_site("Apollo 11")["ms"])
    page.wait_for_function(
        "() => !!_ae.site.shadowSun", timeout=60_000, polling=250
    )  # the shadows' direction is set a frame or so after the visit
    sc = page.evaluate(
        "() => { var s = _ae.site; return { sun: s.fr.sunLocal, now: _ae.scene.ms, landing: s.def.ms, shadow: s.shadowSun }; }"
    )
    assert abs(sc["now"] - sc["landing"]) < 3600 * 1000, "the clock is at the landing"
    assert 0.1 < sc["sun"][2] < 0.4, (
        "the Sun %.2f over the horizon (sine)" % sc["sun"][2]
    )
    assert sc["sun"][0] > 0.8, "in the east"
    assert (
        sc["shadow"][0] > 0 and sc["shadow"][2] >= 0.05
    ), "the shadows are thrown along the same direction"
    assert st["sunZ"] == pytest.approx(sc["sun"][2], abs=1e-6)


def test_a_site_in_the_dark_opens_at_its_landing(page):
    # A dark time at Apollo 12's site (the Sun under the horizon there), as the page itself reckons it.
    dark = page.evaluate(
        """() => { var row = _aeLm.moon.filter(r => r[0] === 'Apollo 12')[0], t0 = Date.UTC(2026, 0, 1);
          for (var h = 0; h < 24 * 30; h += 6) if (_aeLmSunAt(row, t0 + h * 3600000) < -0.3) return t0 + h * 3600000;
          return null; }"""
    )
    assert dark is not None
    _visit(page, "moon", "Apollo 12", at=dark)
    ms_landing = _site("Apollo 12")["ms"]
    assert (
        abs(page.evaluate("() => _ae.scene.ms") - ms_landing) < 6 * 3600 * 1000
    ), "it opens at the landing, in daylight"
    assert page.evaluate("() => _aeSiteState().sunZ") > 0.03
    assert page.evaluate("() => !document.getElementById('as-landing')"), "no Landing button: the time chip is the way to another time"


def test_the_rover_drives_and_its_wheels_stay_on_the_ground(page):
    st = _visit(page, "moon", "Apollo 15", drive=True)
    assert st["rover"]["airborne"] is False
    x0, y0 = st["rover"]["x"], st["rover"]["y"]
    worst, far = 0.0, 0.0
    for keys in ({"f": 1, "l": 1}, {"f": 1}, {"f": 1, "r": 1}, {"b": 1}):
        page.evaluate(
            "(k) => { var i = _ae.site.input.keys; ['f','b','l','r'].forEach(n => i[n] = !!k[n]); }",
            keys,
        )
        for _ in range(8):
            page.evaluate("() => _aeSiteAdvance(0.5)")
            r = page.evaluate("() => _aeSiteState().rover")
            far = max(far, math.hypot(r["x"] - x0, r["y"] - y0))
            for w in r["wheels"]:
                worst = max(worst, abs(w["z"] - w["ground"] - 0.41))
    page.evaluate(
        "() => { var i = _ae.site.input.keys; i.f = i.b = i.l = i.r = false; }"
    )
    r = page.evaluate("() => _aeSiteState().rover")
    assert far > 10, "it went somewhere (%.1f m from where it began)" % far
    assert worst < 1e-6, (
        "every wheel's hub stood its radius over the ground under it (%.2e off)" % worst
    )
    assert abs(r["pitch"]) < 0.3 and abs(r["roll"]) < 0.3
    _shot(page, "drive")


def test_a_mars_rover_has_six_wheels_and_the_ground_there_is_not_the_moons(page):
    st = _visit(page, "mars", "Perseverance", drive=True)
    assert len(st["rover"]["wheels"]) == 6
    page.evaluate(
        "() => { _ae.site.input.keys.f = true; _aeSiteAdvance(4); _ae.site.input.keys.f = false; }"
    )
    r = page.evaluate("() => _aeSiteState().rover")
    assert 0.05 < r["y"] - st["rover"]["y"] < 1, "it drives, at a Mars rover's own pace (centimetres a second: 4 s is a hand's width, not five metres)"
    assert all(abs(w["z"] - w["ground"] - 0.263) < 1e-3 for w in r["wheels"])
    _shot(page, "mars-drive")


def test_the_saturn_v_stands_on_the_pad_and_a_launch_takes_it_away(page):
    st = _visit(page, "earth", "Cape Canaveral")
    saturn = [p for p in st["parts"] if p["model"] == "saturn5"][0]
    pad = _site("Cape Canaveral")["pad"]
    assert _close(saturn["lat"], pad["lat"]) and _close(saturn["lon"], pad["lon"])
    page.evaluate("() => document.getElementById('as-launch').click()")
    page.wait_for_function("() => !!_ae.site.launch", timeout=60_000, polling=250)
    page.evaluate("() => _aeSiteLaunchAdvance(3)")
    assert (
        page.evaluate("() => _ae.site.launch.phase") == "count"
    ), "the count is running"
    page.evaluate("() => _aeSiteLaunchAdvance(2.2)")
    assert page.evaluate("() => _ae.site.launch.phase") == "fly", "and at zero it flies"
    page.evaluate("() => _aeSiteLaunchAdvance(30)")
    alt = page.evaluate(
        "() => { var l = _ae.site.launch; return _asLaunchAt(l.rows, l.t).z - l.padZ; }"
    )
    assert alt > 500, "half a minute after lift-off it is %.0f m up" % alt
    _shot(page, "launch")


def test_the_routes_rover_is_where_its_route_says(page):
    st = _visit(page, "mars", "Curiosity")
    page.evaluate("() => document.getElementById('as-trailbtn').click()")
    try:
        page.wait_for_function("() => !!_ae.site.trail", timeout=60_000, polling=250)
    except Exception:
        pytest.fail("the route did not start: %s" % page.errors)
    page.evaluate(
        "() => { var t = _ae.site.trail; t.playing = false; t.sol = 3000; _asTrailStep(_ae.site, 1 / 60); }"
    )
    got = page.evaluate(
        "() => { var s = _ae.site, st = _aeSiteState(); return { sol: s.trail.sol, parts: st.parts.filter(p => p.model === 'curiosity-body').map(p => [p.lat, p.lon]) }; }"
    )
    with open(
        os.path.join(ROOT, "zimi", "static", "earth", "traverses-v1.json"),
        encoding="utf-8",
    ) as fh:
        pts = json.load(fh)["msl"]["points"]
    near = min(pts, key=lambda p: abs(p[0] - 3000))
    lat, lon = got["parts"][0]
    assert (
        abs(lat - near[1]) < 0.01 and abs(lon - near[2]) < 0.01
    ), "sol 3000: the route has it at %.4f, %.4f, the scene at %.4f, %.4f" % (
        near[1],
        near[2],
        lat,
        lon,
    )
    _shot(page, "route")


def test_the_controls_fit_a_phone_on_its_side(page):
    """At 844 x 390 every control is on the screen and the thumbs' corner is clear of the info corner's words."""
    _visit(page, "moon", "Apollo 15", drive=True)
    page.set_viewport_size({"width": 844, "height": 390})
    page.evaluate("() => _aeResize()")
    page.wait_for_function("() => _ae.w === 844", timeout=120_000, polling=250)
    boxes = page.evaluate(
        """() => ['as-rest', 'ah-info'].map(id => {
          var r = document.getElementById(id).getBoundingClientRect();
          return [id, r.left, r.top, r.right, r.bottom];
        })"""
    )
    for id_, left, top, right, bottom in boxes:
        assert (
            left >= 0 and right <= 844 and top >= 0 and bottom <= 390
        ), "%s is on the screen (%s)" % (id_, [left, top, right, bottom])
    by = {b[0]: b for b in boxes}
    overlap = lambda p, q: p[1] < q[3] and q[1] < p[3] and p[2] < q[4] and q[2] < p[4]
    assert not overlap(by["ah-info"], by["as-rest"]), "the info corner does not cover the stick's ring"
    _shot(page, "landscape")
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate("() => _aeResize()")
    page.wait_for_function("() => _ae.w === 390", timeout=120_000, polling=250)


@pytest.mark.parametrize("probe", ["voyager1", "newhorizons", "juno", "psyche"])
def test_a_probes_sheet_replays_its_flight_from_launch(page, probe):
    """Replay flight from launch: the probe is what is in view and followed, the clock is at its launch and slow enough to
    watch (never the whole solar system at a year in twelve seconds with nothing marked). Voyager opens its mission at the
    launch phase, playing."""
    page.evaluate("() => { if (_ae.mission && typeof _amStop === 'function') _amStop(); if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    page.evaluate("() => _aeNow()")
    page.evaluate("() => _aeTracksLoad()")
    page.wait_for_function("(k) => !!_aeBodyPos(k)", arg=probe, timeout=120_000, polling=250)
    page.evaluate("(k) => _aePreset(k)", probe)
    page.wait_for_function("() => !_ae.fly", timeout=120_000, polling=250)
    page.evaluate("() => document.getElementById('ae-info-btn').click()")
    page.wait_for_function("() => !!document.querySelector('[data-ae-replay]')", timeout=60_000, polling=250)
    page.evaluate("() => document.querySelector('[data-ae-replay]').click()")
    launch = page.evaluate("(k) => _aeLaunchMs(k)", probe)
    if probe.startswith("voyager"):
        page.wait_for_function("() => !!_ae.mission && !!_ae.mission.pose", timeout=120_000, polling=250)
        assert page.evaluate("() => _ae.mission.id") == probe
        assert page.evaluate("() => _ae.mission.paused") is False
    else:
        assert page.evaluate("() => _ae.preset") == probe, "the view is on the probe, not the empty solar system"
        assert page.evaluate("() => _ae.target") == probe, "the probe is the one marked and followed"
        rate = page.evaluate("() => _almRate")
        assert 0 < rate <= 3600, "slow enough to watch the departure, got %s" % rate
    assert abs(page.evaluate("() => _aeDisplayMs()") - launch) < 3 * 86400 * 1000, "the clock is at the launch"
    if probe.startswith("voyager"):
        page.evaluate("() => _amStop()")
    page.evaluate("() => _aeNow()")


def test_a_stand_point_a_pin_and_a_visit_are_one_place_on_the_flattened_earth(page):
    """Cape Canaveral's own place: the point the landmark pin takes, the point Stand here aims its flight at and the visit's
    origin are one point of the Earth's flattened globe (they were up to 20 km apart when one of them used a round Earth).
    """
    _visit(page, "earth", "Cape Canaveral")
    got = page.evaluate(
        """() => { var s = _ae.site, b = _asBody('earth'), pin = _aeLmDir(b, s.lat, s.lon),
          aim = _aeStToScene(_aeStBodyNow('earth'), _aeStPlaceVec('earth', s.lat, s.lon)),
          o = _aeSub(_asToWorld(s.fr, [0, 0, 0]), b.center), back = _asLatLon(s, b, [0, 0, 0]);
          return { pin: pin, aim: aim, origin: o, lat: s.lat, lon: s.lon, back: back }; }"""
    )
    for k in range(3):
        assert abs(got["aim"][k] - got["pin"][k]) < 1e-9, got
        assert (
            abs(got["origin"][k] - got["pin"][k]) < 2e-5
        ), got  # the visit's origin sits a few metres over it
    assert (
        abs(got["back"]["lat"] - got["lat"]) < 0.01
        and abs(got["back"]["lon"] - got["lon"]) < 0.01
    ), got


def test_no_script_error_came_up(page):
    assert page.errors == []


def test_apollo_11_stands_with_what_the_crew_left_and_the_ground_has_its_craters(page):
    """The parts of the Apollo 11 row stand on the ground, its footpaths are laid, and Little West Crater is a bowl at the place
    the USGS map puts it."""
    site = _site("Apollo 11")
    st = _visit(page, "moon", "Apollo 11", at=site["ms"] + 3 * 3600 * 1000)
    assert sorted(p["model"] for p in st["parts"]) == sorted(p["m"] for p in site["parts"])
    for p in st["parts"]:
        assert abs(p["z"] - p["ground"]) < 0.12, p["model"]
    assert page.evaluate("() => !!_ae.site.tracksMesh")
    lw = [r for r in site["relief"] if r["n"] == "Little West Crater"][0]
    middle, rim = page.evaluate(
        "([x, y, r]) => [_asGroundAt(_ae.site, x, y, false), _asGroundAt(_ae.site, x + r, y, false)]",
        [lw["x"], lw["y"], lw["r"]],
    )
    assert rim - middle > 0.6 * lw["d"], "the bowl is %.1f m under its rim (%.1f m deep)" % (rim - middle, lw["d"])
    _shot(page, "apollo-11")


def test_cone_crater_is_a_bowl_beside_apollo_14(page):
    site = _site("Apollo 14")
    _visit(page, "moon", "Apollo 14", at=site["ms"] + 3 * 3600 * 1000)
    cone = site["relief"][0]
    # The relief alone (the ground under it is the real height map, a ridge there that swings by tens of metres).
    middle, rim = page.evaluate(
        "([rows, x, y, r]) => [_asRelief(rows, x, y), _asRelief(rows, x + 1.3 * r, y)]",
        [site["relief"], cone["x"], cone["y"], cone["r"]],
    )
    assert rim - middle > 60, "Cone is a bowl about 75 m deep under a rim (%.0f m between its middle and its rim)" % (rim - middle)
    ground = page.evaluate("([x, y]) => _asGroundAt(_ae.site, x, y, true)", [cone["x"], cone["y"]])
    assert isinstance(ground, (int, float))


def test_every_part_answers_a_tap_a_second_tap_goes_home_and_the_camera_stays_out_of_the_lander(page):
    """Apollo 11 in its own hour: each part standing then (the lander too) is named by a tap on it; tapping it again, or the empty
    ground, goes back to the site's first view; a pinch in to the nearest never puts the camera inside the Lunar Module."""
    site = _site("Apollo 11")
    _visit(page, "moon", "Apollo 11", at=site["ms"] + 3 * 3600 * 1000)
    models = page.evaluate(
        "() => _ae.site.siteParts.map(sp => sp.body || sp).filter(p => p.holder.visible).map(p => p.model)"
    )
    assert {"lm", "lm-ascent", "flag", "lrrr-11", "psep", "tv"} <= set(models) and "flag-down" not in models
    for m in models:
        # the point of the screen is read and tapped in one go: the camera does not move between them
        got = page.evaluate(
            """(m) => { var st = _ae.site, part = st.siteParts.map(sp => sp.body || sp).filter(p => p.model === m)[0], sc = _asPartScreen(st, part);
              st.tappedPart = null; _asTapPart(st, sc.x, sc.y); return st.tapped; }""",
            m,
        )
        assert got == "alm_site_p_" + re.sub(r"-\d+$", "", m).replace("-", "_"), "a tap on %s names %s" % (m, got)
    home = page.evaluate("() => _ae.site.home")
    again = page.evaluate(
        """() => { var st = _ae.site, part = st.siteParts.map(sp => sp.body || sp).filter(p => p.model === 'tv')[0], sc = _asPartScreen(st, part);
          st.tappedPart = null; _asTapPart(st, sc.x, sc.y); _asTapPart(st, sc.x, sc.y); return { t: st.tapped, xy: st.focusXY, d: st.distTo }; }"""
    )
    assert again["t"] is None and again["xy"] == home["xy"] and again["d"] == home["dist"], "a second tap goes home"
    gap = page.evaluate(
        """() => { var st = _ae.site; st.camera.dist = 2.5; st.camera.el = 0.3; st.focusXY = [0, 0]; st.fcur = null; st.distTo = 0;
          var p = _asCameraLocal(st, 0.016).pos, lm = st.siteParts.map(sp => sp.body || sp).filter(q => q.model === 'lm')[0];
          return { d: Math.hypot(p[0] - lm.x, p[1] - lm.y, p[2] - (lm.z + lm.size * 0.3)), r: lm.size * AS_PART_CLEAR }; }"""
    )
    assert gap["d"] >= gap["r"] - 1e-6, "the camera is %.1f m from the lander's middle, not inside its %.1f m" % (gap["d"], gap["r"])


def _screen_of(page, model):
    return page.evaluate(
        """(m) => { var st = _ae.site, p = st.siteParts.map(sp => sp.body || sp).filter(q => q.model === m)[0]; var s = _asPartScreen(st, p);
          return s && { x: s.x, y: s.y, r: s.r, w: _ae.w, h: _ae.h }; }""",
        model,
    )


def test_a_visit_opens_on_the_whole_scene_and_the_view_can_walk_pan_and_come_back(page):
    """Apollo 11 at its own hour: everything within 45 m of the lander is in the picture on arrival; a tap within 44 px of a part's
    bounds is for it; a tap on the ground walks the view there; two fingers pan it; the whole-site control (and a second tap) bring it back."""
    site = _site("Apollo 11")
    _visit(page, "moon", "Apollo 11", at=site["ms"] + 3 * 3600 * 1000)
    page.wait_for_timeout(2500)
    for p in site["parts"]:
        if p["m"] in ("lm-ascent",) or (p["x"] ** 2 + p["y"] ** 2) ** 0.5 > 45 or "until" in p and p["until"] < site["ms"] + 3 * 3600 * 1000:
            continue
        s = _screen_of(page, p["m"])
        assert s and 0 < s["x"] < s["w"] and 0 < s["y"] < s["h"], "%s is in the arrival picture" % p["m"]
    items = page.evaluate("() => Array.from(document.querySelectorAll('#as-strip .as-item')).map(b => ({ n: b.querySelector('b').textContent, d: b.querySelector('small').textContent, pic: b.querySelector('i').getAttribute('style') || '' }))")
    assert len(items) >= 6 and all(i["n"] for i in items), "the strip names every part standing: %s" % items
    assert items[0]["d"] == "" and items[0]["pic"], "nearest first (the lander, 0 m) with its picture"
    assert page.evaluate("() => { var b = document.querySelectorAll('#as-strip .as-item')[2]; b.click(); return _ae.site.tapped === _asPartNameKey(b._part.model) && b._part === _ae.site.tappedPart; }"), "a tap on the strip goes to the part"
    page.wait_for_timeout(300)
    assert page.evaluate("() => !document.getElementById('as-whole').hidden"), "away from the arrival view the Whole site button is there ('missing that now?')"
    page.evaluate("() => _asWholeSite(_ae.site)")
    page.wait_for_function("() => !_ae.site.distTo", timeout=10_000, polling=100)   # (the view eases back to the whole site: a tap is judged on the picture as it stands)
    page.wait_for_timeout(300)
    home = page.evaluate("() => ({ xy: _ae.site.home.xy, d: _ae.site.home.dist })")
    assert page.evaluate("() => _ae.site.camera.el") > 0.4, "from a three-quarter height"
    lrrr = _screen_of(page, "lrrr-11")
    got = page.evaluate("([x, y]) => { _asTapPart(_ae.site, x, y + 40); return _ae.site.tapped; }", [lrrr["x"], lrrr["y"]])
    assert got is not None, "a tap 40 px off a part is still for it"
    page.evaluate("() => _asWholeSite(_ae.site)")
    walked = page.evaluate(
        "() => { var st = _ae.site, g = _asGroundPick(st, _ae.w * 0.8, _ae.h * 0.75); _asTapPart(st, _ae.w * 0.8, _ae.h * 0.75); return { g: g, f: st.focusXY, t: st.tapped, goto: !!(st.eye && st.eye.goto), eye: _aeHostEyeOn(st) }; }"
    )
    # With the ground's own view live a tap on the ground steps the eye out and walks it there (503e5fb28: the eye goes to the place; the orbit's
    # focus stays); otherwise the orbit's focus moves to it.
    walks = walked["goto"] and walked["eye"] if walked["goto"] or walked["eye"] else walked["f"] != home["xy"]
    assert walked["g"] is not None and walked["t"] is None and walks, ("a tap on the ground walks there", walked)
    panned = page.evaluate("() => { var st = _ae.site, a = st.focusXY.slice(); _asPan(st, 100, 0); return [a, st.focusXY]; }")
    assert panned[0] != panned[1], "two fingers pan"
    far = page.evaluate("() => { _asWalkTo(_ae.site, 9999, 0); var f = _ae.site.focusXY; return Math.hypot(f[0], f[1]); }")
    assert far <= 250.01, "the walk stays within 250 m of the lander"
    page.evaluate("() => document.getElementById('as-whole').click()")
    assert page.evaluate("() => _ae.site.focusXY") == home["xy"], "the whole-site control comes back to the arrival view"


def test_the_apollo_17_rover_is_marked_and_the_liftoff_runs(page):
    """The rover is 140 m off: it wears a marker to tap. Watching the liftoff lifts the ascent stage on its own engine's figures and
    ends with the stage gone and the clock after the liftoff."""
    site = _site("Apollo 17")
    _visit(page, "moon", "Apollo 17", at=site["ms"] + 3 * 3600 * 1000)
    page.wait_for_timeout(2500)
    dots = page.evaluate(
        "() => Array.from(document.querySelectorAll('#as-dots i')).filter(i => i.style.display !== 'none' && i._part).map(i => String(i._part.model))"
    )
    where = page.evaluate("() => { var st = _ae.site, p = st.siteParts.map(sp => sp.body || sp).filter(q => /lrv/.test(q.model))[0]; return p && { vis: p.holder.visible, s: _asPartScreen(st, p), size: p.size, w: _ae.w, h: _ae.h }; }")
    assert any(m.startswith("lrv") for m in dots), "the rover has a marker (%s; %s)" % (dots, where)
    row = page.evaluate("() => { var r = _asAscentFlight(1.62); return [r[100], r[300], r[700]]; }")
    assert 8 < row[0][2] < 120 and row[1][2] > row[0][2] and row[2][1] > row[1][1] > 0, "vertical rise, then forward: %s" % row
    page.evaluate("() => _asAscentStart(_ae.site)")
    page.wait_for_function("() => _ae.site.ascent && _ae.site.ascent.t > 0.5", timeout=120_000, polling=500)
    z = page.evaluate("() => _asAscentRow(_ae.site.ascent)[2]")
    assert z > 0, "the ascent stage is rising"
    page.evaluate("() => { _ae.site.ascent.t0 -= 80000; }")
    page.wait_for_function("() => !_ae.site.ascent", timeout=120_000, polling=500)
    assert page.evaluate("() => _aeDisplayMs()") >= site["liftoff"], "the clock is past the liftoff"


def test_cone_crater_is_on_the_horizon_from_the_apollo_14_lander(page):
    """Cone is 1.1 km away (its rim) to the east-north-east, not around the lander: looking toward it puts its rim in the picture, at
    the bearing and the angular size the data gives (the strip lists it, with its distance)."""
    site = _site("Apollo 14")
    _visit(page, "moon", "Apollo 14", at=site["ms"] + 3 * 3600 * 1000)
    page.wait_for_timeout(2000)
    cone = [r for r in site["relief"] if r["n"] == "Cone Crater"][0]
    items = page.evaluate("() => Array.from(document.querySelectorAll('#as-strip .as-item')).map(b => b.textContent)")
    assert any(t.startswith("Cone") and "km" in t for t in items), items
    page.evaluate("([x, y]) => { var st = _ae.site, p0 = st.pose; _asLookToward(st, x, y); window.__pose0 = p0; }", [cone["x"], cone["y"]])
    page.wait_for_function("() => _ae.site.pose !== window.__pose0", timeout=120_000, polling=250)   # a frame after the turn
    sc = page.evaluate(
        "([x, y, w]) => { var st = _ae.site; var s = _asScreenOf(st, [x, y, _asGroundAt(st, x, y, true) + w]); return s && { x: s.x, y: s.y, front: s.front, w: _ae.w, h: _ae.h }; }",
        [cone["x"], cone["y"], cone["w"]],
    )
    assert sc["front"] and 0 < sc["x"] < sc["w"] and 0 < sc["y"] < sc["h"], "Cone's rim is in the picture: %s" % sc
    bearing = math.degrees(math.atan2(cone["x"], cone["y"])) % 360
    assert 55 < bearing < 70, "east-north-east (%.0f degrees)" % bearing
    dist = math.hypot(cone["x"], cone["y"])
    assert 1.0 < (dist - cone["r"]) / 1000 < 1.3 and 2 * math.degrees(math.atan(cone["r"] / dist)) > 12, "about 14 degrees across"


def test_a_visit_over_the_same_body_is_one_move_down(page):
    """With the terrain already in, going to a site from the orbit view is one descent: the camera never rises and takes about AE_MOVE_MS."""
    _visit(page, "moon", "Apollo 15")  # the first visit brings the terrain in
    page.evaluate("() => _aeSiteLeave(true)")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate(
        "([b, n]) => _aeLmOpen(b, _aeLm[b].filter(r => r[0] === n)[0])", ["moon", "Apollo 15"]
    )
    page.wait_for_function("() => !!document.getElementById('as-visit')", timeout=120_000, polling=250)
    page.evaluate(
        """() => { window.__d = []; window.__stop = false;
        function s() { var c = _ae.gl.camera, m = _aeBodyPos('moon');
          window.__d.push([performance.now(), Math.hypot(c.position.x - m[0], c.position.y - m[1], c.position.z - m[2]), _ae.fly ? 1 : 0]);
          if (!window.__stop) requestAnimationFrame(s); }
        requestAnimationFrame(s); document.getElementById('as-visit').click(); }"""
    )
    page.wait_for_function(
        "() => { var s = _aeSiteState(); return s && s.phase === 'stand' && s.ready; }", timeout=STAND_MS, polling=500
    )
    page.evaluate("() => { window.__stop = true; }")
    d = page.evaluate("() => window.__d")
    assert page.evaluate("() => _ae.site.direct") is True
    assert not any(x[2] for x in d), "no separate flight before the drop"
    dist = [x[1] for x in d]
    assert all(b <= a + 1e-4 for a, b in zip(dist, dist[1:])), "the camera only ever goes down"
    page.evaluate("() => _aeSiteLeave(true)")


def test_a_visit_from_the_far_side_goes_round_the_body_and_never_through_it(page):
    """The one move down turns the camera's direction round the body's centre: from a camera over the other side of the Moon it never dips under the ground."""
    _visit(page, "moon", "Apollo 15")  # the terrain comes in
    page.evaluate("() => _aeSiteLeave(true)")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    # The camera on the side away from the site: straight over the Moon's far point.
    page.evaluate(
        """() => { var lm = _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0], d = _aeLmDir(_aeLmBodies().filter(x => x.key === 'moon')[0], lm[1], lm[2]);
          var azel = _aeAzElOf([-d[0], -d[1], -d[2]]); _ae.az = azel.az; _ae.el_ = azel.el; _ae.dist = AE_MOON_RADIUS_RE * 3; _ae.dirty = true; _aeKick(); }"""
    )
    page.wait_for_timeout(500)
    page.evaluate(
        """() => { window.__h = []; window.__stop = false;
        function s() { var st = _ae.site, c = _ae.gl.camera, m = _aeBodyPos('moon'), p = st && st.pose ? st.pose.pos : [c.position.x, c.position.y, c.position.z];
          window.__h.push(Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]) - AE_MOON_RADIUS_RE);
          if (!window.__stop) requestAnimationFrame(s); }
        requestAnimationFrame(s);
        _aeSiteVisit('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0], false); }"""
    )
    page.wait_for_function(
        "() => { var s = _aeSiteState(); return s && s.phase === 'stand' && s.ready; }", timeout=STAND_MS, polling=500
    )
    page.evaluate("() => { window.__stop = true; }")
    h = page.evaluate("() => window.__h")
    assert page.evaluate("() => _ae.site.direct") is True
    assert min(h) > -2e-4, min(h)   # never more than about a kilometre under the sphere (the site's own relief)
    page.evaluate("() => _aeSiteLeave(true)")


@pytest.mark.parametrize("from_behind", [False, True])
def test_a_visit_to_another_body_is_one_move_with_a_world_in_the_picture_every_frame(page, from_behind):
    """From the Earth to a Moon site: no zoom out and back in. The camera's height over the Moon only falls, the move is 2.2-4 s, and the Earth or the Moon is in
    the picture at every frame."""
    _visit(page, "moon", "Apollo 15")  # the Moon's terrain comes in
    page.evaluate("() => _aeSiteLeave(true)")
    page.evaluate("() => _aePreset('earth')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    if from_behind:   # the Earth view faces the person's place at this hour, so where the Moon stands in it is the time of day's: here the camera is on the Moon's far side
        page.evaluate(
            """() => { var m = _aeNorm(_aeBodyPos('moon')), perp = _aeNorm(_aeCross(m, [0, 0, 1])), u = _aeNorm(_aeAdd(_aeScale(m, -0.7), _aeScale(perp, 0.714))), a = _aeAzElOf(u);
              _ae.az = a.az; _ae.el_ = a.el; _ae.dirty = true; _aeKick(); }"""
        )
        page.wait_for_timeout(600)
    page.evaluate(
        """() => { window.__f = []; window.__stop = false;
        function seen(c, p, r) {   // a body's disc reaches into the picture
          var look = new c.position.constructor(0, 0, -1).applyQuaternion(c.quaternion), v = [p[0] - c.position.x, p[1] - c.position.y, p[2] - c.position.z], d = Math.hypot(v[0], v[1], v[2]);
          var off = Math.acos(Math.max(-1, Math.min(1, (v[0] * look.x + v[1] * look.y + v[2] * look.z) / d))), half = _aeRad(c.fov) / 2 * Math.max(1, c.aspect);
          return off - Math.asin(Math.min(1, r / d)) < half; }
        function s() { var st = _ae.site, c = _ae.gl.camera, m = _aeBodyPos('moon'), q = st && st.pose ? st.pose : null,
            p = q ? q.pos : [c.position.x, c.position.y, c.position.z];
          window.__f.push([performance.now(), Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]) - AE_MOON_RADIUS_RE, q ? 1 : 0, seen(c, [0, 0, 0], 1) || seen(c, m, AE_MOON_RADIUS_RE) ? 1 : 0, st ? st.phase : '']);
          if (!window.__stop) requestAnimationFrame(s); }
        requestAnimationFrame(s);
        _aeSiteVisit('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0], false); }"""
    )
    page.wait_for_function(
        "() => { var s = _aeSiteState(); return s && s.phase === 'stand' && s.ready; }", timeout=STAND_MS, polling=500
    )
    page.evaluate("() => { window.__stop = true; }")
    f = page.evaluate("() => window.__f")
    assert page.evaluate("() => _ae.site.far") is True
    h = [x[1] for x in f if x[4] in ("drop", "stand")]
    assert all(b <= a + 1e-3 for a, b in zip(h, h[1:])), "the height over the Moon only falls (no zoom out and in)"
    ms = page.evaluate("() => _ae.site.dropMs")
    assert 2200 <= ms <= 4000, ms
    assert all(x[3] for x in f if x[4] == "drop"), "the Earth or the Moon is in the picture at every frame of the move"
    page.evaluate("() => _aeSiteLeave(true)")


def test_the_ground_under_the_camera_follows_the_terrain_when_its_detail_tiles_arrive(page):
    """The high-resolution height tiles arrive after a visit begins and move the pad's height (176 m at Apollo 15): the ground the camera and the
    vehicle stand on must move with it, not stay on the height kept from before (the camera was left under the ground the mesh is built on)."""
    _visit(page, "moon", "Apollo 15")
    r = page.evaluate(
        """() => { var st = _ae.site, before = st.terrainHere(50, 0, false), orig = window._aeTerrainHeight, t = _aeTerr[st.body], had = t.hd;
          window._aeTerrainHeight = function (k, la, lo, lod) { var r = orig(k, la, lo, lod); return { h: r.h + 176, sea: r.sea }; };   // the whole terrain 176 m higher
          t.hd = { z: 0, px: 256, tiles: { arrived: new Float32Array(1) } };   // a tile has arrived
          var after = st.terrainHere(50, 0, false);
          window._aeTerrainHeight = orig; t.hd = had; return [before, after]; }"""
    )
    assert abs(r[0] - r[1]) < 1.0, r   # the pad is still the ground's zero: a uniform rise of the terrain moves nothing
    page.evaluate("() => _aeSiteLeave(true)")


REC = """() => { window.__x = []; window.__xs = false; (function s() { var c = _ae.gl.camera, m = _aeBodyPos('moon');
  window.__x.push([_ae.site ? 1 : 0, Math.hypot(c.position.x - m[0], c.position.y - m[1], c.position.z - m[2]), _ae.fly ? 1 : 0, [c.position.x - m[0], c.position.y - m[1], c.position.z - m[2]], _ae.scene.ms, performance.now()]);
  if (!window.__xs) requestAnimationFrame(s); })(); }"""


def test_space_from_a_visit_is_one_move_out_to_the_whole_body_with_the_site_in_the_middle(page):
    """Space from a site is one move up and out to the whole body (its own view's distance) with the spot the visit was at in the middle of the picture: the height
    only rises, no frame jumps, no flight follows it (it used to fly again to the zoom the view had before), and the clock does not jump (the visit's day stays:
    the site went dark at the hand-over when the clock went back to now)."""
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); _aeNow(); }")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => { _ae.dist *= 0.7; _ae.dirty = true; _aeKick(); }")   # a zoom of the person's own before going in
    _visit(page, "moon", "Apollo 15")
    page.evaluate(REC)
    page.evaluate("() => _aeRimPress('ae-rim')")
    page.wait_for_function("() => !_ae.site", timeout=120_000, polling=100)
    page.wait_for_timeout(600)
    page.evaluate("() => { window.__xs = true; }")
    f = page.evaluate("() => window.__x")
    h = [x[1] for x in f]
    assert all(b >= a - 1e-9 for a, b in zip(h, h[1:])), "the height over the Moon only rises on the way out, and nothing moves after"
    assert not any(x[2] for x in f), "no flight of its own after the move"
    k = next(i for i, x in enumerate(f) if not x[0])
    step = math.hypot(*[p - q for p, q in zip(f[k - 1][3], f[k][3])]) / max(1e-9, f[k - 1][1] - 0.2727)
    assert step < 0.5, ("a jump leaving the visit", f[k - 1][1], f[k][1])
    dms = [b[4] - a[4] for a, b in zip(f, f[1:])]
    real = [b[5] - a[5] for a, b in zip(f, f[1:])]
    assert all(abs(d - r) < 1000 for d, r in zip(dms, real)), "the clock goes on as it went: no jump back to now at the hand-over"
    end = page.evaluate(
        """() => { var lm = _ae.lm, b = _aeLmBodies(true).filter(x => x.key === 'moon')[0], m = _aeBodyPos('moon'), c = _aeProject(m),
             p = _aeProject(_aeAdd(m, _aeScale(_aeLmRowDir(b, lm.row), AE_MOON_RADIUS_RE)));
           return { dx: p.x - c.x, dy: p.y - c.y, dist: _ae.dist, fit: _aeBodyFitDist('moon'), target: _ae.target }; }"""
    )
    assert end["target"] == "moon" and end["dist"] == pytest.approx(end["fit"], rel=1e-6), end
    assert abs(end["dx"]) < 2 and abs(end["dy"]) < 2, ("the site's spot is in the middle of the body", end)


def test_the_rim_from_the_body_goes_down_into_the_visit_in_one_move_from_any_zoom(page):
    """Surface from the body's view, the site's card up: the visit's own way down (the way Space came out of it, backwards), in one move from wherever the view
    stands, a zoom of the person's own included: no flight to a stop first and then the drop."""
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("([b, n]) => _aeLmOpen(b, _aeLm[b].filter(r => r[0] === n)[0])", ["moon", "Apollo 15"])
    page.wait_for_function("() => !!document.getElementById('as-visit') && !_ae.fly", timeout=120_000, polling=250)
    page.evaluate("() => { _ae.dist *= 1.3; _ae.dirty = true; _aeKick(); }")
    # The camera eases out to the new zoom over a number of frames, however long each takes (seconds each on software GL): the move is
    # recorded from where it has come to rest, not from the middle of that ease.
    page.wait_for_function(
        """() => { var c = _ae.gl.camera, m = _aeBodyPos('moon'), d = Math.hypot(c.position.x - m[0], c.position.y - m[1], c.position.z - m[2]);
          window.__restRun = window.__restPrev !== undefined && Math.abs(d - window.__restPrev) < 1e-9 ? (window.__restRun || 0) + 1 : 0; window.__restPrev = d; return window.__restRun >= 6; }""",
        timeout=60_000,
        polling="raf",
    )
    assert page.evaluate("() => _aeRimState().label") == page.evaluate("() => _aeT('alm_stand_here')")
    page.evaluate(REC)
    page.evaluate("() => _aeRimPress('ae-rim')")
    page.wait_for_function("() => { var s = _aeSiteState(); return s && s.phase === 'stand' && s.ready; }", timeout=STAND_MS, polling=500)
    page.evaluate("() => { window.__xs = true; }")
    f = page.evaluate("() => window.__x")
    assert not any(x[2] for x in f), "no separate flight before the drop"
    h = [x[1] for x in f]
    assert all(b <= a + 1e-4 for a, b in zip(h, h[1:])), ("the camera only ever goes down", [(i, round(a, 5), round(b, 5)) for i, (a, b) in enumerate(zip(h, h[1:])) if b > a + 1e-4], len(h))
    assert h[0] > 2 * 0.2727, "from where the view stood"
    page.evaluate("() => _aeSiteLeave(true)")


def test_leaving_a_long_visit_hands_back_the_live_clock(page):
    """A visit that began on the real clock and lasted past the 'now' tolerance gives the live clock back, not the minute it began."""
    _visit(page, "moon", "Apollo 11")
    try:
        assert page.evaluate("() => _ae.site.clock0.live") is True
        page.evaluate(
            "() => { var RD = Date, off = 10 * 60 * 1000; window.__RD = RD;"
            " window.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(RD.now() + off); } static now() { return RD.now() + off; } }; }"
        )
        page.evaluate("() => _aeSiteLeave(false)")
        page.wait_for_function("() => !_ae.site", timeout=30_000)
        assert page.evaluate("() => _almFocus") is None, "the clock was left frozen at the minute the visit began"
    finally:
        page.evaluate("() => { if (window.__RD) { window.Date = window.__RD; window.__RD = null; } _aeNow(); }")


def test_the_launch_button_clears_the_strip_and_the_strips_names_fit(page):
    """(Cape Canaveral on a phone) the round launch button sat over the pad, tower and Saturn V, and "Launch tower" read "Launch to..." (ellipsis)."""
    _visit(page, "earth", "Cape Canaveral")
    page.evaluate("() => _asStrip(_ae.site)")
    got = page.evaluate(
        """() => { var b = document.getElementById('as-launch').getBoundingClientRect(), s = document.getElementById('as-strip'), items = Array.from(s.querySelectorAll('.as-item')),
          top = Math.min.apply(null, items.map(i => i.getBoundingClientRect().top));
          return { gap: top - b.bottom, cut: items.map(i => { var n = i.querySelector('b'); return [n.textContent, n.scrollWidth > n.clientWidth + 1, n.scrollHeight > n.clientHeight + 1, n.getClientRects().length && Math.round(n.getBoundingClientRect().height)]; }),
          lines: items.map(i => i.querySelector('b').textContent), tower: (items.filter(i => /tower/i.test(i.textContent))[0] || {}).textContent }; }"""
    )
    assert got["gap"] >= 0, got
    assert got["tower"] and "tower" in got["tower"].lower(), got
    assert got["tower"] and all(n for n in got["lines"]), got
    # The strip is pictures; the chosen thing's whole name is on the line over it, inside the screen, and above the launch button.
    full = page.evaluate(
        """() => { var it = Array.from(document.querySelectorAll('#as-strip .as-item')).filter(i => /tower/i.test(i.getAttribute('aria-label')))[0];
          it.click(); var n = document.getElementById('as-name'), r = n.getBoundingClientRect(), b = document.getElementById('as-launch').getBoundingClientRect(), s = document.getElementById('as-strip').getBoundingClientRect();
          return { label: it.getAttribute('aria-label'), said: n.textContent, shown: getComputedStyle(n).display !== 'none', inside: r.left >= 0 && r.right <= innerWidth,
            above: r.bottom <= s.top + 1, clear: r.top >= b.bottom - 1 || r.right < b.left || r.left > b.right, nameBox: Math.round(it.querySelector('b').getBoundingClientRect().width) }; }"""
    )
    assert full["said"] == full["label"] and full["shown"] and full["inside"] and full["above"] and full["clear"], full
    assert full["nameBox"] <= 1, full   # the disc's own caption is out of the way
    page.evaluate("() => _asStrip(_ae.site)")



_TRACE_JS = """window.__trace = []; (function () { var t0 = performance.now(); window.__sampler = setInterval(function () {
    try { var st = (typeof _aeSiteState === 'function') ? _aeSiteState() : null; var el = document.querySelector('.ae-view');
    window.__trace.push({ t: Math.round(performance.now() - t0), phase: st && st.phase, veil: !!(el && el.classList.contains('ae-veil')) }); } catch (e) {} }, 30); })();"""


def _shown_again_trace(pg):
    pg.wait_for_function(
        "() => { var s = typeof _aeSiteState === 'function' && _aeSiteState(); return s && s.phase === 'stand' && s.ready; }",
        timeout=STAND_MS,
        polling=250,
    )
    return pg.evaluate("() => { clearInterval(window.__sampler); return window.__trace; }")


def _assert_veiled_until_the_ground(trace):
    """Every sample before the ground is drawn (a drop or a stand) has the canvas held back; none after it does."""
    first = next(i for i, p in enumerate(trace) if p["phase"] in ("drop", "stand"))
    assert trace[:first], trace
    assert all(p["veil"] for p in trace[:first]), "the Earth or the flight to the site showed: %r" % trace[:first][:4]
    assert not any(p["veil"] for p in trace[first + 1 :]), trace[first:][:4]


def test_switching_apps_and_back_returns_to_the_site_without_a_detour(page):
    _visit(page, "moon", "Apollo 15")
    page.evaluate(
        """() => { window.__away = function (h) { Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return h; } });
            document.dispatchEvent(new Event('visibilitychange')); }; window.__away(true); }"""
    )
    parked = page.evaluate("() => ({ gl: !!_ae.gl, parked: _ae.parked })")
    assert not parked["gl"] and any(p.startswith("m=site") for p in parked["parked"]), parked
    page.evaluate(_TRACE_JS + "; window.__away(false);")
    _assert_veiled_until_the_ground(_shown_again_trace(page))


def test_a_page_shown_again_from_the_back_forward_cache_is_built_again(page):
    _visit(page, "moon", "Apollo 15")
    page.evaluate("() => { _aeGlLetGo(); }")
    page.evaluate("() => { _ae.parked = ['v=moon', 'm=site', 'k=26.13222,3.6339,-159.5,31.5,34.34']; }")
    page.evaluate(_TRACE_JS + "; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));")
    _assert_veiled_until_the_ground(_shown_again_trace(page))


def test_a_visit_to_a_site_with_a_rover_offers_the_drive_on_the_spot(page):
    """(Apollo 15 on a phone) the parked rover stands 130 m from the lander, out of the first view, and the visit had no way to it."""
    _visit(page, "moon", "Apollo 11")
    assert page.evaluate("() => document.getElementById('as-takedrive').hidden"), "Apollo 11 had no rover"
    _visit(page, "moon", "Apollo 15")
    assert not page.evaluate("() => document.getElementById('as-takedrive').hidden")
    page.evaluate("() => document.getElementById('as-takedrive').click()")
    page.wait_for_function(
        "() => { var s = _aeSiteState(); return s && s.drive && s.phase === 'stand' && s.ready; }", timeout=STAND_MS, polling=500
    )
    page.evaluate("() => _aeSiteLeave(true)")
