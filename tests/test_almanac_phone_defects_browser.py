"""Almanac defects a phone-path test found, each held in a real browser.

On the shipped files, served by Zimi, in headless Chromium at an iPhone 15's
size (390 x 844, touch, mobile). One test per defect, named for it.

Run: pytest tests/test_almanac_phone_defects_browser.py -v
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
POLL_MS = 100
READY_MS = 240_000
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'

ON_PAGE = "() => !!document.getElementById('almanac-orrery') && !!document.getElementById('almanac-head')"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("phone")
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
        warm = br.new_page()
        warm.goto("about:blank")
        warm.evaluate("document.createElement('canvas').getContext('webgl2')")
        warm.close()
        yield br
        br.close()


# The harbour's own zone (PLACE is San Francisco): a tide's day is its midnight to midnight, so a test that
# names a clock time names it here, whatever zone the runner is in.
HARBOUR_TZ = "America/Los_Angeles"


def _page(
    browser,
    served,
    theme="dark",
    reduced=False,
    locale="en-US",
    init=None,
    query="",
    tz=None,
):
    ctx = browser.new_context(
        timezone_id=tz,
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        locale=locale,
        reduced_motion="reduce" if reduced else "no-preference",
        color_scheme="dark" if theme == "dark" else "light",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_app_theme', %r);"
        " localStorage.setItem('zimi_almanac_place', %r);"
        " sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (theme, PLACE, PLACE)
    )
    if init:
        ctx.add_init_script(init)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/" + query + "#almanac", wait_until="load")
    pg.wait_for_function(ON_PAGE, timeout=60_000, polling=POLL_MS)
    pg.wait_for_timeout(800)
    return ctx, pg, errors


def _back_leaves_view_only(pg, open_js, open_flag):
    pg.evaluate(open_js)
    pg.wait_for_function("() => " + open_flag, timeout=READY_MS, polling=200)
    pg.evaluate("history.back()")
    pg.wait_for_function("() => !(" + open_flag + ")", timeout=10_000, polling=POLL_MS)
    pg.wait_for_timeout(400)
    assert pg.evaluate("_almanacOpen") is True
    assert pg.evaluate(
        "document.getElementById('almanac-view').classList.contains('open')"
    )


def test_back_from_earth_keeps_the_almanac(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function("() => typeof _aeLoadThree === 'function'", timeout=60_000)
        _back_leaves_view_only(
            pg,
            "openAlmanacEarth({ target: 'earth' })",
            "(typeof _aeIsOpen !== 'undefined' && _aeIsOpen)",
        )
    finally:
        ctx.close()


def test_the_views_own_close_takes_its_step_back(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function("() => typeof _aeLoadThree === 'function'", timeout=60_000)
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeIsOpen !== 'undefined' && _aeIsOpen",
            timeout=READY_MS,
            polling=200,
        )
        pg.click("#ae-back")
        pg.wait_for_function("() => !_aeIsOpen", timeout=10_000)
        pg.wait_for_timeout(400)
        assert not pg.evaluate("!!(history.state && history.state.aeView)")
        assert pg.evaluate("_almanacOpen") is True
    finally:
        ctx.close()


TOOLS = ".alm-sky-gear, .alm-sky-look"


@pytest.mark.parametrize("locale", ["en-US", "ar"])
def test_the_scene_tools_do_not_overlap_and_take_a_44px_tap(browser, served, locale):
    ctx, pg, errors = _page(browser, served, locale=locale)
    try:
        pg.wait_for_selector(".alm-sky-gear", state="attached", timeout=60_000)
        boxes = pg.evaluate(
            "(sel) => [...document.querySelectorAll(sel)].map(e => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();"
            " const cx = r.x + r.width / 2, cy = r.y + r.height / 2, hit = (dx, dy) => e.contains(document.elementFromPoint(cx + dx, cy + dy));"
            # Drawn small (32 px) so the sky is the picture; the tap lands on it 21 px out each way (an invisible ring).
            " return { n: e.className, x: r.x, y: r.y, w: r.width, h: r.height, tap: [hit(21, 0), hit(-21, 0), hit(0, 21), hit(0, -21)] }; })",
            TOOLS,
        )
        assert len(boxes) == 2, boxes
        for b in boxes:
            assert all(b["tap"]), b
        for i, a in enumerate(boxes):
            for b in boxes[i + 1 :]:
                apart = (
                    a["x"] + a["w"] <= b["x"]
                    or b["x"] + b["w"] <= a["x"]
                    or a["y"] + a["h"] <= b["y"]
                    or b["y"] + b["h"] <= a["y"]
                )
                assert apart, (a, b)
    finally:
        ctx.close()


def test_a_jump_repaints_the_sky_even_when_the_observer_is_stale(browser, served):
    """The sky's in-view flag can be stale (the observer speaks only on crossing the screen's edge): after
    a jump of the clock the picture must still be drawn at the new instant, not left at the old one.
    """
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function(
            "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
            timeout=60_000,
        )
        pg.evaluate(
            "() => document.querySelector('.almanac-sky-wrap').scrollIntoView({ behavior: 'instant', block: 'center' })"
        )
        for i in range(4):
            target = 1_790_000_000_000 + i * 86_400_000 * 3 + i * 7_000_000
            pg.evaluate("() => { _skyState.inView = false; }")
            pg.evaluate("(t) => _almScrubSettle(new Date(t), { land: true })", target)
            pg.wait_for_function(
                "(t) => _skyState && _skyState.paintedTime === t",
                arg=target,
                timeout=8_000,
                polling=POLL_MS,
            )
        assert (
            pg.evaluate("_skyState.inView") is True
        )  # a measured, in-view sky wakes properly
    finally:
        ctx.close()


def test_the_ground_light_is_never_read_back_by_waiting(browser, served):
    """Reading the ground's colours back from the GPU with getImageData stopped the page until the GPU answered (a 25 s
    task on a software GPU, a real stall on a slow phone). The read is asked for once per light, into a buffer on the
    GPU, and taken on a later task: no repaint reads anything synchronously, and the colours still arrive."""
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function(
            "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph && typeof _sgReady === 'function' && _sgReady()",
            timeout=READY_MS,
            polling=250,
        )
        got = pg.evaluate("""() => {
              const s = _skyState;
              if (_skySetting('skin') !== 'beach') _skySet('skin', 'beach');
              let sync = 0, asked = 0;
              const get = CanvasRenderingContext2D.prototype.getImageData, rp = WebGL2RenderingContext.prototype.readPixels;
              const ask = window._sgReadStripAsync;
              CanvasRenderingContext2D.prototype.getImageData = function () { sync++; return get.apply(this, arguments); };
              WebGL2RenderingContext.prototype.readPixels = function () { if (typeof arguments[6] !== 'number') sync++; return rp.apply(this, arguments); };
              window._sgReadStripAsync = function () { const r = ask.apply(this, arguments); if (r) asked++; return r; };
              s.ground = null; s.lightKey = null;
              for (let i = 0; i < 6; i++) { s.baseDirty = true; _skyPaintBase(s, performance.now()); }
              CanvasRenderingContext2D.prototype.getImageData = get;
              WebGL2RenderingContext.prototype.readPixels = rp;
              window._sgReadStripAsync = ask;
              return { sync, asked };
            }""")
        assert got == {"sync": 0, "asked": 1}, got
        # The GPU answers when it gets there (a software GPU on a busy machine can be far behind); the page never waits.
        pg.wait_for_function("() => !!_skyState.ground", timeout=120_000, polling=100)
        assert not errors, errors
    finally:
        ctx.close()


def test_the_hero_is_the_picture_of_the_moon_and_nothing_stands_in_for_it(browser, served):
    """Eric, 2026-10-18: the Moon was simpler as a picture that opens the 3D view. No live 3D scene stands in the hero
    (it once showed only a shadow), and there is no pull-back through the solar system."""
    ctx, pg, errors = _page(browser, served, query="?rest=system")
    try:
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady()",
            timeout=READY_MS,
            polling=250,
        )
        got = pg.evaluate("""() => ({
              live: document.getElementById('almanac-view').classList.contains('lp-live'),
              landing: typeof _lpRelease !== 'undefined' || typeof _lpQueueDrag !== 'undefined',
              canvasInHero: !!document.querySelector('.almanac-hero canvas#ae-canvas'),
              sprite: (() => { const i = document.querySelector('.almanac-hero img.almanac-moon-sprite'); return !!i && i.complete && i.naturalWidth > 0 && getComputedStyle(i).visibility !== 'hidden'; })()
            })""")
        assert got == {"live": False, "landing": False, "canvasInHero": False, "sprite": True}, got
        assert pg.evaluate("() => typeof _lpRestSystem === 'undefined' && typeof openAlmanacSpace === 'undefined'")
        assert not pg.query_selector(".orrery-space-btn")
    finally:
        ctx.close()


@pytest.mark.parametrize("theme", ["red", "dark"])
def test_a_lit_section_pill_never_shows_its_unlit_text_on_the_lit_ground(
    browser, served, theme
):
    ctx, pg, errors = _page(browser, served, theme=theme)
    try:
        pg.wait_for_function(
            "() => typeof _almSecBar !== 'undefined' && _almSecBar && _almSecBar.sections",
            timeout=60_000,
        )
        got = pg.evaluate("""() => {
              const bar = document.getElementById('alm-secbar');
              bar.hidden = false;
              const keys = _almSecBar.sections.map(s => s.key).filter(k => k !== ALM_SECBAR_HERO);
              _almSecBar.cur = keys[0]; _almSecBarPaint();
              void bar.offsetWidth;
              _almSecBar.cur = keys[2]; _almSecBarPaint();
              const lit = bar.querySelector('.pill.active');
              const c = getComputedStyle(lit);
              return { color: c.color, on: getComputedStyle(document.documentElement).getPropertyValue('--on-amber').trim() };
            }""")
        assert got["color"] in ("rgb(0, 0, 0)", "rgb(255, 255, 255)"), got
    finally:
        ctx.close()


def test_tapping_saved_keeps_the_toggle_under_the_finger(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate(
            "() => { localStorage.removeItem('zimi_almanac_clocks'); localStorage.removeItem('zimi_almanac_clocks_view'); }"
        )
        pg.reload()
        pg.wait_for_function(
            "() => document.querySelectorAll('#almanac-tz-pills .alm-tz-city-card').length > 5",
            timeout=60_000,
        )
        # The late sections above (the head, the sky's line) have arrived, so the one scroll left to move the page is
        # the tap's own; and a finger lands where the button is, as Playwright's tap would not (it scrolls the
        # element into view again when the page moved under its check, and that scroll is not the page's).
        pg.wait_for_function("() => !_almLateArriving()", timeout=60_000)
        pg.evaluate(
            "() => document.getElementById('almanac-tz-view').scrollIntoView({ behavior: 'instant', block: 'center' })"
        )
        pg.wait_for_timeout(800)
        rect = lambda: pg.evaluate(
            "() => { const r = document.querySelector('#almanac-tz-view .alm-scope-btn:nth-child(2)').getBoundingClientRect(); return [r.left + r.width / 2, r.top, r.top + r.height / 2]; }"
        )
        top = lambda: rect()[1]
        x, before, y = rect()
        pg.touchscreen.tap(x, y)
        pg.wait_for_function(
            "() => !!document.querySelector('.alm-tz-hint')", timeout=10_000
        )
        assert abs(top() - before) < 2, (before, top())
        hint = pg.evaluate(
            "() => { const r = document.querySelector('.alm-tz-hint').getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; }"
        )
        assert 0 < hint[0] and hint[1] < hint[2], hint
    finally:
        ctx.close()


def test_a_clock_cards_light_follows_the_suns_real_height(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function("() => typeof _almTzPhase === 'function'", timeout=60_000)
        got = pg.evaluate("""() => ({
              // Midnight in Reykjavik at midsummer: the Sun is just under the horizon, not night.
              reykjavik: _almTzPhase('Atlantic/Reykjavik', new Date(Date.UTC(2026, 5, 21, 0, 0))),
              // 7:30 on a December morning in Tokyo: the Sun has been up for 40 minutes.
              tokyo: _almTzPhase('Asia/Tokyo', new Date(Date.UTC(2026, 11, 20, 22, 30))),
              // 6:30 pm in Tokyo in December: down for an hour and a half.
              tokyo_eve: _almTzPhase('Asia/Tokyo', new Date(Date.UTC(2026, 11, 21, 9, 30))),
              noon: _almTzPhase('Europe/Paris', new Date(Date.UTC(2026, 9, 17, 11, 0))),
              deep: _almTzPhase('Europe/Paris', new Date(Date.UTC(2026, 9, 17, 1, 0))),
            })""")
        assert got["reykjavik"] in ("dawn", "dusk"), got
        assert got["tokyo"] == "day", got
        assert got["tokyo_eve"] in ("dusk", "night"), got
        assert got["noon"] == "day" and got["deep"] == "night", got
    finally:
        ctx.close()


def test_german_almanac_speaks_german(browser, served):
    ctx, pg, errors = _page(
        browser,
        served,
        locale="de-DE",
        init="try { localStorage.setItem('zimi_ui_lang', 'de'); } catch (e) {}",
    )
    try:
        pg.wait_for_function(
            "() => typeof _almDayMonthYear === 'function' && document.querySelector('.alm-tz-city-time')",
            timeout=60_000,
        )
        got = pg.evaluate("""() => ({
              date: _almDayMonthYear(17, 'Oktober', '2026'),
              holiday: _th('World Water Day'),
              num: _orrNum(3.5, null, 1),
              cardTimes: [...document.querySelectorAll('.alm-tz-city-time')].map(e => e.textContent),
              bigClock: document.getElementById('almanac-tz-label').textContent,
              analemma: t('alm_analemma'),
              evening: t('alm_evening_sky'),
              elong: t('alm_event_elongation', { planet: 'Merkur', event: t('alm_greatest_elongation') }),
            })""")
        assert got["date"] == "17. Oktober 2026", got
        # A numbered month is written 1 + 月; a named one already ends in it.
        zh = pg.evaluate("() => { const was = _currentLang; _currentLang = 'zh'; try { return _almDayMonthYear(17, '一月', '2000'); } finally { _currentLang = was; } }")
        assert zh == "2000年一月17日", zh
        assert got["holiday"] == "Weltwassertag", got
        assert got["num"] == "3,5", got
        # The hour cycle is German's own (24 hours), as the header's is: no AM or PM on any clock.
        assert not any(
            "AM" in x or "PM" in x for x in got["cardTimes"] + [got["bigClock"]]
        ), got
        assert (
            got["analemma"] == "Das Analemma" and got["evening"] == "Abendhimmel"
        ), got
        assert got["elong"] == "Merkur: größte Elongation", got
        # The analemma's month labels are German ("Dez", not "Dec").
        labels = pg.evaluate(
            """() => { const out = []; const f = CanvasRenderingContext2D.prototype.fillText;
              CanvasRenderingContext2D.prototype.fillText = function (s) { out.push(String(s)); return f.apply(this, arguments); };
              _renderAnalemma(new Date(2026, 9, 17)); CanvasRenderingContext2D.prototype.fillText = f; return out; }"""
        )
        assert "Dez" in labels or "Dez." in labels, labels
        assert "Dec" not in labels, labels
    finally:
        ctx.close()


def test_the_orrery_is_still_at_now_under_reduced_motion(browser, served):
    ctx, pg, errors = _page(browser, served, reduced=True)
    try:
        try:   # the orrery is set up after the page's first paint; a slow runner takes longer than a fixed wait
            pg.wait_for_function("() => typeof _orreryPlaying !== 'undefined' && document.getElementById('orrery-speed-label') && !_orreryPlaying", timeout=15_000)
        except Exception:
            pass
        got = pg.evaluate(
            "() => ({ playing: _orreryPlaying, speed: _orrerySpeed, raf: !!_almanacOrreryRAF, offset: _orreryTimeOffset,"
            " label: document.getElementById('orrery-speed-label').textContent })"
        )
        assert (
            got["playing"] is False
            and got["speed"] == 1
            and not got["raf"]
            and got["offset"] == 0
        ), got
        assert "100" not in got["label"], got
    finally:
        ctx.close()
    ctx, pg, errors = _page(browser, served, reduced=False)
    try:
        assert pg.evaluate("() => _orreryPlaying && _orrerySpeed === 100000")
    finally:
        ctx.close()


def test_a_sky_left_alone_stops_asking_for_frames_and_wakes_on_a_touch(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function(
            "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
            timeout=60_000,
        )
        pg.evaluate(
            "() => document.querySelector('.almanac-sky-wrap').scrollIntoView({ behavior: 'instant', block: 'center' })"
        )
        pg.evaluate(
            "() => { if (_skySetting('skin') !== 'beach') _skySet('skin', 'beach'); _skyArm(); }"
        )
        # Being looked at, the breeze runs (once the page has seen the sky come into view).
        pg.wait_for_function(
            "() => !!_skyTimers.sway || !!_almanacSkyRAF", timeout=10_000, polling=POLL_MS
        )
        # The sky's own frames: the world clock ticks a frame a second by design, and the satellite poll asks for one
        # to paint the positions it brings; neither is the sky running a loop.
        pg.evaluate(
            """() => { window.__raf = 0; const r = window.requestAnimationFrame;
              window.requestAnimationFrame = function (f) {
                const at = new Error().stack || '';
                if (at.indexOf('almanac-sky.js') >= 0 && at.indexOf('_skyPollSatsTick') < 0) window.__raf++;
                return r.call(window, f); }; }"""
        )
        # Left alone: backdated attention holds once the page has stopped re-arming the sky (a late redraw, a
        # scene re-made after the place or the tides arrive, counts as opening it again).
        pg.wait_for_function(
            "() => { const t = performance.now(); if (window.__armAt === undefined) { window.__armAt = _skyAttentionAt; window.__armT = t; }"
            " if (_skyAttentionAt !== window.__armAt) { window.__armAt = _skyAttentionAt; window.__armT = t; } return t - window.__armT > 1500; }",
            timeout=20_000, polling=100,
        )
        pg.evaluate(
            "() => { _skyAttentionAt = performance.now() - 10 * SKY_BREEZE_IDLE_MS; }"
        )
        pg.wait_for_timeout(600)  # the last frame asked for
        pg.evaluate("() => { window.__raf = 0; }")
        pg.wait_for_timeout(2500)
        idle = pg.evaluate("() => ({ raf: window.__raf, sway: _skyTimers.sway })")
        assert idle["sway"] == 0 and idle["raf"] <= 3, idle
        pg.evaluate(
            "() => document.dispatchEvent(new Event('pointerdown', { bubbles: true }))"
        )
        pg.wait_for_timeout(300)
        assert pg.evaluate("() => !!_skyTimers.sway || !!_almanacSkyRAF")
    finally:
        ctx.close()


def test_star_chart_names_do_not_stand_on_each_other(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function(
            "() => typeof _drawStarChart === 'function' && !!document.getElementById('almanac-starchart')",
            timeout=60_000,
        )
        boxes = pg.evaluate("""() => {
              const out = [], f = CanvasRenderingContext2D.prototype.fillText;
              CanvasRenderingContext2D.prototype.fillText = function (s, x, y) {
                const w = this.measureText(String(s)).width, a = this.textAlign;
                out.push({ s: String(s), x0: a === 'right' ? x - w : a === 'center' ? x - w / 2 : x, x1: a === 'right' ? x : a === 'center' ? x + w / 2 : x + w, y0: y - 9, y1: y + 1, size: parseFloat(/([0-9.]+)px/.exec(this.font)[1]) });
                return f.apply(this, arguments);
              };
              _drawStarChart(new Date(Date.UTC(2026, 9, 17, 7, 12)));
              CanvasRenderingContext2D.prototype.fillText = f;
              return out.filter(b => b.size < 12);
            }""")
        names = {b["s"] for b in boxes}
        assert {"Aldebaran", "Uranus", "Saturn", "Neptune"} <= names, names
        clash = [
            (a["s"], b["s"])
            for i, a in enumerate(boxes)
            for b in boxes[i + 1 :]
            if a["x0"] < b["x1"]
            and b["x0"] < a["x1"]
            and a["y0"] < b["y1"]
            and b["y0"] < a["y1"]
        ]
        assert not clash, clash
    finally:
        ctx.close()


def test_a_tide_turns_time_keeps_clear_of_a_dot(browser, served):
    ctx, pg, errors = _page(browser, served, tz=HARBOUR_TZ)
    try:
        pg.evaluate(
            "() => document.getElementById('almanac-place').scrollIntoView({ behavior: 'instant' })"
        )
        pg.wait_for_selector("#almanac-place .at-section", timeout=60_000)
        # The end of the day: the clock's dot stands where the day's last turn is.
        pg.evaluate(
            "() => _almScrubSettle(new Date(2026, 9, 16, 23, 17), { land: false })"
        )
        # A slow runner repaints later: wait for the dot to stand at 23:17.
        pg.wait_for_function(
            """() => {
              const d = document.getElementById('at-now-dot'), c = _at.curve;
              const t = new Date(2026, 9, 16, 23, 17).getTime();
              return d && c && t >= c.start && t <= c.end &&
                Math.abs(+d.getAttribute('cx') - c.X(t)) < 1;
            }""",
            timeout=30_000,
        )
        pairs = pg.evaluate("""() => {
              const svg = document.querySelector('#almanac-place .at-section svg[role=img], #almanac-place svg[role=img]');
              const GAP = 4, rect = (e) => { const r = e.getBoundingClientRect(); return { x0: r.left - GAP, x1: r.right + GAP, y0: r.top - GAP, y1: r.bottom + GAP }; };
              const labels = [...svg.querySelectorAll('.at-turn-l:not(.at-yield)')].map(e => ({ s: e.textContent, ...rect(e) }));
              const dots = [...svg.querySelectorAll('circle.at-now-dot')].map(e => ({ c: e.getAttribute('class'), ...rect(e) }));
              const hit = [];
              for (const l of labels) for (const d of dots)
                if (l.x0 < d.x1 && d.x0 < l.x1 && l.y0 < d.y1 && d.y0 < l.y1) hit.push([l.s, d.c]);
              return { labels: labels.length, hit };
            }""")
        assert (
            pairs["labels"] >= 2
        ), pairs  # (the clock's dot is the one a label at the day's end runs into)
        assert not pairs["hit"], pairs
    finally:
        ctx.close()


# The day the dot test is held on (noon in the harbour): tides move 50 minutes a day, so a test run on "today" meets a
# different set of turns each day, and on some days the first turn is so near the day's start that its time is
# written clear of the edge, where the dot can never stand on it.
DOT_DAY_UTC_MS = "Date.UTC(2026, 9, 16, 19, 0)"


def test_a_turns_time_steps_back_while_the_clock_dot_is_on_it(browser, served):
    """The dot travels the whole curve, so at a turn it stands on that
    turn's time: the time fades while it does, and comes back after."""
    ctx, pg, errors = _page(browser, served, tz=HARBOUR_TZ)
    try:
        pg.evaluate(
            "() => document.getElementById('almanac-place').scrollIntoView({ behavior: 'instant' })"
        )
        pg.wait_for_selector("#almanac-place .at-section", timeout=60_000)
        # A fixed day, drawn: its curve, its turns and their times measured.
        pg.evaluate(
            "() => _almScrubSettle(new Date(%s), { land: false })" % DOT_DAY_UTC_MS
        )
        pg.wait_for_function(
            """() => {
              const c = _at.curve, t = %s;
              return !!c && t >= c.start && t <= c.end && _at.labels && _at.labels.length > 0 &&
                document.querySelectorAll('#almanac-place circle.at-dot').length > 1;
            }"""
            % DOT_DAY_UTC_MS,
            timeout=30_000,
            polling=POLL_MS,
        )
        # The turns the dot can stand on: where it is at the turn, the time written over it (the first turn of a
        # day that begins just after midnight has its time moved clear of the edge, and the dot is not on that).
        turn = pg.evaluate(
            """() => {
              const c = _at.curve, labels = _at.labels, g = AT_YIELD_GAP;
              for (const dot of document.querySelectorAll('#almanac-place circle.at-dot')) {
                const cx = +dot.getAttribute('cx');
                let a = c.start, b = c.end;
                for (let i = 0; i < 50; i++) { const m = (a + b) / 2; if (c.X(m) < cx) a = m; else b = m; }
                const x = c.X(a), y = c.Y(c.p.height(a));
                if (labels.some(l => l.x0 < x + g && x - g < l.x1 && l.y0 < y + g && y - g < l.y1)) return a;
              }
              return null;
            }"""
        )
        assert turn is not None, "no turn of the day has its time where the dot can stand"
        shown = "() => [...document.querySelectorAll('#almanac-place .at-turn-l')].filter(e => !e.classList.contains('at-yield')).length"
        total = pg.evaluate("() => document.querySelectorAll('#almanac-place .at-turn-l').length")
        pg.evaluate("(t) => _almScrubSettle(new Date(t), { land: false })", turn)
        pg.wait_for_function(
            "(n) => (%s)() < n" % shown, arg=total, timeout=30_000, polling=POLL_MS
        )
        pg.evaluate(
            "(t) => _almScrubSettle(new Date(t + 3 * 3600e3), { land: false })", turn
        )
        pg.wait_for_function(
            "(n) => (%s)() === n" % shown, arg=total, timeout=30_000, polling=POLL_MS
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_reopening_the_almanac_opens_at_the_top(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate(
            "() => { document.getElementById('almanac-content').scrollTop = 3000; }"
        )
        pg.wait_for_timeout(500)
        assert (
            pg.evaluate("() => document.getElementById('almanac-content').scrollTop")
            > 1000
        )
        pg.evaluate("() => closeAlmanac()")
        pg.evaluate("() => openAlmanac()")
        pg.wait_for_function(
            "() => _almanacOpen && !!document.getElementById('almanac-head')",
            timeout=30_000,
        )
        pg.wait_for_timeout(1500)
        assert (
            pg.evaluate("() => document.getElementById('almanac-content').scrollTop")
            < 5
        )
        # Closing held the loops; a fresh open lets the orrery run again
        # when it scrolls back into view.
        assert pg.evaluate("() => _almanacLoopsHeld") is False
    finally:
        ctx.close()


def test_no_page_load_asks_the_server_for_the_phones_own_list(browser, served):
    ctx = browser.new_context(viewport=VIEW, service_workers="block", locale="en-US")
    pg = ctx.new_page()
    seen, failed = [], []
    pg.on("request", lambda r: seen.append(r.url))
    pg.on("response", lambda r: failed.append(r.url) if r.status == 404 else None)
    try:
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_timeout(2500)
        assert not [u for u in seen if "/keep-local/" in u], seen
        assert not failed, failed
    finally:
        ctx.close()


def test_resizing_the_page_raises_no_resize_observer_loop_error(browser, served):
    ctx, pg, errors = _page(
        browser,
        served,
        init="window.__loop = []; window.addEventListener('error', e => window.__loop.push(e.message));",
    )
    try:
        pg.wait_for_function(
            "() => typeof _almSecBar !== 'undefined' && _almSecBar && _almSecBar.ro",
            timeout=60_000,
        )
        for h in (700, 844, 760, 844):
            pg.set_viewport_size({"width": 390, "height": h})
            pg.wait_for_timeout(400)
        # A late section arriving, as the tide does, is a size change the bar also answers.
        pg.evaluate(
            "() => { const p = document.getElementById('almanac-place'); p.style.minHeight = '900px'; }"
        )
        pg.wait_for_timeout(600)
        pg.evaluate(
            "() => { const p = document.getElementById('almanac-place'); p.style.minHeight = ''; }"
        )
        pg.wait_for_timeout(600)
        assert pg.evaluate("() => window.__loop") == []
    finally:
        ctx.close()


def test_opening_look_makes_no_second_three_and_no_texture_error(browser, served):
    ctx, pg, errors = _page(browser, served)
    msgs = []
    pg.on("console", lambda m: msgs.append(m.text))
    try:
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady()",
            timeout=READY_MS,
            polling=250,
        )
        pg.evaluate("() => document.querySelector('.alm-sky-look').click()")
        pg.wait_for_function(
            "() => typeof _look !== 'undefined' && _look && _look.skyMounted",
            timeout=60_000,
            polling=POLL_MS,
        )
        pg.wait_for_timeout(1500)
        bad = [
            m
            for m in msgs
            if "Multiple instances of Three.js" in m or "texParameter" in m
        ]
        assert not bad, bad
        # Look is the sky edge to edge: no globe of its own to load, and no way out to a second view.
        assert pg.evaluate("() => !document.getElementById('look-globe') && !document.getElementById('look-earth')")
        assert not errors, errors
    finally:
        ctx.close()


IOS_MOTION = """
  window.DeviceOrientationEvent = window.DeviceOrientationEvent || function () {};
  window.__asked = 0; window.__askedBeforeLoad = null;
  window.DeviceOrientationEvent.requestPermission = () => {
    window.__asked++; if (window.__askedBeforeLoad === null) window.__askedBeforeLoad = typeof window.openAlmanacLookNow === 'undefined';
    return Promise.resolve('granted');
  };
"""


def test_look_asks_for_motion_in_the_tap_that_opens_it(browser, served):
    ctx, pg, errors = _page(browser, served, init=IOS_MOTION)
    try:
        pg.wait_for_selector(".alm-sky-look", timeout=60_000)
        pg.tap(".alm-sky-look")
        pg.wait_for_function(
            "() => typeof _look !== 'undefined' && _look && _look.sensing",
            timeout=30_000,
            polling=POLL_MS,
        )
        got = pg.evaluate(
            "() => ({ asked: window.__asked, early: window.__askedBeforeLoad, ask: !document.getElementById('look-ask').hidden })"
        )
        # Asked once, in the tap's own turn (before the view's files had loaded), and no second tap to turn it on.
        assert got == {"asked": 1, "early": True, "ask": False}, got
    finally:
        ctx.close()
