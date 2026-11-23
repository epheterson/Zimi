"""The planets in the 3D view: round the Sun where they are, a flight to each, Saturn's rings, credits.

In headless Chromium at a phone's size: each planet's direction from the Sun as drawn against JPL Horizons'
heliocentric vector for 2026-11-04 00:00 TDB, the flight to Saturn ending on Saturn with its map and rings drawn
and Solar System Scope credited, and a moon of Jupiter at its true distance from it.

Run: pytest tests/test_almanac_planets_browser.py -v
"""

import math
import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
WHEN_MS = 1793750400000  # 2026-11-04T00:00:00Z
# JPL Horizons, apparent RA and Dec (degrees), geocentric, 2026-11-04 00:00 UT.
HORIZONS = {
    "mars": (143.07137, 16.35440),
    "jupiter": (147.21003, 13.95577),
    "saturn": (9.41624, 1.14579),
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("pl")
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


def _sep(a, b):
    c = sum(x * y for x, y in zip(a, b)) / math.sqrt(
        sum(x * x for x in a) * sum(y * y for y in b)
    )
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def test_the_planets_where_the_sky_has_them_and_a_flight_to_saturn(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(
                viewport=VIEW,
                device_scale_factor=2,
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
            asked = []
            pg.on("request", lambda r: asked.append(r.url))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
                timeout=READY_MS,
                polling=200,
            )
            got = pg.evaluate(
                """(a) => { var sc = _aeSceneAt(a.ms); _ae.scene = sc; _aeUpdatePlanets(sc); var out = {};
                var jd = a.ms / MS_PER_DAY + JD_UNIX_EPOCH, jde = jd + _aeDeltaTDays(jd), sun = _aeSunShown(sc);
                Object.keys(a.ref).forEach(function (k) { var p = _ae.gl.planets[k].pos;
                  out[k] = { drawn: [p[0] - sun[0], p[1] - sun[1], p[2] - sun[2]], ref: _ephEclJ2000ToEqOfDate(a.ref[k], jde) }; });
                var j = _ae.gl.planets.jupiter.pos, io = _ae.gl.planets.io.pos, ca = _ae.gl.planets.callisto.pos;
                out.io_km = Math.hypot(io[0] - j[0], io[1] - j[1], io[2] - j[2]) * AE_EARTH_RADIUS_KM;
                out.callisto_km = Math.hypot(ca[0] - j[0], ca[1] - j[1], ca[2] - j[2]) * AE_EARTH_RADIUS_KM;
                return out; }""",
                {"ms": WHEN_MS, "ref": HORIZONS},
            )
            for k in HORIZONS:
                assert _sep(got[k]["drawn"], got[k]["ref"]) < 0.3, (k, got[k])
            assert got["io_km"] == pytest.approx(421769, rel=1e-3)
            assert got["callisto_km"] == pytest.approx(1882794, rel=1e-3)
            # Fly to Saturn: it is the target, framed with its rings, its map asked for and credited.
            pg.evaluate("_aePreset('saturn')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.gl.planets.saturn.uni.mapped.value === 1 && !!_ae.gl.planets.saturn.uni.ringMap.value; }",
                timeout=60_000,
                polling=200,
            )
            assert pg.evaluate("_ae.target") == "saturn"
            assert pg.evaluate(
                "_ae.gl.planets.saturn.mesh.visible && _ae.gl.planets.saturn.ring.visible"
            )
            assert any(u.split("?")[0].endswith("/static/earth/saturn-v1.webp") for u in asked)   # (assets carry a ?v= version)
            assert pg.evaluate("_aeBodyAt(_ae.w / 2, _ae.h / 2)") == "saturn"
            # The maps' credit (shown at the foot of the i sheet) names Solar System Scope here.
            assert "Solar System Scope" in pg.evaluate("_aePlanetCredit()")
            # Far away, a planet is a mark and no map is fetched for the ones too small to see.
            assert not any(u.endswith("/static/earth/neptune-v1.webp") for u in asked)
            # The Planets chip: the whole system from above, every orbit drawn, the belt placed.
            pg.evaluate("() => _aePreset('planets')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeAst && _aeAst.at !== null; }",
                timeout=60_000,
                polling=200,
            )
            assert pg.evaluate("_ae.target") == "sun"
            assert (
                pg.evaluate(
                    "Object.keys(_ae.gl.planets).filter(k => _ae.gl.planets[k].orbit && _ae.gl.planets[k].orbit.visible).length"
                )
                == 7
            )
            # The belt lies between Mars and Jupiter round the Sun: every asteroid's distance from the Sun as drawn
            # within the two planets' (a few of the 18,000 stray inside Mars's: the Hungarias).
            belt = pg.evaluate(
                """() => { var a = _aeAst.cloud.geometry.attributes.position.array, sun = _aeSunShown(_ae.scene), d = [];
                for (var i = 0; i < _aeAst.cloud.geometry.drawRange.count; i++) d.push(Math.hypot(a[i*3], a[i*3+1], a[i*3+2]));   // the cloud is stored round the Sun
                d.sort(function (x, y) { return x - y; });
                var r = function (k) { var p = _ae.gl.planets[k].pos; return Math.hypot(p[0] - sun[0], p[1] - sun[1], p[2] - sun[2]); };
                return { n: _aeAst.n, drawn: d.length, p1: d[Math.floor(d.length * 0.01)], p99: d[Math.floor(d.length * 0.99)], mars: r('mars'), jupiter: r('jupiter') }; }"""
            )
            assert (
                belt["n"] > 15000 and 5000 < belt["drawn"] < belt["n"] / 2
            ), belt  # a faint ring: a third of them drawn
            # Through the same squeeze as the planets: clear of Mars's orbit at its farthest and Jupiter's at its nearest.
            mars_far, jup_near = pg.evaluate(
                "[_aeShownDist(1.666), _aeShownDist(4.95)]"
            )  # the Almanac's one squeeze
            assert mars_far < belt["p1"] and belt["p99"] < jup_near, (
                belt,
                mars_far,
                jup_near,
            )
            assert pg.evaluate(
                "_aeShownDist(1) === AE_SUN_SHOW_DIST && _aeShownDist(30.07) / _aeShownDist(1) === _solarSqueeze(30.07) / _solarSqueeze(1)"
            )
            # Names: none over another name or another body's ring, at 390 px, and the planets named.
            pg.wait_for_timeout(500)
            # Each mark is the body itself, small; its name covers no other body and no other name, at 390 px.
            marks = pg.evaluate(
                """() => _ae.marksDrawn.map(d => { var e = document.getElementById(d.el), b = e && e.querySelector('b');
                var named = b && getComputedStyle(b).display !== 'none' && d.body === d.lead, nb = named ? b.getBoundingClientRect() : null;
                var v = _ae.el.getBoundingClientRect();   // the marks' own frame: the view's
                return { body: d.body, lead: d.lead, box: [d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r], name: nb ? [nb.left - v.left, nb.top - v.top, nb.right - v.left, nb.bottom - v.top] : null }; })"""
            )
            assert pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-labels .ae-ring')).every(r => getComputedStyle(r).display === 'none')"
            ), "no hollow rings"
            meet = (
                lambda a, b: a[0] < b[2] - 0.5
                and b[0] < a[2] - 0.5
                and a[1] < b[3] - 0.5
                and b[1] < a[3] - 0.5
            )  # noqa: E731
            for m in marks:
                for o in marks:
                    if o is m:
                        continue
                    if m["name"]:
                        assert not meet(m["name"], o["box"]), (m, o)
                        assert not (o["name"] and meet(m["name"], o["name"])), (m, o)
            named = {m["body"] for m in marks if m["name"]}
            # The Sun is a disc on the planets' own scale, bigger than Jupiter's, not a speck.
            sizes = pg.evaluate(
                "() => Object.fromEntries(_ae.marksDrawn.map(d => [d.body, d.r]))"
            )
            assert sizes.get("sun", 0) > sizes.get("jupiter", 99), sizes
            assert {"jupiter", "saturn", "uranus", "neptune"} <= named, named
            radius = {m["body"]: m["box"][2] - m["box"][0] for m in marks}
            assert (
                radius.get("jupiter", 0) > radius.get("mercury", radius.get("mars", 99))
                or "mercury" not in radius
            ), radius
            assert "Not to scale" not in pg.evaluate("() => _aeCapNow()")   # the planets page says nothing about its scale: the discs show it
            # Bodies on top of each other are one crowd: a single name with its count, every disc still drawn.
            for m in marks:
                for o in marks:
                    if (
                        o is not m
                        and o["lead"] != m["lead"]
                        and m["body"] == m["lead"]
                        and o["body"] == o["lead"]
                    ):
                        assert not meet(m["box"], o["box"]), (m, o)
            # Nothing under the controls at the foot: the controls are the foot's visible, tappable rows (the hint and the notes are
            # text on a gradient, and the foot's own box also holds whatever a slow machine has not yet folded away).
            # The foot itself: the view is not scrolled and the foot stands on its bottom edge (a scrolled view lifted it over
            # the planets on a slow runner; tests/test_almanac_view_scroll_browser.py holds the cause).
            seat = pg.evaluate(
                """() => { var r = _ae.el.getBoundingClientRect(), f = document.querySelector('.ae-bottom').getBoundingClientRect();
                return { scroll: [_ae.el.scrollTop, _ae.el.scrollLeft], fromBottom: Math.round(r.bottom - f.bottom) }; }"""
            )
            assert seat == {"scroll": [0, 0], "fromBottom": 0}, seat
            foot, under, state = pg.evaluate(
                """() => { var o = _ae.el.getBoundingClientRect().top, rows = Array.from(document.querySelectorAll('.ae-bottom > *')).filter(c => !c.hidden && c.getBoundingClientRect().height > 0 && getComputedStyle(c).pointerEvents !== 'none');
                var vv = window.visualViewport, st = { scroll: [_ae.el.scrollTop, _ae.el.scrollLeft], footStyle: document.querySelector('.ae-bottom').getAttribute('style'), viewH: Math.round(_ae.el.getBoundingClientRect().height), vv: vv ? [vv.height, vv.offsetTop] : null, info: _ae.info, shift: _ae.infoShift };
                return [Math.min.apply(null, rows.map(c => c.getBoundingClientRect().top - o)), rows.map(c => [c.id || c.className, Math.round(c.getBoundingClientRect().top - o), Math.round(c.getBoundingClientRect().height)]).concat([['view', Math.round(_ae.h), innerHeight]]), st]; }"""
            )
            low = [(m["body"], round(m["box"][1])) for m in marks if m["box"][1] >= foot]
            # (state: what could hold the foot up when a slow runner finds it high, as one CI run did: the view scrolled, the foot
            # lifted over a keyboard, the view short.)
            assert not low, "foot top %s, rows %s, under it %s, state %s" % (round(foot), under, low, state)
            # The planets only are named out here: no probe, moon or dwarf planet name, no crowd counts.
            planets = {
                "mercury",
                "venus",
                "earth",
                "mars",
                "jupiter",
                "saturn",
                "uranus",
                "neptune",
            }
            assert named <= planets, named
            assert not pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-labels .ae-bm b')).some(b => / \\+\\d/.test(b.textContent))"
            )
            # The probes: once out here their table comes; each flying one is named, Webb stands at L2 at its true
            # distance from the Earth (1.5 million km, not squeezed by the drawn scale), and a tap's card says where.
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !!_aeTracks && !!_aeProbePos.voyager1 && !!_aeProbePos.jwst; }",
                timeout=60_000,
                polling=200,
            )
            jwst_km = pg.evaluate(
                "Math.hypot.apply(null, _aeProbePos.jwst) * AE_EARTH_RADIUS_KM"
            )
            assert 1.2e6 < jwst_km < 1.9e6, jwst_km
            pg.evaluate("_aePreset('voyager1')")
            # Its model loads first, then the flight and its card: the card names it, where it is, and what it last did.
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.arrived === 'voyager1'; }",
                timeout=60_000,
                polling=200,
            )
            pg.evaluate(
                "_aeOpenInfo('voyager1')"
            )  # a clean view on arrival: its sheet behind the i
            card = pg.inner_text("#ae-info")
            assert "Voyager 1" in card and "AU" in card and "2012" in card, card
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def _open(pg, served, target="earth"):
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    pg.evaluate("(t) => openAlmanacEarth({ target: t })", target)
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=READY_MS,
        polling=200,
    )
    pg.wait_for_function(
        "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
        timeout=60_000,
        polling=200,
    )


def _ctx(br, width=390):
    ctx = br.new_context(
        viewport={"width": width, "height": 844},
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (PLACE, PLACE)
    )
    return ctx


def test_go_to_the_minimap_and_the_orrery_s_way_in(served):
    """The short row stays (Earth, Satellites, Moon, Sun, Planets) with Go to: a sheet of every place in groups, each
    with its disc; a tap flies and puts it away. Near a planet the grid's Solar system opens the
    whole system (the corner minimap is gone); the 2D orrery's planet tap opens the 3D view on that planet."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("_orreryOpenEarthView('jupiter')")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
                timeout=READY_MS,
                polling=200,
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'jupiter'; }",
                timeout=60_000,
                polling=200,
            )
            row = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-views [data-ae-view]')).filter(b => b.offsetParent).map(b => b.dataset.aeView)"
            )
            # At Jupiter the strip is the system from the Sun, Jupiter's moons right after it.
            assert row == _strip("jupiter", ["io", "europa", "ganymede", "callisto"]), row
            pg.click("#ae-find")
            pg.wait_for_function(
                "() => !document.getElementById('ae-go').hidden && document.querySelectorAll('#ae-go [data-ae-go=\"voyager1\"]').length === 1 && document.querySelectorAll('#ae-go [data-ae-go^=\"lm:\"]').length > 20",
                timeout=60_000,
            )
            groups = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-go-groups > h4[data-g]:not(.ae-sent-h)')).length"
            )
            assert (
                groups == 8
            ), pg.evaluate("Array.from(document.querySelectorAll('#ae-go-groups > h4[data-g]:not(.ae-sent-h)')).map(h => h.textContent)")  # Earth and Moon, Planets, Missions, Stand at the pad, Moons, Dwarf planets, Spacecraft, Landings
            assert pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-go-groups > .ae-go-list .ae-go-row')).every(r => !!r.querySelector('.ae-go-thumb'))"
            )
            pg.click("#ae-go [data-ae-go='saturn']")
            assert pg.evaluate("document.getElementById('ae-go').hidden")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'saturn'; }",
                timeout=60_000,
                polling=200,
            )
            # The flight's orbits fade out shortly after it lands (Orbits: While flying).
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return Object.keys(_ae.gl.planets).every(k => !_ae.gl.planets[k].orbit || !_ae.gl.planets[k].orbit.visible); }",
                timeout=10_000,
                polling=100,
            )
            assert "Not to scale" not in pg.evaluate("() => _aeCapNow()")
            pg.evaluate("_aePreset('mars')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'mars' && _ae.gl.planets.mars.uni.mapped.value === 1; }",
                timeout=60_000,
                polling=200,
            )
            assert "Solar System Scope" not in pg.evaluate(
                "_aePlanetCredit()"
            ), "Mars is the Viking map: nothing of Solar System Scope's is drawn"
            assert pg.is_visible("#ae-mini")   # the minimap (bottom left, above the row) is the way to the whole system
            pg.click("#ae-find")
            pg.click("[data-ae-gomode=grid]")
            pg.click(".ae-go-top3 [data-ae-go=planets]")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.preset === 'planets'; }",
                timeout=60_000,
                polling=200,
            )
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_probe_in_orbit_is_one_ellipse_and_a_short_trail(served):
    """Parker round the Sun and Juno round Jupiter: no ellipse (that is the way ahead: only the road travelled is drawn), a trail of under a third of
    an orbit, fading up to the probe; the Voyagers keep the whole road out. Their orbits are still worked out (the trail's length is a share of the period).
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _aeTracksLoad(); _aeSetOrbits(true);"
            )  # paths stay drawn
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            pg.evaluate("() => _aeGoTo(Date.UTC(2026, 1, 10, 12))")   # a fixed day: Parker's orbit is worked out from a thinned table and is lost near some dates
            pg.wait_for_function("() => Math.abs(_aeDisplayMs() - Date.UTC(2026, 1, 10, 12)) < 1000", timeout=60_000, polling=100)   # (the clock's own scrub has finished: the exact instant)
            got = {}
            for k in ("parker", "juno", "voyager1"):
                pg.evaluate("(k) => _aePreset(k)", k)
                pg.wait_for_function(
                    "(k) => { _ae.dirty = true; _aeKick(); return _ae.target === k && !_ae.fly; }",
                    arg=k,
                    timeout=60_000,
                    polling=100,
                )
                pg.evaluate("() => { _ae.dist = AE_PROBE_VIEW_DIST; }")
                got[k] = pg.evaluate(
                    """(k) => { _aeRedrawsLeft = 1e6; _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); _aeUpdate(_aeDisplayMs()); var t = _ae.gl.probes.trails[k], r = _ae.gl.probes.orbits[k], o = t.orbit;
                    var c = t.geometry.attributes.color.array;
                    return { round: o && o.round, period: o && o.period, trail: o && o.trail, ring: r.visible, first: c[3], last: c[c.length - 1] }; }""",
                    k,
                )
            assert (
                got["parker"]["round"] == "sun"
                and 80 < got["parker"]["period"] < 95
                and not got["parker"]["ring"]
            ), got
            assert (
                got["juno"]["round"] == "jupiter"
                and 25 < got["juno"]["period"] < 40
                and not got["juno"]["ring"]
            ), got
            for k in ("parker", "juno"):
                assert (
                    got[k]["trail"] <= got[k]["period"] * 0.31
                    and got[k]["first"] < 0.01
                    and got[k]["last"] == 1
                ), got
            assert (
                got["voyager1"]["round"] is None
                and not got["voyager1"]["ring"]
                and abs(got["voyager1"]["first"] - 0.1) < 1e-6   # the whole road out, fading up from AE_TRAIL_TAIL to the probe
            ), got
            # Every day of 2025 to mid-2028 (the table is thinned, so a state at the close pass is far off: the ellipse is
            # fitted where it moves slowly), Juno is on its ~35-day orbit and Parker on its 88-day one, never held or lost.
            fits = pg.evaluate(
                """() => { var near = (k, jd) => [{ key: k, h: _ephBodyJ2000('Jupiter', jd), reach: AE_PROBE_REACH_AU[k], hAt: x => _ephBodyJ2000('Jupiter', x) }];
                var j = [], p = [];
                for (var jd = 2460676.5; jd < 2461900.5; jd += 1) {
                  var o = _aeProbeOrbit(_aeTracks.tracks.juno, jd, near('jupiter', jd)); j.push(o && o.period ? o.period : 0);
                  var q = _aeProbeOrbit(_aeTracks.tracks.parker, jd, []); p.push(q && q.period ? q.period : 0);
                }
                return { j: [Math.min.apply(null, j), Math.max.apply(null, j)], p: [Math.min.apply(null, p), Math.max.apply(null, p)] }; }"""
            )
            assert 33 < fits["j"][0] and fits["j"][1] < 37, fits
            assert 87 < fits["p"][0] and fits["p"][1] < 90, fits
            ctx.close()
        finally:
            br.close()


def test_the_pull_back_to_the_planets_is_two_seconds_and_smooth(served):
    """Out to the whole system takes 1.5 to 2.5 s from anywhere (the Earth, Jupiter, Neptune), the camera's distance on a
    log scale and its turn with no snap (section 8b's bounds), and the asteroid belt is placed over several frames, not
    in one."""
    import math
    from playwright.sync_api import sync_playwright

    def ang(p, q):
        return math.degrees(
            math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(p, q)))))
        )

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            _open(pg, served)
            for frm in ("earth", "jupiter", "neptune"):
                r = pg.evaluate(
                    """(frm) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset(frm); window._almReduceMotion = undefined; _aeUpdate(_aeDisplayMs());
                    _aePreset('planets'); var f = _ae.fly, total = (f.hold ? (f.lead || AE_FLY_APPROACH_MS) + AE_FLY_TAIL_MS : 0) + f.ms, out = [], FR = 1000 / 60;
                    for (var t = 0; t <= total + FR; t += FR) { f.start = 0; _aeStepFly(Math.min(t, total - 1e-6)); _aePlaceCamera();
                      var cam = _ae.gl.camera; cam.updateMatrixWorld(); var e = cam.matrixWorld.elements; out.push([[-e[8], -e[9], -e[10]], [e[4], e[5], e[6]]]); if (!_ae.fly) break; }
                    _ae.fly = null; return { total: total, hold: f.hold, series: out }; }""",
                    frm,
                )
                assert 1500 <= r["total"] <= 2500 and not r["hold"], (frm, r["total"])
                S = r["series"]
                for k in (0, 1):
                    w = [ang(S[i][k], S[i + 1][k]) for i in range(len(S) - 1)]
                    acc = [w[i + 1] - w[i] for i in range(len(w) - 1)]
                    jerk = [acc[i + 1] - acc[i] for i in range(len(acc) - 1)]
                    assert max(map(abs, acc)) <= 0.5 and max(map(abs, jerk)) <= 0.1, (
                        frm,
                        k,
                        max(map(abs, acc)),
                        max(map(abs, jerk)),
                    )
                    assert w[0] <= 0.05 and w[-1] <= 0.05, (frm, k, w[0], w[-1])
            fills = pg.evaluate(
                """() => { _aeAst.at = null; _aeAst.fill = null; _ae.fly = null; _aePreset('planets'); _ae.fly = null; var n = 0;
                do { _aeUpdate(_aeDisplayMs()); n++; } while (_aeAst.fill != null && n < 50); return { n: n, drawn: _aeAst.drawn }; }"""
            )
            assert fills["n"] >= 3 and fills["drawn"] == pg.evaluate(
                "Math.ceil(_aeAst.n / AE_AST_STRIDE)"
            ), fills
            ctx.close()
        finally:
            br.close()


def test_the_iss_close_up(served):
    """Go to has the ISS; a flight there ends on the station itself (NASA's model, under 1 MB), held as it flies: the
    truss across the direction of travel, the US segment ahead, the truss on the zenith side, the main arrays turned to
    the Sun, lit in daylight, up away from the Earth. From the Earth view it is the dot, and the model is not drawn.
    """
    import math
    from playwright.sync_api import sync_playwright

    assert (
        os.path.getsize(os.path.join(ROOT, "zimi", "static", "earth", "iss-v1.bin"))
        < 1_000_000
    )
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !!_ae.issPos; }",
                timeout=60_000,
                polling=200,
            )
            far = pg.evaluate(
                "() => ({ drawn: !!(_ae.gl.iss && _ae.gl.iss.root.visible) })"
            )
            assert not far["drawn"], far
            pg.evaluate("_aeShowGo(true)")
            pg.click("#ae-go [data-ae-go='iss']")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'iss' && !!_ae.gl.iss && _ae.gl.iss.root.visible; }",
                timeout=60_000,
                polling=200,
            )
            got = pg.evaluate(
                """() => { _aeUpdate(_aeDisplayMs()); _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); var I = _ae.gl.iss, V = _ae.gl.THREE.Vector3;
                var ax = function (x, y, z) { var v = new V(x, y, z).applyQuaternion(I.root.quaternion); return [v.x, v.y, v.z]; };
                var p = _ae.issPos, B = _ae.issBasis, sun = _aeNorm(_ae.scene.sun);
                var arr = new V(1, 0, 0).applyQuaternion(I.pivot.quaternion).applyQuaternion(I.root.quaternion);
                var sunIn = _aeNorm(_aeSub(sun, _aeScale(ax(0, 0, 1), _aeDot(sun, ax(0, 0, 1)))));
                var cam = _ae.gl.camera.matrixWorld.elements, up = [cam[4], cam[5], cam[6]], look = [-cam[8], -cam[9], -cam[10]];
                var zen = _aeNorm(p), zenIn = _aeNorm(_aeSub(zen, _aeScale(look, _aeDot(zen, look))));
                return { truss: _aeDot(ax(0, 0, 1), _aeNorm(_aeCross(p, B[1]))), fwd: _aeDot(ax(0, 1, 0), B[1]), nadir: _aeDot(ax(1, 0, 0), _aeScale(_aeNorm(p), -1)),
                         arrays: _aeDot([arr.x, arr.y, arr.z], sunIn), lit: I.uni.lit.value, up: _aeDot(up, zenIn), label: document.getElementById('ae-lbl-iss').hidden,
                         dist: _ae.dist, span: AE_ISS_SPAN_RE }; }"""
            )
            assert (
                got["truss"] < -0.999
            ), got  # starboard is the orbit's negative normal
            assert got["fwd"] > 0.999 and got["nadir"] > 0.999, got
            assert got["arrays"] > 0.999, got
            assert got["up"] > 0.999 and got["label"], got
            assert got["dist"] < got["span"] * 5, got
            shade = pg.evaluate(
                "() => { var b = _aeNorm(_ae.issPos), s = _aeNorm(_ae.scene.sun); return _aeDot(b, s); }"
            )
            if shade > 0:
                assert got["lit"] == 1, got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("hour", range(0, 24, 2))
def test_the_iss_flight_rings_and_a_tap_on_it(served, hour):
    """A flight to the ISS is the fly-between too: a circle on the Earth it leaves and on the station; never a name of
    its own beside its label. A tap on its dot in the Earth view, or on the model close up, goes to it and follows.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !!_ae.issBasis; }",
                timeout=60_000,
                polling=200,
            )
            pg.evaluate("(h) => _aeGoTo(Date.UTC(2026, 10, 21, h))", hour)
            pg.wait_for_function(
                "(h) => Math.abs(_aeDisplayMs() - Date.UTC(2026, 10, 21, h)) < 1000",
                arg=hour,
                timeout=60_000,
                polling=100,
            )
            assert pg.evaluate(
                "document.getElementById('ae-bm-iss').hidden"
            ), "no ISS mark outside a flight"
            # The ring on the Earth it leaves is there as the flight starts; once the camera is in close the Earth's ring is wider than the
            # screen and is dropped (so the Earth's is held at the start only, the station's all the way). Where the Earth stands against
            # the station follows the hour, so the start is held at every hour of the day.
            ring_js = """(share) => { _aePreset('iss'); var f = _ae.fly; f.start = performance.now() - f.ms * share; _aeStepFly(performance.now());
                _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene); var out = { straight: !!f.straight };
                ['earth', 'iss'].forEach(function (b) { var el = document.getElementById('ae-bm-' + b);
                  out[b] = { shown: !el.hidden, ringed: el.classList.contains('ae-bm-ringed'), ring: getComputedStyle(el.querySelector('.ae-ring')).display }; });
                _ae.fly = null; return out; }"""
            for share, bodies in ((0.02, ("earth", "iss")), (1 / 3, ("iss",))):
                pg.evaluate(
                    "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('earth'); window._almReduceMotion = undefined;"
                )
                pg.wait_for_function(
                    "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'earth'; }",
                    timeout=30_000,
                    polling=100,
                )
                rings = pg.evaluate(ring_js, share)
                assert rings["straight"], rings   # Earth to the station is one straight zoom (1.15.4), marked on the way like any flight
                for b in bodies:
                    assert (
                        rings[b]["shown"]
                        and rings[b]["ringed"]
                        and rings[b]["ring"] != "none"
                    ), (b, share, rings)
            # Back at the Earth, a tap on the ISS's dot.
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('earth');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'earth'; }",
                timeout=30_000,
                polling=100,
            )
            spot = pg.evaluate(
                """() => { var best = null; for (var az = 0; az < 6.28 && !best; az += 0.4) for (var el = -1.2; el < 1.3 && !best; el += 0.4) {
                  _ae.az = az; _ae.el_ = el; _aeUpdate(_aeDisplayMs()); _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld();
                  var s = _aeProject(_ae.issPos); if (s && !_aeBehindEarth(_ae.issPos) && s.x > 30 && s.x < _ae.w - 30 && s.y > 120 && s.y < _ae.h - 250) best = s; }
                return best; }"""
            )
            assert spot, "the ISS is somewhere in sight"
            pg.evaluate("(s) => _aeTap(s.x, s.y)", spot)
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'iss' && _ae.gl.iss && _ae.gl.iss.root.visible; }",
                timeout=30_000,
                polling=100,
            )
            # Close to it from the Earth's target: a tap on the model off its middle. One update and the tap in one
            # step (at 330 m the station crosses its own length in a hundredth of a second).
            pg.evaluate("_ae.fly = null; _aePreset('earth');")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'earth'; }",
                timeout=30_000,
                polling=100,
            )
            got = pg.evaluate(
                """() => { _aeUpdate(_aeDisplayMs()); var p = _ae.issPos, d = _aeNorm(p);
                var at = _aeAdd(p, _aeScale(d, AE_ISS_SPAN_RE * 3)); _ae.dist = _aeLen(at); var a = _aeAzElOf(at); _ae.az = a.az; _ae.el_ = a.el;
                _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); var s = _aeProject(p);
                if (!s) return null; _ae.positions = []; var b = _aeBodyAt(s.x + 25, s.y + 10); _aeTap(s.x + 25, s.y + 10); return [b, _ae.target]; }"""
            )
            assert got == ["iss", "iss"], got
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_ae.gl.iss && _ae.gl.iss.root.visible; }",
                timeout=30_000,
                polling=100,
            )
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize(
    "width,lang", [(390, "en"), (360, "en"), (360, "ru"), (360, "ar")]
)
def test_the_row_is_one_line(served, width, lang):
    """The planets (the body in view marked) and its moons share one scrolling line on a phone, in English and in the
    longest translations; each disc gives a finger; Go to is the page header's search field."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br, width)
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_ui_lang', %r); } catch (e) {}" % lang
            )
            pg = ctx.new_page()
            _open(pg, served)
            tops = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-views .ae-disc')).filter(b => b.offsetParent).map(b => { var r = b.getBoundingClientRect(); return [Math.round(r.top + r.height / 2), Math.round(r.left), Math.round(r.right), Math.round(r.width), b.dataset.aeView]; })"
            )
            keys = [t[4] for t in tops]
            # the strip: the Sun out to Neptune, then the body in view's moons (the grid opener moved to the sheet's band, 4e472d532)
            assert keys == ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune"], tops
            assert max(t[0] for t in tops) - min(t[0] for t in tops) <= 1, tops  # one line, centres level
            assert all(t[3] >= 32 for t in tops), tops  # drawn size (the finger rule is hit_area's)
            assert pg.get_attribute("#ae-views [data-ae-view=earth]", "aria-current") == "true"
            assert pg.evaluate("_aeRowNameNow()") == pg.get_attribute("#ae-views [data-ae-view=earth]", "aria-label")
            if lang == "en":
                assert pg.evaluate("() => !document.getElementById('ae-go-btn')")   # Go to is the page header's one search field
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("start", ["earth", "jupiter"])
def test_every_destination_flies(served, start):
    """Every place in Go to (and the row) takes the camera there: from the Earth and from Jupiter, none is a dead tap
    (Pluto and Ceres wait for their table and then go)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("_aeShowGo(true)")
            pg.wait_for_function(
                "() => !!_aeTracks && document.querySelectorAll('#ae-go .ae-go-row').length > 20",
                timeout=60_000,
            )
            # Every body (the landing sites are the landmarks test's).
            keys = pg.evaluate(
                "_aeGoGroups().reduce((a, g) => a.concat(g[1]), []).filter(k => k.indexOf(':') < 0 && k !== AE_GO_LOADING && k !== AE_SPIN_KEY).concat(['sun', 'planets', 'sats'])"
            )
            pg.evaluate(
                "_aeShowGo(false); window._almReduceMotion = function () { return true; };"
            )  # each flight lands at once
            missed = []
            for k in keys:
                pg.evaluate("(s) => { _ae.fly = null; _aePreset(s); }", start)
                pg.wait_for_function(
                    "(s) => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset && (_ae.target === s || (s === 'jupiter' ? false : true)); }",
                    arg=start,
                    timeout=30_000,
                    polling=100,
                )
                pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k)
                pg.wait_for_function(
                    "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset; }",
                    timeout=30_000,
                    polling=100,
                )
                try:  # a probe's first visit fetches its model; the view moves to it on the frame after
                    pg.wait_for_function(
                        "(k) => { _ae.dirty = true; _aeKick(); var w = k === 'planets' ? 'sun' : k === 'sats' ? 'earth' : k; return _ae.target === w && !_ae.fly; }",
                        arg=k,
                        timeout=10_000,
                        polling=100,
                    )
                except Exception:
                    pass
                got = pg.evaluate(
                    """(k) => { var want = k === 'planets' ? 'sun' : k === 'sats' ? 'earth' : k;
                    _aeUpdate(_aeDisplayMs());   // where the camera stands now
                    var t = _aeTargetPos(), b = _aeBodyPos(want), c = _ae.gl.camera.position;
                    return { target: _ae.target, want: want, near: !!b && Math.hypot(t[0] - b[0], t[1] - b[1], t[2] - b[2]) < 1e-6,
                             dist: Math.hypot(c.x - t[0], c.y - t[1], c.z - t[2]), allowed: Math.max(AE_TARGETS[want].max, _ae.dist) * 1.01, d: _ae.dist }; }""",
                    k,
                )
                if (
                    got["target"] != got["want"]
                    or not got["near"]
                    or got["dist"] > got["allowed"]
                ):
                    missed.append((k, got))
            assert not missed, missed
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_every_destination_arrives_with_its_card(served):
    """Every place Go to flies to arrives clean, with its sheet behind the i: its name, its line, and its rows.
    Saturn used to arrive with nothing."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("_aeShowGo(true)")
            pg.wait_for_function(
                "() => !!_aeTracks && document.querySelectorAll('#ae-go .ae-go-row').length > 20",
                timeout=60_000,
            )
            keys = pg.evaluate(
                "_aeGoGroups().reduce((a, g) => a.concat(g[1]), []).filter(k => k.indexOf(':') < 0 && k !== AE_GO_LOADING && k !== AE_SPIN_KEY).concat(['sun'])"
            )
            pg.evaluate(
                "_aeShowGo(false); window._almReduceMotion = function () { return true; };"
            )
            bare = []
            for k in keys:
                pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k)
                pg.wait_for_function(
                    "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset; }",
                    timeout=30_000,
                    polling=100,
                )
                if k not in ("earth", "sats"):
                    try:
                        pg.wait_for_function(
                            "() => { _ae.dirty = true; _aeKick(); return !document.getElementById('ae-info-btn').hidden; }",
                            timeout=5_000,
                            polling=100,
                        )
                    except Exception:
                        pass
                card = pg.evaluate(
                    """() => { var b = document.getElementById('ae-info-btn'), shown = !b.hidden && document.getElementById('ae-card').hidden;
                    if (shown) _aeOpenInfo(_ae.arrived);
                    var c = document.getElementById('ae-info'), out = { shown: shown, name: (c.querySelector('h2') || {}).textContent || '', lines: c.querySelectorAll('.ae-info-row').length };
                    _aeCloseInfo(false); return out; }"""
                )
                want = 2
                if k not in ("earth", "sats") and (
                    not card["shown"]
                    or not card["name"].strip()
                    or card["lines"] < want
                ):
                    bare.append((k, card))
            assert not bare, bare
            shade = pg.evaluate(
                """() => ({ behind: _aeInShadow([-2, 0, 0], [5, 0, 0]), beside: _aeInShadow([0, 2, 0], [5, 0, 0]), front: _aeInShadow([2, 0, 0], [5, 0, 0]) })"""
            )
            assert shade == {"behind": True, "beside": False, "front": False}, shade
            iss = pg.evaluate(
                """() => { return { dark: _aeInShadow(_ae.issPos, _ae.scene.sun),
                says: !!_aeArrival('iss', _aeDisplayMs()).note }; }"""
            )
            assert iss["dark"] == iss["says"], iss
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def _row_settles(pg, row, want, timeout_s=5.0):
    """The row is drawn on the frame after an arrival: it is read until it is `want`, or for `timeout_s`."""
    import time as _t

    end, got = _t.time() + timeout_s, None
    while _t.time() < end:
        got = pg.evaluate("() => { _ae.dirty = true; _aeKick(); }") or pg.evaluate(row)
        if got == want:
            return
        _t.sleep(0.1)
    assert got == want, got


STRIP_PLANETS = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"]


def _strip(host=None, moons=()):
    """The strip as the page keeps it: the Sun, every planet in order, the lit world's moons right after it."""
    out = ["sun"]
    for p in STRIP_PLANETS:
        out.append(p)
        if p == host:
            out += list(moons)
    return out


def test_the_row_follows_where_the_view_is(served):
    """The row is one strip of the system from the Sun: every planet in order, and only the world in view brings its
    moons, right after it (a moon has its planet before it; a probe goes after the body it is near). The lit world is
    marked, named above, and kept in view. One line, level; Side by side stands at the Sun with its tools."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br, 360)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            row = "() => Array.from(document.querySelectorAll('#ae-views [data-ae-view]')).map(b => b.getAttribute('data-ae-view'))"
            go = lambda k: (
                pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k),
                pg.wait_for_function(
                    "(k) => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset && _ae.target === k; }",
                    arg=k,
                    timeout=60_000,
                    polling=100,
                ),
            )
            _row_settles(pg, row, _strip("earth", ["moon"]))
            go("moon")
            _row_settles(pg, row, _strip("earth", ["moon"]))  # the planet before the moon
            assert pg.get_attribute("#ae-views [data-ae-view=moon]", "aria-current") == "true"
            go("jupiter")
            _row_settles(pg, row, _strip("jupiter", ["io", "europa", "ganymede", "callisto"]))
            assert pg.evaluate("_aeRowNameNow()") == "Jupiter"
            line = pg.evaluate(
                """() => { var bs = Array.from(document.querySelectorAll('#ae-views .ae-disc')).filter(b => b.offsetParent).map(b => b.getBoundingClientRect());
                var c = bs.map(r => r.top + r.height / 2); return { level: Math.max.apply(null, c) - Math.min.apply(null, c) <= 1.5 }; }"""
            )
            assert line == {"level": True}, line
            lit = pg.evaluate("() => { var b = document.querySelector('#ae-views [data-ae-view=jupiter]'), s = document.getElementById('ae-views'), r = b.getBoundingClientRect(), q = s.getBoundingClientRect(); return r.left >= q.left - 1 && r.right <= q.right + 1; }")
            assert lit, "the lit world is kept in view"
            go("io")
            _row_settles(pg, row, _strip("jupiter", ["io", "europa", "ganymede", "callisto"]))
            go("saturn")
            _row_settles(pg, row, _strip("saturn", [m for m in pg.evaluate("() => AE_PLANETS.filter(m => m.parent === 'saturn').sort((a, b) => a.orbit[0] - b.orbit[0]).map(m => m.key)")]))  # nearest first (6c972e9e)
            go("sun")
            _row_settles(pg, row, _strip())
            assert pg.get_attribute("#ae-views [data-ae-view=sun]", "aria-current") == "true"
            pg.evaluate("() => document.querySelector('#ae-views [data-ae-view=earth]').click()")  # a disc is a hop
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'earth'; }", timeout=60_000, polling=100)
            go("sun")
            pg.evaluate("_ae.fly = null; _aePreset('planets');")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.preset === 'planets'; }",
                timeout=60_000,
                polling=100,
            )
            pg.click("#ae-find"); pg.click("[data-ae-gomode=grid]"); pg.click(".ae-go-top3 [data-ae-go=spin]")
            pg.wait_for_function("() => !!_ae.spin", timeout=30_000, polling=100)
            assert pg.evaluate(row) == ["sun", "spin"]  # side by side: the Sun and itself (its tools beside them)
            assert pg.evaluate("() => document.querySelector('#ae-views [data-ae-view=\"spin\"]').getAttribute('aria-pressed')") == "true"
            assert not pg.query_selector("#ae-views [data-ae-view='orbits']")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_orbits_is_a_round_switch(served):
    """Orbits is a round switch, not in the gear: off (the default) a flight shows the orbits of the bodies it involves and
    fades them out after it lands; on keeps the system in view drawn. The Planets view always has the planets' orbits, and
    there the switch stands aside. The choice is remembered on this device."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            vis = "(k) => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); return _ae.gl.planets[k].orbit.visible; }"
            assert not pg.evaluate("_aeOrbitsOn()")
            assert not pg.evaluate(
                "!!document.querySelector('#ae-set-body input[name=ae-orbits]')"
            )
            pg.evaluate("_aePreset('jupiter')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !!_ae.fly; }",
                timeout=10_000,
                polling=50,
            )
            assert pg.evaluate(vis, "jupiter") and pg.evaluate(
                vis, "io"
            )  # the system it flies to, on the way
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=120_000,
                polling=100,
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); return !_ae.gl.planets.io.orbit.visible; }",
                timeout=10_000,
                polling=100,
            )
            # On: there, pressed, and remembered.
            pg.evaluate("() => document.getElementById('ae-orbits-btn').click()")   # (its button stays in the page, unseen: the name pill's sheet presses it)
            assert pg.evaluate("localStorage.getItem('zimi_ae_orbits')") == "always"
            assert pg.get_attribute("#ae-orbits-btn", "aria-pressed") == "true"
            assert pg.evaluate(vis, "io") and pg.evaluate(vis, "jupiter")
            # Off, standing still at Jupiter: the lines go (they stayed, Eric 2026-11-05).
            pg.evaluate("() => document.getElementById('ae-orbits-btn').click()")   # (its button stays in the page, unseen: the name pill's sheet presses it)
            assert pg.get_attribute("#ae-orbits-btn", "aria-pressed") == "false"
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); return !_ae.gl.planets.io.orbit.visible && !_ae.gl.planets.jupiter.orbit.visible; }",
                timeout=10_000,
                polling=100,
            )
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('planets');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=60_000,
                polling=100,
            )
            assert pg.evaluate(vis, "saturn") and not pg.evaluate(
                vis, "io"
            )  # the Planets view is a map of the orbits, whatever the switch
            assert pg.evaluate(
                "() => { _aeUpdate(_aeDisplayMs()); return _ae.gl.earthOrbit.orbit.visible; }"
            )  # the Earth's too
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return document.getElementById('ae-orbits-btn').hidden; }",
                timeout=10_000,
                polling=100,
            )
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_tap_on_the_craft_in_view_opens_its_card(served):
    """The model itself is what to tap, not only its little circle: at Voyager with its card put away, a tap on the
    craft brings the card back, and its name and the Golden Record link to their articles where the library has them.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _aeTracksLoad();"
            )
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            pg.evaluate("_ae.fly = null; _aePreset('voyager1');")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'voyager1' && !!_ae.gl.crafts && !!_ae.gl.crafts.voyager1 && _ae.gl.crafts.voyager1.root.visible; }",
                timeout=60_000,
                polling=200,
            )
            assert pg.evaluate(
                "document.getElementById('ae-card').hidden"
            )  # a clean view
            pg.evaluate("() => document.getElementById('ae-info-btn').click()")   # (its button stays in the page, unseen: the name pill's sheet presses it)
            pg.wait_for_function("() => !!_ae.info", timeout=10_000)
            assert "Voyager 1" in pg.inner_text("#ae-info h2")
            keys = pg.evaluate(
                "() => [_aeArrivalKey('voyager1'), AE_ARRIVAL_EXTRA.voyager1.key].map(k => !!AlmanacLinks.MAP[k])"
            )
            assert keys == [True, True], keys
            # Its Golden Record opens the Almanac's own section: the view closes and lands there.
            pg.evaluate(
                """() => { window._grOpened = 0; window._grStacks = []; window._scrollToGoldenRecord = function () { window._grOpened++; window._grStacks.push(new Error().stack); }; }"""
            )
            got = pg.evaluate(
                "() => { try { document.querySelector('#ae-info [data-ae-open]').click(); return window._grOpened; } catch (e) { return String(e); } }"
            )
            assert got == 1, (got, pg.evaluate("window._grStacks"))
            pg.wait_for_function("() => !_aeIsOpen", timeout=30_000)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_iss_stays_in_view_at_an_hour_a_second(served):
    """At an hour a second a fortnight passes in minutes: the station keeps its (approximate) dot and can still be
    flown to and followed, instead of going out once its elements age past the dot's days.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !!_ae.issPos; }",
                timeout=60_000,
                polling=200,
            )
            pg.evaluate(
                "() => { var s = _ae.sats.list.filter(x => x.iss)[0]; _aeGoTo(s.epochMs + 30 * 86400000); _almClockSetRate(3600); }"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); var s = _ae.sats.list.filter(x => x.iss)[0]; return s.standing === 'approximate' && !!_ae.issPos; }",
                timeout=30_000,
                polling=200,
            )
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_no_far_body_is_named_on_the_moon_close_up(served):
    """At the Moon, a third of the way in: no far body's mark floats on its disc (Callisto did, a dot and a name on the
    Moon's face). A far body's mark never draws over a nearer body's disc, and close in only the Moon's own group
    (the Earth, the Moon) is named."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('moon');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'moon'; }",
                timeout=30_000,
                polling=100,
            )
            pg.evaluate("_ae.dist = _ae.dist / 3; _ae.dirty = true; _aeKick();")
            pg.wait_for_timeout(1500)
            shown = pg.evaluate(
                """() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene);
                var m = _aeProject(_aeBodyPos('moon')), r = AE_TARGETS.moon.surface / _aeLen(_aeSub(_aeBodyPos('moon'), _aeXyz(_ae.gl.camera.position))) * _aePxPerRad(_ae.gl.camera);
                return Array.from(document.querySelectorAll('#ae-labels .ae-bm')).filter(e => !e.hidden).map(e => { var p = _aeProject(_aeBodyPos(e.id.replace('ae-bm-', '')));
                  return [e.id.replace('ae-bm-', ''), e.classList.contains('ae-bm-quiet'), !!p && Math.hypot(p.x - m.x, p.y - m.y) < r]; }); }"""
            )
            # a far planet may be a faint unnamed point in the sky (1.15.3), where it happens to stand, but never a name and never on the Moon's disc
            assert all(k in ("earth", "moon") or (quiet and not on_disc) for k, quiet, on_disc in shown), shown
            # Behind the Moon, not only close in: a point straight behind its centre is hidden by the sphere test.
            behind = pg.evaluate(
                """() => { var c = _ae.gl.camera.position, t = _aeTargetPos(), d = _aeNorm(_aeSub(t, [c.x, c.y, c.z]));
                return _aeBehindTarget('callisto', _aeAdd(t, _aeScale(d, 1000))); }"""
            )
            assert behind is True
            # As it opens at the Moon (not close in), the same: only the Earth and the Moon are named; a planet is a
            # faint point with no name, another planet's moons are not drawn; no mark sits under the controls on top.
            for width in (360, 390):
                pg.set_viewport_size({"width": width, "height": 844})
                pg.evaluate("_ae.fly = null; _aePreset('moon');")
                pg.wait_for_function(
                    "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                    timeout=30_000,
                    polling=100,
                )
                pg.wait_for_timeout(800)
                got = pg.evaluate(
                    """() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene);
                    var els = Array.from(document.querySelectorAll('#ae-labels .ae-bm')).filter(e => !e.hidden);
                    var named = els.filter(e => { var b = e.querySelector('b'); return b && getComputedStyle(b).display !== 'none' && b.textContent; }).map(e => e.id.replace('ae-bm-', ''));
                    var moons = els.map(e => e.id.replace('ae-bm-', '')).filter(k => { var b = _aePlanetBody(k); return b && b.parent; });
                    var tops = ['ae-gear', 'ae-locate'].map(id => document.getElementById(id)).filter(e => e && !e.hidden).map(e => e.getBoundingClientRect());
                    var under = Array.from(document.querySelectorAll('#ae-labels .ae-bm:not([hidden]) b, #ae-labels .ae-bm:not([hidden])')).filter(e => {
                      var r = e.getBoundingClientRect(); if (!r.width) return false;
                      return tops.some(t => r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top); }).map(e => e.textContent || e.id);
                    return { named: named, moons: moons, under: under }; }"""
                )
                assert set(got["named"]) <= {"earth", "moon"}, (width, got)
                assert got["moons"] == [], (width, got)
                assert got["under"] == [], (width, got)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_flight_to_a_planet_is_the_fly_between(served):
    """1.15.2's shot for every flight: over the shoulder, a circle on the body it leaves and on the one it goes to, and
    the line of sight and up turning with no snap (the bounds of test_almanac_earth_view.cjs's section 8b).

    Each flight starts from a pinned azimuth (-0.5): the fresh page's Earth view faces wherever the clock puts it, and from
    some azimuths the shoulder shot has the destination off screen (Jupiter 1000 px off from az -2.9).
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            _open(pg, served)
            for frm, to in (
                ("earth", "jupiter"),
                ("jupiter", "saturn"),
                ("mars", "moon"),
            ):
                rings = pg.evaluate(
                    """(a) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset(a.frm); window._almReduceMotion = undefined; _aeUpdate(_aeDisplayMs()); _ae.az = -0.5;
                    _aePreset(a.to); var f = _ae.fly; f.start = performance.now() - AE_FLY_APPROACH_MS; _aeStepFly(performance.now());
                    _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene);
                    var out = {}; [a.frm, a.to].forEach(function (b) { var el = document.getElementById('ae-bm-' + b);
                      out[b] = { shown: !el.hidden, ringed: el.classList.contains('ae-bm-ringed'), ring: getComputedStyle(el.querySelector('.ae-ring')).display }; });
                    out.hold = !!f.hold; _ae.fly = null; return out; }""",
                    {"frm": frm, "to": to},
                )
                assert rings["hold"], (frm, to, rings)
                for b in (frm, to):
                    assert (
                        rings[b]["shown"]
                        and rings[b]["ringed"]
                        and rings[b]["ring"] != "none"
                    ), (frm, to, b, rings)
                series = pg.evaluate(
                    """(a) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset(a.frm); window._almReduceMotion = undefined; _aeUpdate(_aeDisplayMs()); _ae.az = -0.5;
                    _aePreset(a.to); var f = _ae.fly, total = (f.hold ? (f.lead || AE_FLY_APPROACH_MS) + AE_FLY_TAIL_MS : 0) + f.ms, out = [], FR = 1000 / 60;
                    for (var t = 0; t <= total + FR; t += FR) { f.start = 0; _aeStepFly(Math.min(t, total - 1e-6)); _aePlaceCamera();
                      var cam = _ae.gl.camera; cam.updateMatrixWorld(); var e = cam.matrixWorld.elements; out.push([[-e[8], -e[9], -e[10]], [e[4], e[5], e[6]]]); if (!_ae.fly) break; }
                    _ae.fly = null; return out; }""",
                    {"frm": frm, "to": to},
                )
                import math

                def ang(p, q):
                    return math.degrees(
                        math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(p, q)))))
                    )

                for k in (0, 1):
                    w = [
                        ang(series[i][k], series[i + 1][k])
                        for i in range(len(series) - 1)
                    ]
                    acc = [w[i + 1] - w[i] for i in range(len(w) - 1)]
                    jerk = [acc[i + 1] - acc[i] for i in range(len(acc) - 1)]
                    assert max(abs(x) for x in acc) <= 0.5, (
                        frm,
                        to,
                        k,
                        max(abs(x) for x in acc),
                    )
                    assert max(abs(x) for x in jerk) <= 0.1, (
                        frm,
                        to,
                        k,
                        max(abs(x) for x in jerk),
                    )
                    assert w[0] <= 0.05 and w[-1] <= 0.05, (frm, to, k, w[0], w[-1])
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("width", [390, 360])
def test_no_name_runs_off_the_screen(served, width):
    """In the Planets view every name stays inside the screen, flipping inward at the edge (Neptune ran off at 390)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(
                viewport={"width": width, "height": 844},
                device_scale_factor=2,
                has_touch=True,
                is_mobile=True,
                service_workers="block",
            )
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
                % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
                timeout=READY_MS,
                polling=200,
            )
            pg.evaluate("_aePreset('planets')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeTracks; }",
                timeout=60_000,
                polling=200,
            )
            for _ in range(6):
                pg.evaluate("_ae.dirty = true; _aeKick()")
                pg.wait_for_timeout(200)
            names = pg.evaluate(
                """() => Array.from(document.querySelectorAll('#ae-labels .ae-bm')).filter(e => !e.hidden).map(e => {
                var b = e.querySelector('b'); if (getComputedStyle(b).display === 'none') return null;
                var r = b.getBoundingClientRect(); return [b.textContent, r.left, r.right]; }).filter(Boolean)"""
            )
            assert names
            for text, left, right in names:
                assert left >= 0 and right <= width, (width, text, left, right)
            ctx.close()
        finally:
            br.close()


CRAFT = {
    "voyager1": None,
    "pioneer10": None,
    "juno": None,
    "parker": None,
    "jwst": None,
    "galileo": "1996-06-27T12:00:00Z",
    "cassini": "2005-01-14T12:00:00Z",
}


def test_every_probe_model_is_small_and_knows_where_it_points():
    """Each probe's model (scripts/build_craft_models.py) is under 400 KB gzipped and carries a unit pointing axis
    and a unit axis across it: the view turns the first to the Earth (or the Sun) and holds the second level.
    """
    import gzip
    import struct

    earth = os.path.join(ROOT, "zimi", "static", "earth")
    for model in ("voyager", "pioneer", "juno", "parker", "webb", "galileo", "cassini", "kepler", "newhorizons", "clipper", "osirisrex", "psyche", "lucy"):
        raw = open(os.path.join(earth, "craft-%s-v1.bin" % model), "rb").read()
        assert len(gzip.compress(raw, 9)) < 400_000, model
        head = struct.unpack("<4sIf6f3f3fI", raw[:64])
        assert head[0] == b"ZCR2" and 1 <= head[15] <= 12, (model, head[0], head[15])
        aim, across = head[9:12], head[12:15]
        assert (
            abs(math.hypot(*aim) - 1) < 1e-3 and abs(math.hypot(*across) - 1) < 1e-3
        ), model
        assert abs(sum(a * b for a, b in zip(aim, across))) < 1e-3, model


@pytest.mark.parametrize("key", list(CRAFT))
def test_a_flight_to_a_probe_ends_on_its_model(served, key):
    """Go to a probe and the flight ends on NASA's model of it, a few of its spans off, its dot gone: Voyager, Pioneer,
    Juno, Cassini and Galileo with the high-gain antenna on the Earth, Parker's heat shield and Webb's sunshield on the
    Sun; its own path is not drawn through it."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("_aeTracksLoad()")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            if CRAFT[key]:
                pg.evaluate(
                    "(iso) => { _almClockSetRate(0); _almScrubSettle(new Date(iso)); }",
                    CRAFT[key],
                )
            pg.evaluate(
                "(k) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aeUpdate(_aeDisplayMs()); _aePreset(k); }",
                key,
            )
            pg.wait_for_function(
                "(k) => { _ae.dirty = true; _aeKick(); var I = _ae.gl.crafts && _ae.gl.crafts[k]; return !_ae.fly && _ae.target === k && !!I && I.root.visible && I.show > 0.99; }",
                arg=key,
                timeout=60_000,
                polling=200,
            )
            got = pg.evaluate(
                """(k) => { _aeUpdate(_aeDisplayMs()); var I = _ae.gl.crafts[k], m = AE_CRAFT_MODEL[k], d = _aeCraftData(m), V = _ae.gl.THREE.Vector3;
                var a = new V(d.aim[0], d.aim[1], d.aim[2]).applyQuaternion(I.root.quaternion), p = _aeBodyPos(k);
                var goal = AE_CRAFT_POINTS[m] === 'sun' ? _aeSunShown(_ae.scene) : [0, 0, 0], to = _aeNorm(_aeSub(goal, p));
                var c = _ae.gl.camera.position, dist = Math.hypot(c.x - p[0], c.y - p[1], c.z - p[2]);
                return { aim: a.x * to[0] + a.y * to[1] + a.z * to[2], spans: dist / _aeCraftSpanRe(m), dot: _aeProbeCraftDot(k),
                         trail: _ae.gl.probes.trails[k].visible }; }""",
                key,
            )
            assert got["aim"] > 0.999, got
            assert 1.5 < got["spans"] < 6, got
            assert (
                got["dot"] < 0.01
            ), got  # its tail stays beside it (test_almanac_iss_browser.py)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


LINES = """() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); var S = _ae.gl, out = [];
    Object.keys(S.planets).forEach(k => { var o = S.planets[k].orbit; if (o && o.visible && o.material.opacity > 0) out.push(k); });
    if (S.probes) Object.keys(S.probes.trails).forEach(k => { if (S.probes.trails[k].visible && S.probes.trails[k].material.opacity > 0) out.push(k + ':trail'); if (S.probes.orbits[k].visible) out.push(k + ':ellipse'); });
    [['moonPath', 'moon:path'], ['gpsRings', 'gps'], ['issRing', 'iss:ring']].forEach(p => { var l = S[p[0]]; if (l.visible && l.material.opacity > 0 && l.geometry.drawRange.count > 0) out.push(p[1]); });
    return out; }"""


@pytest.mark.parametrize("mode", ["always", None])
def test_the_orbits_setting_holds_after_a_reload(served, mode):
    """The remembered Orbits switch applies from the moment the view opens, for every line the scene draws (planets',
    moons', a probe's path and ellipse, the Moon's path, the GPS and station rings): on draws those of the place in view;
    off draws them in flight and none once landed (the Planets view keeps the planets'; a probe in view keeps its travelled road).
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            if mode:
                ctx.add_init_script(
                    "try { localStorage.setItem('zimi_ae_orbits', %r); } catch (e) {}"
                    % mode
                )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _aeTracksLoad();"
            )
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            seen = {}
            for k in ("earth", "moon", "jupiter", "juno", "planets"):
                pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k)
                pg.wait_for_function(
                    "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                    timeout=60_000,
                    polling=100,
                )
                if k == "juno":
                    pg.evaluate(
                        "() => { _ae.dist = AE_PROBE_VIEW_DIST; }"
                    )  # out where Juno is a point and its path is drawn
                pg.wait_for_timeout(1800)  # past While flying's fade
                seen[k] = pg.evaluate(LINES)
            if mode == "always":
                assert "io" in seen["jupiter"] and "jupiter" in seen["jupiter"], seen
                assert "juno:trail" in seen["juno"], seen
                assert "saturn" in seen["planets"], seen
            else:
                assert all(v == [] for k, v in seen.items() if k not in ("planets", "juno")), seen
                assert seen["juno"] == ["juno:trail"], seen   # the probe in view always shows the road it has travelled
                assert "saturn" in seen["planets"] and "io" not in seen["planets"], seen
            assert pg.evaluate("_aeOrbitsOn()") == bool(mode)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_moon_s_landings_on_the_first_tap(served):
    """At the Moon its landing table is there before Landings is tapped: the first tap opens Go to at the landings with
    their heading in view. With Landmarks off the Moon names none of them, before or after (Eric 2026-11-08).
    """
    from playwright.sync_api import sync_playwright

    labels = "() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden).map(b => b.textContent)"
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _aeLmSetLayer(false); _ae.fly = null; _aePreset('moon');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeLm; }",
                timeout=60_000,
                polling=100,
            )
            pg.wait_for_timeout(600)
            assert pg.evaluate(labels) == []
            pg.evaluate("() => _aeShowGo(true, 'alm_go_landings')")
            seen = pg.evaluate(
                """() => { var s = document.getElementById('ae-go'), r = s.querySelector('[data-ae-go^="lm:"]');
                if (!r || s.querySelector('[data-ae-pill="landings"]').getAttribute('aria-pressed') !== 'true') return null;
                var a = s.getBoundingClientRect(), b = r.getBoundingClientRect(); return b.top >= a.top - 1 && b.bottom <= a.bottom + 1; }"""
            )
            assert seen is True, seen
            pg.evaluate("_aeShowGo(false)")
            pg.wait_for_timeout(600)
            assert pg.evaluate(labels) == []
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_landing_s_card_and_the_go_to_sheet_stay_small(served):
    """A landing site's card is a name, its kind and a small Fly there on one line (no big button on a line of its own);
    once flown there the button is gone. The Go to sheet, opened at Landing sites, is the tall one: under the band, never the whole screen.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('moon');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeLm; }",
                timeout=60_000,
                polling=100,
            )
            pg.evaluate("() => _aeShowGo(true, 'alm_go_landings')")
            sheet = pg.evaluate(
                "() => document.getElementById('ae-go').getBoundingClientRect().height / innerHeight"
            )
            assert sheet <= 0.85, sheet  # the tall sheet: 704 of 844 px, a strip of the view stays above it
            pg.evaluate("_aeShowGo(false)")
            pg.evaluate(
                "() => _aeLmOpen('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 11')[0])"
            )
            box = pg.evaluate(
                "() => document.getElementById('ae-card').getBoundingClientRect().height"
            )
            assert box <= 150, box
            pg.evaluate("_aeLmFly(_ae.lm.body, _ae.lm.row)")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=60_000,
                polling=100,
            )
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_in_the_planets_view_a_tap_on_jupiter_is_jupiter(served):
    """In the Planets view a moon sits on its planet: not a target. A tap on Jupiter flies to Jupiter."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('planets');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=60_000,
                polling=100,
            )
            for k in ("jupiter", "saturn"):
                at = pg.evaluate(
                    "(k) => { _aeUpdate(_aeDisplayMs()); var s = _aeProject(_aeBodyPos(k)); return [s.x, s.y]; }",
                    k,
                )
                for dx, dy in ((0, 0), (3, 2), (-2, 3)):
                    assert (
                        pg.evaluate(
                            "(a) => _aeBodyAt(a[0], a[1])", [at[0] + dx, at[1] + dy]
                        )
                        == k
                    )
            at = pg.evaluate(
                "() => { var s = _aeProject(_aeBodyPos('jupiter')), r = document.getElementById('ae-canvas').getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; }"
            )
            pg.mouse.click(at["x"], at["y"])
            pg.wait_for_function(
                "() => _ae.target !== 'earth' && _ae.preset !== 'planets'",
                timeout=10_000,
                polling=100,
            )
            assert pg.evaluate("_ae.target") == "jupiter"
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize(
    "when", ["now", "2026-11-04", "2027-03-15", "2030-07-01", "2034-12-24"]
)
def test_all_eight_planets_are_named_in_the_planets_view(served, when):
    """At Planets scale the eight planets, and only they, are named, whatever the date (today Mercury and Venus are
    close): no two names overlap, none is across a planet's disc or the Sun, and each name's nearest dot is its own,
    or it stands on a short leader line back to its own dot, which no other body lies on.
    """
    from playwright.sync_api import sync_playwright

    eight = {
        "mercury",
        "venus",
        "earth",
        "mars",
        "jupiter",
        "saturn",
        "uranus",
        "neptune",
    }
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('planets');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && (_ae.marksDrawn || []).length > 5; }",
                timeout=60_000,
                polling=100,
            )
            if when != "now":
                import calendar
                import datetime

                ms = (
                    calendar.timegm(datetime.date.fromisoformat(when).timetuple())
                    * 1000
                )
                pg.evaluate("(ms) => _aeGoTo(ms)", ms)
            pg.wait_for_function(
                "(n) => { _ae.dirty = true; _aeKick(); var d = (_ae.marksDrawn || []).map(m => m.body); return n.every(k => d.indexOf(k) >= 0); }",
                arg=sorted(eight),
                timeout=30_000,
                polling=150,
            )
            pg.wait_for_timeout(400)
            got = pg.evaluate("""() => {
                var o = _ae.el.getBoundingClientRect(), pts = _ae.marksDrawn, named = [], boxes = [], bad = [];
                Array.from(document.querySelectorAll('#ae-labels .ae-bm')).forEach(function (el) {
                  var b = el.querySelector('b'), id = el.id.replace('ae-bm-', '');
                  if (el.hidden || el.classList.contains('ae-bm-n') || !b || getComputedStyle(b).display === 'none') return;
                  var r = b.getBoundingClientRect(), box = [r.left - o.left, r.top - o.top, r.right - o.left, r.bottom - o.top];
                  named.push(id); boxes.push([id, box]);
                  var d = function (p) { return Math.hypot(Math.max(box[0] - p.x, 0, p.x - box[2]), Math.max(box[1] - p.y, 0, p.y - box[3])); };
                  var own = pts.filter(p => p.body === id)[0];
                  if (!own) { bad.push([id, 'no dot']); return; }
                  var nearest = pts.slice().sort((a, c) => d(a) - d(c))[0];
                  var leader = el.classList.contains('ae-bm-pos');
                  if (nearest.body !== id && !leader) bad.push([id, 'nearest', nearest.body]);
                });
                var meet = [];
                for (var i = 0; i < boxes.length; i++) for (var j = i + 1; j < boxes.length; j++) {
                  var a = boxes[i][1], c = boxes[j][1];
                  if (a[0] < c[2] && c[0] < a[2] && a[1] < c[3] && c[1] < a[3]) meet.push([boxes[i][0], boxes[j][0]]);
                }
                return { named: named, bad: bad, meet: meet }; }""")
            assert set(got["named"]) == eight, got
            assert got["bad"] == [] and got["meet"] == [], got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_added_light_carries_its_own_alpha(served):
    """The Sun's corona and the Earth's rim are light added to a see-through canvas: over empty sky each pixel must have
    alpha at least as big as its colour (WebKit drops colour where alpha is zero, which left the corona as streaks).
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('sun');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'sun'; }",
                timeout=60_000,
                polling=100,
            )
            pg.wait_for_timeout(1500)  # the Sun fades in as it arrives
            got = pg.evaluate(
                """() => {
                var S = _ae.gl, gl = S.renderer.getContext(), s = _aeProject(_aeSunShown(_ae.scene)), cam = S.camera;
                var d = _aeLen(_aeSub(_aeSunShown(_ae.scene), [cam.position.x, cam.position.y, cam.position.z]));
                var pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2), disc = AE_SUN_SHOW_R / d * pxPerRad;
                S.renderer.render(S.scene, cam);
                var x = Math.round((s.x + disc * 1.5) * S.dpr), y = Math.round(gl.drawingBufferHeight - (s.y + 0) * S.dpr), px = new Uint8Array(4);
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                return { px: Array.from(px), src: S.sunGlowUni && S.sun.children[1].material.blendSrcAlpha, one: AE_THREE_ONE_FACTOR }; }"""
            )
            r, g, b, a = got["px"]
            assert a > 0 and max(r, g, b) <= a + 1, got
            assert got["src"] == got["one"], got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_sun_in_the_planets_view_is_on_the_planets_scale(served):
    """At the planets' scale (log of true size, squeezed to fit) the Sun is drawn by the same law, so it reads as the
    biggest body without swallowing the inner orbits: wider than Jupiter's disc, under twice its width, a fraction of
    the Sun's true ratio (nearly ten to one). No planet or probe is named with a count (no "+n").
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('planets');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && (_ae.marksDrawn || []).some(m => m.body === 'sun'); }",
                timeout=60_000,
                polling=100,
            )
            got = pg.evaluate(
                """() => { var d = _ae.marksDrawn, r = b => (d.filter(m => m.body === b)[0] || {}).r;
                var names = Array.from(document.querySelectorAll('#ae-labels .ae-bm:not([hidden]):not(.ae-bm-quiet) b')).map(b => b.textContent);
                return { sun: r('sun'), jupiter: r('jupiter'), law: _aeMarkDiscR('sun'), names: names }; }"""
            )
            assert (
                got["sun"] == pytest.approx(got["law"])
                and got["jupiter"] < got["sun"] < 2 * got["jupiter"]
            ), got
            assert not any("+" in n for n in got["names"]), got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_nothing_is_drawn_through_a_nearer_body(served):
    """A moon passing behind its planet is hidden, its mark and its name too; the same rule for anything behind the Sun
    (as drawn) or behind a nearer planet."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('jupiter');"
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=60_000,
                polling=100,
            )
            # Step through two days at Jupiter (Io goes round in 1.77): when Io is behind Jupiter from here, nothing of it.
            got = pg.evaluate("""() => { var t0 = _aeDisplayMs(), hits = 0, wrong = [];
                for (var t = t0; t < t0 + 2 * 86400000; t += 15 * 60000) {
                  _aeUpdate(t); _aeUpdate(t); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene);
                  var c = _ae.gl.camera.position, eye = [c.x, c.y, c.z], io = _aeBodyPos('io'), j = _aeBodyPos('jupiter');
                  if (!(_aeLen(_aeSub(io, eye)) > _aeLen(_aeSub(j, eye)) && _aeBehindSphere(io, j, AE_TARGETS.jupiter.surface))) continue;
                  hits++;
                  var el = document.getElementById('ae-bm-io');
                  if (_ae.gl.planets.io.mesh.visible || (_ae.marksDrawn || []).some(m => m.body === 'io') || (el && !el.hidden)) wrong.push(t);
                }
                return { hits: hits, wrong: wrong }; }""")
            assert got["hits"] > 0, got
            assert got["wrong"] == [], got
            # And the Sun: a point straight behind it, as drawn, is behind it.
            behind = pg.evaluate(
                """() => { var c = _ae.gl.camera.position, eye = [c.x, c.y, c.z], s = _aeSunShown(_ae.scene);
                var p = _aeAdd(s, _aeScale(_aeNorm(_aeSub(s, eye)), 50)), q = _aeAdd(p, [0, 0, 10 * AE_SUN_SHOW_R]);
                return [_aeBehindAny('mars', p), _aeBehindAny('mars', q)]; }"""
            )
            assert behind == [True, False], behind
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("view", ["jupiter", "planets"])
def test_a_small_body_in_front_never_hides_a_bigger_one(served, view):
    """Io straight in front of Jupiter's middle (the camera on the line through both, beyond Io) hides nothing of
    Jupiter: its sphere stays drawn (close up), its name stays, and Io is drawn over it. Hiding is by the screen disc
    that covers a body, never "A is nearer than B"."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "(v) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset(v); }",
                view,
            )
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=60_000,
                polling=100,
            )
            got = pg.evaluate(
                """(v) => {
                _aeUpdate(_aeDisplayMs()); _aeUpdate(_aeDisplayMs());
                var io = _aeBodyPos('io'), j = _aeBodyPos('jupiter'), u = _aeNorm(_aeSub(io, j));
                var far = v === 'planets' ? 4000 : 3 * AE_TARGETS.jupiter.surface;
                var eye = _aeAdd(io, _aeScale(u, far)), cam = _ae.gl.camera;
                cam.position.set(eye[0], eye[1], eye[2]); cam.lookAt(j[0], j[1], j[2]); cam.updateMatrixWorld();
                var behind = _aeBehindAny('jupiter', j, true), ioBehind = _aeBehindAny('io', io, true);
                _aeUpdatePlanets(_ae.scene); _aeUpdateMarks(_ae.scene);
                var el = document.getElementById('ae-bm-jupiter');
                return { behind: behind, ioBehind: ioBehind, mesh: _ae.gl.planets.jupiter.mesh.visible, ioMesh: _ae.gl.planets.io.mesh.visible,
                         mark: !!el && !el.hidden, sphereTest: _aeBehindSphere(j, io, AE_TARGETS.io.surface) }; }""",
                view,
            )
            assert (
                got["sphereTest"] is True
            ), got  # Io's disc does cover Jupiter's middle from here
            assert got["behind"] is False, got
            if view == "jupiter":
                assert got["mesh"] and got["ioMesh"], got
            assert got["mark"] or view == "jupiter", got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_voyager_carries_its_golden_record(served):
    """Voyager's model carries the record itself: a round gold disc on the bus with the Almanac's own picture of its
    cover, and a tap on it opens the Almanac's Golden Record. The craft has a gentle fill beside the Sun's light, so far
    out its shape still reads."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _aeTracksLoad();"
            )
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            pg.evaluate("_ae.fly = null; _aePreset('voyager1');")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); var I = _ae.gl.crafts && _ae.gl.crafts.voyager1; return !_ae.fly && !!I && I.root.visible && !!I.record && I.record.material.uniforms.mapped.value === 1; }",
                timeout=60_000,
                polling=200,
            )
            assert pg.evaluate("_ae.gl.crafts.voyager1.uni.fill.value") > 0
            assert (
                pg.evaluate("AE_RECORD_IMG").split("?")[0] == "/static/golden-record/cover.jpg"
            )  # the picture the Golden Record section shows
            assert pg.evaluate(
                "!!_ae.gl.crafts.voyager1.record.material.uniforms.map.value"
            )
            pg.evaluate(
                """() => { window._grOpened = 0; window._scrollToGoldenRecord = function () { window._grOpened++; }; }"""
            )
            # Turn the view so the record faces the camera, then tap it.
            at = pg.evaluate(
                """() => { var I = _ae.gl.crafts.voyager1, c = I.record.userData.at;
                I.root.updateMatrixWorld(true);
                var w = new _ae.gl.THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(I.root.matrixWorld), o = new _ae.gl.THREE.Vector3(c[0] + 1, c[1], c[2]).applyMatrix4(I.root.matrixWorld);
                var n = _aeNorm([o.x - w.x, o.y - w.y, o.z - w.z]), ae = _aeAzElOf(n);
                _ae.az = ae.az; _ae.el_ = ae.el; _aeUpdate(_aeDisplayMs()); _ae.gl.camera.updateMatrixWorld(); I.root.updateMatrixWorld(true);
                w = new _ae.gl.THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(I.root.matrixWorld);
                var s = _aeProject([w.x, w.y, w.z]), r = document.getElementById('ae-canvas').getBoundingClientRect();
                return { x: r.left + s.x, y: r.top + s.y }; }"""
            )
            (
                pg.screenshot(
                    path=os.environ.get("ALM_SHOT_DIR", "/tmp") + "/voyager-record.png"
                )
                if os.environ.get("ALM_SHOT_DIR")
                else None
            )
            pg.mouse.click(at["x"], at["y"])
            pg.wait_for_function("() => window._grOpened === 1", timeout=10_000)
            pg.wait_for_function("() => !_aeIsOpen", timeout=30_000)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_first_moments_ask_health_once_and_the_activity_poll_waits_for_quiet(served):
    """One /health for the footer's version and the build check together; /manage/activity is not asked for before the
    page has gone quiet."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            seen = []
            pg.on("request", lambda r: seen.append((r.url.replace(served, "").split("&")[0], 0)))
            pg.goto(served + "/", wait_until="load")
            pg.wait_for_function("() => !!document.getElementById('footer-version') && !!document.getElementById('footer-version').textContent", timeout=30_000)
            first = [u for u, _ in seen]
            health = [u for u in first if u.startswith("/health") and "ping" not in u]
            assert len(health) <= 1, first
            pg.wait_for_timeout(12_000)
            assert any(u.startswith("/manage/activity") for u, _ in seen), "the poll still starts"
            ctx.close()
        finally:
            br.close()


def test_the_minimap_is_96_px_bottom_left_above_the_row_and_a_tap_opens_the_solar_system(served):
    """The v1.15.7 minimap is back: 96 px at the bottom left, above the row of worlds, drawn from the orrery's painters; a tap opens the
    solar system view, where it goes away."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br, 390)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=120_000)
            pg.wait_for_function("() => !document.getElementById('ae-mini').hidden", timeout=30_000)
            box = pg.evaluate("() => { const m = document.getElementById('ae-mini').getBoundingClientRect(), r = document.getElementById('ae-chips').getBoundingClientRect(); return { w: m.width, h: m.height, left: m.left, bottom: m.bottom, rowTop: r.top }; }")
            assert abs(box["w"] - 96) < 1 and abs(box["h"] - 96) < 1 and box["left"] < 20 and box["bottom"] <= box["rowTop"], box
            pg.tap("#ae-mini")
            pg.wait_for_function("() => _ae.preset === 'planets'", timeout=60_000)
            pg.wait_for_function("() => document.getElementById('ae-mini').hidden", timeout=30_000)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_planets_stay_on_their_orbits_and_the_belt_round_the_sun_as_the_date_runs(
    served,
):
    """The Sun swings round the Earth a degree a day, and the Earth is the middle of this view. An orbit line or the belt
    stored beside where the Sun stood left every planet off its ring as the date ran (up to the 30 days a line is kept):
    at a month a second a planet stood 20 px from its line at 390 px, at a year a second 90. Each line is round the Sun as
    drawn this frame, whatever date it was worked out for."""
    from playwright.sync_api import sync_playwright

    day = 86400000
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("() => _aePreset('planets')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeAst && _aeAst.at !== null && _aeAst.fill == null; }",
                timeout=60_000,
                polling=200,
            )
            probe = """() => { var S = _ae.gl, sun = _aeSunShown(_ae.scene), worst = 0, belt = 0;
              Object.keys(S.planets).forEach(function (k) { var p = S.planets[k]; if (p.b.parent || !p.orbit || !p.pos || !p.orbit.visible) return;
                var a = p.orbit.geometry.attributes.position.array, o = p.orbit.position, best = 1e9;
                // The nearest line vertex to the body, in scene units, over the vertex spacing (the line is polylines).
                var n = p.orbit.geometry.drawRange.count, pts = []; for (var i = 0; i < n; i++) pts.push([a[i*3] + o.x, a[i*3+1] + o.y, a[i*3+2] + o.z]);
                for (var i = 0; i < n; i++) { var A = pts[i], B = pts[(i + 1) % n], d = _aeSub(B, A), l = _aeDot(d, d),
                  t = l ? Math.max(0, Math.min(1, _aeDot(_aeSub(p.pos, A), d) / l)) : 0, c = _aeAdd(A, _aeScale(d, t));
                  best = Math.min(best, _aeLen(_aeSub(p.pos, c)) / _aeShownDist(_aeLen(_aeSub(p.pos, sun))));   // as a share of its drawn radius
                }
                worst = Math.max(worst, best); });
              var c = _aeAst.cloud.position; belt = Math.hypot(c.x - sun[0], c.y - sun[1], c.z - sun[2]);
              return { worst: worst, belt: belt }; }"""
            for step in (20, 11, 29, -20, -45):
                pg.evaluate(
                    "(ms) => { _almFocus = new Date((_almFocus ? +_almFocus : Date.now()) + ms); _aeFollowClock(); }",
                    step * day,
                )
                got = pg.evaluate(probe)
                assert got["worst"] < 0.01, (step, got)
                assert got["belt"] < 1e-6, (step, got)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_probe_s_path_ends_on_the_probe_as_the_date_runs(served):
    """A path kept from an earlier date left the probe behind as the date ran (the Sun moves a degree a day under it, and a
    planet under Juno's): every frame a path is shown it ends on the probe.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate(
                "window._almReduceMotion = function () { return true; }; _aeTracksLoad(); _aeSetOrbits(true);"
            )
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            for k, step in (("parker", 1.0), ("juno", 0.3)):
                pg.evaluate("(k) => _aePreset(k)", k)
                pg.wait_for_function(
                    "(k) => { _ae.dirty = true; _aeKick(); return _ae.target === k && !_ae.fly; }",
                    arg=k,
                    timeout=60_000,
                    polling=100,
                )
                pg.evaluate("() => { _ae.dist = AE_PROBE_VIEW_DIST; }")
                for _ in range(4):
                    pg.evaluate(
                        "(ms) => { _almFocus = new Date(_aeDisplayMs() + ms); _aeFollowClock(); }",
                        step * 86400000,
                    )
                    got = pg.evaluate(
                        """(k) => { var t = _ae.gl.probes.trails[k], r = _ae.gl.probes.orbits[k], a = t.geometry.attributes.position.array,
                        n = a.length / 3 - 1, p = _aeProbePos[k], end = Math.hypot(t.position.x + a[n*3] - p[0], t.position.y + a[n*3+1] - p[1], t.position.z + a[n*3+2] - p[2]), gap = 1e9;
                        var b = r.geometry.attributes.position.array;
                        for (var i = 0; i < 180; i++) gap = Math.min(gap, Math.hypot(b[i*3] - p[0], b[i*3+1] - p[1], b[i*3+2] - p[2]));
                        return { shown: t.visible, ring: r.visible, end: end, gap: gap, au: AU_KM / AE_EARTH_RADIUS_KM }; }""",
                        k,
                    )
                    assert got["shown"] and not got["ring"], (k, got)   # (no ellipse: it is the way ahead)
                    assert got["end"] < 0.01, (k, got)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_every_body_turns_at_its_own_period_in_real_time(served):
    """a Mars moon looked to spin crazy fast at 1x. Over ten seconds of real time every planet and moon turns its own rate: the rotation tables' for a planet, its
    orbit's for a moon locked to its planet (Phobos once in 7.65 hours), within 1%."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            res = pg.evaluate(
                """() => { var out = {}, ms = Date.UTC(2026, 5, 1, 12), turn = function (t) { var sc = _aeSceneAt(t); _ae.scene = sc; _aeUpdatePlanets(sc); var o = {};
                    Object.keys(_ae.gl.planets).forEach(function (k) { var p = _ae.gl.planets[k]; if (p.mesh) { var e = p.mesh.matrix.elements; o[k] = [e[0], e[1], e[2]]; } }); return o; };
                  var a = turn(ms), b = turn(ms + 10000);
                  Object.keys(a).forEach(function (k) { var p = _ae.gl.planets[k], u = a[k], v = b[k], d = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) * 180 / Math.PI;
                    var perDay = p.b.pole && p.b.pole[3] ? Math.abs(p.b.pole[3]) : p.b.orbit ? Math.abs(p.b.orbit[2]) : 0;
                    // a planet's x axis is its prime meridian (turning at the table's rate); the pole's own drift is nothing over ten seconds
                    out[k] = [d / 10, perDay / 86400, !!p.pos, !!p.b.parent]; });
                  return out; }"""
            )
            checked = 0
            for k, (got, want, placed, is_moon) in res.items():
                if want == 0 or not placed or got == 0:
                    continue   # no rotation table or no place for it at this date (the dwarf planets and Charon are held)
                assert got == pytest.approx(want, rel=0.01), (k, got, want, "deg/s: its turn over ten seconds is its own period's")
                checked += 1
            assert checked >= 15 and "phobos" in res and res["phobos"][0] == pytest.approx(360 / (0.3189 * 86400), rel=0.01), res.get("phobos")   # 7.65 h
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_flight_between_worlds_crosses_no_cage_of_satellite_orbits_or_stray_lines(served):
    """Z (d): the Earth to Moon flight went through a zoomed-out web of satellite orbits with a stray straight line (an orbit seen edge-on). While a flight is on, no orbit line, ring or satellite dot
    is drawn; they fade back at rest."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("() => { _aeNow(); _aePreset('moon'); }")
            pg.wait_for_function("() => _ae.fly && _ae.fly.prog > 0.5", timeout=120_000, polling=50)
            pg.wait_for_timeout(700)
            seen = pg.evaluate(
                """() => { var S = _ae.gl, out = [];
                  // (a flight shows the planets' own paths round the Sun and the gyroscope's axis, since 27a36e55 and 1.15.4: not the satellites' web)
                  // (the station's ring and the telescopes' rings, Hubble and Chandra, are one kind: a craft's own orbit, which a flight from the Earth keeps)
                  var kept = o => o === S.issRing || Object.keys(S.craftRings || {}).some(k => S.craftRings[k] === o) || o.material.color.getHexString() === '9aa8c8' || o.material.color.getHexString() === 'ffb347';
                  S.scene.traverse(o => { if ((o.isLine || o.isLineSegments || o.isLineLoop) && o.visible && o.material.opacity > 0.01 && !kept(o)) out.push(o.material.opacity); });
                  return { lines: out, gps: S.gpsRings.visible && S.gpsRings.material.opacity > 0.01, sats: S.sats.material.uniforms.fade.value, flying: !!_ae.fly }; }"""
            )
            assert seen["flying"] and seen["lines"] == [] and not seen["gps"] and seen["sats"] < 0.05, seen
            pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=100)
            pg.wait_for_timeout(1200)
            assert pg.evaluate("() => _ae.transitK") == 1
            assert not errors, errors
        finally:
            br.close()


def test_satellites_stay_further_out_in_time_faded_and_marked_approximate(served):
    """a GPS satellite past the 180 days its data holds exactly keeps a faded dot (to AE_SAT_APPROX_DAYS, where SGP4's along-track error reaches a hundredth of the orbit), the card and the status
    line say approximate, and beyond it nothing is drawn."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            ctx.add_init_script("try { localStorage.setItem('zimi_ae_sats_all', '1'); } catch (e) {}")   # the constellation is the Satellites layer's
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.wait_for_function("() => _ae.sats && _ae.sats.list && _ae.sats.list.length > 5", timeout=120_000, polling=250)
            newest = pg.evaluate("() => Math.max(..._ae.sats.list.map(s => s.epochMs))")

            def at(days):
                pg.evaluate("(ms) => { _aeGoTo(ms); _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); }", newest + days * 86400000)
                return pg.evaluate(
                    "() => { var g = _ae.sats.list.filter(s => !s.iss && s.standing !== 'none'); return { n: g.length, standing: g.length ? g[0].standing : null, alpha: _ae.gl.sats.geometry.attributes.aAlpha.array[0], drawn: _ae.gl.sats.geometry.drawRange.count }; }"
                )

            near, mid, far, gone = at(10), at(600), at(1090), at(1200)
            assert near["standing"] == "exact" and near["alpha"] == 1, near
            assert mid["n"] > 0 and mid["standing"] == "approximate" and 0.12 < mid["alpha"] < 0.6, mid
            assert far["standing"] == "approximate" and far["alpha"] < mid["alpha"], (far, mid)
            assert gone["n"] == 0, gone
            assert not errors, errors
        finally:
            br.close()


def test_the_moons_path_is_smooth_where_the_moon_is(served):
    """The Moon's path was drawn in 6-hour steps, a chord about 3.5 Earth radii long: seen up close it had corners.
    Near the Moon it is drawn in 10-minute steps, so beside the Moon each segment turns by under a tenth of a degree.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _ctx(br).new_page()
            _open(pg, served)
            pg.evaluate("() => { _aeSetOrbits(true); _aePreset('moon'); }")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return _ae.target === 'moon' && !_ae.fly && _ae.moonPathAt !== null; }", timeout=60_000, polling=100)
            got = pg.evaluate(
                """() => { var S = _ae.gl, a = S.moonPath.geometry.attributes.position.array, m = _ae.scene.moon, n = S.moonPathCount, best = 0, d0 = 1e9;
                  for (var i = 0; i < n; i++) { var d = Math.hypot(a[3*i]-m[0], a[3*i+1]-m[1], a[3*i+2]-m[2]); if (d < d0) { d0 = d; best = i; } }
                  var turn = 0;
                  for (var j = Math.max(1, best - 5); j < Math.min(n - 1, best + 5); j++) {
                    var u = [0,1,2].map(k => a[3*j+k] - a[3*(j-1)+k]), v = [0,1,2].map(k => a[3*(j+1)+k] - a[3*j+k]);
                    var c = (u[0]*v[0]+u[1]*v[1]+u[2]*v[2]) / Math.hypot(...u) / Math.hypot(...v);
                    turn = Math.max(turn, Math.acos(Math.min(1, c)) * 180 / Math.PI); }
                  return { near: d0, turn: turn, seg: Math.hypot(a[3*best+3]-a[3*best], a[3*best+4]-a[3*best+1], a[3*best+5]-a[3*best+2]) }; }"""
            )
            assert got["near"] < 0.05, got   # the path runs through the Moon (Earth radii)
            assert got["seg"] < 0.2, got     # short steps beside it, not 3.5 Earth radii
            assert got["turn"] < 0.2, got    # degrees a segment turns: no corners
        finally:
            br.close()


def test_earths_orbit_has_no_corners_beside_the_moon(served):
    """Earth's orbit was drawn in 2-degree steps, chords about 820 Earth radii long: beside the Moon it showed corners.
    It is now drawn in fine steps about where the Earth is, so each segment there turns by under 0.2 degrees.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _ctx(br).new_page()
            _open(pg, served)
            pg.evaluate("() => { _aeSetOrbits(true); _aePreset('moon'); }")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); var o = _ae.gl.earthOrbit; return _ae.target === 'moon' && !_ae.fly && o.orbitAt != null && o.orbit.visible; }", timeout=60_000, polling=100)
            got = pg.evaluate(
                """() => { var e = _ae.gl.earthOrbit, a = e.orbit.geometry.attributes.position.array, o = e.orbit.position, n = e.orbit.geometry.drawRange.count;
                  var P = i => [a[3*i] + o.x, a[3*i+1] + o.y, a[3*i+2] + o.z], best = 0, d0 = 1e12;
                  for (var i = 0; i < n; i++) { var p = P(i), d = Math.hypot(p[0], p[1], p[2]); if (d < d0) { d0 = d; best = i; } }   // the Earth is the scene's origin
                  var turn = 0;
                  for (var j = Math.max(1, best - 5); j < Math.min(n - 1, best + 5); j++) {
                    var p0 = P(j-1), p1 = P(j), p2 = P(j+1), u = [0,1,2].map(k => p1[k]-p0[k]), v = [0,1,2].map(k => p2[k]-p1[k]);
                    var c = (u[0]*v[0]+u[1]*v[1]+u[2]*v[2]) / Math.hypot(...u) / Math.hypot(...v);
                    turn = Math.max(turn, Math.acos(Math.min(1, c)) * 180 / Math.PI); }
                  return { n: n, near: d0, turn: turn }; }"""
            )
            assert got["near"] < 30, got   # the line runs by the Earth (Earth radii), not a chord's sagitta away
            assert got["turn"] < 0.2, got  # no corners where the Moon is
        finally:
            br.close()
