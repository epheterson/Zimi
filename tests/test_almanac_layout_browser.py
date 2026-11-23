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

from browser_slots import WEBGL_ARGS
GL_ARGS = (
    []
    if sys.platform == "darwin"
    else WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
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


def _page(browser, served, place=True, locale="en-US", desktop=False):
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 800} if desktop else VIEW,
        device_scale_factor=2,
        has_touch=not desktop,
        is_mobile=not desktop,
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
        assert "Dark" in text and "City" in text, text
    finally:
        ctx.close()


def test_the_light_pollution_slider_shows_the_dial_the_sky_is_drawn_with(browser, served):
    """The dial starts at the place's own night lights, which can arrive after the panel was built: opening the panel shows it."""
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate("() => { _skyToggleSettings(true); _skyToggleSettings(false); }")
        pg.evaluate("() => { window._osPlaceDial = 0.6; _skyToggleSettings(true); }")
        assert pg.evaluate("() => [_skySetting('dial'), document.querySelector('[data-sky-set=dial]').value]") == [0.6, "60"]
        assert not errors, errors
    finally:
        ctx.close()


def test_the_sky_sheet_has_three_scene_cards_a_life_switch_and_two_sizes(browser, served):
    """Scene: Local, Beach, Horizon as cards (Local is the default), each with a line saying what it draws; Life is one saved switch
    with a line saying what it shows; the Sun and Moon are Actual or Larger and the constellations Off, Lines or Names, as segmented
    controls (no native dropdown); the light-pollution slider stays. Only what is chosen is saved."""
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate("() => _skyToggleSettings(true)")
        pg.wait_for_function("() => document.getElementById('almanac-sky-set').classList.contains('in')")
        cards = pg.evaluate("() => Array.from(document.querySelectorAll('#almanac-sky-set [data-sky-skin]')).map(b => [b.dataset.skySkin, b.querySelector('span:nth-of-type(2)').textContent.trim(), b.getAttribute('aria-checked'), b.querySelector('[data-sky-sub]').textContent.trim()])")
        assert [c[:3] for c in cards] == [["local", "Local", "true"], ["beach", "Beach", "false"], ["horizon", "Horizon", "false"]], cards
        assert cards[1][3] == "Sea and sand" and cards[2][3] == "Sky only" and cards[0][3], cards
        assert cards[0][3] not in ("Sea and sand", "Plain ground", "Flat, nothing"), "the place's own says its terrain: " + cards[0][3]
        assert pg.evaluate("() => !document.querySelector('#almanac-sky-set select')")
        sizes = pg.evaluate("() => Array.from(document.querySelectorAll('#almanac-sky-set [data-sky-seg=size]')).map(o => o.textContent)")
        assert sizes == ["Actual", "Larger"], sizes
        lines = pg.evaluate("() => Array.from(document.querySelectorAll('#almanac-sky-set [data-sky-seg=lines]')).map(o => o.textContent)")
        assert lines == ["Off", "Lines", "Names"], lines
        assert pg.evaluate("() => !!document.querySelector('#almanac-sky-set [data-sky-set=dial]')")
        assert "Constellations" in pg.inner_text("#almanac-sky-set")
        assert pg.evaluate("() => document.querySelector('[data-sky-set=life]').checked") is True
        assert pg.inner_text("#alm-sky-life-sub").strip()
        pg.click("[data-sky-seg=size][data-v=true]")
        assert pg.evaluate("() => _skySetting('size')") == "true"
        # An inland place (its land read as desert), so the Local card has its own scene to keep saying.
        pg.evaluate("() => { _skyState.landKey = _osLandKey(_skyState); _skyState.land = { cls: 'desert', coast: false }; _skySyncSettings(document.getElementById('almanac-sky-set')); }")
        assert pg.evaluate("() => document.querySelector('[data-sky-sub=local]').textContent") == "Desert"
        local_sub = pg.evaluate("() => [document.querySelector('[data-sky-sub=local]').textContent, document.querySelector('[data-sky-skin=local] .alm-sky-skin-pic').style.background]")
        pg.click("[data-sky-skin=beach]")
        assert pg.evaluate("() => _skySetting('skin')") == "beach"
        # Local keeps saying (and wearing) the place's own scene with the beach chosen: not "Coast" because the beach is drawn.
        assert pg.evaluate("() => [document.querySelector('[data-sky-sub=local]').textContent, document.querySelector('[data-sky-skin=local] .alm-sky-skin-pic').style.background]") == local_sub
        pg.click("[data-sky-set=life]")
        assert pg.evaluate("() => [_skySetting('life'), JSON.parse(localStorage.getItem('zimi_sky_settings'))]") == ["off", {"size": "true", "skin": "beach", "life": "off"}]
        pg.click("[data-sky-skin=horizon]")
        assert pg.evaluate("() => !document.getElementById('alm-sky-life-row').classList.contains('dim') && !!_skyLifeOn()") is False   # life is off here (switched off above) but it is not dimmed: it works on every scene
        pg.click("[data-sky-set=life]")
        assert pg.evaluate("() => _skyLifeOn()"), "life is on over the plain horizon too"
        assert "water" in pg.inner_text("#alm-sky-life-sub")
        assert not errors, errors
    finally:
        ctx.close()


def test_the_sky_sheet_moves_by_transform_alone_320_up_200_away_and_the_page_behind_does_not_move(browser, served):
    """The sheet comes up from the foot of the screen in 320 ms and goes back in 200, by transform alone (no opacity, no height): the
    card is scrolled to the top first and then no box behind the sheet changes size or place; a switch on life brings a plane or birds
    at once."""
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate("() => _skyToggleSettings(true)")
        pg.wait_for_function("() => document.getElementById('almanac-sky-set').classList.contains('in')")
        up = pg.evaluate("() => { var c = getComputedStyle(document.getElementById('almanac-sky-set')); return [c.transitionProperty, c.transitionDuration, c.position]; }")
        assert up == ["transform", "0.32s", "fixed"], up
        pg.wait_for_timeout(600)
        before = pg.evaluate("() => { var r = document.querySelector('#almanac-view .almanac-sky-wrap').getBoundingClientRect(); return [r.top, r.height, document.getElementById('almanac-content').scrollTop]; }")
        assert before[0] < 400, ("the card stands in view above the sheet", before)
        pg.wait_for_timeout(600)
        mid = pg.evaluate("() => { var r = document.querySelector('#almanac-view .almanac-sky-wrap').getBoundingClientRect(); return [r.top, r.height, document.getElementById('almanac-content').scrollTop]; }")
        assert mid == before, (before, mid)
        pg.evaluate("() => _skyToggleSettings(false)")
        assert pg.evaluate("() => !document.getElementById('almanac-sky-set').classList.contains('in')")
        away = pg.evaluate("() => { var c = getComputedStyle(document.getElementById('almanac-sky-set')); return [c.transitionProperty.split(',')[0], c.transitionDuration.split(',')[0]]; }")
        assert away == ["transform", "0.2s"], away
        pg.wait_for_function("() => document.getElementById('almanac-sky-set').hidden", timeout=2000)
        pg.evaluate("() => { _skySet('life', 'off'); _skySet('life', 'on'); }")
        pg.wait_for_function("() => _skyState && _skyState.actors.some(a => a.type === 'plane' || a.type === 'birds')", timeout=45000)   # spawned on the scene's own timer, which a slow renderer stretches
        assert not errors, errors
    finally:
        ctx.close()


def test_the_sky_sheet_closes_by_a_swipe_down_on_its_handle_a_tap_on_the_card_and_escape(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        def shut():
            pg.wait_for_function("() => document.getElementById('almanac-sky-set').hidden", timeout=3000)
            assert pg.evaluate("() => document.getElementById('almanac-sky-gear').getAttribute('aria-expanded')") == "false"

        def open_():
            pg.evaluate("() => _skyToggleSettings(true)")
            pg.wait_for_function("() => document.getElementById('almanac-sky-set').classList.contains('in')")
            pg.wait_for_timeout(500)

        open_()
        g = pg.evaluate("() => { var r = document.getElementById('alm-sky-set-grip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        pg.mouse.move(*g)
        pg.mouse.down()
        pg.mouse.move(g[0], g[1] + 30)
        assert pg.evaluate("() => document.getElementById('almanac-sky-set').style.transform") == "translateY(30px)", "it follows the finger"
        pg.mouse.move(g[0], g[1] + 20)
        pg.mouse.up()
        assert pg.evaluate("() => document.getElementById('almanac-sky-set').classList.contains('in')"), "a short drag springs back"
        # The spring back takes 0.2 s: the handle is back under g only when it has finished (a slow runner starts the second grip mid-flight and misses it).
        pg.wait_for_function(
            "(g) => { var r = document.getElementById('alm-sky-set-grip').getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - g[1]) < 1; }",
            arg=g,
            timeout=3000,
        )
        pg.mouse.move(*g)
        pg.mouse.down()
        pg.mouse.move(g[0], g[1] + 120)
        pg.mouse.up()
        shut()
        open_()
        pg.mouse.click(195, 150)   # the card behind
        shut()
        open_()
        pg.keyboard.press("Escape")
        shut()
        assert pg.evaluate("() => document.activeElement && document.activeElement.id") == "almanac-sky-gear", "focus returns to the gear"
        assert not errors, errors
    finally:
        ctx.close()


def test_closing_the_almanac_with_the_sky_sheet_open_leaves_escape_alone(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate("() => _skyToggleSettings(true)")
        pg.wait_for_function("() => document.getElementById('almanac-sky-set').classList.contains('in')")
        pg.evaluate("() => closeAlmanac()")
        reached = pg.evaluate(
            "() => { var n = 0; document.addEventListener('keydown', function () { n++; }); "
            "var e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); "
            "document.dispatchEvent(e); return [n, e.defaultPrevented]; }"
        )
        assert reached == [1, False], "the sheet's Escape handler is gone with the Almanac"
        assert not errors, errors
    finally:
        ctx.close()


def test_the_sky_sheet_has_an_open_in_3d_row_with_the_rim_glyph(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate("() => _skyToggleSettings(true)")
        row = pg.evaluate("() => { var b = document.getElementById('alm-sky-open3d'); return [b.textContent.trim(), !!b.querySelector('.ae-rim-glyph'), b.getBoundingClientRect().height >= 44]; }")
        assert row == ["Open in 3D", True, True], row
        assert not errors, errors
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


def test_on_a_desktop_the_sky_settings_open_over_the_sky(browser, served):
    """With a mouse and room the settings are a panel over the sky's corner, not a sheet up from the foot (the card
    coming up from the bottom on a desktop is odd; over the sky was right)."""
    ctx, pg, errors = _page(browser, served, desktop=True)
    try:
        pg.evaluate("() => _skyToggleSettings(true)")
        pg.wait_for_function("() => document.getElementById('almanac-sky-set').classList.contains('in')")
        pg.wait_for_timeout(400)
        box, sky = pg.evaluate("() => [document.getElementById('almanac-sky-set'), document.querySelector('#almanac-view .almanac-sky-wrap')].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })")
        assert sky[0] <= box[0] and sky[1] <= box[1] and box[2] <= sky[2] and box[3] <= sky[3], (box, sky)
        assert box[2] - box[0] <= 330, box
        assert pg.evaluate("() => getComputedStyle(document.querySelector('#alm-sky-set-grip')).display") == "none"
        pg.keyboard.press("Escape")
        pg.wait_for_function("() => !document.getElementById('almanac-sky-set').classList.contains('in')")
        assert errors == [], errors
    finally:
        ctx.close()
