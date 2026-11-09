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
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 300_000
STAND_MS = 240_000
SHOTS = os.environ.get(
    "ZIMI_SITE_SHOTS", ""
)  # a folder to keep the screenshots in (else they are not saved)
DEG_TOL = 2e-3  # about 60 m on the Moon: the flags and parked rovers stand tens of metres from the lander
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
    assert page.evaluate(
        "() => document.getElementById('as-visit').getAttribute('aria-label')"
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
        assert _close(p["lat"], row[1]) and _close(
            p["lon"], row[2]
        ), "%s %s at %.5f, %.5f, the landing is %.5f, %.5f" % (
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


def test_a_site_in_the_dark_opens_at_its_landing_and_the_clock_button_comes_back(page):
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
    page.evaluate("() => document.getElementById('as-landing').click()")
    page.wait_for_function(
        "(n) => Math.abs(_aeDisplayMs() - n) < 3600 * 1000",
        arg=dark,
        timeout=30_000,
        polling=250,
    )


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


def test_the_rover_jumps_in_the_moons_gravity_and_lands_again(page):
    page.evaluate(
        "() => { var s = _ae.site; s.input.keys.f = s.input.keys.b = s.input.keys.l = s.input.keys.r = false; s.rover.v = 0; }"
    )
    page.evaluate("() => { _ae.site.input.jump = true; _aeSiteAdvance(1 / 60); }")
    peak, airborne_s = 0.0, 0.0
    # One arc: the rebound is its own check below.
    page.evaluate("() => { window.__keep = AS_BOUNCE_KEEP; AS_BOUNCE_KEEP = 0; }")
    for _ in range(200):
        r = page.evaluate(
            "() => { _aeSiteAdvance(1 / 20); return _aeSiteState().rover; }"
        )
        peak = max(peak, r["z"] - r["mean"])
        if r["airborne"]:
            airborne_s += 1 / 20
        else:
            break
    # v = 3.0 m/s up in 1.62 m/s^2: 2.8 m high, 3.7 s in the air.
    assert 2.4 < peak < 3.2, "peak %.2f m" % peak
    assert 3.2 < airborne_s < 4.2, "%.1f s in the air" % airborne_s
    assert page.evaluate("() => _aeSiteState().rover.airborne") is False
    # With its rebound a landing at jump speed lifts the rover again, lower.
    page.evaluate("() => { AS_BOUNCE_KEEP = window.__keep; _ae.site.input.jump = true; _aeSiteAdvance(1 / 60); }")
    for _ in range(200):
        page.evaluate("() => _aeSiteAdvance(1 / 20)")
        if page.evaluate("() => _ae.site.rover.vz") > 0.3 and page.evaluate("() => _ae.site.rover.z - _ae.site.rover.mean") < 0.5:
            break
    else:
        pytest.fail("the rover did not rebound")


def test_a_mars_rover_has_six_wheels_and_the_ground_there_is_not_the_moons(page):
    st = _visit(page, "mars", "Perseverance", drive=True)
    assert len(st["rover"]["wheels"]) == 6
    page.evaluate(
        "() => { _ae.site.input.keys.f = true; _aeSiteAdvance(4); _ae.site.input.keys.f = false; }"
    )
    r = page.evaluate("() => _aeSiteState().rover")
    assert r["y"] > st["rover"]["y"] + 5
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
    assert page.evaluate("() => _ae.site.launch.phase") == "count", "the count is running"
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
    """At 844 x 390 every control is on the screen and the thumbs' two corners are clear of the caption."""
    _visit(page, "moon", "Apollo 15", drive=True)
    page.set_viewport_size({"width": 844, "height": 390})
    page.evaluate("() => _aeResize()")
    page.wait_for_function("() => _ae.w === 844", timeout=120_000, polling=250)
    boxes = page.evaluate(
        """() => ['as-exit', 'as-landing', 'as-rate', 'as-jump', 'as-rest', 'as-cap'].map(id => {
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
    for other in ("as-exit", "as-landing", "as-rate", "as-jump", "as-rest"):
        assert not overlap(by["as-cap"], by[other]), "the caption does not cover %s" % other
    _shot(page, "landscape")
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate("() => _aeResize()")
    page.wait_for_function("() => _ae.w === 390", timeout=120_000, polling=250)


def test_a_probes_sheet_replays_its_flight_from_launch(page):
    page.evaluate(
        "() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }"
    )
    page.evaluate("() => _aeNow()")
    page.evaluate("() => _aeTracksLoad()")
    page.wait_for_function(
        "() => !!_aeBodyPos('voyager1')", timeout=120_000, polling=250
    )
    page.evaluate("() => _aePreset('voyager1')")
    page.wait_for_function("() => !_ae.fly", timeout=120_000, polling=250)
    page.evaluate("() => document.getElementById('ae-info-btn').click()")
    page.wait_for_function(
        "() => !!document.querySelector('[data-ae-replay]')",
        timeout=60_000,
        polling=250,
    )
    page.evaluate("() => document.querySelector('[data-ae-replay]').click()")
    assert page.evaluate("() => _ae.preset") == "planets"
    launch = page.evaluate("() => _aeLaunchMs('voyager1')")
    assert (
        abs(page.evaluate("() => _aeDisplayMs()") - launch) < 3 * 86400 * 1000
    ), "the clock is at the launch"
    assert page.evaluate("() => _almRate") == pytest.approx(365.25 * 86400 / 12)
    page.evaluate("() => _aeNow()")


def test_no_script_error_came_up(page):
    assert page.errors == []
