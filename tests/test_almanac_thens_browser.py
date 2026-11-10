"""The There-and-then list, opened from the live sky and from the Launches sheet, driven in headless Chromium at a phone's size.
It lists the four families, searches, opens an entry, and one tap stands there then: the ground view at the place, the clock held at
the instant, facing where the entry says. THENS_SHOTS=<folder> saves a screenshot of each state there.

Run: pytest tests/test_almanac_thens_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = os.environ.get(
    "LAUNCHES_GL_ARGS",
    "--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist",
).split()
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":34.05,"lon":-118.24,"name":"Los Angeles"}'
READY_MS = 400_000
SHOTS = os.environ.get("THENS_SHOTS", "")
TAG = "2022-141"
LIFTOFF_MS = 1_666_919_640_000  # 2022-10-28 01:14 UTC
CLOCK_SLACK_MS = 3_000


@pytest.fixture(scope="module")
def browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


@pytest.fixture
def served(tmp_path):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    (tmp_path / "zims").mkdir()
    (tmp_path / "data").mkdir()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp_path / "zims"), str(tmp_path / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _shot(pg, name):
    if SHOTS:
        pg.screenshot(path=os.path.join(SHOTS, name))


def test_the_list_opens_from_the_sky_searches_and_stands_there_then(browser, served):
    ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
    ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); } catch (e) {}" % PLACE)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    try:
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function("() => typeof openAlmanacThens === 'function' && typeof _aeLoadThree === 'function'", timeout=READY_MS)
        assert pg.evaluate("typeof _atHtml") == "undefined"          # nothing is loaded before it is asked for
        pg.evaluate("openAlmanacThens()")                            # the live sky's button
        pg.wait_for_selector(".at-row", timeout=READY_MS)
        groups = pg.eval_on_selector_all(".at-group", "els => els.length")
        rows = pg.eval_on_selector_all(".at-row", "els => els.length")
        assert groups == 4 and rows >= 15, (groups, rows)
        _shot(pg, "thens-list.png")
        pg.fill("#at-q", "eclipse")
        pg.wait_for_function("() => document.querySelectorAll('.at-row').length === 4")
        pg.fill("#at-q", "zzzz")
        pg.wait_for_selector(".al-sheet p")
        assert pg.eval_on_selector_all(".at-row", "els => els.length") == 0
        pg.fill("#at-q", "eclipse")
        pg.wait_for_function("() => document.querySelectorAll('.at-row').length === 4")
        pg.click(".at-row[data-id='eclipse-2024-kerrville']")
        pg.wait_for_selector("#at-stand")
        _shot(pg, "thens-detail.png")
        pg.click("#at-stand")
        pg.wait_for_function("() => _ae.stand && _ae.stand.mode === 'ground'", timeout=READY_MS, polling=500)
        pg.wait_for_timeout(4000)
        held = pg.evaluate("_aeDisplayMs()")
        assert abs(held - 1712601290000) < 30_000, held                # totality at Kerrville, 2024-04-08 18:34:50 UTC
        assert pg.evaluate("Math.abs(_ae.stand.lat - 30.05) < 1e-6 && Math.abs(_ae.stand.lon + 99.14) < 1e-6")
        head = pg.evaluate("((_ae.stand.yaw + _ae.stand.userYaw) * 180 / Math.PI % 360 + 360) % 360")
        assert abs(head - 177.8) < 2, head                              # facing the Sun
        _shot(pg, "thens-eclipse-stand.png")
        assert not errors, errors
    finally:
        ctx.close()


def test_the_moons_entry_faces_the_earth_the_ground_view_draws_and_go_to_has_the_list(browser, served):
    """Tranquility Base opens the ground view on the Moon at the landing, facing where the view puts the Earth; Go to lists the there-and-thens."""
    ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
    pg = ctx.new_page()
    try:
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function("() => typeof openAlmanacThens === 'function' && typeof _aeLoadThree === 'function'", timeout=READY_MS)
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=250)
        pg.evaluate("_aeShowGo(true)")
        pg.wait_for_selector("[data-ae-then]")
        _shot(pg, "thens-goto.png")
        pg.click("[data-ae-then]")
        pg.wait_for_selector(".at-row", timeout=READY_MS)
        pg.click(".at-row[data-id='apollo-11-tranquility']")
        pg.wait_for_selector("#at-stand")
        assert pg.evaluate("document.getElementById('at-sky') === null")      # no live sky on another body
        pg.click("#at-stand")
        pg.wait_for_function("() => _ae.stand && _ae.stand.key === 'moon' && _ae.stand.mode === 'ground'", timeout=READY_MS, polling=500)
        pg.wait_for_timeout(4000)
        got = pg.evaluate("""() => { var st = _ae.stand, o = st.fr.objs.filter(function (x) { return x.key === 'earth'; })[0], d = o.dir;
          return { az: (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360, el: Math.asin(d[2]) * 180 / Math.PI, ms: _aeDisplayMs(),
                   head: (((st.yaw + st.userYaw) * 180 / Math.PI) % 360 + 360) % 360 }; }""")
        assert abs(got["ms"] - (-14182940000)) < 30_000, got
        assert abs(got["az"] - 272.3) < 1.5 and abs(got["el"] - 59.2) < 1.5, got       # the entry's look is the Earth's place in the view
        assert abs(got["head"] - 272.3) < 2, got
        _shot(pg, "thens-tranquility.png")
    finally:
        ctx.close()

