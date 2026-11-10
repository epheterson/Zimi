"""One sky: the live sky card and Stand here draw the same sky (almanac-onesky.js, almanac-oneair.js), in headless Chromium at a phone's size.

The card (AlmanacSkyView, almanac-skygl.js) and the ground view on the Earth (almanac-stand.js, with the card's air from
almanac-oneair.js) are put at one place, one instant and one heading, and the sky's colour is read at a grid of directions
(altitude 15 to 65 degrees, 20 degrees either side of the heading) with the Sun at 35, 3, -6, -12 and -18 degrees: day, sunset,
civil twilight, nautical and astronomical night. The median colour of each view must agree, by channel, within a tolerance, and
the tolerance is the point: before the card's air was given to the ground view it was 30 percent too warm by day and five times
too dark at night.

Run: pytest tests/test_almanac_onesky_browser.py -v
"""

import base64
import io
import json
import os
import sys
import threading
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
LAT, LON = 40.71, -74.0  # New York
PLACE = json.dumps({"lat": LAT, "lon": LON, "name": "New York"})
DAY = "2026-09-11"
SUN_ALTS = [35, 3, -6, -12, -18]
HEADING, PITCH = 90.0, 35.0
SAMPLE_DIRS = [
    (HEADING + da, al) for da in (-20, 0, 20) for al in (15, 25, 35, 45, 55, 65)
]
# The median stand/card ratio of each channel: close to 1 by day and at dusk; at night the card's own dither and the display's rounding
# are a good part of ten levels, so the night is compared in levels, not in ratio.
DAY_RATIO = (0.88, 1.14)
NIGHT_LEVELS = 3.0
READY_MS = 240_000


def _ms(iso):
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


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

    tmp = tmp_path_factory.mktemp("onesky")
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
def browser(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


def _context(browser):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=1,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        "DeviceOrientationEvent.requestPermission = function () { return Promise.resolve('granted'); };"
        % (PLACE, PLACE)
    )
    return ctx


def _medians(png, points):
    import numpy as np
    from PIL import Image

    im = np.asarray(Image.open(io.BytesIO(png)).convert("RGB")).astype(float)
    out = []
    for x, y in points:
        x, y = int(round(x)), int(round(y))
        if 4 <= x < im.shape[1] - 4 and 4 <= y < im.shape[0] - 4:
            out.append(im[y - 3 : y + 4, x - 3 : x + 4].reshape(-1, 3))
    return np.median(np.concatenate(out), axis=0), len(out)


@pytest.fixture(scope="module")
def times(browser, served):
    ctx = _context(browser)
    pg = ctx.new_page()
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyEphemeris === 'function' && typeof _jdToJulianCentury === 'function'",
        timeout=120_000,
    )
    out = {}
    for a in SUN_ALTS:
        out[a] = pg.evaluate(
            """([day, lat, lon, target]) => {
              const alt = ms => _skyEphemeris(new Date(ms), lat, lon).sunGeoAlt;
              let lo = Date.parse(day + 'T17:00:00Z'), hi = Date.parse(day + 'T23:59:00Z');
              for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (alt(m) > target) lo = m; else hi = m; }
              return Math.round(lo); }""",
            [DAY, LAT, LON, a],
        )
    ctx.close()
    return out


@pytest.fixture(scope="module")
def card(browser, served, times):
    ctx = _context(browser)
    pg = ctx.new_page()
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof AlmanacSkyView !== 'undefined' && _skyState && _skyState.eph",
        timeout=120_000,
    )
    pg.evaluate(
        "() => { const h = document.createElement('div'); h.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000'; document.body.appendChild(h); window._osh = h; }"
    )
    out = {}
    for sa, ms in times.items():
        pg.evaluate(
            "(ms) => { _almClockSetRate(0); _almScrubSettle(new Date(ms)); }", ms
        )
        pg.wait_for_timeout(500)
        pg.evaluate(
            "([la, lo, az, alt]) => { AlmanacSkyView.mount(_osh, { lat: la, lon: lo, name: '' }); AlmanacSkyView.setView(_osh, az, alt, 70); }",
            [LAT, LON, HEADING, PITCH],
        )
        pg.wait_for_function(
            "() => _sgReady() && _sg.starCount === 9096 && _sg.mwReady",
            timeout=60_000,
            polling=250,
        )
        pg.wait_for_timeout(1500)
        pts = pg.evaluate(
            "(ds) => ds.map(([az, alt]) => { const p = AlmanacSkyView.screenOf(_osh, az, alt); return [p.x, p.y]; })",
            SAMPLE_DIRS,
        )
        out[sa] = _medians(pg.screenshot(), pts)
        pg.evaluate("() => AlmanacSkyView.unmount(_osh)")
    ctx.close()
    return out


@pytest.fixture(scope="module")
def stand(browser, served, times):
    ctx = _context(browser)
    pg = ctx.new_page()
    pg.warnings = []
    pg.on(
        "console",
        lambda m: (
            pg.warnings.append(m.text) if m.type in ("error", "warning") else None
        ),
    )
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
        timeout=READY_MS,
        polling=250,
    )
    pg.evaluate("([la, lo]) => _aeStandAt('earth', la, lo)", [LAT, LON])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground' && _ae.stand.fr",
        timeout=READY_MS,
        polling=250,
    )
    pg.wait_for_timeout(1500)
    pg.air_on = pg.evaluate("() => !!_ae.stand.airOn")
    out = {}
    for sa, ms in times.items():
        pg.evaluate(
            """([ms, head, pitch]) => { _aeGoTo(ms); const st = _ae.stand; st.userYaw = head * Math.PI / 180 - st.yaw;
              st.userPitch = pitch * Math.PI / 180 - _aeRad(AE_STAND_PITCH_DEG); st.dirty = true; st.fr = null; _ae.dirty = true; _aeKick(); }""",
            [ms, HEADING, PITCH],
        )
        pg.wait_for_timeout(2500)
        pts = pg.evaluate(
            """(ds) => { const st = _ae.stand, V = _ae.gl.THREE.Vector3;
              return ds.map(([az, alt]) => { const d = _aeStandSkyDir(az, alt); const p = new V(d[0] * 1e4, d[1] * 1e4, d[2] * 1e4).project(st.camera); return [(p.x + 1) / 2 * _ae.w, (1 - p.y) / 2 * _ae.h]; }); }""",
            SAMPLE_DIRS,
        )
        data = pg.evaluate(
            "() => { const st = _ae.stand; _ae.gl.renderer.render(st.scene, st.camera); return _ae.gl.renderer.domElement.toDataURL('image/png'); }"
        )
        out[sa] = _medians(base64.b64decode(data.split(",")[1]), pts)
        out[("amb", sa)] = pg.evaluate(
            "() => _aeStandAir.ambient(_ae.stand, _ae.stand.fr)"
        )
    out["air_on"] = pg.air_on
    out["warnings"] = pg.warnings
    ctx.close()
    return out


def test_the_ground_view_is_drawn_with_the_cards_air(stand):
    """The provider built (it needs half-float targets and the card's shader text) and the sky pass uses it; a failed build falls back silently."""
    assert stand["air_on"], stand["warnings"][-5:]
    assert not [w for w in stand["warnings"] if "oneair" in w], stand["warnings"]


@pytest.mark.parametrize("sun", [35, 3, -6])
def test_by_day_and_through_dusk_the_two_skies_have_one_colour(card, stand, sun):
    """Day, sunset and civil twilight: the median colour agrees per channel within the tolerance."""
    c, n_c = card[sun]
    s, n_s = stand[sun]
    assert n_c >= 6 and n_s >= 6, (n_c, n_s)
    for k, name in enumerate("RGB"):
        ratio = (s[k] + 1) / (c[k] + 1)
        assert (
            DAY_RATIO[0] <= ratio <= DAY_RATIO[1]
        ), "sun %+d %s: card %.1f stand %.1f" % (sun, name, c[k], s[k])


@pytest.mark.parametrize("sun", [-12, -18])
def test_at_night_the_two_skies_are_as_dark_as_each_other(card, stand, sun):
    """Nautical and astronomical night: within a few levels of 255 (the sky's glow and airglow, the eye's exposure)."""
    c, _ = card[sun]
    s, _ = stand[sun]
    for k, name in enumerate("RGB"):
        assert abs(s[k] - c[k]) <= NIGHT_LEVELS, "sun %+d %s: card %.1f stand %.1f" % (
            sun,
            name,
            c[k],
            s[k],
        )


def test_one_tap_from_the_card_stands_at_its_place_instant_and_facing_and_back_returns(
    browser, served, times
):
    """The card's Stand here button opens the ground view at the Almanac's place, at the instant the card shows, facing the way its
    panorama faces; the view's own way back closes it and the card is where it was."""
    ctx = _context(browser)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph && typeof _osStandHere === 'function' && typeof _jdToJulianCentury === 'function'",
        timeout=120_000,
    )
    ms = times[3]
    pg.evaluate(
        "(ms) => { _almClockSetRate(0); _almScrubSettle(new Date(ms)); document.querySelector('.almanac-sky-wrap').scrollIntoView({ behavior: 'instant', block: 'center' }); }",
        ms,
    )
    pg.wait_for_function(
        "(t) => _skyState && _skyState.nowTime === t && !_skyState.moonAnim",
        arg=ms,
        timeout=60_000,
        polling=200,
    )
    center = pg.evaluate("() => _skyState.center")
    y = pg.evaluate("() => Math.round(window.pageYOffset)")
    assert pg.query_selector(".alm-sky-bar .alm-sky-stand"), "the button is on the card"
    pg.click(".alm-sky-bar .alm-sky-stand")
    assert pg.query_selector("canvas.os-still"), "the card's picture is held over the view while it opens"
    pg.wait_for_function(
        "() => typeof _ae !== 'undefined' && _ae && _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=READY_MS,
        polling=250,
    )
    pg.wait_for_function(
        "() => !document.querySelector('canvas.os-still')", timeout=15_000, polling=250
    )
    assert pg.evaluate("() => _ae.stand.handoff.direct === true"), "no flight down from the globe"
    got = pg.evaluate(
        """() => { const st = _ae.stand, head = (((st.yaw + st.userYaw) * 180 / Math.PI) % 360 + 360) % 360; return { lat: st.lat, lon: st.lon, ms: _aeDisplayMs(), head: head, key: st.key }; }"""
    )
    assert got["key"] == "earth"
    assert abs(got["lat"] - LAT) < 1e-3 and abs(got["lon"] - LON) < 1e-3, got
    assert abs(got["ms"] - ms) < 120_000, got["ms"] - ms
    diff = abs(((got["head"] - center) + 540) % 360 - 180)
    assert diff < 2, (got["head"], center)
    pg.evaluate("() => _aeStandClose()")
    pg.wait_for_function(
        "() => !_ae.stand && !_ae.standPending && !_aeIsOpen",
        timeout=60_000,
        polling=250,
    )
    assert abs(pg.evaluate("() => Math.round(window.pageYOffset)") - y) <= 2
    assert not errors, errors
    ctx.close()


def test_the_air_gives_the_ground_its_light_at_every_sun_height(stand):
    """provider.ambient: three radiances (the ground's light from above, the horizon, the zenith) in the view's units, finite at every
    Sun height; a hundred times brighter by day than at night, and the zenith bluer than the horizon by day.
    """
    import math

    for sa in SUN_ALTS:
        a = stand[("amb", sa)]
        assert a and set(a) == {"amb", "horizon", "zenith"}, (sa, a)
        assert all(math.isfinite(x) and x >= 0 for k in a for x in a[k]), (sa, a)
    lum = lambda rgb: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    assert lum(stand[("amb", 35)]["amb"]) > 100 * lum(stand[("amb", -18)]["amb"])
    day = stand[("amb", 35)]
    assert day["zenith"][2] / day["zenith"][0] > day["horizon"][2] / day["horizon"][0]


FOREGROUNDS = [
    ("Freudenstadt", 48.46, 8.41, "conifer"),
    ("Salina", 38.84, -97.61, "grass"),
    ("Ghat", 25.0, 10.0, "desert"),
    ("Greenland", 72.0, -40.0, "snow"),
    ("Tiksi", 71.6, 128.9, "tundra"),  # a tundra shore is tundra, not a beach
    ("Cairo", 30.04, 31.24, "desert"),  # the Nile valley in a dry cell
    ("McMurdo", -77.85, 166.67, "snow"),  # an ice shore, not a beach
    ("Lisbon", 38.72, -9.14, "beach"),
    ("Sydney", -33.87, 151.21, "beach"),
]


@pytest.mark.parametrize(
    "name,lat,lon,scene", FOREGROUNDS, ids=[f[0] for f in FOREGROUNDS]
)
def test_the_cards_foreground_is_the_places_own_land(
    browser, served, name, lat, lon, scene
):
    """Forest, grass, desert and snow where the one grid says so; the sea only where it says there is a coast."""
    place = json.dumps({"lat": lat, "lon": lon, "name": name})
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=1,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); } catch (e) {}" % place
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph && _skyState.land",
        timeout=120_000,
        polling=250,
    )
    assert pg.evaluate("() => _osCardScene(_skyState)") == scene
    assert not errors, errors
    ctx.close()


def test_the_card_is_a_plain_horizon_until_the_grid_is_in_and_stays_so_without_it(
    browser, served
):
    """Never the palms by default: with the grid unreachable the card paints a plain horizon, quietly, and does not ask again and again."""
    place = json.dumps({"lat": 36.7, "lon": -4.4, "name": "Malaga"})
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=1,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); localStorage.removeItem('zimi_sky_land'); } catch (e) {}"
        % place
    )
    asked = []
    ctx.route("**/landcover-v1.bin", lambda route: (asked.append(1), route.abort())[1])
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
        timeout=120_000,
    )
    pg.wait_for_timeout(4000)
    assert pg.evaluate("() => _osCardScene(_skyState)") == "plain"
    assert not pg.evaluate("() => !!_skyState.land")
    assert len(asked) <= 1, asked
    assert not errors, errors
    ctx.close()


def _cloud_change(png_with, png_without):
    """How much the whole picture changes, in levels, when the deck is taken away (at night the sky is dark either way: a cloud is a few levels)."""
    import numpy as np
    from PIL import Image

    a = np.asarray(Image.open(io.BytesIO(png_with)).convert("RGB")).astype(float)
    b = np.asarray(Image.open(io.BytesIO(png_without)).convert("RGB")).astype(float)
    return float(np.abs(a - b).mean())


CLOUD_PLACE = {"lat": 40.015, "lon": -105.27, "name": "Boulder"}
CLOUD_MS = 1782075600000  # 2026-06-21 21:00 UTC, 3 PM there: a partly cloudy deck
CLOUD_DIRS = [(180 + da, al) for da in (-25, 0, 25) for al in (25, 40, 55)]
CLOUD_DIFF_LEVELS = 12.0


def _cloudy(png_with, png_without, points, levels):
    """Per point, whether the picture with the deck differs from the one without it by more than the threshold."""
    import numpy as np
    from PIL import Image

    a = np.asarray(Image.open(io.BytesIO(png_with)).convert("RGB")).astype(float)
    b = np.asarray(Image.open(io.BytesIO(png_without)).convert("RGB")).astype(float)
    out = []
    for x, y in points:
        x, y = int(round(x)), int(round(y))
        if not (4 <= x < a.shape[1] - 4 and 4 <= y < a.shape[0] - 4):
            out.append(None)
            continue
        out.append(
            float(
                np.abs(
                    a[y - 3 : y + 4, x - 3 : x + 4] - b[y - 3 : y + 4, x - 3 : x + 4]
                ).mean()
            )
            > levels
        )
    return out


CLOUD_SCENES = [
    # (id, place, instant, the difference with and without the deck that counts as cloud (levels), whether the day shows both cloud and clear sky)
    ("boulder_3pm", CLOUD_PLACE, CLOUD_MS, 12.0, True),
    (
        "black_forest_noon_heavy",
        {"lat": 47.8, "lon": 8.2, "name": "Black Forest"},
        1790076432000,
        12.0,
        False,
    ),
    (
        "black_forest_night_heavy",
        {"lat": 47.8, "lon": 8.2, "name": "Black Forest"},
        1790104570890,
        3.0,
        False,
    ),
]


@pytest.mark.parametrize(
    "scene,cplace,cms,levels,mixed", CLOUD_SCENES, ids=[c[0] for c in CLOUD_SCENES]
)
def test_the_card_and_the_ground_view_draw_the_same_cloud_field(
    browser, served, scene, cplace, cms, levels, mixed
):
    """One field, one shader: at one place, instant and facing, the directions where the deck is (the picture with it differs from the
    picture without it) are the directions in both views."""
    place = json.dumps(cplace)
    clear = "() => { const f = window.__realField || (window.__realField = _osCloudField); window._osCloudField = (d) => Object.assign(f(d), { coverage: 0 }); }"
    real = (
        "() => { if (window.__realField) window._osCloudField = window.__realField; }"
    )

    def context():
        c = browser.new_context(
            viewport=VIEW,
            device_scale_factor=1,
            has_touch=True,
            is_mobile=True,
            service_workers="block",
        )
        c.add_init_script(
            "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
            % (place, place)
        )
        return c

    # The card, through the look-around host.
    ctx = context()
    pg = ctx.new_page()
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof AlmanacSkyView !== 'undefined' && _skyState && _skyState.eph && typeof _jdToJulianCentury === 'function'",
        timeout=120_000,
    )
    pg.evaluate(
        "() => { const h = document.createElement('div'); h.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000'; document.body.appendChild(h); window._osh = h; }"
    )
    pg.evaluate("(ms) => { _almClockSetRate(0); _almScrubSettle(new Date(ms)); }", cms)
    pg.wait_for_timeout(500)

    def card_shot():
        pg.evaluate(
            "([la, lo, az, alt]) => { AlmanacSkyView.unmount(_osh); AlmanacSkyView.mount(_osh, { lat: la, lon: lo, name: '' }); AlmanacSkyView.setView(_osh, az, alt, 70); }",
            [cplace["lat"], cplace["lon"], 180, 40],
        )
        pg.wait_for_function(
            "() => _sgReady() && _sg.starCount === 9096 && _sg.mwReady",
            timeout=60_000,
            polling=250,
        )
        pg.wait_for_timeout(1200)
        return pg.screenshot()

    with_clouds = card_shot()
    pts = pg.evaluate(
        "(ds) => ds.map(([az, alt]) => { const p = AlmanacSkyView.screenOf(_osh, az, alt); return [p.x, p.y]; })",
        CLOUD_DIRS,
    )
    pg.evaluate(clear)
    without = card_shot()
    card_mask = _cloudy(with_clouds, without, pts, levels)
    card_change = _cloud_change(with_clouds, without)
    ctx.close()

    # The ground view.
    ctx = context()
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
        polling=250,
    )
    pg.evaluate(
        "([la, lo]) => _aeStandAt('earth', la, lo)",
        [cplace["lat"], cplace["lon"]],
    )
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground' && _ae.stand.fr",
        timeout=READY_MS,
        polling=250,
    )

    def stand_shot():
        pg.evaluate(
            """([ms, head, pitch]) => { _aeGoTo(ms); const st = _ae.stand; st.userYaw = head * Math.PI / 180 - st.yaw;
              st.userPitch = pitch * Math.PI / 180 - _aeRad(AE_STAND_PITCH_DEG); st.dirty = true; st.fr = null; _ae.dirty = true; _aeKick(); }""",
            [cms, 180, 40],
        )
        pg.wait_for_timeout(3000)
        data = pg.evaluate(
            "() => { const st = _ae.stand; _ae.gl.renderer.render(st.scene, st.camera); return _ae.gl.renderer.domElement.toDataURL('image/png'); }"
        )
        return base64.b64decode(data.split(",")[1])

    with_clouds = stand_shot()
    pts = pg.evaluate(
        """(ds) => { const st = _ae.stand, V = _ae.gl.THREE.Vector3;
          return ds.map(([az, alt]) => { const d = _aeStandSkyDir(az, alt); const p = new V(d[0] * 1e4, d[1] * 1e4, d[2] * 1e4).project(st.camera); return [(p.x + 1) / 2 * _ae.w, (1 - p.y) / 2 * _ae.h]; }); }""",
        CLOUD_DIRS,
    )
    pg.evaluate(clear)
    without = stand_shot()
    stand_mask = _cloudy(with_clouds, without, pts, levels)
    stand_change = _cloud_change(with_clouds, without)
    ctx.close()

    if (
        levels < 5
    ):  # night: the views are compared by how much of the picture the deck is
        assert card_change > 1.0 and stand_change > 1.0, (card_change, stand_change)
        assert 0.2 < card_change / stand_change < 5.0, (card_change, stand_change)
        return
    both = [
        (a, b) for a, b in zip(card_mask, stand_mask) if a is not None and b is not None
    ]
    assert len(both) >= 7, (card_mask, stand_mask)
    if mixed:
        assert any(a for a, _ in both) and not all(a for a, _ in both), (
            "the day shows both cloud and clear sky",
            card_mask,
            stand_mask,
        )
    else:  # a heavy day: the field says cloud nearly everywhere, and both views must draw it
        assert sum(1 for a, _ in both if a) >= len(both) - 2, ("card", card_mask)
        assert sum(1 for _, b in both if b) >= len(both) - 2, ("stand", stand_mask)
    agree = sum(1 for a, b in both if a == b)
    assert agree >= len(both) - 1, (card_mask, stand_mask)


def test_look_goes_down_to_the_ground_facing_the_same_way_and_comes_back(
    browser, served
):
    """Look's ground button opens Stand here at its place, at the page's instant, facing where Look faced; Stand's way back opens Look again."""
    ctx = _context(browser)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacLook === 'function' && typeof _skyState !== 'undefined' && _skyState && _skyState.eph && typeof _jdToJulianCentury === 'function'",
        timeout=120_000,
    )
    pg.evaluate("() => openAlmanacLook()")
    pg.wait_for_function(
        "() => !!document.getElementById('look-stand') && !!_look && _look.skyMounted",
        timeout=60_000,
    )
    pg.evaluate(
        "() => { _look.target = { az: 130, alt: 25, roll: 0 }; _look.view = { az: 130, alt: 25, roll: 0 }; }"
    )
    pg.click("#look-stand")
    pg.wait_for_function(
        "() => typeof _ae !== 'undefined' && _ae && _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=READY_MS,
        polling=250,
    )
    assert pg.evaluate("() => !_look"), "Look is closed while the ground is open"
    head = pg.evaluate(
        "() => (((_ae.stand.yaw + _ae.stand.userYaw) * 180 / Math.PI) % 360 + 360) % 360"
    )
    assert abs(((head - 130) + 540) % 360 - 180) < 2, head
    pg.evaluate("() => _aeStandClose()")
    pg.wait_for_function("() => !!_look", timeout=60_000, polling=250)
    assert not errors, errors
    ctx.close()


def test_without_webgl2_the_there_and_then_list_stands_and_the_ground_buttons_do_not(
    browser, served
):
    """No WebGL2: the card shows no Stand here button, There and then opens its list over the page (not a dead black 3D view), and an entry
    shows its facts with the ground button off and one short line saying why."""
    ctx = _context(browser)
    ctx.add_init_script(
        "(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t) {"
        " return /webgl/.test(t) ? null : g.apply(this, arguments); }; })();"
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph && typeof openAlmanacThens === 'function'",
        timeout=120_000,
    )
    pg.wait_for_function(
        "() => document.querySelector('.alm-sky-stand') && document.querySelector('.alm-sky-stand').hidden === true",
        timeout=30_000,
        polling=250,
    )
    pg.evaluate(
        "() => document.querySelector('.alm-sky-then').scrollIntoView({ block: 'center' })"
    )
    pg.click(".alm-sky-then")
    pg.wait_for_function(
        "() => document.querySelectorAll('.al-sheet .at-row').length > 3",
        timeout=60_000,
        polling=250,
    )
    assert not pg.evaluate(
        "() => typeof _aeIsOpen !== 'undefined' && _aeIsOpen"
    ), "the 3D view did not open"
    pg.click(".al-sheet .at-row")
    pg.wait_for_function("() => !!document.getElementById('at-no3d')", timeout=30_000)
    assert pg.evaluate("() => document.getElementById('at-stand').disabled")
    assert pg.evaluate(
        "() => document.querySelector('.al-sheet .al-facts li') !== null"
    )
    assert not errors, errors
    ctx.close()


def test_in_totality_the_sky_is_deep_twilight_and_venus_and_jupiter_are_drawn(
    browser, served
):
    """Kerrville, 8 April 2024, mid-totality: the faintest star shown is about +3, and Venus (west of the Sun) and Jupiter (east) are
    each a visible point in the ground view against the sky round them."""
    import numpy as np
    from PIL import Image

    ctx = _context(browser)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _aeStandOpen === 'function' && typeof _osEclipse === 'function' && typeof _jdToJulianCentury === 'function'",
        timeout=120_000,
    )
    ms = _ms("2024-04-08T18:34:50")
    pg.evaluate(
        "(ms) => _aeStandOpen({ body: 'earth', lat: 30.0474, lon: -99.1403, ms: ms, heading: 180, pitch: 20, clouds: 'clear', direct: true })",
        ms,
    )
    pg.wait_for_function(
        "() => _ae && _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground' && _ae.stand.fr && _ae.stand.photo",
        timeout=READY_MS,
        polling=250,
    )
    pg.wait_for_function(
        "(ms) => Math.abs(_aeDisplayMs() - ms) < 5000 && _ae.stand.photo && _ae.stand.photo.lim > 2.4",
        arg=ms,
        timeout=60_000,
        polling=250,
    )
    lim = pg.evaluate("() => _ae.stand.photo.lim")
    assert 2.4 < lim < 3.4, lim
    for planet in ("venus", "jupiter"):
        found = pg.evaluate(
            """(name) => { const st = _ae.stand, o = st.fr.objs.find(x => x.key === name);
              if (!o) return null;
              const az = Math.atan2(o.dir[0], o.dir[1]) * 180 / Math.PI, alt = Math.asin(o.dir[2]) * 180 / Math.PI;
              st.userYaw = az * Math.PI / 180 - st.yaw; st.userPitch = alt * Math.PI / 180 - _aeRad(AE_STAND_PITCH_DEG);
              st.dirty = true; st.fr = null; _ae.dirty = true; _aeKick();
              return { mag: o.mag, az: az, alt: alt }; }""",
            planet,
        )
        assert found and found["mag"] < lim and found["alt"] > 5, (planet, found)
        pg.wait_for_function(
            "() => _ae.stand.fr && _ae.stand.photo", timeout=60_000, polling=250
        )
        pg.wait_for_timeout(1500)
        xy = pg.evaluate(
            """(name) => { const V = _ae.gl.THREE.Vector3, st = _ae.stand, o = st.fr.objs.find(x => x.key === name), p = new V(o.dir[0] * 10, o.dir[1] * 10, o.dir[2] * 10).project(st.camera);
              const r = _ae.gl.renderer.domElement.getBoundingClientRect();
              return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; }""",
            planet,
        )
        img = np.asarray(
            Image.open(io.BytesIO(pg.screenshot())).convert("L")
        ).astype(float)
        x, y = int(round(xy[0])), int(round(xy[1]))
        core = img[max(0, y - 4) : y + 5, max(0, x - 4) : x + 5].max()
        ring = np.median(img[max(0, y - 30) : y + 31, max(0, x - 30) : x + 31])
        assert core > ring + 8, (planet, xy, core, ring)
    assert not errors, errors
    ctx.close()
