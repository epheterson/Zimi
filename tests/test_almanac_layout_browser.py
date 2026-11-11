"""The Almanac's page, as Eric laid it out (2026-10-18), in a real browser at a phone's width.

  1. The wall calendar: the live sky stands directly above the calendar, with
     nothing in between, whether or not a place has been chosen.
  2. The hero: the Moon with its six tiles in two rows of three, the Moon's (how
     lit, when it rises or sets, when it is next full) then the Sun's (sunrise,
     sunset, daylight), then what the sky says (its caption, the ask for a
     place), then the sky. Each tile is a label and one value.
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
    "alm-hc-nextfull",
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
                // The six as they read: one grid, row by row (top, then left).
                reading: [...document.querySelectorAll('#almanac-head .alm-cards .alm-card')].filter(e => !e.hidden)
                  .map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), e.id || e.className]; })
                  .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2].replace(/^alm-card /, '')),
                cap: document.getElementById('almanac-sky-cap').textContent.trim().length > 0,
                facts: document.getElementById('almanac-sky-facts').querySelectorAll('.alm-card').length,
                tiles: document.querySelectorAll('#almanac-head .alm-cards .alm-card:not([hidden])').length,
                subs: document.querySelectorAll('#almanac-head .alm-cards .alm-card:not([hidden]) .alm-card-sub:not(:empty)').length,
                factLabels: [...document.querySelectorAll('#almanac-sky-facts .alm-card-lbl')].map(e => e.textContent.trim().toLowerCase()),
                factText: document.getElementById('almanac-sky-facts').textContent,
                ...(() => { const rows = {}; document.querySelectorAll('#almanac-head .alm-cards .alm-card:not([hidden])').forEach(e => { const r = e.getBoundingClientRect(); (rows[Math.round(r.top)] = rows[Math.round(r.top)] || []).push(Math.round(r.height)); });
                  const v = Object.values(rows); return { rows: v.map(a => a.length), rowsEven: v.every(a => new Set(a).size === 1) }; })() };
            }""",
            HERO_CARDS,
        )
        assert all(got["present"]), got
        assert all(got["text"]), got  # each has its figure
        # The Moon, its cards, then the caption directly over the sky (Eric, 2026-10-18).
        assert got["order"] == sorted(got["order"]), got["order"]
        # Two rows of three, one idea each: the Moon (how lit, when it rises or sets, when it is next full), then the
        # Sun (when it rises, when it sets, how long the day is).
        assert got["reading"] == [
            "alm-hc-illum-card",
            "alm-sf-moon",
            "alm-hc-nextfull-card",
            "alm-sf-sunrise",
            "alm-sf-sunset",
            "alm-sf-daylight",
        ], got["reading"]
        assert got["rows"] == [3, 3], got["rows"]
        assert got["cap"] and got["facts"] == 4, got
        # None says how lit the Moon is twice (the hero's tile does), and none is the Sun's time by the clock.
        assert "lit" not in got["factText"].lower(), got["factText"]
        assert not any("solar" in l or "dark" in l for l in got["factLabels"]), got[
            "factLabels"
        ]
        # Six tiles, every one a label and one value: no third line, and no tile taller than another in its row.
        assert got["tiles"] == 6 and got["subs"] == 0, got
        assert got["rowsEven"], got
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
        # The 3D view is made ready when the Moon is touched, not behind the page (a page only looked at never loads it).
        pg.wait_for_function(
            "() => typeof _almMoonPrepare === 'function'", timeout=60_000
        )
        pg.evaluate("_almMoonPrepare()")
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


# Sampled every frame while the Almanac opens: how many tiles show, and where the sky stands and how tall it is (its
# place in the page, so a scroll is not a move).
_ENTRY_SAMPLER = """() => {
  window.__entry = [];
  const t0 = performance.now();
  function tick() {
    const view = document.getElementById('almanac-view'), sky = document.querySelector('#almanac-view .almanac-sky-wrap');
    const sc = document.getElementById('almanac-content');
    if (view && view.classList.contains('open') && sky) {
      const cards = [...document.querySelectorAll('#almanac-view .alm-card')].filter(c => c.getBoundingClientRect().height > 0);
      const r = sky.getBoundingClientRect();
      window.__entry.push({ cards: cards.length, top: Math.round(r.top + sc.scrollTop), h: Math.round(r.height) });
    }
    if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}"""


@pytest.mark.parametrize("dark", [False, True])
def test_opening_the_almanac_holds_still(browser, served, dark):
    """Eric (2026-11-04): "Almanac reloads weird when I enter, like the tiles go away and the sky jumps up and down a
    little bit." From its first frame open, cold and opened again, the Almanac shows all six tiles, and the sky stands
    where it will stay at the height it will keep: the Sun's tiles came a frame or more after the Moon's (the sky
    filled them), the canvas waited at its default size, and the sky's caption was empty until its first tick, each
    moving the sky when it came."""
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        timezone_id="America/Los_Angeles",
        color_scheme="dark" if dark else "light",
    )
    ctx.add_init_script(
        "localStorage.setItem('zimi_almanac_place', %s);"
        % json.dumps(json.dumps(PLACE))
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    try:
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanac === 'function'", timeout=60_000, polling=POLL_MS
        )
        for entry in ("cold", "again"):
            pg.evaluate(_ENTRY_SAMPLER)
            pg.evaluate("openAlmanac()")
            pg.wait_for_function(
                "() => window.__entry.length && performance.now() > 0",
                timeout=60_000,
                polling=POLL_MS,
            )
            pg.wait_for_function(  # settled: the sky's own state has written its tiles and caption
                "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph && _skyState.factsAt",
                timeout=60_000,
                polling=POLL_MS,
            )
            pg.wait_for_timeout(600)
            frames = pg.evaluate("window.__entry")
            final = frames[-1]
            assert final["cards"] == 6, (entry, final)
            moved = [
                f
                for f in frames
                if (f["cards"], f["top"], f["h"])
                != (final["cards"], final["top"], final["h"])
            ]
            assert not moved, (
                entry,
                "first frame %s, settled %s" % (frames[0], final),
                moved[:5],
            )
            pg.evaluate("closeAlmanac()")
            pg.wait_for_timeout(300)
        assert not errors, errors
    finally:
        ctx.close()
