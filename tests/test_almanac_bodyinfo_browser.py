"""A body's axis and its facts sheet in the Almanac's 3D view.

In headless Chromium at a phone's size: the sheet's numbers against NASA's planetary fact sheet, its library link going to
the right Q-ID, each body's axis pointing at the IAU pole the maps use (Earth, Uranus, Venus) and following the Orbits
setting, the km/mi units, the sheet opening and shutting (button, Escape, a tap elsewhere, a swipe down), and the Almanac's
Constants pages listing every quantity a sheet shows (the test fails on one they do not).

Screenshots (390x844 and 1440x900, Chromium and WebKit) go to SHOTS_DIR when it is set.

Run: pytest tests/test_almanac_bodyinfo_browser.py -v
"""

import math
import os
import re
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
PHONE = {"width": 390, "height": 844}
DESKTOP = {"width": 1440, "height": 900}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
WHEN_MS = 1793750400000  # 2026-11-04T00:00:00Z
SHOTS = os.environ.get("SHOTS_DIR")

# NASA NSSDC planetary fact sheet: mass (1e24 kg), surface gravity (m/s2), escape velocity (km/s).
FACT_SHEET = {
    "mercury": (0.330, 3.7, 4.3),
    "venus": (4.87, 8.9, 10.4),
    "earth": (5.97, 9.8, 11.2),
    "mars": (0.642, 3.7, 5.0),
    "jupiter": (1898, 23.1, 59.5),
    "saturn": (568, 9.0, 35.5),
    "uranus": (86.8, 8.7, 21.3),
    "neptune": (102, 11.0, 23.5),
    "pluto": (0.0130, 0.7, 1.3),
}
# Equatorial radii (km), IAU: the diameter row is twice this.
RADIUS = {
    "mercury": 2439.7,
    "venus": 6051.8,
    "mars": 3396.2,
    "jupiter": 71492,
    "saturn": 60268,
    "uranus": 25559,
    "neptune": 24764,
}
# The Q-IDs of the articles each sheet links to (Wikidata).
QIDS = {
    "sun": "Q525",
    "mercury": "Q308",
    "venus": "Q313",
    "earth": "Q2",
    "moon": "Q405",
    "mars": "Q111",
    "jupiter": "Q319",
    "saturn": "Q193",
    "uranus": "Q324",
    "neptune": "Q332",
    "pluto": "Q339",
    "ceres": "Q596",
    "io": "Q3123",
    "europa": "Q3143",
    "ganymede": "Q3169",
    "callisto": "Q3134",
    "titan": "Q2565",
}
# IAU north poles (RA, Dec, degrees, J2000): what the maps are placed by, and the axis drawn.
POLES = {"earth": (0.0, 90.0), "uranus": (257.311, -15.175), "venus": (272.76, 67.16)}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("bodyinfo")
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


def open_view(pg, served):
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
    pg.evaluate(
        "(ms) => { _almFocus = new Date(ms); _aeSetSpeed(1); _ae.dirty = true; _aeKick(); }",
        WHEN_MS,
    )
    pg.evaluate("_aeTracksLoad()")
    pg.wait_for_function("() => !!_aeTracks", timeout=60_000, polling=200)


@pytest.fixture(scope="module")
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(
            viewport=PHONE,
            device_scale_factor=2,
            has_touch=True,
            is_mobile=True,
            service_workers="block",
            locale="en-US",
        )
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r);"
            " localStorage.setItem('zimi_almanac_units', 'm'); } catch (e) {}"
            % (PLACE, PLACE)
        )
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        open_view(pg, served)
        yield pg
        assert not pg.errors, pg.errors
        br.close()


def sheet(pg, key):
    """Open a body's sheet as its card's button does and return {row id: dd html}."""
    pg.evaluate("(k) => { _ae.arrived = k; _aeRenderCard(); _aeOpenInfo(k); }", key)
    return pg.evaluate(
        "() => Object.fromEntries([...document.querySelectorAll('#ae-info [data-bi]')].map(r => [r.dataset.bi, r.querySelector('dd').innerHTML]))"
    )


def text(html):
    return re.sub(r"<[^>]+>", " ", html)


def test_sheet_numbers_match_the_fact_sheet(page):
    for key, (mass, gravity, escape) in FACT_SHEET.items():
        rows = sheet(page, key)
        m = re.search(r"([\d.]+) × 10<sup>(\d+)</sup>", rows["mass"])
        assert m, (key, rows["mass"])
        kg24 = float(m.group(1)) * 10 ** (int(m.group(2)) - 24)
        assert kg24 == pytest.approx(mass, rel=0.01), (key, rows["mass"])
        assert float(re.search(r"[\d.]+", rows["gravity"]).group()) == pytest.approx(
            gravity, rel=0.02
        ), (key, rows["gravity"])
        assert float(re.search(r"[\d.]+", rows["escape"]).group()) == pytest.approx(
            escape, rel=0.02
        ), (key, rows["escape"])
        if key in RADIUS:
            km = float(text(rows["diameter"]).replace(",", "").split()[0])
            assert km == pytest.approx(2 * RADIUS[key], rel=0.001), (
                key,
                rows["diameter"],
            )
    # Jupiter, in the units: a day, a year, a tilt, its moons, a link-free range.
    rows = sheet(page, "jupiter")
    assert "9 hr 55 min" in text(rows["day"]) or "9 hr 56 min" in text(
        rows["day"]
    ), rows["day"]
    assert "11.9" in rows["year"], rows["year"]
    assert "3.1°" in rows["tilt"] or "3.0°" in rows["tilt"], rows["tilt"]
    assert (
        "AU" in rows["from_sun"]
        and "AU" in rows["from_earth"]
        and "light takes" in rows["from_earth"]
    )
    # Earth: a day against the stars and noon to noon; the Moon a month each way.
    rows = sheet(page, "earth")
    assert "23 hr 56 min" in text(rows["day"]) and "1 day from noon" in text(
        rows["day"]
    ), rows["day"]
    assert "23.4°" in rows["tilt"] or "23.5°" in rows["tilt"], rows["tilt"]
    rows = sheet(page, "moon")
    assert "27.3 days" in text(rows["day"]) and "29.5 days" in text(rows["day"]), rows[
        "day"
    ]
    assert "km" in rows["from_earth"] and "–" in rows["range"]
    # Venus turns backwards; Pluto and a moon have what the table gives.
    assert "backwards" in sheet(page, "venus")["day"]
    assert "Tombaugh" in sheet(page, "pluto")["found"]
    assert "Galileo" in sheet(page, "io")["found"]
    # A probe: launch, where it is, and how fast.
    rows = sheet(page, "voyager1")
    assert (
        "1977" in rows["launched"]
        and "AU" in rows["from_sun"]
        and "km/s" in rows["speed"]
    ), rows
    assert float(re.search(r"[\d.]+", rows["speed"]).group()) == pytest.approx(
        17, abs=1.5
    )


def test_units_follow_the_setting(page):
    page.evaluate("_prefWrite(SK.ALM_UNITS, 'ft')")
    assert (
        "mi" in text(sheet(page, "jupiter")["diameter"])
        and "mi/s" in sheet(page, "jupiter")["escape"]
    )
    assert page.evaluate("localStorage.getItem('zimi_almanac_units')") == "ft"
    page.evaluate("_prefWrite(SK.ALM_UNITS, 'm')")
    assert "km" in text(sheet(page, "jupiter")["diameter"])


def test_the_library_link_is_the_right_q_id(page):
    got = page.evaluate(
        """(keys) => { var seen = [], real = window.AlmanacLinks.wrap;
            window.AlmanacLinks.wrap = function (k, h) { seen.push(k); return real.apply(this, arguments); };
            var out = {};
            keys.forEach(k => { seen.length = 0; _ae.arrived = k; _aeOpenInfo(k); out[k] = [seen.slice(), (AlmanacLinks.MAP[_aeArrivalKey(k)] || {}).q]; });
            window.AlmanacLinks.wrap = real; return out; }""",
        list(QIDS) + ["voyager1", "jwst"],
    )
    for key, qid in QIDS.items():
        assert (
            got[key][0] and got[key][0][0] == "planet:" + key and got[key][1] == qid
        ), (key, got[key])
    assert (
        got["voyager1"] == [["probe:voyager1"], "Q48469"]
        and got["jwst"][1] == "Q186447"
    ), got


def axis_of(pg, key, mode="always"):
    pg.evaluate("(m) => localStorage.setItem('zimi_ae_orbits', m)", mode)
    pg.evaluate("(k) => _aePreset(k)", key)
    pg.wait_for_function("() => !_ae.fly", timeout=60_000, polling=100)
    return pg.evaluate(
        "(k) => { _aeUpdate(_aeDisplayMs()); var o = _ae.gl.axes && _ae.gl.axes[k]; return o && o.north.visible ? o.dir : null; }",
        key,
    )


def test_axes_point_at_the_iau_pole_and_follow_the_orbits(page):
    for key, (ra, dec) in POLES.items():
        d = axis_of(page, key)
        assert d, key
        got_ra = math.degrees(math.atan2(d[1], d[0])) % 360
        got_dec = math.degrees(math.asin(d[2]))
        # The pole is J2000; the scene is the equator of date (26 years of precession, under half a degree).
        assert got_dec == pytest.approx(dec, abs=0.6), (key, d)
        if abs(dec) < 89:
            assert math.cos(math.radians(got_ra - ra)) > math.cos(math.radians(0.7)), (
                key,
                got_ra,
                ra,
            )
    # Uranus' axis lies near its orbit plane: the arrowhead is not where the right-hand rule puts it, it is at the map's north.
    # The lines are the orbits' companions: Off hides them, While flying (the default) shows them only in flight.
    assert axis_of(page, "uranus", "off") is None
    page.evaluate("localStorage.removeItem('zimi_ae_orbits')")
    page.evaluate("() => { _ae.orbitFly = null; _aeUpdate(_aeDisplayMs()); }")
    assert page.evaluate("() => !_ae.gl.axes.uranus.north.visible")
    page.evaluate("localStorage.setItem('zimi_ae_orbits', 'always')")
    page.evaluate("() => { _aeUpdate(_aeDisplayMs()); }")
    assert page.evaluate("() => _ae.gl.axes.uranus.north.visible")


def test_the_sheet_opens_and_shuts(page):
    page.evaluate("localStorage.setItem('zimi_ae_orbits', 'always')")
    page.evaluate("_aePreset('mars')")
    page.wait_for_function(
        "() => !_ae.fly && !!document.querySelector('#ae-card-facts')",
        timeout=60_000,
        polling=100,
    )
    assert page.evaluate(
        "!document.querySelector('#ae-info').classList.contains('in')"
    ), "hidden until asked for"
    page.click("#ae-card-facts")
    page.wait_for_function(
        "() => document.querySelector('#ae-info').classList.contains('in')"
    )
    assert (
        page.evaluate("document.querySelector('#ae-info-title').textContent") == "Mars"
    )
    page.wait_for_function(  # its slide up, slow under software GL
        "() => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(document.querySelector('#ae-info')).transform)",
        timeout=20_000,
    )
    box = page.evaluate(
        "(() => { var r = document.querySelector('#ae-info').getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; })()"
    )
    assert (
        box[1] <= box[2] and box[0] > box[2] * 0.3
    ), box  # on screen, the top of the view left to look at
    page.keyboard.press("Escape")
    page.wait_for_function(
        "() => !document.querySelector('#ae-info').classList.contains('in')"
    )
    page.evaluate("_aeOpenInfo('mars')")
    page.mouse.click(195, 150)  # the view above it
    page.wait_for_function(
        "() => !document.querySelector('#ae-info').classList.contains('in')"
    )
    # A swipe down from its top.
    page.evaluate("_aeOpenInfo('mars')")
    page.evaluate(
        """() => { var el = document.querySelector('#ae-info'), mk = (y) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
            var fire = (t, y) => el.dispatchEvent(new TouchEvent(t, { touches: t === 'touchend' ? [] : [mk(y)], changedTouches: [mk(y)], bubbles: true, cancelable: true }));
            fire('touchstart', 500); fire('touchmove', 560); fire('touchmove', 640); fire('touchend', 640); }"""
    )
    page.wait_for_function(
        "() => !document.querySelector('#ae-info').classList.contains('in')"
    )
    # Following a tap on another body moves the sheet to it; closing the card takes it away.
    page.evaluate("_aeOpenInfo('mars'); _aePreset('jupiter')")
    page.wait_for_function("() => !_ae.fly", timeout=60_000, polling=100)
    assert page.evaluate("_ae.info") == "jupiter"
    page.evaluate("document.querySelector('#ae-card-x').click()")  # under the sheet on a phone
    page.wait_for_function("() => !_ae.info")


def test_the_constants_list_every_quantity_a_sheet_shows(page):
    ids = page.evaluate(
        "() => _aeRefBodiesRows().concat(_aeRefAxesRows()).map(r => r[6])"
    )
    assert len(ids) == len(set(ids)), "an id is listed twice"
    keys = list(QIDS) + [p for p in page.evaluate("_aeTracks.probes")] + ["iss"]
    page.evaluate("_aeCloseInfo(false)")
    problems = []
    for key in keys:
        for row in sheet(page, key):
            needs = page.evaluate("([k, r]) => _aeInfoRefNeeds(k, r)", [key, row])
            if needs is None:
                problems.append((key, row, "the pages do not know this row"))
                continue
            problems += [(key, row, n) for n in needs if n not in ids]
    assert not problems, problems
    # And the pages are there: both tiles open with those rows, each with a source.
    for tile, want in (("k_bodies", "_aeRefBodiesRows"), ("k_poles", "_aeRefAxesRows")):
        n = page.evaluate("(w) => window[w]().length", want)
        page.evaluate("(t) => _almRefOpen(t)", tile)
        page.wait_for_function(
            "(t) => window._tb && _tb.id === t && document.querySelectorAll('#tb-body .tb-consts tbody tr').length > 0",
            arg=tile,
            timeout=60_000,
        )
        rows = page.evaluate(
            "() => [...document.querySelectorAll('#tb-body .tb-consts tbody tr')].map(r => [r.cells.length, r.querySelector('.tb-src').textContent.trim()])"
        )
        assert len(rows) == n and all(c == 3 and src for c, src in rows), (
            tile,
            len(rows),
            n,
        )
    page.evaluate("typeof _tbClose === 'function' && _tbClose()")


def test_screenshots(served):
    """The sheet and the axes, read by eye: 390x844 and 1440x900, Chromium and WebKit."""
    if not SHOTS:
        pytest.skip("SHOTS_DIR is not set")
    from playwright.sync_api import sync_playwright

    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as pw:
        for name in ("chromium", "webkit"):
            for label, vp in (("390x844", PHONE), ("1440x900", DESKTOP)):
                try:
                    br = (
                        getattr(pw, name).launch(args=GL_ARGS)
                        if name == "chromium"
                        else pw.webkit.launch()
                    )
                except Exception as e:  # noqa: BLE001
                    print("no", name, e)
                    break
                ctx = br.new_context(
                    viewport=vp,
                    device_scale_factor=2,
                    has_touch=label == "390x844",
                    is_mobile=label == "390x844" and name == "chromium",
                    service_workers="block",
                    locale="en-US",
                )
                ctx.add_init_script(
                    "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); localStorage.setItem('zimi_ae_orbits', 'always'); localStorage.setItem('zimi_almanac_units', 'm'); } catch (e) {}"
                    % (PLACE, PLACE)
                )
                pg = ctx.new_page()
                try:
                    open_view(pg, served)
                    for body in ("earth", "uranus", "venus"):
                        pg.evaluate("(k) => _aePreset(k)", body)
                        pg.wait_for_function(
                            "() => !_ae.fly", timeout=60_000, polling=100
                        )
                        pg.wait_for_timeout(1200)
                        pg.screenshot(
                            path="%s/%s-%s-axis-%s.png" % (SHOTS, name, label, body)
                        )
                    for body in ("jupiter", "moon", "voyager1"):
                        pg.evaluate("(k) => _aePreset(k)", body)
                        pg.wait_for_function(
                            "() => !_ae.fly", timeout=60_000, polling=100
                        )
                        pg.wait_for_timeout(800)
                        pg.screenshot(
                            path="%s/%s-%s-card-%s.png" % (SHOTS, name, label, body)
                        )
                        pg.click("#ae-card-facts")
                        pg.wait_for_timeout(700)
                        pg.screenshot(
                            path="%s/%s-%s-sheet-%s.png" % (SHOTS, name, label, body)
                        )
                        pg.click("#ae-info-x")
                finally:
                    br.close()


def test_the_iss_label_is_only_its_name(page):
    """The age of the orbital data is not written on the Earth: the status line and the station's sheet carry it."""
    page.evaluate("_aePreset('earth'); _ae.dirty = true; _aeUpdate(_aeDisplayMs()); _aeUpdateLabels()")
    assert page.evaluate("document.querySelector('#ae-lbl-iss .ae-label-sub')") is None
    rows = sheet(page, "iss")
    if rows:   # the shipped orbital snapshot has put the station in view
        assert "data" in rows and "Orbital" not in rows["data"] and re.search(r"\d{4}", rows["data"]), rows
