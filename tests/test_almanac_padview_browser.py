"""Stand at the pad: the launch pad view (zimi/static/almanac-padview.js) in the Almanac's 3D Earth.

The view loads only when asked for (opening the Earth requests none of its files); a mission's launch phase has the chip, the chip stands the person
at the pad at T minus 30 s with the count on screen, the vehicle is on screen and above the pad after the tower is cleared, the Back arrow names where it
goes and returns to the mission, and nothing in the page throws. A light device draws the flames and no cloud.

Run: pytest tests/test_almanac_padview_browser.py -v   (run on the Mac mini: heavy.sh ../venv/bin/python -m pytest -p no:xdist ...)
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
PAD_FILE = "almanac-padview.js"
MIN_DRAWN_PX = 12  # the vehicle, or its glint far up, is at least this long on the screen (CSS pixels)
MIN_RISE_M = 150  # the middle of the vehicle this far over the ground three seconds after the tower is cleared
BENIGN_ERRORS = (
    "Failed to load resource",
)  # the Almanac HD index asked for and not there, the favicon


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("pad")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    httpd = None
    try:
        srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
        srv.load_cache(force=True)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        yield "http://127.0.0.1:%d" % httpd.server_address[1]
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _page(br, served, requests=None, errors=None):
    ctx = br.new_context(
        viewport=VIEW,
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
    if requests is not None:
        pg.on("request", lambda r: requests.append(r.url))
    if errors is not None:
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on(
            "console",
            lambda m: (
                errors.append(m.text)
                if m.type == "error" and not any(b in m.text for b in BENIGN_ERRORS)
                else None
            ),
        )
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=READY_MS,
        polling=200,
    )
    return pg


def _ready(pg):
    pg.wait_for_function(
        "() => typeof _pv !== 'undefined' && _pv && _pv.ready",
        timeout=READY_MS,
        polling=250,
    )


def test_opening_the_earth_requests_none_of_the_pad_view(served):
    from playwright.sync_api import sync_playwright

    requests = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _page(br, served, requests)
            pg.wait_for_timeout(3000)
            assert not [u for u in requests if PAD_FILE in u], [
                u for u in requests if PAD_FILE in u
            ]
            assert pg.evaluate(
                "() => typeof _aePadStart === 'undefined' && typeof _aePadOpen === 'function'"
            )
        finally:
            br.close()


def test_go_to_lists_each_pad_and_a_row_stands_the_person_there_from_a_cold_start(served):
    """"You say I can stand at a launch pad but I can't figure out how to get to a launch from this list."
    Go to has a Stand at the pad group; its row opens the pad with no site file loaded before (the exhaust's shader is the
    sites' own), and Back returns to the Earth."""
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _page(br, served, errors=errors)
            assert pg.evaluate("() => typeof _asPointVert === 'undefined'")   # a cold start: no site visit has loaded its files
            pg.click("#ae-find")
            pg.wait_for_selector("#ae-go-groups h4[data-g='alm_pad_at']", timeout=60_000)
            rows = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-go-groups h4[data-g=alm_pad_at] + .ae-go-list [data-ae-go]')).map(b => b.getAttribute('data-ae-go'))"
            )
            assert rows == ["pad:apollo11", "pad:perseverance"], rows
            pg.click("#ae-go [data-ae-go='pad:apollo11']")
            _ready(pg)
            assert pg.evaluate("() => _pv.id === 'apollo11' && !!_ae.site && document.getElementById('ae-go').hidden")
            pg.click("#ae-back")
            pg.wait_for_function("() => !_ae.site && !document.getElementById('pv-hud') && _ae.target === 'earth'", timeout=60_000, polling=200)
            assert errors == [], errors
        finally:
            br.close()


@pytest.mark.parametrize(
    "mission,name", [("apollo11", "Apollo 11"), ("perseverance", "Perseverance")]
)
def test_the_launch_phase_stands_the_person_at_the_pad_and_back_returns(
    served, mission, name
):
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _page(br, served, errors=errors)
            pg.evaluate(
                "(id) => { ZimiCap.set('full'); _aeMissionStart(id); }", mission
            )
            pg.wait_for_function(
                "() => !!_ae.mission && !!document.getElementById('am-pad')",
                timeout=READY_MS,
                polling=250,
            )
            pg.click("#am-pad")
            _ready(pg)
            # the arrow's words follow the view's next paint of its controls
            pg.wait_for_function("(n) => (document.getElementById('ae-back').getAttribute('aria-label') || '').indexOf(n) >= 0", arg=name, timeout=10_000, polling=100)
            state = pg.evaluate(
                """() => ({ mission: !!_ae.mission, site: !!_ae.site, back: document.getElementById('ae-back').getAttribute('aria-label'),
                  clock: document.getElementById('pv-clock').textContent, t: (_aeDisplayMs() - _pv.zeroMs) / 1000, dist: _pv.eye.dist,
                  eye: Math.hypot(_ae.site.eye.x, _ae.site.eye.y), rate: _almRate })"""
            )
            assert not state["mission"] and state["site"], state
            assert name in state["back"], state  # the arrow names where it goes
            assert state["clock"].startswith(
                "T−0:"
            ), state  # the count, T minus about thirty seconds
            assert -31 <= state["t"] <= -20, state
            assert abs(state["eye"] - state["dist"]) < 1, state  # the viewing spot
            assert state["rate"] == 1, state
            # After the tower is cleared the vehicle is on screen and above the pad.
            pg.evaluate(
                "() => { _aeGoTo(_pv.zeroMs + (_pv.P.clearS + 3) * 1000); _almClockSetRate(0); }"
            )
            pg.wait_for_timeout(2500)
            at = pg.evaluate(
                """() => ({ up: _pv.follow[2] - _asGroundAt(_ae.site, 0, 0, false), live: Object.keys(_pv.parts).filter(k => _pv.parts[k].live).length,
                  count: document.getElementById('pv-clock').textContent })"""
            )
            assert at["up"] > MIN_RISE_M, at
            assert at["live"] >= 3 and at["count"].startswith("T+"), at
            # Time controls: back to T minus 30, paused and played.
            pg.click("#pv-restart")
            assert pg.evaluate("() => (_aeDisplayMs() - _pv.zeroMs) / 1000") < -25
            pg.click("#pv-play")
            assert pg.evaluate("() => _almRate") == 0
            pg.click("#ae-back")   # the one way out steps back to the mission
            pg.wait_for_function(
                "() => !!_ae.mission && !_ae.site && !document.getElementById('pv-hud')",
                timeout=60_000,
                polling=200,
            )
            assert errors == [], errors
        finally:
            br.close()



def test_a_light_device_draws_the_flames_and_no_cloud(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _page(br, served)
            pg.evaluate("() => { ZimiCap.set('light'); _aePadOpen('apollo11'); }")
            _ready(pg)
            pg.evaluate("() => { _aeGoTo(_pv.zeroMs + 6000); }")
            pg.wait_for_timeout(2500)
            fx = pg.evaluate("() => ({ smoke: !!_pv.fx.smoke, flame: !!_pv.fx.flame })")
            assert fx == {"smoke": False, "flame": True}, fx
        finally:
            br.close()


def test_the_view_keeps_following_the_vehicle_far_up(served):
    """(Apollo 11, Jul 16 1969) the camera stopped following the Saturn V once it was far up."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _page(br, served)
            pg.evaluate("(id) => { ZimiCap.set('full'); _aeMissionStart(id); }", "apollo11")
            pg.wait_for_function("() => !!_ae.mission && !!document.getElementById('am-pad')", timeout=READY_MS, polling=250)
            pg.click("#am-pad")
            _ready(pg)
            probe = """(s) => { _aeGoTo(_pv.zeroMs + s * 1000); _almClockSetRate(0);
              var st = _ae.site, c; for (var i = 0; i < 40; i++) c = _pvCamera(st, 0.25);
              var f = _pv.follow, d = [c.focus[0] - c.pos[0], c.focus[1] - c.pos[1], c.focus[2] - c.pos[2]], w = [f[0] - c.pos[0], f[1] - c.pos[1], f[2] - c.pos[2]];
              var dot = d[0] * w[0] + d[1] * w[1] + d[2] * w[2], n = Math.hypot(d[0], d[1], d[2]) * Math.hypot(w[0], w[1], w[2]);
              return { off: Math.acos(Math.min(1, dot / n)) * 180 / Math.PI, fov: c.fov, up: f[2] }; }"""
            for s in (30, 90, 160, 300, 500, 650):
                r = pg.evaluate(probe, s)
                pg.wait_for_timeout(600)
                assert r["off"] < r["fov"] * 0.3, (s, r)   # near the middle of the picture, not just inside it
                r["px"] = pg.evaluate("() => _pv.drawnPx")
                assert r["px"] is not None and r["px"] >= MIN_DRAWN_PX, (s, r)   # and drawn large enough to find, at any range
        finally:
            br.close()
