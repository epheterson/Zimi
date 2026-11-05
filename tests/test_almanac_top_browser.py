"""The top of the Almanac on a phone (Eric, 2026-11-05): the live sky never flashes black before its first
paint, the sky is a section of its own in the bar, and a part that is not laid out never names its section.

Run: pytest tests/test_almanac_top_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

POLL_MS = 100
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("almtop")
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
        br = pw.chromium.launch()
        yield br
        br.close()


def _page(browser, served, width):
    phone = width < 600
    ctx = browser.new_context(viewport={"width": width, "height": 844}, device_scale_factor=2, has_touch=phone,
                              is_mobile=phone, service_workers="block", color_scheme="dark")
    ctx.add_init_script("try { localStorage.setItem('zimi_app_theme', 'dark'); localStorage.setItem('zimi_almanac_place', %r); }"
                        " catch (e) {}" % PLACE)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="domcontentloaded")
    return ctx, pg, errors


def test_the_sky_shows_its_hour_before_its_first_paint(browser, served):
    """Before the sky module draws a pixel, the canvas already wears the hour's sky (zenith to horizon over a
    ground), not the page behind it: in the dark theme that page is black, and the sky flashed black on opening."""
    ctx, pg, errors = _page(browser, served, 390)
    try:
        pg.wait_for_function("() => !!document.getElementById('almanac-sky-canvas')", timeout=60_000, polling=20)
        got = pg.evaluate("""() => { const c = document.getElementById('almanac-sky-canvas');
            const loc = _getLocation(), alt = _sunPosition(_almFocusInstant(), loc.lat, loc.lon).altitude;
            return { bg: getComputedStyle(c).backgroundImage, want: _skyPreBackground(alt) }; }""")
        assert got["bg"].startswith("linear-gradient"), got
        # The computed form spells the same colours: each of the wanted stops is in it.
        for rgba in got["want"].split("rgba(")[1:]:
            r, g, b = rgba.split(",")[:3]
            assert "rgb(%s, %s, %s)" % (r, g, b.strip()) in got["bg"], got
        assert not errors, errors
    finally:
        ctx.close()


@pytest.mark.parametrize("width,split", [(390, True), (1280, False)])
def test_on_a_phone_the_sky_is_a_section_of_its_own(browser, served, width, split):
    ctx, pg, errors = _page(browser, served, width)
    try:
        pg.wait_for_function("() => typeof _almSecBar !== 'undefined' && _almSecBar && _almSecBar.sections",
                             timeout=60_000, polling=POLL_MS)
        keys = pg.evaluate("() => _almSecBar.sections.map(s => s.key)")
        if split:
            assert keys[:3] == ["today", "sky", "calendar"], keys
            # Scrolled to the sky, the bar shows and names it.
            pg.evaluate("() => { document.querySelector('.alm-sky-info').scrollIntoView({block: 'start'}); }")
            pg.wait_for_timeout(400)
            pg.evaluate("_almSecBarSync()")
            assert pg.evaluate("_almSecBar.cur") == "sky"
            assert pg.evaluate("document.getElementById('alm-secbar').hidden") is False
        else:
            assert "sky" not in keys and keys[:2] == ["today", "calendar"], keys
        assert not errors, errors
    finally:
        ctx.close()


def test_a_part_not_laid_out_never_names_its_section(browser, served):
    """A section hidden for a moment (the time machine pins and hides parts) reads as top 0: it had 'begun', and
    the bar named a section far below the reader (Eric: the pills "start at tides even while I'm above tides")."""
    ctx, pg, errors = _page(browser, served, 390)
    try:
        pg.wait_for_function("() => typeof _almSecBar !== 'undefined' && _almSecBar && _almSecBar.sections",
                             timeout=60_000, polling=POLL_MS)
        pg.evaluate("() => document.getElementById('almanac-calendar').scrollIntoView({block: 'start'})")
        pg.wait_for_timeout(400)
        pg.evaluate("_almSecBarSync()")
        assert pg.evaluate("_almSecBar.cur") == "calendar"
        pg.evaluate("""() => { const s = _almSecBar.sections.filter(x => x.key === 'solar')[0];
            s.els.forEach(e => { e.style.display = 'none'; }); _almSecBarSync(); }""")
        assert pg.evaluate("_almSecBar.cur") == "calendar"
        assert not errors, errors
    finally:
        ctx.close()
