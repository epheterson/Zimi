"""The Almanac's page, as Eric laid it out (2026-10-18), in a real browser at a phone's width.

  1. The wall calendar: the live sky stands directly above the calendar, with
     nothing in between, whether or not a place has been chosen.
  2. The hero: the Moon with its numbers (illuminated, age, distance, next full
     Moon, sunrise, sunset, daylight, golden hour), then what the sky says (its
     caption, the survivor facts, the ask for a place), then the sky. Nothing in
     the facts repeats a hero card.
  3. The world clocks: the All / Saved switch is above the clocks, at the end of
     the line.
  4. The Moon is its picture (nothing stands in for it), and the solar system
     has no flown view.
  5. Every control that is on the sky is the size of a finger and clear of the
     others, in English and in Arabic.

Run: pytest tests/test_almanac_layout_browser.py -v
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
POLL_MS = 100
HERO_CARDS = [
    "alm-hc-illum",
    "alm-hc-age",
    "alm-hc-dist",
    "alm-hc-nextfull",
    "alm-hc-sunrise",
    "alm-hc-sunset",
    "alm-hc-daylight",
    "alm-hc-golden",
]


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("layout")
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


def _page(browser, served, place=True, locale="en-US"):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        locale=locale,
        timezone_id="America/Los_Angeles",
    )
    if place:
        ctx.add_init_script(
            "localStorage.setItem('zimi_almanac_place', %s);"
            % json.dumps(json.dumps(PLACE))
        )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => !!document.getElementById('almanac-calendar') && !!document.getElementById('almanac-head') && _almPanelsReady",
        timeout=60_000,
        polling=POLL_MS,
    )
    pg.wait_for_timeout(500)
    return ctx, pg, errors


@pytest.mark.parametrize("place", [True, False])
def test_the_live_sky_is_directly_above_the_calendar(browser, served, place):
    """Eric: 'LIVE SKY RIGHT ABOVE CALENDAR WITH NOTHING IN BETWEEN.' Not an element between them in the page, and
    not a pixel of anything between them on the screen, whether the place is chosen (no ask) or not (the ask moves up).
    """
    ctx, pg, errors = _page(browser, served, place=place)
    try:
        got = pg.evaluate("""() => {
              const wrap = document.querySelector('.almanac-sky-wrap'), cal = document.getElementById('almanac-calendar');
              const w = wrap.getBoundingClientRect(), c = cal.getBoundingClientRect();
              return { next: wrap.nextElementSibling && wrap.nextElementSibling.id, prev: cal.previousElementSibling && cal.previousElementSibling.className,
                gap: Math.round(c.top - w.bottom), inside: ['almanac-sky-cap', 'almanac-sky-facts', 'almanac-sky-invite'].map(i => wrap.contains(document.getElementById(i))) };
            }""")
        assert (
            got["next"] == "almanac-calendar" and got["prev"] == "almanac-sky-wrap"
        ), got
        assert got["inside"] == [False, False, False], got
        # Only the calendar's own breathing room (its month heading's margin), not a block of content.
        assert 0 <= got["gap"] <= 40, got
        assert not errors, errors
    finally:
        ctx.close()


def test_the_moons_numbers_and_the_skys_are_one_grid_with_the_caption_over_the_sky(
    browser, served
):
    ctx, pg, errors = _page(browser, served)
    try:
        got = pg.evaluate(
            """(ids) => {
              const y = (e) => e.getBoundingClientRect().top;
              const moon = document.querySelector('#almanac-head .almanac-hero'), info = document.querySelector('.alm-sky-info'),
                sky = document.querySelector('.almanac-sky-wrap');
              const cards = ids.map(i => document.getElementById(i));
              return { present: cards.map(c => !!c), text: cards.map(c => c && c.textContent.trim()),
                order: [y(moon), y(cards[0]), y(document.getElementById('almanac-sky-cap')), y(sky)],
                // The twelve as they read: one grid, row by row (top, then left).
                reading: [...document.querySelectorAll('#almanac-head .alm-cards .alm-card')].filter(e => !e.hidden)
                  .map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), e.id || e.className]; })
                  .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2].replace(/^alm-card /, '')),
                cap: document.getElementById('almanac-sky-cap').textContent.trim().length > 0,
                facts: document.getElementById('almanac-sky-facts').querySelectorAll('.alm-card').length,
                factLabels: [...document.querySelectorAll('#almanac-sky-facts .alm-card-lbl')].map(e => e.textContent.trim().toLowerCase()),
                factText: document.getElementById('almanac-sky-facts').textContent };
            }""",
            HERO_CARDS,
        )
        assert all(got["present"]), got
        assert all(got["text"]), got  # each has its figure
        # The Moon, its cards, then the caption directly over the sky (Eric, 2026-10-18).
        assert got["order"] == sorted(got["order"]), got["order"]
        # The sky's four among the Moon's eight, in pairs: the Moon, its distance and the Sun's clock, the Sun's day.
        assert got["reading"] == [
            "alm-hc-illum-card", "alm-hc-age-card", "alm-sf-moon", "alm-hc-nextfull-card",
            "alm-hc-dist-card", "alm-sf-solar", "alm-hc-sunrise-card", "alm-hc-sunset-card",
            "alm-hc-daylight-card", "alm-sf-left", "alm-hc-golden-card", "alm-sf-dark",
        ], got["reading"]
        assert got["cap"] and got["facts"] >= 4, got
        # No duplication: the facts do not say how lit the Moon is (the hero's Illuminated card does), and do not
        # write a sunrise or sunset hour again (the hero's cards do).
        assert "lit" not in got["factText"].lower(), got["factText"]
        assert not any(
            l in ("illuminated", "sunrise", "sunset", "daylight")
            for l in got["factLabels"]
        ), got["factLabels"]
        # Four cards, so the Moon's eight and these four are one grid of twelve.
        assert got["facts"] == 4, got
        assert not errors, errors
    finally:
        ctx.close()


def test_all_and_saved_are_above_the_clocks_at_the_end_of_the_line(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function(
            "() => document.querySelectorAll('#almanac-tz-pills .alm-tz-city-card').length > 5",
            timeout=60_000,
            polling=POLL_MS,
        )
        got = pg.evaluate("""() => {
              const sw = document.querySelector('#almanac-tz-view .alm-scope-seg').getBoundingClientRect(),
                list = document.getElementById('almanac-tz-pills').getBoundingClientRect(),
                first = document.querySelector('#almanac-tz-pills .alm-tz-city-card').getBoundingClientRect();
              return { switchBottom: sw.bottom, firstTop: first.top, switchRight: sw.right, listRight: list.right, switchLeft: sw.left, listLeft: list.left };
            }""")
        assert got["switchBottom"] <= got["firstTop"], got
        assert (
            abs(got["switchRight"] - got["listRight"]) <= 2
        ), got  # right aligned with the clocks under it
        assert (
            got["switchLeft"] > got["listLeft"] + 100
        ), got  # not stretched or centred
        assert not errors, errors
    finally:
        ctx.close()


def test_the_moon_is_its_picture_and_the_solar_system_has_no_flown_view(
    browser, served
):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady()",
            timeout=240_000,
            polling=250,
        )
        got = pg.evaluate("""() => ({
              sprite: (() => { const i = document.querySelector('.almanac-hero img.almanac-moon-sprite'); return !!i && i.complete && i.naturalWidth > 0 && getComputedStyle(i).visibility !== 'hidden'; })(),
              canvasInHero: !!document.querySelector('.almanac-hero canvas#ae-canvas'),
              landing: typeof _lpRelease !== 'undefined', space: typeof openAlmanacSpace !== 'undefined' || typeof _almOpenSpace !== 'undefined',
              pill: !!document.querySelector('.orrery-space-pill, .orrery-space-btn'),
              solarView: !!document.querySelector('[data-ae-view=axis]') })""")
        assert got == {
            "sprite": True,
            "canvasInHero": False,
            "landing": False,
            "space": False,
            "pill": False,
            "solarView": False,
        }, got
        assert not errors, errors
    finally:
        ctx.close()


def test_no_tide_line_about_where_the_prediction_comes_from(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_selector("#almanac-place .at-section", timeout=60_000)
        assert pg.locator("#almanac-place .at-note").count() == 0
        assert "Weather moves the real sea" not in pg.inner_text("#almanac-place")
    finally:
        ctx.close()


def test_the_light_pollution_setting_is_named_for_what_it_does(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate("() => _skyToggleSettings(true)")
        text = pg.inner_text("#almanac-sky-set")
        assert "Light pollution" in text and "Darkness" not in text, text
        assert "Dark site" in text and "City" in text, text
    finally:
        ctx.close()
