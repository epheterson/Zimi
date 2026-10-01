"""The Almanac's live sky in a real browser: taps, the one clock, the cost.

On the shipped files, served by Zimi, in headless Chromium (SwiftShader for
the 3D view), at a phone's width, San Francisco chosen as the place:

  1. Taps. The Sun (by day) and the Moon (by night) open the 3D view on
     themselves, its Back saying Almanac; a planet is named, and its button
     brings the solar system into view with that planet's tip open. The
     orrery's Sun opens the 3D view on the Sun.
  2. One clock. The sky shows the page's instant: the time machine's settle
     moves it there, Back to Now brings it to now, and live a timer (not a
     frame loop) keeps it there.
  3. The cost. Nothing in the frame loop once the sky is still; motion
     reduced, no twinkle and no muons, and a still muon to tap instead.
  4. Light clock: on a ride at 0.8c, gamma 1.67 beside the two clocks.

The positions themselves are held to JPL Horizons in
tests/test_almanac_live_sky.cjs.

Run: pytest tests/test_almanac_live_sky_browser.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
VIEW = {"width": 390, "height": 844}
PLACE = {"lat": 37.7749, "lon": -122.4194, "name": "San Francisco"}
DAY = "2026-09-30T21:00:00Z"  # 14:00 in San Francisco, the Sun high in the south
NIGHT = (
    "2026-10-01T06:00:00Z"  # 23:00, the Moon up in the east, Saturn in the southeast
)
POLL_MS = 100


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("livesky")
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


def _almanac(browser, served, reduced=False, place=PLACE):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        reduced_motion="reduce" if reduced else "no-preference",
    )
    ctx.add_init_script(
        "localStorage.setItem('zimi_almanac_place', %s);"
        % json.dumps(json.dumps(place))
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
        polling=POLL_MS,
    )
    return ctx, pg, errors


def _settle(pg, iso):
    pg.evaluate("(iso) => _almScrubSettle(new Date(iso))", iso)
    pg.wait_for_function(
        "(t) => _skyState && _skyState.nowTime === t && !_skyState.moonAnim && _skyState.bodies.length",
        arg=_ms(iso),
        polling=POLL_MS,
    )


def _ms(iso):
    from datetime import datetime

    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _tap_body(pg, kind, name=None):
    """Tap the canvas where the sky drew a body (CSS px from its record)."""
    pg.locator("#almanac-sky-canvas").scroll_into_view_if_needed()
    pg.wait_for_timeout(200)
    b = pg.evaluate(
        "([k, n]) => { const b = _skyState.bodies.find((x) => x.type === k && (!n || x.name === n));"
        " const r = _skyState.canvas.getBoundingClientRect(); if (!b) return null; const x = b.type === 'muon' ? (b.x0 + b.x1) / 2 : b.x, y = b.type === 'muon' ? (b.y0 + b.y1) / 2 : b.y; return { x: r.left + x, y: r.top + y }; }",
        [kind, name],
    )
    assert b, "%s %s is drawn" % (kind, name or "")
    pg.touchscreen.tap(b["x"], b["y"])


def _wait_still(pg, sel):
    """Until the element holds its place on screen for a few frames."""
    pg.wait_for_function(
        "(s) => { const y = document.querySelector(s).getBoundingClientRect().top;"
        " const w = window.__still || (window.__still = { y: null, n: 0 });"
        " w.n = y === w.y ? w.n + 1 : 0; w.y = y; return w.n >= 3; }",
        arg=sel,
        polling=150,
    )


def _wait_view(pg, target):
    pg.wait_for_function(
        "(t) => _aeIsOpen && _ae.preset === t",
        arg=target,
        timeout=60000,
        polling=POLL_MS,
    )


def test_the_sun_and_the_moon_open_the_3d_view_on_themselves(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, DAY)
        _tap_body(pg, "sun")
        _wait_view(pg, "sun")
        assert pg.evaluate(
            "document.getElementById('ae-back-text').textContent"
        ) == pg.evaluate("t('almanac')")
        # The view keeps the page's clock: it shows the sky's instant.
        assert abs(pg.evaluate("_aeDisplayMs()") - _ms(DAY)) < 60000
        pg.evaluate("_aeClose()")
        pg.wait_for_function("() => !_aeIsOpen", polling=POLL_MS)
        _settle(pg, NIGHT)
        _tap_body(pg, "moon")
        _wait_view(pg, "moon")
        pg.evaluate("_aeClose()")
        pg.wait_for_function("() => !_aeIsOpen", polling=POLL_MS)
        assert not errors, errors
    finally:
        ctx.close()


def test_a_planet_is_named_and_found_in_the_solar_system(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        _tap_body(pg, "planet", "Saturn")
        tip = pg.locator("#almanac-sky-tip")
        assert tip.is_visible()
        assert pg.evaluate("_tp('Saturn')") in tip.inner_text()
        btn = tip.locator("[data-sky-orrery]")
        assert btn.inner_text() == pg.evaluate("t('alm_sky_find_orrery')")
        box = tip.bounding_box()
        assert box["x"] >= 0 and box["x"] + box["width"] <= VIEW["width"]
        btn.tap()
        assert not tip.is_visible()
        pg.wait_for_function(
            "() => { const r = document.getElementById('almanac-orrery').getBoundingClientRect();"
            " return r.top >= 0 && r.bottom <= innerHeight + 1; }",
            polling=POLL_MS,
            timeout=15000,
        )
        orr_tip = pg.locator("#orrery-tooltip")
        assert (
            orr_tip.is_visible()
            and pg.evaluate("_tp('Saturn')") in orr_tip.inner_text()
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_the_orrery_sun_opens_the_3d_view_on_the_sun(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        pg.evaluate(
            "_orrerySnapToNow(); document.getElementById('almanac-orrery').scrollIntoView({ block: 'center' })"
        )
        # The bar above the Almanac slides away after a scroll down; tap once
        # the orrery has stopped moving with it.
        _wait_still(pg, "#almanac-orrery")
        sun = pg.evaluate(
            "() => { const r = document.getElementById('almanac-orrery').getBoundingClientRect();"
            " const s = _orreryWorldToScreen(_orrerySunPos.x, _orrerySunPos.y); return { x: r.left + s.x, y: r.top + s.y }; }"
        )
        # Touch: the first tap names it, with the way in; the second goes there.
        pg.touchscreen.tap(sun["x"], sun["y"])
        btn = pg.locator("#orrery-tooltip [data-orr-earth='sun']")
        assert btn.is_visible() and btn.inner_text() == pg.evaluate(
            "t('alm_orr_sun_view')"
        )
        pg.touchscreen.tap(sun["x"], sun["y"])
        _wait_view(pg, "sun")
        assert pg.evaluate(
            "document.getElementById('ae-back-text').textContent"
        ) == pg.evaluate("t('alm_solar_system')")
        assert not errors, errors
    finally:
        ctx.close()


def test_one_clock(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        # Live: the sky is at now, kept there by a timer.
        assert abs(pg.evaluate("_skyState.nowTime") - pg.evaluate("Date.now()")) < 60000
        assert pg.evaluate("!!_skyTimers.live")
        # Scrubbed: the sky is at the focus, and no live timer runs.
        _settle(pg, NIGHT)
        assert pg.evaluate("_skyState.nowTime") == _ms(NIGHT)
        assert pg.evaluate("!_skyTimers.live")
        assert pg.evaluate("_skyState.eph.sunGeoAlt") < -18
        # A time-machine frame moves the sky in the same call (the Moon glides).
        pg.evaluate("_skySetInstant(new Date('2026-10-01T07:00:00Z'))")
        assert pg.evaluate("_skyState.now.getTime()") == _ms("2026-10-01T07:00:00Z")
        # Back to now.
        pg.evaluate("_almBackToToday()")
        pg.wait_for_function(
            "() => Math.abs(_skyState.nowTime - Date.now()) < 60000 && !!_skyTimers.live",
            polling=POLL_MS,
        )
        # Still: once the glide has landed, no frame loop.
        pg.wait_for_function(
            "() => !_skyState.moonAnim && !_heroMoonAnim", polling=POLL_MS
        )
        # Nothing crossing the sky either (planes, birds, meteors run their
        # own light loop while on screen: test_life_on_the_horizon).
        pg.evaluate(
            "() => { Object.keys(SKY_SPAWNERS).forEach((k) => clearTimeout(_skyTimers[k]));"
            " _skyState.actors = []; _skyState.issUp = false; }"
        )
        pg.wait_for_timeout(300)
        frames = pg.evaluate("""() => new Promise((done) => {
          let n = 0; const r = window.requestAnimationFrame;
          window.requestAnimationFrame = (f) => { if (f === _skyLoop) n++; return r.call(window, f); };
          setTimeout(() => { window.requestAnimationFrame = r; done(n); }, 1000);
        })""")
        # The palms' breeze asks for a frame every SKY_SWAY_MS (twelve a
        # second); a twinkle or a muon's fall a frame or two more; a loop
        # would ask ~60.
        assert frames <= 1000 / pg.evaluate("SKY_SWAY_MS") + 3, frames
        assert not errors, errors
    finally:
        ctx.close()


DENVER = {"lat": 39.74, "lon": -104.99, "name": "Denver"}
TROMSO = {"lat": 69.65, "lon": 18.96, "name": "Tromso"}
TROMSO_NIGHT = "2026-10-01T22:00:00Z"


def _drag(pg, dx, dy, steps=8):
    pg.locator("#almanac-sky-canvas").scroll_into_view_if_needed()
    pg.wait_for_timeout(200)
    r = pg.evaluate(
        "() => { const r = _skyState.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; }"
    )
    pg.mouse.move(r["x"], r["y"])
    pg.mouse.down()
    for i in range(1, steps + 1):
        pg.mouse.move(r["x"] + dx * i / steps, r["y"] + dy * i / steps)
    pg.mouse.up()


def test_dragging_looks_round_the_whole_horizon(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        c0 = pg.evaluate("_skyState.center")
        assert c0 == 180  # facing the equator to begin with
        assert "facing S" in pg.inner_text("#almanac-sky-cap")
        width = pg.evaluate("_skyState.cssW")
        span = pg.evaluate("SKY_SPAN_DEG")
        _drag(pg, -width / 2, 0)  # drag left: the view turns right (west)
        c1 = pg.evaluate("_skyState.center")
        turned = ((c1 - c0) + 540) % 360 - 180
        assert abs(turned - span / 2) < span * 0.08, turned
        # 180 + 120 = 300 degrees: the compass word follows (no fixed heading).
        assert "facing NW" in pg.inner_text("#almanac-sky-cap")
        # The south point has moved left by what was turned.
        x = pg.evaluate("_skyX(_skyState, 180) / _skyState.dpr")
        assert abs(x - (width / 2 - turned / span * width)) < 2, x
        # A drag is not a tap: no tip opened.
        assert not pg.locator("#almanac-sky-tip").is_visible()
        # The keyboard turns it too.
        pg.focus("#almanac-sky-canvas")
        pg.keyboard.press("ArrowRight")
        assert (
            abs(((pg.evaluate("_skyState.center") - c1) + 540) % 360 - 180 - 15) < 1e-6
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_life_on_the_horizon(browser, served):
    """The coast has the sea at its tide, inland the land; the moving things
    run a light loop only while one is on screen, and each says what it is."""
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, DAY)
        # Nothing spawns on its own during this test: each thing is put there.
        pg.evaluate(
            "() => { Object.keys(SKY_SPAWNERS).forEach((k) => { clearTimeout(_skyTimers[k]); SKY_FIRST_SPAWN_MS[k] = 1e9; });"
            " [SKY_PLANE_GAP_S, SKY_BIRD_GAP_S, SKY_MUON_GAP_MS].forEach((g) => { g[0] = g[1] = 1e9; });"
            " clearTimeout(_skyTimers.muon); _skyState.muons = []; _skyState.actors = []; _skyKick(); }"
        )
        pg.wait_for_function("() => !!_skyState.sea", polling=POLL_MS, timeout=60000)
        sea = pg.evaluate("_skyState.sea")
        assert 0 <= sea["frac"] <= 1
        # Its level is the tide's: a later instant at the other end of the day's range.
        assert sea["name"]
        assert pg.evaluate("_skyState.bodies.some((b) => b.type === 'boat')")
        # Tap the sea: the tide there.
        pg.locator("#almanac-sky-canvas").scroll_into_view_if_needed()
        pg.wait_for_timeout(200)
        box = pg.evaluate(
            "() => { const b = _skyState.bodies.find((x) => x.type === 'sea'); const r = _skyState.canvas.getBoundingClientRect();"
            " return { x: r.left + (b.box[0] + b.box[2]) / 2 + 40, y: r.top + (b.box[1] + b.box[3]) / 2 }; }"
        )
        pg.touchscreen.tap(box["x"], box["y"])
        tip = pg.locator("#almanac-sky-tip")
        assert tip.is_visible()
        assert pg.evaluate("t('alm_sky_sea')") in tip.inner_text()
        # A plane: frames while it crosses, none once it has gone.
        pg.evaluate(
            "() => { Object.keys(SKY_SPAWNERS).forEach((k) => { clearTimeout(_skyTimers[k]); SKY_FIRST_SPAWN_MS[k] = 1e9; });"
            " [SKY_PLANE_GAP_S, SKY_BIRD_GAP_S, SKY_MUON_GAP_MS].forEach((g) => { g[0] = g[1] = 1e9; }); clearTimeout(_skyTimers.muon); _skyState.muons = [];"
            " const a = _skyCrossing(_skyState, 'plane', [6, 6], [30, 30]); _skyState.actors = [a]; _skyKick(); }"
        )
        moving = pg.evaluate("""() => new Promise((done) => {
          const n0 = _skyState.paints || 0;
          setTimeout(() => done({ painted: (_skyState.paints || 0) - n0, loop: !!_almanacSkyRAF }), 1000);
        })""")
        # It moves frame by frame while on screen (a loaded test machine draws
        # few frames a second; the thirty-a-second cap is held in
        # test_almanac_live_sky.cjs).
        assert moving["painted"] >= 1 and moving["loop"], moving
        pg.wait_for_function(
            "() => _skyState.actors.length === 0", polling=POLL_MS, timeout=30000
        )
        pg.wait_for_timeout(200)
        after = pg.evaluate("""() => new Promise((done) => {
          let n = 0; const r = window.requestAnimationFrame;
          window.requestAnimationFrame = (f) => { if (f === _skyLoop) n++; return r.call(window, f); };
          setTimeout(() => { window.requestAnimationFrame = r; done(n); }, 700);
        })""")
        assert after <= 2, after
        assert pg.evaluate("_skyState.actors.length") == 0
        # Birds by day, named on a tap.
        pg.evaluate(
            "() => { const b = _skyCrossing(_skyState, 'birds', [600, 600], [45, 45]); b.n = 5; b.az0 = b.az1 = _skyState.center + 50; b.alt1 = 45; _skyState.actors = [b]; _skyHideTip(); _skyKick(); }"
        )
        pg.wait_for_function(
            "() => _skyState.bodies.some((b) => b.type === 'birds')", polling=POLL_MS
        )
        _tap_body(pg, "birds")
        assert pg.evaluate("t('alm_sky_birds')") in tip.inner_text()
        assert not errors, errors
    finally:
        ctx.close()
    # Inland: the same beach and palms, the sea at half tide, and no tide claimed.
    ctx, pg, errors = _almanac(browser, served, place=DENVER)
    try:
        _settle(pg, DAY)
        pg.wait_for_function(
            "() => !!document.querySelector('#almanac-place .at-tides')",
            polling=POLL_MS,
            timeout=60000,
        )
        pg.evaluate("_skyKick()")
        pg.wait_for_timeout(300)
        assert pg.evaluate("_skyState.sea") is None
        assert not pg.evaluate("_skyState.bodies.some((b) => b.type === 'sea')")
        assert pg.evaluate("(_skyState.palmCache || []).some(Boolean)")
        assert not errors, errors
    finally:
        ctx.close()


def test_the_aurora_where_it_is_seen(browser, served):
    ctx, pg, errors = _almanac(browser, served, place=TROMSO)
    try:
        _settle(pg, TROMSO_NIGHT)
        au = pg.evaluate("_skyState.aurora")
        assert au and au["k"] > 0.3, au
        assert abs(au["mag"]) > 60
        assert not errors, errors
    finally:
        ctx.close()
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate("_skyState.aurora") is None  # San Francisco: too far south
        # Meteors by night, with the rate said and the speed-up owned up to.
        pg.evaluate(
            "() => { const m = _skyMeteor(_skyState); m.dur = 60000; m.az0 = _skyState.center; m.az1 = _skyState.center + 4;"
            " m.alt0 = 40; m.alt1 = 30; m.start -= 30000; _skyState.actors = [m]; _skyKick(); }"
        )
        pg.locator("#almanac-sky-canvas").scroll_into_view_if_needed()
        pg.wait_for_function(
            "() => _skyState.bodies.some((b) => b.type === 'meteor')", polling=POLL_MS
        )
        pg.wait_for_timeout(200)
        b = pg.evaluate(
            "() => { const b = _skyState.bodies.find((x) => x.type === 'meteor'); const r = _skyState.canvas.getBoundingClientRect();"
            " return { x: r.left + (b.x0 + b.x1) / 2, y: r.top + (b.y0 + b.y1) / 2 }; }"
        )
        pg.touchscreen.tap(b["x"], b["y"])
        tip = pg.inner_text("#almanac-sky-tip")
        assert "an hour" in tip and "10 times" in tip, tip
        assert not errors, errors
    finally:
        ctx.close()


def test_reduced_motion_keeps_the_sky_still(browser, served):
    ctx, pg, errors = _almanac(browser, served, reduced=True)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate("!_skyTimers.twinkle && !_skyTimers.muon")
        assert pg.evaluate(
            "!_skyTimers.plane && !_skyTimers.birds && !_skyTimers.meteor && !_skyTimers.whale"
        )
        # The palms stand still: no breeze timer, and no frames asked for.
        assert pg.evaluate("!_skyTimers.sway")
        still = pg.evaluate("_skyState.muons.filter((m) => m.still).length")
        assert still == 1
        _tap_body(pg, "muon")
        tip = pg.locator("#almanac-sky-tip")
        assert tip.is_visible()
        assert pg.evaluate("t('alm_sky_muon')") in tip.inner_text()
        assert not errors, errors
    finally:
        ctx.close()


def test_the_light_clock_on_a_ride(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        pg.evaluate(
            "_orrerySnapToNow(); _orreryLaunchRocket('Mars'); _orreryTwinInput(80)"
        )
        pg.wait_for_function(
            "() => document.getElementById('orrery-lc-gamma') && document.getElementById('orrery-lc-gamma').textContent",
            polling=POLL_MS,
        )
        gamma = pg.evaluate("document.getElementById('orrery-lc-gamma').textContent")
        assert (
            gamma
            == "\u2066\u03b3 = "
            + pg.evaluate("_orrFmtGamma(_lorentzFactor(0.8))")
            + "\u2069"
        )
        assert pg.evaluate("document.getElementById('orrery-lc').clientWidth") > 200
        assert pg.evaluate(
            "t('alm_lc_moving', { v: _orrFmtBeta(0.8) })"
        ) in pg.evaluate("document.getElementById('orrery-lc-moving').textContent")
        assert not errors, errors
    finally:
        ctx.close()
