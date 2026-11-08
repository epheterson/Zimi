"""Planets side by side in the 3D view: Mercury to Neptune turning at their real rates, tilted as they are to their orbits.

In headless Chromium at a phone's size: the rates and tilts the view uses against NASA's planetary fact sheet, every planet
drawn (its disc has pixels), each one turning with the shown clock (a rotation angle that changes), Venus' turn the opposite
sense to the Earth's (and Uranus', on its side, too), the same-size toggle, the Orbits setting hiding the orbital planes and
years, full screen (chrome gone, faces on, a way out by tool, Escape and back) and the faces tile, and a tap on a planet leaving for it
with the date put back.

Run: pytest tests/test_almanac_spin_browser.py -v
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
HOUR_MS = 3_600_000
ORDER = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"]
# NASA planetary fact sheet (nssdc.gsfc.nasa.gov/planetary/factsheet): sidereal rotation period (hours, negative =
# retrograde), obliquity to orbit (degrees), sidereal orbit period (days).
FACT_SHEET = {
    "mercury": (1407.6, 0.034, 87.969),
    "venus": (-5832.5, 177.36, 224.701),
    "earth": (23.9345, 23.44, 365.256),
    "mars": (24.6229, 25.19, 686.98),
    "jupiter": (9.925, 3.13, 4332.589),
    "saturn": (10.656, 26.73, 10759.22),
    "uranus": (-17.24, 97.77, 30685.4),
    "neptune": (16.11, 28.32, 60189.0),
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("spin")
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


def open_spin(pg, served):
    """Open the 3D view, then Planets, then Side by side, by the chips a person taps."""
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
    pg.click("[data-ae-view='planets']")
    pg.wait_for_function(
        "() => !_ae.fly && _ae.target === 'sun'", timeout=60_000, polling=200
    )
    pg.click("[data-ae-view='spin']")
    pg.wait_for_function(
        "() => !!_ae.spin && !!_ae.gl.spin && _ae.gl.spin.cells.every(c => c.uni.mapped.value === 1)",
        timeout=60_000,
        polling=200,
    )


def at(pg, ms):
    """Show the clock at ms and draw the view once, so what is read is what is drawn then."""
    pg.evaluate(
        "(ms) => { _almClockSetRate(1); _almFocus = new Date(ms); _aeSpinDraw(); }", ms
    )


COLUMN = """() => Object.fromEntries(_ae.gl.spin.cells.map(c => { var e = c.mesh.matrix.elements, r = c.r;
    return [c.b.key, [e[0] / r, e[1] / r, e[2] / r]]; }))"""


def turn_deg(a, b):
    """The angle a prime meridian turned through from a to b (unit vectors), and the sign of its turn about +y (the
    orbit's normal): positive is counter-clockwise seen from the north."""
    dot = sum(x * y for x, y in zip(a, b))
    cross_y = a[2] * b[0] - a[0] * b[2]
    return math.degrees(math.acos(max(-1.0, min(1.0, dot)))), cross_y


@pytest.fixture(scope="module")
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
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
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        open_spin(pg, served)
        yield pg
        assert not pg.errors, pg.errors
        br.close()


def test_rates_tilts_and_years_match_the_fact_sheet(page):
    got = page.evaluate(
        """(a) => { var jd = a.ms / MS_PER_DAY + JD_UNIX_EPOCH;
            return Object.fromEntries(a.order.map(k => { var f = _aeSpinFacts(_aeSpinBody(k), jd); return [k, [f.periodS / 3600, f.tiltDeg, f.yearDays]]; })); }""",
        {"ms": WHEN_MS, "order": ORDER},
    )
    for k, (hours, tilt, year) in FACT_SHEET.items():
        # Neptune: the IAU rate (541.1397757 deg a day, 15.97 h) is the one the maps are placed by; the sheet's 16.11 h is Voyager's.
        assert got[k][0] == pytest.approx(hours, rel=0.01), (k, got[k])
        # Mars: the IAU 2015 pole the maps are placed by stands 23.9 deg from Mars' orbit normal (the sheet's 25.19 goes with
        # the older IAU 2009 pole, 317.68 / 52.89); the others agree with the sheet to under half a degree.
        assert got[k][1] == pytest.approx(tilt, abs=1.5 if k == "mars" else 0.6), (k, got[k])
        assert got[k][2] == pytest.approx(year, rel=0.002), (k, got[k])
    assert got["jupiter"][0] == pytest.approx(9.93, abs=0.02)
    assert got["venus"][0] == pytest.approx(-5832.5, rel=0.001)
    assert got["mars"][0] == pytest.approx(24.62, abs=0.02)


def test_every_planet_is_drawn_and_named(page):
    page.evaluate("_aeSpinDraw()")
    lit = page.evaluate(
        """() => { var S = _ae.gl, gl = S.renderer.getContext(), sp = S.spin, out = {};
            S.renderer.render(sp.scene, sp.camera);
            var dpr = S.renderer.getPixelRatio();
            // The brightest of a grid across each disc (an ocean at its middle is nearly black, as it is).
            sp.cells.forEach(c => { var best = [0, 0, 0, 0], px = new Uint8Array(4);
              for (var i = -2; i <= 2; i++) for (var j = -2; j <= 2; j++) {
                var x = Math.round((c.G.position.x + i * 0.3 * c.r) * dpr), y = Math.round((c.G.position.y + j * 0.3 * c.r) * dpr);
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                if (px[0] + px[1] + px[2] > best[0] + best[1] + best[2]) best = [px[0], px[1], px[2], px[3]]; }
              out[c.b.key] = best; });
            return out; }"""
    )
    for k in ORDER:
        r, g, b, a = lit[k]
        assert a == 255 and r + g + b > 60, (
            k,
            lit[k],
        )  # a lit disc at its centre, not the black behind it
    names = page.evaluate(
        "Array.from(document.querySelectorAll('#ae-spin .ae-sp b')).map(b => b.textContent)"
    )
    assert names == [
        "Mercury",
        "Venus",
        "Earth",
        "Mars",
        "Jupiter",
        "Saturn",
        "Uranus",
        "Neptune",
    ]
    # Under each planet one short line: the day, the year, the tilt; the words are for a screen reader.
    jup = page.inner_text("[data-ae-spin=jupiter] span")
    assert "↻" not in jup and "↺" not in jup and "9.9h" in jup and "3.1°" in jup and jup.count("·") >= 1, jup
    assert "Day 9.9 hr" in page.get_attribute("[data-ae-spin=jupiter]", "aria-label")
    # Backwards ends the line with ↺ in amber; said in words only to a screen reader.
    assert page.evaluate("document.querySelector('[data-ae-spin=venus] .ae-sp-back').textContent") == "↺"
    assert "Spins backwards" in page.get_attribute("[data-ae-spin=venus]", "aria-label")
    assert page.evaluate("document.querySelectorAll('[data-ae-spin=venus] span').length") == 1
    assert "Solar System Scope" in page.evaluate("_aePlanetCredit()")


def test_they_turn_by_the_clock_and_venus_turns_the_other_way(page):
    at(page, WHEN_MS)
    a = page.evaluate(COLUMN)
    at(page, WHEN_MS + HOUR_MS)
    b = page.evaluate(COLUMN)
    deg = {k: turn_deg(a[k], b[k]) for k in ORDER}
    # An hour of each planet's own sidereal rate (IAU: degrees a day), as drawn.
    rates = page.evaluate(
        "Object.fromEntries("
        + str(ORDER)
        + ".map(k => [k, Math.abs(_aeSpinBody(k).pole[3])]))"
    )
    for k in ORDER:
        assert deg[k][0] == pytest.approx(rates[k] / 24, abs=0.01), (
            k,
            deg[k],
            rates[k] / 24,
        )
    assert deg["earth"][0] == pytest.approx(15.04, abs=0.01)
    assert deg["jupiter"][0] == pytest.approx(36.27, abs=0.02)
    # Seen from the north: the Earth's prime meridian goes counter-clockwise (positive about the orbit's normal), Venus' clockwise.
    assert deg["earth"][1] > 0 > deg["venus"][1]
    assert deg["uranus"][1] < 0 < deg["neptune"][1]
    # And it moves with the clock a person runs: whatever the drawn date has run to, each planet has turned by its own rate over it.
    page.evaluate("_almFocus = null; _almClockSetRate(1); _aeSpinDraw()")
    before, jd0 = page.evaluate(COLUMN), page.evaluate("_ae.gl.spin.jd")
    page.evaluate("_almClockSetRate(3600)")
    page.wait_for_function("(jd0) => _ae.gl.spin.jd - jd0 > 0.01", arg=jd0, timeout=120_000, polling=200)
    page.evaluate("_almClockSetRate(1)")
    page.evaluate("_aeSpinDraw()")
    after, jd1 = page.evaluate(COLUMN), page.evaluate("_ae.gl.spin.jd")
    for k in ("earth", "jupiter", "mars", "venus"):
        want = (rates[k] * (jd1 - jd0)) % 360
        want = min(want, 360 - want)
        assert turn_deg(before[k], after[k])[0] == pytest.approx(want, abs=0.05), (k, want)
    assert turn_deg(before["earth"], after["earth"])[0] > 0.1


def test_tilts_are_drawn_as_they_are_and_the_axis_and_orbit_are_there(page):
    page.evaluate("_aeSpinDraw()")
    got = page.evaluate(
        """() => Object.fromEntries(_ae.gl.spin.cells.map(c => { var g = _aeSpinGeometry(c.b, _aeDisplayMs() / MS_PER_DAY + JD_UNIX_EPOCH), p = c.north.geometry.attributes.position.array;
            return [c.b.key, { axis: g.axis, tilt: g.tiltDeg, tip: [p[3], p[4]], orbit: c.orbit.visible, northVisible: c.north.visible && c.south.visible }]; }))"""
    )
    for k in ORDER:
        ax = got[k]["axis"]
        assert math.hypot(*ax) == pytest.approx(1, abs=1e-6)
        # The axis leans right by the tilt from the orbit's normal (up): sin to the right, cos up.
        assert (
            ax[0] == pytest.approx(math.sin(math.radians(got[k]["tilt"])), abs=1e-6)
            and abs(ax[2]) < 1e-6
        )
        assert ax[1] == pytest.approx(math.cos(math.radians(got[k]["tilt"])), abs=1e-6)
        assert got[k]["orbit"] and got[k]["northVisible"]
    assert got["venus"]["axis"][1] < -0.99  # upside down: spinning backwards
    assert got["uranus"]["axis"][0] > 0.98  # on its side


def test_same_size_and_true_sizes(page):
    page.evaluate(
        "localStorage.setItem('zimi_ae_spin_same', '1'); _aeSpinMarkSame(); _ae.dirty = true; _aeSpinDraw()"
    )
    same = page.evaluate(
        "Object.fromEntries(_ae.gl.spin.cells.map(c => [c.b.key, c.r]))"
    )
    assert len({round(v, 3) for v in same.values()}) == 1, same
    assert page.get_attribute("#ae-spin-same", "aria-pressed") == "true"
    page.click("#ae-spin-same")
    page.evaluate("_aeSpinDraw()")
    true = page.evaluate(
        "Object.fromEntries(_ae.gl.spin.cells.map(c => [c.b.key, c.r]))"
    )
    assert page.get_attribute("#ae-spin-same", "aria-pressed") == "false"
    # True relative sizes: equatorial radii (km) as a ratio.
    ratio = page.evaluate(
        "Object.fromEntries(" + str(ORDER) + ".map(k => [k, _aeSpinBody(k).km]))"
    )
    for k in ORDER:
        assert true[k] / true["earth"] == pytest.approx(
            ratio[k] / ratio["earth"], rel=1e-3
        ), k
    assert true["jupiter"] > 10 * true["earth"] * 0.99
    page.evaluate("localStorage.removeItem('zimi_ae_spin_same'); _aeSpinMarkSame()")


def test_labels_sit_inside_the_view_and_clear_of_the_controls(page):
    page.evaluate("_ae.dirty = true; _aeSpinDraw()")
    boxes = page.evaluate(
        """() => { var v = _ae.el.getBoundingClientRect(), bottom = document.querySelector('.ae-bottom .ae-row:not([hidden])').getBoundingClientRect().top - v.top;
            return { bottom: bottom, cells: Array.from(document.querySelectorAll('#ae-spin .ae-sp')).map(b => { var r = b.getBoundingClientRect();
              return [r.left - v.left, r.top - v.top, r.right - v.left, r.bottom - v.top]; }), w: v.width }; }"""
    )
    for c in boxes["cells"]:
        assert c[0] >= 0 and c[2] <= boxes["w"] + 0.5, c
        assert c[3] <= boxes["bottom"] + 1, (c, boxes["bottom"])
    # Each label's text fits its button (no clipped lines).
    assert page.evaluate(
        "Array.from(document.querySelectorAll('#ae-spin .ae-sp')).every(b => b.scrollHeight <= b.clientHeight + 1 && b.scrollWidth <= b.clientWidth + 1)"
    )


def test_side_by_side_always_has_the_planes_and_years(page):
    """Side by side is a comparison of the planets: their orbital planes and years show whatever the Orbits switch says
    (the switch stands aside here)."""
    years = "document.querySelector('[data-ae-spin=jupiter] span').textContent.split('·').length === 3"   # turn · year · tilt
    for on in ("true", "false"):
        page.evaluate("(on) => { _aeSetOrbits(on); _ae.dirty = true; _aeSpinDraw(); }", on == "true")
        assert page.evaluate(years)
        assert page.evaluate("_ae.gl.spin.cells.every(c => c.orbit.visible)")
        page.wait_for_function("() => { _ae.dirty = true; _aeKick(); return document.getElementById('ae-orbits-btn').hidden; }", timeout=10_000)


def full_state(pg):
    return pg.evaluate(
        """() => { var v = _ae.el.getBoundingClientRect(), shown = id => { var e = document.querySelector(id); return !!e && e.getClientRects().length > 0; };
            return { full: _aeFullOn(), cls: _ae.el.classList.contains('ae-spin-full'), top: shown('.ae-top'), bottom: shown('.ae-bottom'), gear: shown('#ae-gear'),
              bar: shown('#ae-fullbar'), topbar: shown('.topbar'), w: v.width, h: v.height, left: v.left, topEdge: v.top, faces: _aeSpinFacesOn(),
              pressed: document.querySelector('#ae-fullbar [data-ae-faces]').getAttribute('aria-pressed'),
              shownFaces: _ae.gl.spin.cells.every(c => c.face.visible),
              cells: Array.from(document.querySelectorAll('#ae-spin .ae-sp')).map(b => { var r = b.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, b.querySelectorAll('span').length]; }),
              discs: _ae.gl.spin.cells.map(c => [c.G.position.x - c.r, _ae.h - c.G.position.y - c.r, c.G.position.x + c.r, _ae.h - c.G.position.y + c.r]) }; }"""
    )


def test_full_screen_hides_the_chrome_and_faces_follow_the_person(page):
    page.evaluate("localStorage.removeItem('zimi_alm_spin_faces'); _aeSpinMarkFaces(); _aeSpinDraw()")
    before = full_state(page)
    # The normal view: the numbers, no faces unless chosen, the chrome there, the tools in the row (icons: they carry a label, not a word).
    assert not before["full"] and before["bottom"] and before["top"] and not before["faces"] and not before["shownFaces"]
    assert page.get_attribute("#ae-spinrow [data-ae-full]", "aria-label") == "Full screen"
    page.click("#ae-spinrow [data-ae-full]")
    page.wait_for_function("() => _aeFullOn()", timeout=10_000)
    page.evaluate("_aeSpinDraw()")
    on = full_state(page)
    assert on["cls"] and on["bar"] and not on["top"] and not on["bottom"] and not on["gear"] and not on["topbar"]
    # Faces on by default here, the names alone (no Day / Year / Tilt lines), the whole screen used.
    assert on["faces"] and on["shownFaces"] and on["pressed"] == "true"
    assert all(c[4] == 0 for c in on["cells"])
    assert on["left"] == 0 and on["topEdge"] == 0 and on["w"] >= VIEW["width"] - 1 and on["h"] >= VIEW["height"] - 1
    # No planet's disc (or name) is clipped by the screen.
    for d in on["discs"]:
        assert d[0] >= 0 and d[1] >= 0 and d[2] <= on["w"] and d[3] <= on["h"], d
    for c in on["cells"]:
        assert c[0] >= -0.5 and c[2] <= on["w"] + 0.5 and c[3] <= on["h"] + 0.5, c
    assert max(d[2] - d[0] for d in on["discs"]) > 0.15 * on["w"]
    # The faces tile: a choice kept with the person (the synced preference), for both views, and read back after a reload of state.
    page.click("#ae-fullbar [data-ae-faces]")
    assert page.evaluate("localStorage.getItem('zimi_alm_spin_faces')") == "0"
    page.evaluate("_aeSpinDraw()")
    off = full_state(page)
    assert not off["faces"] and not off["shownFaces"] and off["pressed"] == "false"
    page.click("#ae-fullbar [data-ae-faces]")
    assert page.evaluate("localStorage.getItem('zimi_alm_spin_faces')") == "1"
    assert page.evaluate("_isPrefKey('zimi_alm_spin_faces')")
    # Escape leaves full screen, not the view; so does the system back; and the way out the corner tool is.
    page.keyboard.press("Escape")
    page.wait_for_function("() => !_aeFullOn()", timeout=10_000)
    assert page.evaluate("!!_ae.spin && _aeIsOpen")
    page.evaluate("_aeSpinDraw()")
    after = full_state(page)
    assert not after["cls"] and after["bottom"] and after["top"] and after["faces"] and after["shownFaces"]
    page.click("#ae-spinrow [data-ae-full]")
    page.wait_for_function("() => _aeFullOn()", timeout=10_000)
    page.go_back()
    page.wait_for_function("() => !_aeFullOn()", timeout=10_000)
    assert page.evaluate("!!_ae.spin && _aeIsOpen")
    page.click("#ae-spinrow [data-ae-full]")
    page.wait_for_function("() => _aeFullOn()", timeout=10_000)
    page.click("#ae-fullbar [data-ae-full]")
    page.wait_for_function("() => !_aeFullOn()", timeout=10_000)
    assert page.evaluate("!document.documentElement.classList.contains('ae-full-on')")
    page.evaluate("localStorage.removeItem('zimi_alm_spin_faces'); _aeSpinMarkFaces(); _aeSpinDraw()")


def test_a_tap_on_a_planet_goes_there_and_the_date_is_put_back(page):
    # From the live clock: Side by side runs it at an hour a second, and leaving puts it back where it was.
    page.evaluate("_almClockSetRate(1); _aeNow()")
    page.click("[data-ae-view='spin']")   # Side by side again: back to the planets (its row is the Sun and itself)
    page.wait_for_function("() => !_ae.spin && !_ae.fly && _ae.preset === 'planets'", timeout=60_000, polling=200)
    # One tap from the Planets view: its chip stands beside it.
    assert page.is_visible("[data-ae-view='spin']")
    page.click("[data-ae-view='spin']")
    page.wait_for_function("() => !!_ae.spin", timeout=60_000, polling=200)
    assert page.evaluate("_almRate") == 3600 and page.evaluate("_ae.spin.autoRun")
    # The clock runs ahead of the wall (an hour a second).
    page.wait_for_function("() => _aeDisplayMs() - Date.now() > 60000", timeout=60_000, polling=200)
    # The row while they stand side by side: the Sun and itself, lit (its tools where Earth and Planets were).
    assert page.evaluate("_aeRowKeys().join(',')") == "sun,spin"
    assert page.get_attribute("[data-ae-view='spin']", "aria-pressed") == "true"
    page.click("[data-ae-spin='jupiter']")
    page.wait_for_function("() => !_ae.spin && _ae.target === 'jupiter'", timeout=60_000, polling=200)
    assert not page.evaluate("document.getElementById('ae-view').classList.contains('ae-spinning')")
    assert page.evaluate("_almRate") == 1 and abs(page.evaluate("_aeDisplayMs() - Date.now()")) < 10_000
    # Go to lists it first among the planets.
    page.click("#ae-go-btn")
    assert page.evaluate("document.querySelector('#ae-go [data-ae-go=\"spin\"]').textContent") == "Side by side"
    page.evaluate("_aeShowGo(false)")   # the open sheet covers its button (a tap away or Escape shuts it)


def test_a_phone_on_its_side_has_the_row_down_the_left_and_room_for_the_planets(page):
    """In Safari on its side a phone has about 250 px under its bars: the row stands down the left edge, the foot is the date
    and time, and no planet's caption runs into either."""
    page.evaluate("() => { if (_aeFullOn()) _aeFullExit(); if (!_ae.spin) { _ae.fly = null; _aePreset(AE_SPIN_KEY); } }")
    page.wait_for_function("() => !!_ae.spin", timeout=10_000)
    page.set_viewport_size({"width": 932, "height": 300})
    try:
        page.wait_for_function("() => { _ae.dirty = true; _aeKick(); return _ae.sidePx > 0; }", timeout=10_000)
        page.evaluate("_aeSpinDraw()")
        got = page.evaluate(
            """() => { var r = e => e.getBoundingClientRect(), v = r(document.getElementById('ae-views')), c = r(document.querySelector('#ae-clock .alm-ck-l') || document.getElementById('ae-clock'));
            return { col: v.height > v.width, cells: Array.from(document.querySelectorAll('#ae-spin .ae-sp')).map(b => { var q = r(b); return [q.left, q.bottom]; }),
              viewsRight: v.right, clockTop: c.top, slider: !!document.querySelector('#ae-clock .alm-spd') && document.querySelector('#ae-clock .alm-spd').getClientRects().length > 0 }; }"""
        )
        assert got["col"], got
        assert all(x >= got["viewsRight"] and b <= got["clockTop"] + 1 for x, b in got["cells"]), got
        assert not got["slider"], got
    finally:
        page.set_viewport_size(VIEW)
