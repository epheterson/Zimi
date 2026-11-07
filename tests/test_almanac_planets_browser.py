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

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
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
    c = sum(x * y for x, y in zip(a, b)) / math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
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
            got = pg.evaluate("""(a) => { var sc = _aeSceneAt(a.ms); _ae.scene = sc; _aeUpdatePlanets(sc); var out = {};
                var jd = a.ms / MS_PER_DAY + JD_UNIX_EPOCH, jde = jd + _aeDeltaTDays(jd), sun = _aeSunShown(sc);
                Object.keys(a.ref).forEach(function (k) { var p = _ae.gl.planets[k].pos;
                  out[k] = { drawn: [p[0] - sun[0], p[1] - sun[1], p[2] - sun[2]], ref: _ephEclJ2000ToEqOfDate(a.ref[k], jde) }; });
                var j = _ae.gl.planets.jupiter.pos, io = _ae.gl.planets.io.pos, ca = _ae.gl.planets.callisto.pos;
                out.io_km = Math.hypot(io[0] - j[0], io[1] - j[1], io[2] - j[2]) * AE_EARTH_RADIUS_KM;
                out.callisto_km = Math.hypot(ca[0] - j[0], ca[1] - j[1], ca[2] - j[2]) * AE_EARTH_RADIUS_KM;
                return out; }""", {"ms": WHEN_MS, "ref": HORIZONS})
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
            assert any(u.endswith("/static/earth/saturn-v1.webp") for u in asked)
            assert pg.evaluate("_aeBodyAt(_ae.w / 2, _ae.h / 2)") == "saturn"
            pg.evaluate("_aeUpdateText(_aeDisplayMs())")
            assert "Solar System Scope" in pg.inner_text(".ae-note")
            # Far away, a planet is a mark and no map is fetched for the ones too small to see.
            assert not any(u.endswith("/static/earth/neptune-v1.webp") for u in asked)
            # The Planets chip: the whole system from above, every orbit drawn, the belt placed.
            pg.click("[data-ae-view='planets']")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeAst && _aeAst.at !== null; }", timeout=60_000, polling=200)
            assert pg.evaluate("_ae.target") == "sun"
            assert pg.evaluate("Object.keys(_ae.gl.planets).filter(k => _ae.gl.planets[k].orbit && _ae.gl.planets[k].orbit.visible).length") == 7
            # The belt lies between Mars and Jupiter round the Sun: every asteroid's distance from the Sun as drawn
            # within the two planets' (a few of the 18,000 stray inside Mars's: the Hungarias).
            belt = pg.evaluate("""() => { var a = _aeAst.cloud.geometry.attributes.position.array, sun = _aeSunShown(_ae.scene), d = [];
                for (var i = 0; i < _aeAst.cloud.geometry.drawRange.count; i++) d.push(Math.hypot(a[i*3] - sun[0], a[i*3+1] - sun[1], a[i*3+2] - sun[2]));
                d.sort(function (x, y) { return x - y; });
                var r = function (k) { var p = _ae.gl.planets[k].pos; return Math.hypot(p[0] - sun[0], p[1] - sun[1], p[2] - sun[2]); };
                return { n: _aeAst.n, drawn: d.length, p1: d[Math.floor(d.length * 0.01)], p99: d[Math.floor(d.length * 0.99)], mars: r('mars'), jupiter: r('jupiter') }; }""")
            assert belt["n"] > 15000 and 5000 < belt["drawn"] < belt["n"] / 2, belt   # a faint ring: a third of them drawn
            # Through the same squeeze as the planets: clear of Mars's orbit at its farthest and Jupiter's at its nearest.
            mars_far, jup_near = pg.evaluate("[_aeShownDist(1.666), _aeShownDist(4.95)]")   # the Almanac's one squeeze
            assert mars_far < belt["p1"] and belt["p99"] < jup_near, (belt, mars_far, jup_near)
            assert pg.evaluate("_aeShownDist(1) === AE_SUN_SHOW_DIST && _aeShownDist(30.07) / _aeShownDist(1) === _solarSqueeze(30.07) / _solarSqueeze(1)")
            # Names: none over another name or another body's ring, at 390 px, and the planets named.
            pg.wait_for_timeout(500)
            # Each mark is the body itself, small; its name covers no other body and no other name, at 390 px.
            marks = pg.evaluate("""() => _ae.marksDrawn.map(d => { var e = document.getElementById(d.el), b = e && e.querySelector('b');
                var named = b && getComputedStyle(b).display !== 'none' && d.body === d.lead, nb = named ? b.getBoundingClientRect() : null;
                var v = _ae.el.getBoundingClientRect();   // the marks' own frame: the view's
                return { body: d.body, lead: d.lead, box: [d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r], name: nb ? [nb.left - v.left, nb.top - v.top, nb.right - v.left, nb.bottom - v.top] : null }; })""")
            assert pg.evaluate("Array.from(document.querySelectorAll('#ae-labels .ae-ring')).every(r => getComputedStyle(r).display === 'none')"), "no hollow rings"
            meet = lambda a, b: a[0] < b[2] - 0.5 and b[0] < a[2] - 0.5 and a[1] < b[3] - 0.5 and b[1] < a[3] - 0.5  # noqa: E731
            for m in marks:
                for o in marks:
                    if o is m:
                        continue
                    if m["name"]:
                        assert not meet(m["name"], o["box"]), (m, o)
                        assert not (o["name"] and meet(m["name"], o["name"])), (m, o)
            named = {m["body"] for m in marks if m["name"]}
            # The Sun is a disc on the planets' own scale, bigger than Jupiter's, not a speck.
            sizes = pg.evaluate("() => Object.fromEntries(_ae.marksDrawn.map(d => [d.body, d.r]))")
            assert sizes.get("sun", 0) > sizes.get("jupiter", 99), sizes
            assert {"jupiter", "saturn", "uranus", "neptune"} <= named, named
            radius = {m["body"]: m["box"][2] - m["box"][0] for m in marks}
            assert radius.get("jupiter", 0) > radius.get("mercury", radius.get("mars", 99)) or "mercury" not in radius, radius
            assert pg.is_visible("#ae-scale")
            # Bodies on top of each other are one crowd: a single name with its count, every disc still drawn.
            for m in marks:
                for o in marks:
                    if o is not m and o["lead"] != m["lead"] and m["body"] == m["lead"] and o["body"] == o["lead"]:
                        assert not meet(m["box"], o["box"]), (m, o)
            # Nothing under the controls at the foot.
            foot = pg.evaluate("document.querySelector('.ae-bottom').getBoundingClientRect().top - _ae.el.getBoundingClientRect().top")
            assert all(m["box"][1] < foot for m in marks), (foot, marks)
            # The planets only are named out here: no probe, moon or dwarf planet name, no crowd counts.
            planets = {"mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"}
            assert named <= planets, named
            assert not pg.evaluate("Array.from(document.querySelectorAll('#ae-labels .ae-bm b')).some(b => / \\+\\d/.test(b.textContent))")
            # The probes: once out here their table comes; each flying one is named, Webb stands at L2 at its true
            # distance from the Earth (1.5 million km, not squeezed by the drawn scale), and a tap's card says where.
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !!_aeTracks && !!_aeProbePos.voyager1 && !!_aeProbePos.jwst; }", timeout=60_000, polling=200)
            jwst_km = pg.evaluate("Math.hypot.apply(null, _aeProbePos.jwst) * AE_EARTH_RADIUS_KM")
            assert 1.2e6 < jwst_km < 1.9e6, jwst_km
            pg.evaluate("_aePreset('voyager1')")
            # Its model loads first, then the flight and its card: the card names it, where it is, and what it last did.
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.arrived === 'voyager1'; }", timeout=60_000, polling=200)
            card = pg.inner_text("#ae-card")
            assert "Voyager 1" in card and "AU from the Sun" in card and "2012" in card, card
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def _open(pg, served, target="earth"):
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
    pg.evaluate("(t) => openAlmanacEarth({ target: t })", target)
    pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
    pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=200)


def _ctx(br, width=390):
    ctx = br.new_context(viewport={"width": width, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
    ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE))
    return ctx


def test_go_to_the_minimap_and_the_orrery_s_way_in(served):
    """The short row stays (Earth, Satellites, Moon, Sun, Planets) with Go to: a sheet of every place in groups, each
    with its disc; a tap flies and puts it away. Near a planet the corner minimap shows where you are and opens the
    whole system; the 2D orrery's planet tap opens the 3D view on that planet."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            pg.evaluate("_orreryOpenEarthView('jupiter')")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'jupiter'; }", timeout=60_000, polling=200)
            row = pg.evaluate("Array.from(document.querySelectorAll('#ae-views .ae-btn')).map(b => b.dataset.aeView || b.id)")
            # At Jupiter the row is Jupiter's: its moons and the way back, Go to at the end.
            assert row[:3] == ["sun", "jupiter", "io"] and row[-2:] == ["planets", "ae-go-btn"], row
            pg.click("#ae-go-btn")
            pg.wait_for_function("() => !document.getElementById('ae-go').hidden && document.querySelectorAll('#ae-go [data-ae-go=\"voyager1\"]').length === 1 && document.querySelectorAll('#ae-go [data-ae-go^=\"lm:\"]').length > 20", timeout=60_000)
            groups = pg.evaluate("Array.from(document.querySelectorAll('#ae-go h4')).length")
            assert groups == 6, groups   # Earth and Moon, Planets, Moons, Dwarf planets, Spacecraft, Moon landings
            assert pg.evaluate("Array.from(document.querySelectorAll('#ae-go .ae-go-row')).every(r => !!r.querySelector('.ae-go-dot'))")
            pg.click("#ae-go [data-ae-go='saturn']")
            assert pg.evaluate("document.getElementById('ae-go').hidden")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'saturn'; }", timeout=60_000, polling=200)
            # The flight's orbits fade out shortly after it lands (Orbits: While flying).
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return Object.keys(_ae.gl.planets).every(k => !_ae.gl.planets[k].orbit || !_ae.gl.planets[k].orbit.visible); }", timeout=10_000, polling=100)
            assert not pg.is_visible("#ae-scale")
            pg.evaluate("_aePreset('mars')")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'mars' && _ae.gl.planets.mars.uni.mapped.value === 1; }", timeout=60_000, polling=200)
            pg.evaluate("_aeUpdateText(_aeDisplayMs())")
            assert "Solar System Scope" not in pg.inner_text(".ae-note"), "Mars is the Viking map: nothing of Solar System Scope's is drawn"
            assert pg.is_visible("#ae-mini")
            pg.click("#ae-mini")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.preset === 'planets'; }", timeout=60_000, polling=200)
            assert not pg.is_visible("#ae-mini")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_probe_in_orbit_is_one_ellipse_and_a_short_trail(served):
    """Parker round the Sun and Juno round Jupiter: one closed ellipse (their present orbit, which they were on one period
    ago too) and a trail of under a third of an orbit, fading behind; the Voyagers keep the whole road out. Seen from
    out where the probe is a point: close up, on its model, its path is not drawn through it."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            _open(pg, served)
            pg.evaluate("window._almReduceMotion = function () { return true; }; _aeTracksLoad(); localStorage.setItem('zimi_ae_orbits', 'always');")   # paths stay drawn
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            got = {}
            for k in ("parker", "juno", "voyager1"):
                pg.evaluate("(k) => _aePreset(k)", k)
                pg.wait_for_function("(k) => { _ae.dirty = true; _aeKick(); return _ae.target === k && !_ae.fly; }", arg=k, timeout=60_000, polling=100)
                pg.evaluate("() => { _ae.dist = AE_PROBE_VIEW_DIST; }")
                got[k] = pg.evaluate("""(k) => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); _aeUpdate(_aeDisplayMs()); var t = _ae.gl.probes.trails[k], r = _ae.gl.probes.orbits[k], o = t.orbit;
                    var c = t.geometry.attributes.color.array;
                    return { round: o && o.round, period: o && o.period, trail: o && o.trail, ring: r.visible, first: c[3], last: c[c.length - 1] }; }""", k)
            assert got["parker"]["round"] == "sun" and 80 < got["parker"]["period"] < 95 and got["parker"]["ring"], got
            assert got["juno"]["round"] == "jupiter" and 25 < got["juno"]["period"] < 40 and got["juno"]["ring"], got
            for k in ("parker", "juno"):
                assert got[k]["trail"] <= got[k]["period"] * 0.31 and got[k]["first"] < 0.01 and got[k]["last"] == 1, got
            assert got["voyager1"]["round"] is None and not got["voyager1"]["ring"] and got["voyager1"]["first"] == 1, got
            # Every day of 2025 to mid-2028 (the table is thinned, so a state at the close pass is far off: the ellipse is
            # fitted where it moves slowly), Juno is on its ~35-day orbit and Parker on its 88-day one, never held or lost.
            fits = pg.evaluate("""() => { var near = (k, jd) => [{ key: k, h: _ephBodyJ2000('Jupiter', jd), reach: AE_PROBE_REACH_AU[k], hAt: x => _ephBodyJ2000('Jupiter', x) }];
                var j = [], p = [];
                for (var jd = 2460676.5; jd < 2461900.5; jd += 1) {
                  var o = _aeProbeOrbit(_aeTracks.tracks.juno, jd, near('jupiter', jd)); j.push(o && o.period ? o.period : 0);
                  var q = _aeProbeOrbit(_aeTracks.tracks.parker, jd, []); p.push(q && q.period ? q.period : 0);
                }
                return { j: [Math.min.apply(null, j), Math.max.apply(null, j)], p: [Math.min.apply(null, p), Math.max.apply(null, p)] }; }""")
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
        return math.degrees(math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(p, q))))))

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            _open(pg, served)
            for frm in ("earth", "jupiter", "neptune"):
                r = pg.evaluate("""(frm) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset(frm); window._almReduceMotion = undefined; _aeUpdate(_aeDisplayMs());
                    _aePreset('planets'); var f = _ae.fly, total = (f.hold ? (f.lead || AE_FLY_APPROACH_MS) + AE_FLY_TAIL_MS : 0) + f.ms, out = [], FR = 1000 / 60;
                    for (var t = 0; t <= total + FR; t += FR) { f.start = 0; _aeStepFly(Math.min(t, total - 1e-6)); _aePlaceCamera();
                      var cam = _ae.gl.camera; cam.updateMatrixWorld(); var e = cam.matrixWorld.elements; out.push([[-e[8], -e[9], -e[10]], [e[4], e[5], e[6]]]); if (!_ae.fly) break; }
                    _ae.fly = null; return { total: total, hold: f.hold, series: out }; }""", frm)
                assert 1500 <= r["total"] <= 2500 and not r["hold"], (frm, r["total"])
                S = r["series"]
                for k in (0, 1):
                    w = [ang(S[i][k], S[i + 1][k]) for i in range(len(S) - 1)]
                    acc = [w[i + 1] - w[i] for i in range(len(w) - 1)]
                    jerk = [acc[i + 1] - acc[i] for i in range(len(acc) - 1)]
                    assert max(map(abs, acc)) <= 0.5 and max(map(abs, jerk)) <= 0.1, (frm, k, max(map(abs, acc)), max(map(abs, jerk)))
                    assert w[0] <= 0.05 and w[-1] <= 0.05, (frm, k, w[0], w[-1])
            fills = pg.evaluate("""() => { _aeAst.at = null; _aeAst.fill = null; _ae.fly = null; _aePreset('planets'); _ae.fly = null; var n = 0;
                do { _aeUpdate(_aeDisplayMs()); n++; } while (_aeAst.fill != null && n < 50); return { n: n, drawn: _aeAst.drawn }; }""")
            assert fills["n"] >= 3 and fills["drawn"] == pg.evaluate("Math.ceil(_aeAst.n / AE_AST_STRIDE)"), fills
            ctx.close()
        finally:
            br.close()


def test_the_iss_close_up(served):
    """Go to has the ISS; a flight there ends on the station itself (NASA's model, under 1 MB), held as it flies: the
    truss across the direction of travel, the US segment ahead, the truss on the zenith side, the main arrays turned to
    the Sun, lit in daylight, up away from the Earth. From the Earth view it is the dot, and the model is not drawn."""
    import math
    from playwright.sync_api import sync_playwright

    assert os.path.getsize(os.path.join(ROOT, "zimi", "static", "earth", "iss-v1.bin")) < 1_000_000
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !!_ae.issPos; }", timeout=60_000, polling=200)
            far = pg.evaluate("() => ({ drawn: !!(_ae.gl.iss && _ae.gl.iss.root.visible) })")
            assert not far["drawn"], far
            pg.evaluate("_aeShowGo(true)")
            pg.click("#ae-go [data-ae-go='iss']")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'iss' && !!_ae.gl.iss && _ae.gl.iss.root.visible; }", timeout=60_000, polling=200)
            got = pg.evaluate("""() => { _aeUpdate(_aeDisplayMs()); _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); var I = _ae.gl.iss, V = _ae.gl.THREE.Vector3;
                var ax = function (x, y, z) { var v = new V(x, y, z).applyQuaternion(I.root.quaternion); return [v.x, v.y, v.z]; };
                var p = _ae.issPos, B = _ae.issBasis, sun = _aeNorm(_ae.scene.sun);
                var arr = new V(1, 0, 0).applyQuaternion(I.pivot.quaternion).applyQuaternion(I.root.quaternion);
                var sunIn = _aeNorm(_aeSub(sun, _aeScale(ax(0, 0, 1), _aeDot(sun, ax(0, 0, 1)))));
                var cam = _ae.gl.camera.matrixWorld.elements, up = [cam[4], cam[5], cam[6]], look = [-cam[8], -cam[9], -cam[10]];
                var zen = _aeNorm(p), zenIn = _aeNorm(_aeSub(zen, _aeScale(look, _aeDot(zen, look))));
                return { truss: _aeDot(ax(0, 0, 1), _aeNorm(_aeCross(p, B[1]))), fwd: _aeDot(ax(0, 1, 0), B[1]), nadir: _aeDot(ax(1, 0, 0), _aeScale(_aeNorm(p), -1)),
                         arrays: _aeDot([arr.x, arr.y, arr.z], sunIn), lit: I.uni.lit.value, up: _aeDot(up, zenIn), label: document.getElementById('ae-lbl-iss').hidden,
                         dist: _ae.dist, span: AE_ISS_SPAN_RE }; }""")
            assert got["truss"] < -0.999, got     # starboard is the orbit's negative normal
            assert got["fwd"] > 0.999 and got["nadir"] > 0.999, got
            assert got["arrays"] > 0.999, got
            assert got["up"] > 0.999 and got["label"], got
            assert got["dist"] < got["span"] * 5, got
            shade = pg.evaluate("() => { var b = _aeNorm(_ae.issPos), s = _aeNorm(_ae.scene.sun); return _aeDot(b, s); }")
            if shade > 0:
                assert got["lit"] == 1, got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_iss_flight_rings_and_a_tap_on_it(served):
    """A flight to the ISS is the fly-between too: a circle on the Earth it leaves and on the station; never a name of
    its own beside its label. A tap on its dot in the Earth view, or on the model close up, goes to it and follows."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !!_ae.issBasis; }", timeout=60_000, polling=200)
            assert pg.evaluate("document.getElementById('ae-bm-iss').hidden"), "no ISS mark outside a flight"
            rings = pg.evaluate("""() => { _aePreset('iss'); var f = _ae.fly; f.start = performance.now() - AE_FLY_APPROACH_MS; _aeStepFly(performance.now());
                _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene); var out = { hold: !!f.hold };
                ['earth', 'iss'].forEach(function (b) { var el = document.getElementById('ae-bm-' + b);
                  out[b] = { shown: !el.hidden, ringed: el.classList.contains('ae-bm-ringed'), ring: getComputedStyle(el.querySelector('.ae-ring')).display }; });
                _ae.fly = null; return out; }""")
            assert rings["hold"], rings
            for b in ("earth", "iss"):
                assert rings[b]["shown"] and rings[b]["ringed"] and rings[b]["ring"] != "none", (b, rings)
            # Back at the Earth, a tap on the ISS's dot.
            pg.evaluate("window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('earth');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'earth'; }", timeout=30_000, polling=100)
            spot = pg.evaluate("""() => { var best = null; for (var az = 0; az < 6.28 && !best; az += 0.4) for (var el = -1.2; el < 1.3 && !best; el += 0.4) {
                  _ae.az = az; _ae.el_ = el; _aeUpdate(_aeDisplayMs()); _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld();
                  var s = _aeProject(_ae.issPos); if (s && !_aeBehindEarth(_ae.issPos) && s.x > 30 && s.x < _ae.w - 30 && s.y > 120 && s.y < _ae.h - 250) best = s; }
                return best; }""")
            assert spot, "the ISS is somewhere in sight"
            pg.evaluate("(s) => _aeTap(s.x, s.y)", spot)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'iss' && _ae.gl.iss && _ae.gl.iss.root.visible; }", timeout=30_000, polling=100)
            # Close to it from the Earth's target: a tap on the model off its middle. One update and the tap in one
            # step (at 330 m the station crosses its own length in a hundredth of a second).
            pg.evaluate("_ae.fly = null; _aePreset('earth');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'earth'; }", timeout=30_000, polling=100)
            got = pg.evaluate("""() => { _aeUpdate(_aeDisplayMs()); var p = _ae.issPos, d = _aeNorm(p);
                var at = _aeAdd(p, _aeScale(d, AE_ISS_SPAN_RE * 3)); _ae.dist = _aeLen(at); var a = _aeAzElOf(at); _ae.az = a.az; _ae.el_ = a.el;
                _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); var s = _aeProject(p);
                if (!s) return null; _ae.positions = []; var b = _aeBodyAt(s.x + 25, s.y + 10); _aeTap(s.x + 25, s.y + 10); return [b, _ae.target]; }""")
            assert got == ["iss", "iss"], got
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_ae.gl.iss && _ae.gl.iss.root.visible; }", timeout=30_000, polling=100)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("width,lang", [(390, "en"), (360, "en"), (360, "ru"), (360, "ar")])
def test_the_row_is_one_line(served, width, lang):
    """Earth, Satellites, Moon, Sun, Planets and Go to share one line on a phone, in English and in the longest
    translations (Russian, Arabic): Go to is a round button named Go to."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br, width)
            ctx.add_init_script("try { localStorage.setItem('zimi_ui_lang', %r); } catch (e) {}" % lang)
            pg = ctx.new_page()
            _open(pg, served)
            tops = pg.evaluate("Array.from(document.querySelectorAll('#ae-views .ae-btn')).map(b => { var r = b.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.right)]; })")
            assert len(tops) == 6 and len({t[0] for t in tops}) == 1, tops
            assert min(t[1] for t in tops) >= 0 and max(t[2] for t in tops) <= width, tops
            if lang == "en":
                assert pg.get_attribute("#ae-go-btn", "aria-label") == "Go to"
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
            pg.wait_for_function("() => !!_aeTracks && document.querySelectorAll('#ae-go .ae-go-row').length > 20", timeout=60_000)
            # Every body (the landing sites are the landmarks test's).
            keys = pg.evaluate("_aeGoGroups().reduce((a, g) => a.concat(g[1]), []).filter(k => k.indexOf(AE_GO_LM) !== 0 && k !== AE_GO_LOADING && k !== AE_SPIN_KEY).concat(['sun', 'planets', 'sats'])")
            pg.evaluate("_aeShowGo(false); window._almReduceMotion = function () { return true; };")   # each flight lands at once
            missed = []
            for k in keys:
                pg.evaluate("(s) => { _ae.fly = null; _aePreset(s); }", start)
                pg.wait_for_function("(s) => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset && (_ae.target === s || (s === 'jupiter' ? false : true)); }", arg=start, timeout=30_000, polling=100)
                pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k)
                pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset; }", timeout=30_000, polling=100)
                try:   # a probe's first visit fetches its model; the view moves to it on the frame after
                    pg.wait_for_function("(k) => { _ae.dirty = true; _aeKick(); var w = k === 'planets' ? 'sun' : k === 'sats' ? 'earth' : k; return _ae.target === w && !_ae.fly; }", arg=k, timeout=10_000, polling=100)
                except Exception:
                    pass
                got = pg.evaluate("""(k) => { var want = k === 'planets' ? 'sun' : k === 'sats' ? 'earth' : k;
                    _aeUpdate(_aeDisplayMs());   // where the camera stands now
                    var t = _aeTargetPos(), b = _aeBodyPos(want), c = _ae.gl.camera.position;
                    return { target: _ae.target, want: want, near: !!b && Math.hypot(t[0] - b[0], t[1] - b[1], t[2] - b[2]) < 1e-6,
                             dist: Math.hypot(c.x - t[0], c.y - t[1], c.z - t[2]), allowed: Math.max(AE_TARGETS[want].max, _ae.dist) * 1.01, d: _ae.dist }; }""", k)
                if got["target"] != got["want"] or not got["near"] or got["dist"] > got["allowed"]:
                    missed.append((k, got))
            assert not missed, missed
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_every_destination_arrives_with_its_card(served):
    """Every place Go to flies to arrives with the same card: its name, a line of what it is, and where it is from here
    (a probe: from the Sun, and what it last did). Saturn used to arrive with nothing. The ISS says when it is in the
    Earth's shadow and when the Sun comes back."""
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
            pg.wait_for_function("() => !!_aeTracks && document.querySelectorAll('#ae-go .ae-go-row').length > 20", timeout=60_000)
            keys = pg.evaluate("_aeGoGroups().reduce((a, g) => a.concat(g[1]), []).filter(k => k.indexOf(AE_GO_LM) !== 0 && k !== AE_GO_LOADING && k !== AE_SPIN_KEY).concat(['sun'])")
            pg.evaluate("_aeShowGo(false); window._almReduceMotion = function () { return true; };")
            bare = []
            for k in keys:
                pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k)
                pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset; }", timeout=30_000, polling=100)
                if k not in ("earth", "sats"):   # the card is put up by the frame after the arrival
                    try:
                        pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); var c = document.getElementById('ae-card'); return c && !c.hidden; }", timeout=5_000, polling=100)
                    except Exception:
                        pass
                card = pg.evaluate("""() => { var c = document.getElementById('ae-card');
                    return { shown: !c.hidden, name: (c.querySelector('h3') || {}).textContent || '', lines: c.querySelectorAll('p').length }; }""")
                want = 2
                if k not in ("earth", "sats") and (not card["shown"] or not card["name"].strip() or card["lines"] < want):
                    bare.append((k, card))
            assert not bare, bare
            shade = pg.evaluate("""() => ({ behind: _aeInShadow([-2, 0, 0], [5, 0, 0]), beside: _aeInShadow([0, 2, 0], [5, 0, 0]), front: _aeInShadow([2, 0, 0], [5, 0, 0]) })""")
            assert shade == {"behind": True, "beside": False, "front": False}, shade
            iss = pg.evaluate("""() => { return { dark: _aeInShadow(_ae.issPos, _ae.scene.sun),
                says: !!_aeArrival('iss', _aeDisplayMs()).note }; }""")
            assert iss["dark"] == iss["says"], iss
            assert not errors, errors
            ctx.close()
        finally:
            br.close()



def _row_settles(pg, row, want, timeout_s=5.0):
    """The quick row is drawn on the frame after an arrival: it is read until it is `want`, or for `timeout_s`."""
    import time as _t

    end, got = _t.time() + timeout_s, None
    while _t.time() < end:
        got = pg.evaluate("() => { _ae.dirty = true; _aeKick(); }") or pg.evaluate(row)
        if got == want:
            return
        _t.sleep(0.1)
    assert got == want, got

def _wide_row(pg, row, shortcuts):
    """In the planets' views the row is Sun, Earth, the shortcuts that fit, Planets, Side by side: Planets and Side by side
    are never scrolled out of sight, so a shortcut that would push them out is dropped (the oldest first)."""
    import time as _t

    end, got = _t.time() + 5.0, None
    while _t.time() < end:
        pg.evaluate("() => { _ae.dirty = true; _aeKick(); }")
        got = pg.evaluate(row)
        if got[:2] == ["sun", "earth"] and got[-2:] == ["planets", "spin"]:
            break
        _t.sleep(0.1)
    assert got[:2] == ["sun", "earth"] and got[-2:] == ["planets", "spin"], got
    mid = got[2:-2]
    assert mid == shortcuts[2:2 + len(mid)] and len(mid) <= 1, (got, shortcuts)
    fits = pg.evaluate("() => { var c = document.getElementById('ae-chips'); return c.scrollWidth <= c.clientWidth + 1; }")
    assert fits, got


def test_the_row_follows_where_the_view_is(served):
    """One rule for every selection: Sun, then the way down from the Sun ending on the body (the Moon is Sun, Earth,
    Moon, never Moon after Sun), then its satellites (Earth: Satellites, Moon; the Moon, Mars, Venus: Landings; a
    planet: its moons; a probe: the body it is near), then the places just left (shortcuts, newest first, none
    repeated), then Planets, Side by side where the planets are in view as a whole, then Go to. No Orbits pill.
    Always one line (it scrolls sideways past its width, Go to at its end inside the screen)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br, 360)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            row = "() => Array.from(document.querySelectorAll('#ae-views .ae-btn[data-ae-view]')).map(b => b.getAttribute('data-ae-view'))"
            go = lambda k: (pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k),
                            pg.wait_for_function("(k) => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset && _ae.target === k; }", arg=k, timeout=60_000, polling=100))
            _row_settles(pg, row, ["sun", "earth", "sats", "moon", "planets"])
            pg.evaluate("window._almReduceMotion = function () { return true; }; _aeTracksLoad();")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            go("moon")
            _row_settles(pg, row, ["sun", "earth", "moon", "landings", "planets"])
            go("jupiter")
            jup = ["sun", "jupiter", "io", "europa", "ganymede", "callisto"]
            _row_settles(pg, row, jup + ["moon", "planets"])   # a long family leaves room for one shortcut
            line = pg.evaluate("""() => { var bs = Array.from(document.querySelectorAll('#ae-views .ae-btn')).map(b => b.getBoundingClientRect());
                var go = document.getElementById('ae-go-btn').getBoundingClientRect();
                return { tops: new Set(bs.map(r => Math.round(r.top))).size, goIn: go.left >= 0 && go.right <= innerWidth }; }""")
            assert line == {"tops": 1, "goIn": True}, line
            go("io")
            _row_settles(pg, row, jup + ["moon", "planets"])   # Jupiter, the place just left, is on it already
            go("voyager1")
            _row_settles(pg, row, ["sun", "voyager1", "io", "jupiter", "planets"])   # two shortcuts: a probe has no family
            go("juno")
            assert pg.evaluate(row)[:3] == ["sun", "juno", "jupiter"], pg.evaluate(row)
            go("earth")
            _row_settles(pg, row, ["sun", "earth", "sats", "moon", "juno", "voyager1", "planets"])
            go("sun")
            # Earth is always beside the Sun; then the place just left; Side by side beside the Planets
            _wide_row(pg, row, ["sun", "earth", "juno"])
            go("mars")
            _row_settles(pg, row, ["sun", "mars", "landings", "earth", "juno", "planets"])   # Mars's landers, like the Moon's
            pg.evaluate("_ae.fly = null; _aePreset('planets');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.preset === 'planets'; }", timeout=60_000, polling=100)
            _wide_row(pg, row, ["sun", "earth", "mars"])
            assert pg.evaluate("document.querySelector('#ae-views [data-ae-view=\"planets\"]').getAttribute('aria-pressed')") == "true"
            pg.click("#ae-views [data-ae-view='spin']")
            _wide_row(pg, row, ["sun", "earth", "mars"])   # the same row while they stand side by side
            assert pg.evaluate("document.querySelector('#ae-views [data-ae-view=\"spin\"]').getAttribute('aria-pressed')") == "true"
            assert not pg.query_selector("#ae-views [data-ae-view='orbits']")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_orbits_is_a_setting_shown_while_flying(served):
    """Orbits live in the gear: While flying (the default) shows the orbits of the bodies a flight involves during it and
    fades them out after it lands; Always keeps the system in view drawn; Off draws none near a body. The Planets view always has
    the planets' orbits. The choice is remembered on this device."""
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
            assert pg.evaluate("_aeOrbitsMode()") == "flying"
            pg.evaluate("_aePreset('jupiter')")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !!_ae.fly; }", timeout=10_000, polling=50)
            assert pg.evaluate(vis, "jupiter") and pg.evaluate(vis, "io")   # the system it flies to, on the way
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=120_000, polling=100)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); return !_ae.gl.planets.io.orbit.visible; }", timeout=10_000, polling=100)
            # Always, from the gear: there, and remembered.
            pg.click("#ae-gear")
            pg.click("input[name='ae-orbits'][value='always']")
            assert pg.evaluate("localStorage.getItem('zimi_ae_orbits')") == "always"
            assert pg.evaluate(vis, "io") and pg.evaluate(vis, "jupiter")
            # Back to While flying, standing still at Jupiter: the lines go (they stayed, Eric 2026-11-05).
            pg.click("input[name='ae-orbits'][value='flying']")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); return !_ae.gl.planets.io.orbit.visible && !_ae.gl.planets.jupiter.orbit.visible; }", timeout=10_000, polling=100)
            pg.click("input[name='ae-orbits'][value='always']")
            pg.click("input[name='ae-orbits'][value='off']")
            assert not pg.evaluate(vis, "io")
            pg.evaluate("window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('planets');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=100)
            assert pg.evaluate("_aeOrbitsMode()") == "off"
            assert pg.evaluate(vis, "saturn") and not pg.evaluate(vis, "io")   # the Planets view is a map of the orbits, whatever the setting
            if not pg.is_visible("input[name='ae-orbits'][value='flying']"):
                pg.click("#ae-gear")
            pg.click("input[name='ae-orbits'][value='flying']")
            assert pg.evaluate(vis, "saturn")   # by default the Planets view has the planets' orbits
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_tap_on_the_craft_in_view_opens_its_card(served):
    """The model itself is what to tap, not only its little circle: at Voyager with its card put away, a tap on the
    craft brings the card back, and its name and the Golden Record link to their articles where the library has them."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("window._almReduceMotion = function () { return true; }; _aeTracksLoad();")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            pg.evaluate("_ae.fly = null; _aePreset('voyager1');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'voyager1' && !!_ae.gl.crafts && !!_ae.gl.crafts.voyager1 && _ae.gl.crafts.voyager1.root.visible; }", timeout=60_000, polling=200)
            pg.click("#ae-card-x")
            assert pg.evaluate("document.getElementById('ae-card').hidden")
            at = pg.evaluate("() => { var s = _aeProject(_aeTargetPos()), r = document.getElementById('ae-canvas').getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; }")
            pg.mouse.click(at["x"], at["y"])
            pg.wait_for_function("() => !document.getElementById('ae-card').hidden", timeout=10_000)
            assert "Voyager 1" in pg.inner_text("#ae-card h3")
            keys = pg.evaluate("() => [_aeArrivalKey('voyager1'), AE_ARRIVAL_EXTRA.voyager1.key].map(k => !!AlmanacLinks.MAP[k])")
            assert keys == [True, True], keys
            # Its Golden Record opens the Almanac's own section: the view closes and lands there.
            pg.evaluate("""() => { window._grOpened = 0; window._grStacks = []; window._scrollToGoldenRecord = function () { window._grOpened++; window._grStacks.push(new Error().stack); }; }""")
            got = pg.evaluate("() => { try { document.querySelector('#ae-card [data-ae-open]').click(); return window._grOpened; } catch (e) { return String(e); } }")
            assert got == 1, (got, pg.evaluate("window._grStacks"))
            pg.wait_for_function("() => !_aeIsOpen", timeout=30_000)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_iss_stays_in_view_at_an_hour_a_second(served):
    """At an hour a second a fortnight passes in minutes: the station keeps its (approximate) dot and can still be
    flown to and followed, instead of going out once its elements age past the dot's days."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !!_ae.issPos; }", timeout=60_000, polling=200)
            pg.evaluate("() => { var s = _ae.sats.list.filter(x => x.iss)[0]; _aeGoTo(s.epochMs + 30 * 86400000); _ae.speed = 3600; }")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); var s = _ae.sats.list.filter(x => x.iss)[0]; return s.standing === 'approximate' && !!_ae.issPos; }", timeout=30_000, polling=200)
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
            pg.evaluate("window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('moon');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'moon'; }", timeout=30_000, polling=100)
            pg.evaluate("_ae.dist = _ae.dist / 3; _ae.dirty = true; _aeKick();")
            pg.wait_for_timeout(1500)
            shown = pg.evaluate("""() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene);
                return Array.from(document.querySelectorAll('#ae-labels .ae-bm')).filter(e => !e.hidden).map(e => e.id.replace('ae-bm-', '')); }""")
            assert all(_k in ("earth", "moon") for _k in shown), shown
            # Behind the Moon, not only close in: a point straight behind its centre is hidden by the sphere test.
            behind = pg.evaluate("""() => { var c = _ae.gl.camera.position, t = _aeTargetPos(), d = _aeNorm(_aeSub(t, [c.x, c.y, c.z]));
                return _aeBehindTarget('callisto', _aeAdd(t, _aeScale(d, 1000))); }""")
            assert behind is True
            # As it opens at the Moon (not close in), the same: only the Earth and the Moon are named; a planet is a
            # faint point with no name, another planet's moons are not drawn; no mark sits under the controls on top.
            for width in (360, 390):
                pg.set_viewport_size({"width": width, "height": 844})
                pg.evaluate("_ae.fly = null; _aePreset('moon');")
                pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=30_000, polling=100)
                pg.wait_for_timeout(800)
                got = pg.evaluate("""() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene);
                    var els = Array.from(document.querySelectorAll('#ae-labels .ae-bm')).filter(e => !e.hidden);
                    var named = els.filter(e => { var b = e.querySelector('b'); return b && getComputedStyle(b).display !== 'none' && b.textContent; }).map(e => e.id.replace('ae-bm-', ''));
                    var moons = els.map(e => e.id.replace('ae-bm-', '')).filter(k => { var b = _aePlanetBody(k); return b && b.parent; });
                    var tops = ['ae-back', 'ae-when-col', 'ae-gear', 'ae-locate', 'ae-mini'].map(id => document.getElementById(id)).filter(e => e && !e.hidden).map(e => e.getBoundingClientRect());
                    var under = Array.from(document.querySelectorAll('#ae-labels .ae-bm:not([hidden]) b, #ae-labels .ae-bm:not([hidden])')).filter(e => {
                      var r = e.getBoundingClientRect(); if (!r.width) return false;
                      return tops.some(t => r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top); }).map(e => e.textContent || e.id);
                    return { named: named, moons: moons, under: under }; }""")
                assert set(got["named"]) <= {"earth", "moon"}, (width, got)
                assert got["moons"] == [], (width, got)
                assert got["under"] == [], (width, got)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_flight_to_a_planet_is_the_fly_between(served):
    """1.15.2's shot for every flight: over the shoulder, a circle on the body it leaves and on the one it goes to, and
    the line of sight and up turning with no snap (the bounds of test_almanac_earth_view.cjs's section 8b)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            _open(pg, served)
            for frm, to in (("earth", "jupiter"), ("jupiter", "saturn"), ("mars", "moon")):
                rings = pg.evaluate("""(a) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset(a.frm); window._almReduceMotion = undefined; _aeUpdate(_aeDisplayMs());
                    _aePreset(a.to); var f = _ae.fly; f.start = performance.now() - AE_FLY_APPROACH_MS; _aeStepFly(performance.now());
                    _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld(); _aeUpdateMarks(_ae.scene);
                    var out = {}; [a.frm, a.to].forEach(function (b) { var el = document.getElementById('ae-bm-' + b);
                      out[b] = { shown: !el.hidden, ringed: el.classList.contains('ae-bm-ringed'), ring: getComputedStyle(el.querySelector('.ae-ring')).display }; });
                    out.hold = !!f.hold; _ae.fly = null; return out; }""", {"frm": frm, "to": to})
                assert rings["hold"], (frm, to, rings)
                for b in (frm, to):
                    assert rings[b]["shown"] and rings[b]["ringed"] and rings[b]["ring"] != "none", (frm, to, b, rings)
                series = pg.evaluate("""(a) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset(a.frm); window._almReduceMotion = undefined; _aeUpdate(_aeDisplayMs());
                    _aePreset(a.to); var f = _ae.fly, total = (f.hold ? (f.lead || AE_FLY_APPROACH_MS) + AE_FLY_TAIL_MS : 0) + f.ms, out = [], FR = 1000 / 60;
                    for (var t = 0; t <= total + FR; t += FR) { f.start = 0; _aeStepFly(Math.min(t, total - 1e-6)); _aePlaceCamera();
                      var cam = _ae.gl.camera; cam.updateMatrixWorld(); var e = cam.matrixWorld.elements; out.push([[-e[8], -e[9], -e[10]], [e[4], e[5], e[6]]]); if (!_ae.fly) break; }
                    _ae.fly = null; return out; }""", {"frm": frm, "to": to})
                import math

                def ang(p, q):
                    return math.degrees(math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(p, q))))))

                for k in (0, 1):
                    w = [ang(series[i][k], series[i + 1][k]) for i in range(len(series) - 1)]
                    acc = [w[i + 1] - w[i] for i in range(len(w) - 1)]
                    jerk = [acc[i + 1] - acc[i] for i in range(len(acc) - 1)]
                    assert max(abs(x) for x in acc) <= 0.5, (frm, to, k, max(abs(x) for x in acc))
                    assert max(abs(x) for x in jerk) <= 0.1, (frm, to, k, max(abs(x) for x in jerk))
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
            ctx = br.new_context(viewport={"width": width, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE))
            pg = ctx.new_page()
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=READY_MS, polling=200)
            pg.evaluate("_aePreset('planets')")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeTracks; }", timeout=60_000, polling=200)
            for _ in range(6):
                pg.evaluate("_ae.dirty = true; _aeKick()")
                pg.wait_for_timeout(200)
            names = pg.evaluate("""() => Array.from(document.querySelectorAll('#ae-labels .ae-bm')).filter(e => !e.hidden).map(e => {
                var b = e.querySelector('b'); if (getComputedStyle(b).display === 'none') return null;
                var r = b.getBoundingClientRect(); return [b.textContent, r.left, r.right]; }).filter(Boolean)""")
            assert names
            for text, left, right in names:
                assert left >= 0 and right <= width, (width, text, left, right)
            ctx.close()
        finally:
            br.close()


CRAFT = {"voyager1": None, "pioneer10": None, "juno": None, "parker": None, "jwst": None,
         "galileo": "1996-06-27T12:00:00Z", "cassini": "2005-01-14T12:00:00Z"}


def test_every_probe_model_is_small_and_knows_where_it_points():
    """Each probe's model (scripts/build_craft_models.py) is under 400 KB gzipped and carries a unit pointing axis
    and a unit axis across it: the view turns the first to the Earth (or the Sun) and holds the second level."""
    import gzip
    import struct

    earth = os.path.join(ROOT, "zimi", "static", "earth")
    for model in ("voyager", "pioneer", "juno", "parker", "webb", "galileo", "cassini"):
        raw = open(os.path.join(earth, "craft-%s-v1.bin" % model), "rb").read()
        assert len(gzip.compress(raw, 9)) < 400_000, model
        head = struct.unpack("<4sIf6f3f3fI", raw[:64])
        assert head[0] == b"ZCRF" and 1 <= head[15] <= 8, (model, head[0], head[15])
        aim, across = head[9:12], head[12:15]
        assert abs(math.hypot(*aim) - 1) < 1e-3 and abs(math.hypot(*across) - 1) < 1e-3, model
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
                pg.evaluate("(iso) => _almScrubSettle(new Date(iso))", CRAFT[key])
            pg.evaluate("(k) => { window._almReduceMotion = function () { return true; }; _ae.fly = null; _aeUpdate(_aeDisplayMs()); _aePreset(k); }", key)
            pg.wait_for_function("(k) => { _ae.dirty = true; _aeKick(); var I = _ae.gl.crafts && _ae.gl.crafts[k]; return !_ae.fly && _ae.target === k && !!I && I.root.visible && I.show > 0.99; }",
                                 arg=key, timeout=60_000, polling=200)
            got = pg.evaluate("""(k) => { _aeUpdate(_aeDisplayMs()); var I = _ae.gl.crafts[k], m = AE_CRAFT_MODEL[k], d = _aeCraftData(m), V = _ae.gl.THREE.Vector3;
                var a = new V(d.aim[0], d.aim[1], d.aim[2]).applyQuaternion(I.root.quaternion), p = _aeBodyPos(k);
                var goal = AE_CRAFT_POINTS[m] === 'sun' ? _aeSunShown(_ae.scene) : [0, 0, 0], to = _aeNorm(_aeSub(goal, p));
                var c = _ae.gl.camera.position, dist = Math.hypot(c.x - p[0], c.y - p[1], c.z - p[2]);
                return { aim: a.x * to[0] + a.y * to[1] + a.z * to[2], spans: dist / _aeCraftSpanRe(m), dot: _aeProbeCraftDot(k),
                         trail: _ae.gl.probes.trails[k].visible }; }""", key)
            assert got["aim"] > 0.999, got
            assert 1.5 < got["spans"] < 6, got
            assert got["dot"] < 0.01 and not got["trail"], got
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


LINES = """() => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); var S = _ae.gl, out = [];
    Object.keys(S.planets).forEach(k => { var o = S.planets[k].orbit; if (o && o.visible && o.material.opacity > 0) out.push(k); });
    if (S.probes) Object.keys(S.probes.trails).forEach(k => { if (S.probes.trails[k].visible && S.probes.trails[k].material.opacity > 0) out.push(k + ':trail'); if (S.probes.orbits[k].visible) out.push(k + ':ellipse'); });
    [['moonPath', 'moon:path'], ['gpsRings', 'gps'], ['issRing', 'iss:ring']].forEach(p => { var l = S[p[0]]; if (l.visible && l.material.opacity > 0 && l.geometry.drawRange.count > 0) out.push(p[1]); });
    return out; }"""


@pytest.mark.parametrize("mode", ["off", "always", "flying"])
def test_the_orbits_setting_holds_after_a_reload(served, mode):
    """The remembered Orbits choice applies from the moment the view opens, for every line the scene draws (planets',
    moons', a probe's path and ellipse, the Moon's path, the GPS and station rings): Off draws none anywhere, the Planets
    view too; Always draws those of the place in view; While flying draws them in flight and none once landed (the Planets
    view keeps the planets')."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            ctx.add_init_script("try { localStorage.setItem('zimi_ae_orbits', %r); } catch (e) {}" % mode)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("window._almReduceMotion = function () { return true; }; _aeTracksLoad();")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            seen = {}
            for k in ("earth", "moon", "jupiter", "juno", "planets"):
                pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k)
                pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=100)
                if k == "juno":
                    pg.evaluate("() => { _ae.dist = AE_PROBE_VIEW_DIST; }")   # out where Juno is a point and its path is drawn
                pg.wait_for_timeout(1800)   # past While flying's fade
                seen[k] = pg.evaluate(LINES)
            if mode == "off":
                assert all(v == [] for k, v in seen.items() if k != "planets"), seen
                assert "saturn" in seen["planets"] and "io" not in seen["planets"], seen   # the map keeps its orbits
            elif mode == "always":
                assert "io" in seen["jupiter"] and "jupiter" in seen["jupiter"], seen
                assert "juno:trail" in seen["juno"], seen
                assert "saturn" in seen["planets"], seen
            else:
                assert all(v == [] for k, v in seen.items() if k != "planets"), seen
                assert "saturn" in seen["planets"] and "io" not in seen["planets"], seen
            assert pg.evaluate("_aeOrbitsMode()") == mode
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_moon_s_landings_on_the_first_tap(served):
    """At the Moon its landing table is there before Landings is tapped: the first tap opens Go to at the landings with
    their heading in view. Until then the Moon names only Apollo's six; opened, every landing on the near side."""
    from playwright.sync_api import sync_playwright

    apollo = {"Apollo 11", "Apollo 12", "Apollo 14", "Apollo 15", "Apollo 16", "Apollo 17"}
    labels = "() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden).map(b => b.textContent)"
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            assert pg.evaluate("_aeLm === null")
            pg.evaluate("window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('moon');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeLm; }", timeout=60_000, polling=100)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return (" + labels + ")().length > 0; }", timeout=30_000, polling=200)
            quiet = pg.evaluate(labels)
            assert set(quiet) <= apollo, quiet
            pg.click("#ae-views [data-ae-view='landings']")
            seen = pg.evaluate("""() => { var s = document.getElementById('ae-go'), h = s.querySelector('h4[data-g="alm_go_landings"]');
                if (!h) return null; var a = s.getBoundingClientRect(), b = h.getBoundingClientRect(); return b.top >= a.top - 1 && b.bottom <= a.bottom + 1; }""")
            assert seen is True, seen
            pg.click("#ae-go-btn")   # put away: the Moon now names all its landings in view
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return (" + labels + ")().some(n => !/^Apollo/.test(n)); }", timeout=30_000, polling=200)
            assert len(pg.evaluate(labels)) > len(quiet)
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
            pg.evaluate("window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('planets');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=100)
            for k in ("jupiter", "saturn"):
                at = pg.evaluate("(k) => { _aeUpdate(_aeDisplayMs()); var s = _aeProject(_aeBodyPos(k)); return [s.x, s.y]; }", k)
                for dx, dy in ((0, 0), (3, 2), (-2, 3)):
                    assert pg.evaluate("(a) => _aeBodyAt(a[0], a[1])", [at[0] + dx, at[1] + dy]) == k
            at = pg.evaluate("() => { var s = _aeProject(_aeBodyPos('jupiter')), r = document.getElementById('ae-canvas').getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; }")
            pg.mouse.click(at["x"], at["y"])
            pg.wait_for_function("() => _ae.target !== 'earth' && _ae.preset !== 'planets'", timeout=10_000, polling=100)
            assert pg.evaluate("_ae.target") == "jupiter"
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
            pg.evaluate("window._almReduceMotion = function () { return true; }; _ae.fly = null; _aePreset('jupiter');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=100)
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
            behind = pg.evaluate("""() => { var c = _ae.gl.camera.position, eye = [c.x, c.y, c.z], s = _aeSunShown(_ae.scene);
                var p = _aeAdd(s, _aeScale(_aeNorm(_aeSub(s, eye)), 50)), q = _aeAdd(p, [0, 0, 10 * AE_SUN_SHOW_R]);
                return [_aeBehindAny('mars', p), _aeBehindAny('mars', q)]; }""")
            assert behind == [True, False], behind
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
            pg.evaluate("window._almReduceMotion = function () { return true; }; _aeTracksLoad();")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            pg.evaluate("_ae.fly = null; _aePreset('voyager1');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); var I = _ae.gl.crafts && _ae.gl.crafts.voyager1; return !_ae.fly && !!I && I.root.visible && !!I.record && I.record.material.uniforms.mapped.value === 1; }", timeout=60_000, polling=200)
            assert pg.evaluate("_ae.gl.crafts.voyager1.uni.fill.value") > 0
            assert pg.evaluate("AE_RECORD_IMG") == "/static/golden-record/cover.jpg"   # the picture the Golden Record section shows
            assert pg.evaluate("!!_ae.gl.crafts.voyager1.record.material.uniforms.map.value")
            pg.evaluate("""() => { window._grOpened = 0; window._scrollToGoldenRecord = function () { window._grOpened++; }; }""")
            # Turn the view so the record faces the camera, then tap it.
            at = pg.evaluate("""() => { var I = _ae.gl.crafts.voyager1, c = I.record.userData.at;
                I.root.updateMatrixWorld(true);
                var w = new _ae.gl.THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(I.root.matrixWorld), o = new _ae.gl.THREE.Vector3(c[0] + 1, c[1], c[2]).applyMatrix4(I.root.matrixWorld);
                var n = _aeNorm([o.x - w.x, o.y - w.y, o.z - w.z]), ae = _aeAzElOf(n);
                _ae.az = ae.az; _ae.el_ = ae.el; _aeUpdate(_aeDisplayMs()); _ae.gl.camera.updateMatrixWorld(); I.root.updateMatrixWorld(true);
                w = new _ae.gl.THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(I.root.matrixWorld);
                var s = _aeProject([w.x, w.y, w.z]), r = document.getElementById('ae-canvas').getBoundingClientRect();
                return { x: r.left + s.x, y: r.top + s.y }; }""")
            pg.screenshot(path=os.environ.get("ALM_SHOT_DIR", "/tmp") + "/voyager-record.png") if os.environ.get("ALM_SHOT_DIR") else None
            pg.mouse.click(at["x"], at["y"])
            pg.wait_for_function("() => window._grOpened === 1", timeout=10_000)
            pg.wait_for_function("() => !_aeIsOpen", timeout=30_000)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("width", [360, 1280])
def test_the_minimap_is_always_there(served, width):
    """The little solar system is in the corner in every state of the view (the Earth, its satellites, the Moon, a
    planet, a moon, a probe, the Sun, and in flight), on a phone and a desktop, but not over the Planets view itself;
    it never covers the way back or the date."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br, width)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            _open(pg, served)
            pg.evaluate("_aeTracksLoad();")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            clear = """() => { var m = document.getElementById('ae-mini').getBoundingClientRect();
                return ['ae-back', 'ae-when-col', 'ae-now'].every(function (id) { var e = document.getElementById(id); if (!e || !e.offsetParent) return true;
                  var r = e.getBoundingClientRect(); return r.right <= m.left || r.left >= m.right || r.bottom <= m.top || r.top >= m.bottom; }); }"""
            shown = "() => { _ae.dirty = true; _aeKick(); return !document.getElementById('ae-mini').hidden; }"
            for k in ("earth", "sats", "moon", "jupiter", "io", "voyager1", "sun"):
                pg.evaluate("(k) => { window._almReduceMotion = undefined; _aePreset(k); }", k)
                if k == "jupiter":   # in flight too
                    pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !!_ae.fly; }", timeout=10_000, polling=50)
                    assert pg.evaluate(shown), "in flight"
                pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=120_000, polling=100)
                assert pg.evaluate(shown), k
                assert pg.evaluate(clear), k
            pg.evaluate("window._almReduceMotion = function () { return true; }; _aePreset('planets');")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && document.getElementById('ae-mini').hidden; }", timeout=60_000, polling=100)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
