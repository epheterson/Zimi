"""Landmarks on the Moon: named at their true places, a card each, and Fly there to the spot.

Eric, 2026-11-03: "I want to fly right to the moon landing spot". In headless Chromium at a phone's size: the Moon
view names the Apollo 11 site where the Sea of Tranquility is, its card offers Fly there, and the flight ends over
it, looking straight down, as near as the view allows.

Run: pytest tests/test_almanac_landmarks_browser.py -v
"""

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


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("lm")
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


LABELS = "() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden).map(b => b.textContent)"

APOLLO = {"Apollo 11", "Apollo 12", "Apollo 14", "Apollo 15", "Apollo 16", "Apollo 17"}


def test_fly_to_the_apollo_11_site(served):
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
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("openAlmanacEarth({ target: 'moon' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
                timeout=READY_MS,
                polling=200,
            )
            pg.evaluate("_aePreset('moon')")
            # Landmarks are off until turned on: the Moon names nothing, its landing sites included.
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeLm; }", timeout=60_000, polling=200)
            pg.wait_for_timeout(600)
            assert pg.evaluate(LABELS) == []
            # The pin turns them on, pressed and remembered on this device.
            pg.click("#ae-lm-btn")
            assert pg.evaluate("localStorage.getItem('zimi_alm_landmarks')") == "1"
            assert pg.get_attribute("#ae-lm-btn", "aria-pressed") == "true"
            # Seen from the Earth's side, the near side faces us: its landings are named.
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return ("
                + LABELS
                + ")().indexOf('Apollo 11') >= 0; }",
                timeout=60_000,
                polling=250,
            )
            labels = pg.evaluate(LABELS)
            assert len(labels) <= 18, labels
            assert (
                "Chang'e 4" not in labels
            ), "the far side's landing is behind the Moon"
            pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-lms .ae-lm')).find(b => b.textContent === 'Apollo 11').click()"
            )
            card = pg.inner_text("#ae-card")
            assert "Apollo 11" in card and "Landing site" in card, card
            pg.evaluate("_aeLmFly(_ae.lm.body, _ae.lm.row)")   # as Go to flies to a site (the card has no button for it)
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                timeout=30_000,
                polling=100,
            )
            # There: no way there any more, and the card is a small thing at the bottom (a quarter of the screen at most;
            # with the row under it, the view keeps most of the screen).
            assert not pg.query_selector("#ae-lm-fly")
            box = pg.evaluate("""() => { var c = document.getElementById('ae-card').getBoundingClientRect(), v = document.getElementById('ae-views').getBoundingClientRect(),
                t = document.getElementById('ae-clock'); return { card: c.height, top: Math.min(c.top, v.top), time: !!t && t.offsetParent !== null }; }""")
            assert box["card"] <= 0.25 * VIEW["height"] + 1, box
            assert box["top"] >= 0.6 * VIEW["height"], box
            assert not box["time"], box   # the time row steps aside while a card is open
            # Over the site, as near as allowed, the site at the middle of the screen.
            spot = pg.evaluate("""() => {
                var b = _aeLmBodies()[0], d = _aeLmDir(b, 0.67408, 23.47297);
                var p = [b.center[0] + d[0] * b.r, b.center[1] + d[1] * b.r, b.center[2] + d[2] * b.r];
                _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld();
                var s = _aeProject(p);
                return { x: s.x / _ae.w, y: s.y / _ae.h, dist: _ae.dist, min: AE_TARGETS.moon.min, target: _ae.target };
            }""")
            assert spot["target"] == "moon"
            assert spot["dist"] == pytest.approx(spot["min"], rel=1e-6)
            assert abs(spot["x"] - 0.5) < 0.03 and abs(spot["y"] - 0.5) < 0.03, spot
            # Off again, a landing site chosen in Go to: the flight there shows that one name and its card, alone.
            pg.evaluate("_aeLmSetLayer(false); _ae.lm = null; _aeRenderCard(); window._almReduceMotion = function () { return true; }; _aePreset('earth'); window._almReduceMotion = undefined;")
            pg.click("#ae-go-btn")
            pg.click("#ae-go .ae-go-row:has-text('Apollo 11')")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'moon' && (" + LABELS + ")().length > 0; }",
                timeout=60_000,
                polling=200,
            )
            assert "Apollo 11" in pg.evaluate(LABELS) and set(pg.evaluate(LABELS)) <= APOLLO
            assert "Apollo 11" in pg.inner_text("#ae-card")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_map_here_opens_the_map_at_the_place_below(served):
    """Close over the Earth, Map here hands over to an installed map, at the point under the middle of the screen."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE))
            pg = ctx.new_page()
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=READY_MS, polling=200)
            # No map installed: no button, however close.
            pg.evaluate("_ae.dist = 1.15; _aeUpdateText(_aeDisplayMs())")
            assert not pg.is_visible("#ae-map")
            # A map installed (stood in for here), over San Francisco, close in.
            pg.evaluate("""() => {
                window._installedMaps = () => [{ name: 'maps_test', main_path: 'index.html', title: 'Test map' }];
                window._lastMapVisit = () => null;
                window.__opened = null;
                window.openArticle = (zim, path, title, opts) => { window.__opened = { zim: zim, path: path, opts: opts }; };
                var a = _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(37.77, -122.42), _ae.scene.gast));
                _ae.az = a.az; _ae.el_ = a.el; _ae.dist = 1.15; _aePlaceCamera(); _aeUpdateText(_aeDisplayMs());
            }""")
            assert pg.is_visible("#ae-map")
            # Zoomed out to the whole Earth, it goes again.
            pg.evaluate("_ae.dist = 3; _aeUpdateText(_aeDisplayMs())")
            assert not pg.is_visible("#ae-map")
            pg.evaluate("_ae.dist = 1.15; _aePlaceCamera(); _aeUpdateText(_aeDisplayMs())")
            pg.click("#ae-map")
            got = pg.evaluate("window.__opened")
            assert got["zim"] == "maps_test" and got["path"] == "index.html", got
            zoom, lat, lon = (float(x) for x in got["opts"]["pos"].split("=")[1].split("/"))
            assert abs(lat - 37.77) < 0.5 and abs(lon + 122.42) < 0.5, got
            assert 4 <= zoom <= 9, zoom
            ctx.close()
        finally:
            br.close()
