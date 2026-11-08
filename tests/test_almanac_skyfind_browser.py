"""Find in the sky, in the phone's Look view, in a real browser.

On the shipped files, served by Zimi, in headless Chromium at a phone's
width, San Francisco at 23:00 on 30 September 2026 (Saturn up in the
southeast, Mars, Jupiter, Venus and the Sun under the horizon):

  1. Find is Look's: its magnifier opens the sheet; with nothing typed it
     offers what is up; a name finds its thing; choosing it says where it is
     and, with no sensors, turns the view to it. Clearing takes the chip away.
  2. A thing under the horizon is as findable as one above it: Look shows the
     whole sphere, so the view turns down to it and rings it there.
  3. Nowhere else: the live sky and the star chart have no Find (see also
     tests/test_almanac_look_browser.py).

The maths (matching, places against Horizons, the way to a thing) is
tests/test_almanac_skyfind.cjs.

Run: pytest tests/test_almanac_skyfind_browser.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = (
    []
    if sys.platform == "darwin"
    else ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
)
VIEW = {"width": 390, "height": 844}
PLACE = {"lat": 37.7749, "lon": -122.4194, "name": "San Francisco"}
NIGHT = "2026-10-01T06:00:00Z"
POLL_MS = 100


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("skyfind")
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


@pytest.fixture(scope="module")
def browser(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


def _almanac(browser, served, no_sensors=False):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=1,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "localStorage.setItem('zimi_almanac_place', %s);"
        % json.dumps(json.dumps(PLACE))
    )
    if no_sensors:
        ctx.add_init_script("window.DeviceOrientationEvent = undefined;")
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
        polling=POLL_MS,
        timeout=60000,
    )
    # The sky stands under the Moon's numbers and its words, below the first screen: bring it into view, as a reader does.
    pg.evaluate(
        "() => document.querySelector('.almanac-sky-wrap').scrollIntoView({ behavior: 'instant', block: 'center' })"
    )
    pg.evaluate("(iso) => { _almClockSetRate(0); _almScrubSettle(new Date(iso)); }", NIGHT)
    pg.wait_for_function(
        "(t) => _skyState.nowTime === t && !_skyState.moonAnim",
        arg=_ms(NIGHT),
        polling=POLL_MS,
        timeout=60000,
    )
    return ctx, pg, errors


def _ms(iso):
    from datetime import datetime

    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _open_look(pg):
    pg.evaluate("() => document.querySelector('.alm-sky-look').click()")
    pg.wait_for_function(
        "() => typeof _look !== 'undefined' && _look && _look.skyMounted",
        polling=POLL_MS,
        timeout=60000,
    )


def _find(pg, query):
    pg.evaluate("() => document.getElementById('look-find').click()")
    pg.wait_for_selector("#sf-input", timeout=60000)
    pg.fill("#sf-input", query)
    pg.wait_for_function(
        "() => document.querySelectorAll('#sf-list .sf-row').length > 0",
        polling=POLL_MS,
    )
    pg.keyboard.press("Enter")
    pg.wait_for_function("() => !document.getElementById('sf-sheet')", polling=POLL_MS)


def test_find_offers_what_is_up_and_leads_to_a_planet(browser, served):
    ctx, pg, errors = _almanac(browser, served, no_sensors=True)
    try:
        _open_look(pg)
        pg.evaluate("() => document.getElementById('look-find').click()")
        pg.wait_for_selector("#sf-input", timeout=60000)
        pg.wait_for_function(
            "() => document.querySelectorAll('#sf-list .sf-row').length > 0",
            polling=POLL_MS,
        )
        offered = pg.evaluate(
            "() => [...document.querySelectorAll('#sf-list .sf-name')].map(e => e.textContent)"
        )
        assert "Saturn" in offered and "Moon" in offered, offered
        assert "Mars" not in offered, "Mars is under the horizon: not on offer unasked"
        pg.keyboard.press("Escape")
        pg.wait_for_function("() => !document.getElementById('sf-sheet')")
        _find(pg, "saturn")
        assert pg.evaluate("() => _skyFind && _skyFind.id") == "planet:Saturn"
        chip = pg.inner_text("#sf-look-chip")
        assert "Saturn" in chip, chip
        # No sensors: the view turned to it, and it is in view.
        pg.wait_for_function(
            "() => { const r = document.getElementById('look-read').textContent; return /SE/.test(r) && /\\+4[23]/.test(r); }",
            polling=POLL_MS,
            timeout=30000,
        )
        assert "In view" in pg.inner_text("#sf-look-chip")
        # Turn the view away by a finger's worth: the chip leads back with an arrow and degrees.
        pg.evaluate(
            "() => { _look.target = { az: 300, alt: 10, roll: 0 }; _lookKick(); }"
        )
        pg.wait_for_function(
            "() => /away/.test(document.getElementById('sf-look-chip').textContent)",
            polling=POLL_MS,
            timeout=30000,
        )
        assert pg.query_selector("#sf-arrow"), "an arrow when it is out of view"
        pg.evaluate(
            "() => document.querySelector('#sf-look-chip [data-sf-clear]').click()"
        )
        assert pg.evaluate("() => _skyFind") is None
        assert pg.query_selector("#sf-look-chip") is None
        assert not errors, errors
    finally:
        ctx.close()


def test_a_thing_under_the_horizon_is_found_in_look_and_ringed(browser, served):
    ctx, pg, errors = _almanac(browser, served, no_sensors=True)
    try:
        _open_look(pg)
        _find(pg, "mars")
        assert pg.evaluate("() => _skyFind.id") == "planet:Mars"
        # The view went down to it, and Mars is drawn there, as under the horizon.
        pg.wait_for_function(
            "() => _look.view.alt < -5 && _skyHost.s.bodies.some(b => b.type === 'planet' && b.name === 'Mars' && b.under)",
            polling=POLL_MS,
            timeout=30000,
        )
        # The view glides there: a slow runner reads the chip on the way.
        pg.wait_for_function(
            "() => (document.getElementById('sf-look-chip') || {}).innerText.indexOf('In view') >= 0",
            polling=POLL_MS,
            timeout=30000,
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_a_finder_elsewhere_can_lead_look_to_a_thing(browser, served):
    """openAlmanacFind('look', id) is what a finder elsewhere would call, with Look open."""
    ctx, pg, errors = _almanac(browser, served, no_sensors=True)
    try:
        _open_look(pg)
        pg.evaluate("() => openAlmanacFind('look', 'planet:Saturn')")
        pg.wait_for_selector("#sf-look-chip", timeout=60000)
        assert "Saturn" in pg.inner_text("#sf-look-chip")
        assert not errors, errors
    finally:
        ctx.close()
