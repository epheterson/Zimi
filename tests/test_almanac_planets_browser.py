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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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
            squeeze = pg.evaluate("[AE_SUN_SHOW_DIST, AE_PLANET_DIST_POW]")
            drawn = lambda au: squeeze[0] * au ** squeeze[1]  # noqa: E731
            assert drawn(1.666) < belt["p1"] and belt["p99"] < drawn(4.95), (belt, drawn(1.666), drawn(4.95))
            # Names: none over another name or another body's ring, at 390 px, and the planets named.
            pg.wait_for_timeout(500)
            marks = pg.evaluate("""() => Array.from(document.querySelectorAll('#ae-labels .ae-bm')).filter(e => !e.hidden).map(e => {
                var ring = e.querySelector('.ae-ring').getBoundingClientRect(), b = e.querySelector('b'), named = getComputedStyle(b).display !== 'none';
                var nb = b.getBoundingClientRect();
                return { id: e.id, ring: [ring.left, ring.top, ring.right, ring.bottom], name: named ? [nb.left, nb.top, nb.right, nb.bottom] : null }; })""")
            meet = lambda a, b: a[0] < b[2] - 0.5 and b[0] < a[2] - 0.5 and a[1] < b[3] - 0.5 and b[1] < a[3] - 0.5  # noqa: E731
            for m in marks:
                if not m["name"]:
                    continue
                for o in marks:
                    if o is m:
                        continue
                    assert not meet(m["name"], o["ring"]), (m, o)
                    assert not (o["name"] and meet(m["name"], o["name"])), (m, o)
            named = {m["id"] for m in marks if m["name"]}
            assert {"ae-bm-jupiter", "ae-bm-saturn", "ae-bm-uranus", "ae-bm-neptune"} <= named, named
            assert pg.is_visible("#ae-scale")
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


def test_the_strip_the_minimap_and_the_orrery_s_way_in(served):
    """Every destination in one sideways strip; near a planet the corner minimap shows where you are and opens the
    whole system; the 2D orrery's planet tip opens the 3D view on that planet."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE))
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            # The orrery's way in: open on Jupiter, as its tip's button does.
            pg.evaluate("_orreryOpenEarthView('jupiter')")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'jupiter'; }", timeout=60_000, polling=200)
            # One strip, one row, sideways only, every planet in it.
            strip = pg.evaluate("""() => { var s = document.getElementById('ae-views'), cs = getComputedStyle(s);
                var tops = new Set(Array.from(s.children).map(b => b.offsetTop));
                return { rows: tops.size, wrap: cs.flexWrap, ox: cs.overflowX, keys: Array.from(s.children).map(b => b.dataset.aeView) }; }""")
            assert strip["rows"] == 1 and strip["wrap"] == "nowrap" and strip["ox"] == "auto", strip
            assert {"earth", "moon", "sun", "planets", "mercury", "neptune", "io", "titan", "pluto", "ceres"} <= set(strip["keys"]), strip
            assert pg.evaluate("document.querySelector('#ae-views [data-ae-view=\"jupiter\"]').getAttribute('aria-pressed')") == "true"
            # Tap straight to Saturn from Jupiter.
            pg.click("#ae-views [data-ae-view='saturn']")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'saturn'; }", timeout=60_000, polling=200)
            # The minimap is up near a planet, and takes you to the whole system.
            assert pg.is_visible("#ae-mini")
            pg.click("#ae-mini")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.preset === 'planets'; }", timeout=60_000, polling=200)
            assert not pg.is_visible("#ae-mini")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
