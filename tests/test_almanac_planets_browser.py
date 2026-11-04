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
            clusters = pg.evaluate("_ae.clusters")
            if clusters:
                dist0 = pg.evaluate("_ae.dist")
                c = clusters[0]
                pg.evaluate("(c) => _aeTap(c.x, c.y)", c)
                pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=200)
                assert pg.evaluate("_ae.dist") < dist0 / 2
            # The probes: once out here their table comes; each flying one is named, Webb stands at L2 at its true
            # distance from the Earth (1.5 million km, not squeezed by the drawn scale), and a tap's card says where.
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !!_aeTracks && !!_aeProbePos.voyager1 && !!_aeProbePos.jwst; }", timeout=60_000, polling=200)
            jwst_km = pg.evaluate("Math.hypot.apply(null, _aeProbePos.jwst) * AE_EARTH_RADIUS_KM")
            assert 1.2e6 < jwst_km < 1.9e6, jwst_km
            pg.evaluate("_aePreset('voyager1')")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=200)
            card = pg.inner_text("#ae-card")
            assert "Voyager 1" in card and "AU from the Sun" in card and "Saturn" in card, card
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
            row = pg.evaluate("Array.from(document.querySelectorAll('#ae-views > *')).map(b => b.dataset.aeView || b.id)")
            assert row == ["earth", "sats", "moon", "sun", "planets", "ae-go-btn"], row
            pg.click("#ae-go-btn")
            pg.wait_for_function("() => !document.getElementById('ae-go').hidden && document.querySelectorAll('#ae-go [data-ae-go=\"voyager1\"]').length === 1", timeout=60_000)
            groups = pg.evaluate("Array.from(document.querySelectorAll('#ae-go h4')).length")
            assert groups == 5, groups
            assert pg.evaluate("Array.from(document.querySelectorAll('#ae-go .ae-go-row')).every(r => !!r.querySelector('.ae-go-dot'))")
            pg.click("#ae-go [data-ae-go='saturn']")
            assert pg.evaluate("document.getElementById('ae-go').hidden")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'saturn'; }", timeout=60_000, polling=200)
            assert pg.evaluate("Object.keys(_ae.gl.planets).every(k => !_ae.gl.planets[k].orbit || !_ae.gl.planets[k].orbit.visible)")
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
    ago too) and a trail of under a third of an orbit, fading behind; the Voyagers keep the whole road out."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = _ctx(br)
            pg = ctx.new_page()
            _open(pg, served)
            pg.evaluate("window._almReduceMotion = function () { return true; }; _aeTracksLoad();")
            pg.wait_for_function("() => !!_aeTracks", timeout=60_000)
            got = {}
            for k in ("parker", "juno", "voyager1"):
                pg.evaluate("(k) => _aePreset(k)", k)
                got[k] = pg.evaluate("""(k) => { _ae.dirty = true; _aeKick(); _aeUpdate(_aeDisplayMs()); var t = _ae.gl.probes.trails[k], r = _ae.gl.probes.orbits[k], o = t.orbit;
                    var c = t.geometry.attributes.color.array;
                    return { round: o && o.round, period: o && o.period, trail: o && o.trail, ring: r.visible, first: c[3], last: c[c.length - 1] }; }""", k)
            assert got["parker"]["round"] == "sun" and 80 < got["parker"]["period"] < 95 and got["parker"]["ring"], got
            assert got["juno"]["round"] == "jupiter" and 25 < got["juno"]["period"] < 40 and got["juno"]["ring"], got
            for k in ("parker", "juno"):
                assert got[k]["trail"] <= got[k]["period"] * 0.31 and got[k]["first"] < 0.01 and got[k]["last"] == 1, got
            assert got["voyager1"]["round"] is None and not got["voyager1"]["ring"] and got["voyager1"]["first"] == 1, got
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
            tops = pg.evaluate("Array.from(document.querySelectorAll('#ae-views > *')).map(b => { var r = b.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.right)]; })")
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
            keys = pg.evaluate("_aeGoGroups().reduce((a, g) => a.concat(g[1]), []).concat(['sun', 'planets', 'sats'])")
            pg.evaluate("_aeShowGo(false); window._almReduceMotion = function () { return true; };")   # each flight lands at once
            missed = []
            for k in keys:
                pg.evaluate("(s) => { _ae.fly = null; _aePreset(s); }", start)
                pg.wait_for_function("(s) => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset && (_ae.target === s || (s === 'jupiter' ? false : true)); }", arg=start, timeout=30_000, polling=100)
                pg.evaluate("(k) => { _ae.fly = null; _aePreset(k); }", k)
                pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !_ae.pendingPreset; }", timeout=30_000, polling=100)
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
