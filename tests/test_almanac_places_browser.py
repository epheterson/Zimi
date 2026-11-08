"""Go to by name in the 3D view: type a town or a landmark, fly down over it, and read its article.

Eric, 2026-11-07: "I should be able to use these places to fly to any city or landmark on the globe and link those to
article content with rich previews." In headless Chromium at a phone's size, with a library of a Kiwix map's towns and a
Wikipedia: Go to has a search field; "Paris" offers the towns of that name (and no landmark); picking one turns the Earth
to it and brings the camera down over its latitude and longitude, drops a marker, and the card previews the article that
says it stands there (Paris, France's, not Paris, Texas's: that one has no article here); a tap opens it. A landmark is
offered with the towns and its card links its article by its Q-ID. With no map installed the landmarks alone answer and
nothing else is said.

Run: pytest tests/test_almanac_places_browser.py -v
"""

import math
import os
import sys
import threading

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
PARIS = (48.857, 2.352)
TEXAS = (33.66, -95.56)
EVEREST = (27.9881, 86.925)
MAX_OFF_DEG = 3  # the camera stands over the place within this many degrees


def _serve(root, with_map):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi import mapplaces
    from zimi.http import ZimHandler

    zdir = root / "zims"
    zdir.mkdir()
    (root / "data").mkdir()
    import wiki_fixture

    wiki_fixture.build_library(str(zdir))
    if with_map:
        from conftest_zim import build_fixture_zim
        from test_place_autocomplete import NAME, _map_files

        build_fixture_zim(
            str(zdir / f"{NAME}.zim"),
            {"Scraper": "maps2zim v0.2.1"},
            files=_map_files(),
        )
    saved = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(zdir), str(root / "data")
    mapplaces._reset_for_tests()
    srv.load_cache(force=True)
    if with_map:
        mapplaces.build_all()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, saved


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    # Offline and no torrents for this module's server only: set for the session, they turned later modules' download
    # and catalog tests offline on the same worker.
    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    import zimi.server as srv
    from zimi import mapplaces

    httpd, saved = _serve(tmp_path_factory.mktemp("places_lib"), True)
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = saved
    mapplaces._reset_for_tests()
    env.undo()


@pytest.fixture(scope="module")
def no_map(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    # Offline and no torrents for this module's server only: set for the session, they turned later modules' download
    # and catalog tests offline on the same worker.
    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    import zimi.server as srv
    from zimi import mapplaces

    httpd, saved = _serve(tmp_path_factory.mktemp("places_nomap"), False)
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = saved
    mapplaces._reset_for_tests()
    env.undo()


def _open(browser, base, view=VIEW):
    ctx = browser.new_context(
        viewport=view,
        device_scale_factor=2 if view["width"] < 600 else 1,
        has_touch=view["width"] < 600,
        is_mobile=view["width"] < 600,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (PLACE, PLACE)
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base + "/#almanac", wait_until="load")
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
    return ctx, pg, errors


def _type(pg, text):
    pg.click("#ae-go-btn")
    pg.wait_for_selector("#ae-go-q", state="visible")
    pg.wait_for_function("() => !!_aeLm", timeout=60_000)
    pg.fill("#ae-go-q", text)


def _rows(pg):
    return pg.evaluate(
        "() => Array.from(document.querySelectorAll('#ae-go-found .ae-go-row')).map(b => b.textContent)"
    )


def _landed(pg):
    pg.wait_for_function(
        "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
        timeout=90_000,
        polling=200,
    )


def _camera_off_deg(pg, lat, lng):
    """How far, in degrees, the point under the camera is from (lat, lng)."""
    got = pg.evaluate(
        """() => { _ae.dirty = true; _aePlaceCamera(); var c = _ae.gl.camera.position;
        return _aeFixedToGeodeticDirection(_aeSceneToFixed([c.x, c.y, c.z], _ae.scene.gast)); }"""
    )
    a, b = math.radians(got["lat"]), math.radians(lat)
    d = math.acos(
        max(
            -1.0,
            min(
                1.0,
                math.sin(a) * math.sin(b)
                + math.cos(a) * math.cos(b) * math.cos(math.radians(got["lon"] - lng)),
            ),
        )
    )
    return math.degrees(d)


def test_go_to_a_town_flies_over_it_and_its_card_previews_its_article(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library)
            _type(pg, "Paris")
            pg.wait_for_function(
                "() => document.querySelectorAll('#ae-go-found .ae-go-row').length >= 2",
                timeout=30_000,
            )
            rows = _rows(pg)
            # The larger Paris first, with where it is; the other after it.
            assert "France" in rows[0] and "Texas" in rows[1], rows
            # The groups give way while something is typed.
            assert pg.evaluate("document.getElementById('ae-go-groups').hidden")
            pg.click("#ae-go-found .ae-go-row:nth-child(1)")
            _landed(pg)
            assert _camera_off_deg(pg, *PARIS) < MAX_OFF_DEG
            assert pg.evaluate("_ae.target") == "earth"
            # Its marker stands on the globe, named.
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); var l = document.getElementById('ae-lbl-place'); return !l.hidden && l.textContent === 'Paris'; }",
                timeout=30_000,
                polling=200,
            )
            # The card previews the article that says it stands there.
            pg.wait_for_selector("#ae-card [data-ae-place-open]", timeout=30_000)
            card = pg.inner_text("#ae-card")
            assert (
                "Paris" in card and "capital and largest city of France" in card
            ), card
            pg.evaluate(
                "window.__opened = null; AlmanacLinks.openHit = function (h) { window.__opened = h; }"
            )
            pg.click("#ae-card .ae-place-preview")
            opened = pg.evaluate("window.__opened")
            assert opened["path"] == "Paris" and opened["zim"] == "wikipedia", opened
            # The flight stops where the Earth's picture ends; Map here goes on, to the town itself in the map.
            pg.wait_for_selector("#ae-maprow:not([hidden])", timeout=30_000)
            pg.evaluate(
                "window.__opened = null; AlmanacLinks.openHit = function (h, o) { window.__opened = { hit: h, opts: o }; }"
            )
            pg.click("#ae-map")
            opened = pg.evaluate("window.__opened")
            assert opened["opts"]["pos"] == pg.evaluate(
                "mapPositionHash(AE_MAP_PLACE_ZOOM, _ae.place.lat, _ae.place.lon)"
            ) and opened["hit"]["zim"] == "maps_en_places", opened
            # Paris, Texas: flown to, and Paris, France's page is not its article.
            _type(pg, "Paris")
            pg.wait_for_function(
                "() => document.querySelectorAll('#ae-go-found .ae-go-row').length >= 2",
                timeout=30_000,
            )
            pg.click("#ae-go-found .ae-go-row:nth-child(2)")
            _landed(pg)
            assert _camera_off_deg(pg, *TEXAS) < MAX_OFF_DEG
            pg.wait_for_function(
                "() => _ae.place && _ae.place.article === false", timeout=30_000
            )
            assert not pg.query_selector("#ae-card [data-ae-place-open]")
            assert "Texas" in pg.inner_text("#ae-card")
            # Another place put the marker away.
            pg.click("#ae-views [data-ae-view='moon']")
            assert pg.evaluate("_ae.place") is None
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_landmark_is_offered_with_the_towns_and_its_card_links_its_article(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library)
            # The Almanac's own links resolve a Q-ID to the library's article: here, to a page this library has.
            pg.evaluate(
                """() => { AlmanacLinks.resolve = function (qids) { var out = {};
                  qids.forEach(function (q) { if (q === 'Q513') out[q] = { zim: 'wikipedia', path: 'Physics', title: 'Physics' }; });
                  return Promise.resolve(out); }; }"""
            )
            _type(pg, "Everest")
            assert _rows(pg) == ["Mount Everest"], _rows(pg)
            pg.keyboard.press("Enter")  # the first row, from the keyboard
            _landed(pg)
            assert _camera_off_deg(pg, *EVEREST) < MAX_OFF_DEG
            pg.wait_for_selector("#ae-card [data-ae-place-open]", timeout=30_000)
            assert "Physics" in pg.inner_text("#ae-card")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_with_no_map_installed_the_landmarks_answer_and_nothing_else_is_said(no_map):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, no_map)
            _type(pg, "Mont")
            pg.wait_for_function(
                "() => document.querySelectorAll('#ae-go-found .ae-go-row').length > 0",
                timeout=30_000,
            )
            assert _rows(pg) == ["Mont Blanc"], _rows(pg)
            # A town of a map: no answer, and no word about it (the sheet is the field and its rows).
            pg.fill("#ae-go-q", "Paris")
            pg.wait_for_timeout(800)
            assert _rows(pg) == []
            words = pg.evaluate(
                "() => document.getElementById('ae-go').innerText.trim()"
            )
            assert words == "", words
            pg.fill("#ae-go-q", "Mont Blanc")
            pg.click("#ae-go-found .ae-go-row")
            _landed(pg)
            assert _camera_off_deg(pg, 45.8326, 6.8652) < MAX_OFF_DEG
            # No map to open: no Map here.
            assert pg.evaluate("document.getElementById('ae-maprow').hidden")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
