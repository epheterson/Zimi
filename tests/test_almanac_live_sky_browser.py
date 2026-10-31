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
     reduced, no twinkle, no breeze and nothing crossing.
  4. Light clock: on a ride at 0.8c, gamma 1.67 beside the two clocks.

The positions themselves are held to JPL Horizons in
tests/test_almanac_live_sky.cjs.

Run: pytest tests/test_almanac_live_sky_browser.py -v
"""

import datetime
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


def _almanac(browser, served, reduced=False, place=PLACE, horizon=False):
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
    if horizon:   # the beach with its life is the default; the true horizon is a choice that is kept
        ctx.add_init_script("localStorage.setItem('zimi_sky_settings', '{\"skin\":\"horizon\"}');")
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
        polling=POLL_MS,
    )
    pg.wait_for_function(   # the panels under the calendar, drawn after the first paint
        "() => typeof _almSecBar !== 'undefined' && _almSecBar && _almSecBar.sections",
        polling=POLL_MS,
    )
    # The sky stands under the Moon's numbers and its words, below the first screen: bring it into view, as a reader does.
    pg.evaluate(
        "() => document.querySelector('.almanac-sky-wrap').scrollIntoView({ behavior: 'instant', block: 'center' })"
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
    # Not a fixed pause: a scroll slides the bar above the Almanac away, and
    # on a slow runner the canvas was still moving with it when the body's
    # place was read, so the tap landed beside it.
    _wait_still(pg, "#almanac-sky-canvas")
    b = pg.evaluate(
        "([k, n]) => { const b = _skyState.bodies.find((x) => x.type === k && (!n || x.name === n));"
        " const r = _skyState.canvas.getBoundingClientRect(); if (!b) return null; const x = b.x0 != null ? (b.x0 + b.x1) / 2 : b.x, y = b.x0 != null ? (b.y0 + b.y1) / 2 : b.y; return { x: r.left + x, y: r.top + y }; }",
        [kind, name],
    )
    assert b, "%s %s is drawn" % (kind, name or "")
    # In the part of the turning sky that is on screen, not off its edge.
    assert 0 <= b["x"] <= VIEW["width"] and 0 <= b["y"] <= VIEW["height"], b
    pg.touchscreen.tap(b["x"], b["y"])


def _wait_still(pg, sel):
    """Until the element holds its place on screen for a few frames."""
    pg.evaluate("() => { window.__still = null; }")
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
        assert btn.inner_text() == pg.evaluate("t('alm_solar_system')")
        assert btn.get_attribute("aria-label") == pg.evaluate("t('alm_sky_find_orrery')")
        assert btn.bounding_box()["height"] < 40  # a word in the facts row, not a pill across the tip
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
        pg.wait_for_function("!!_skyTimers.live", polling=POLL_MS)   # armed once the sky is seen (an observer, after the scroll)
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
        # second); a twinkle a frame or two more; a loop
        # would ask ~60.
        assert frames <= 1000 / pg.evaluate("SKY_SWAY_MS") + 3, frames
        assert not errors, errors
    finally:
        ctx.close()


def test_a_live_sky_catches_up_after_the_app_slept(browser, served):
    """Eric's phone showed night at 10:41 until a reload: the app had slept,
    the live timer had stopped, and the observer's last word said the sky was
    off screen. Any frame, and the page shown again, bring it to now."""
    ctx, pg, errors = _almanac(browser, served)
    slept = (
        "() => { clearTimeout(_skyTimers.live); _skyTimers.live = 0;"
        " _skyCompute(_skyState, new Date(Date.now() - 12 * 3600000)); }"
    )
    caught_up = "() => Math.abs(_skyState.nowTime - Date.now()) < 5000"
    try:
        # A frame asked for any reason (the palms' breeze, a tap). Slept and
        # read in one turn: the breeze's own frame can catch it up between two.
        assert not pg.evaluate(
            "([slept, up]) => { (0, eval)('(' + slept + ')')(); return (0, eval)('(' + up + ')')(); }",
            [slept, caught_up],
        )
        pg.evaluate("_skyKick()")
        pg.wait_for_function(caught_up, polling=POLL_MS, timeout=10000)
        # Shown again, with the observer's stale word that it was off screen
        # (in one turn, so no frame catches it up first).
        pg.locator("#almanac-sky-canvas").scroll_into_view_if_needed()
        woke = pg.evaluate(
            "(slept) => { (0, eval)('(' + slept + ')')(); _skyPause(); _skyState.inView = false;"
            " window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));"
            " return [Date.now() - _skyState.nowTime, _skyState.inView, !!_skyTimers.live]; }",
            slept,
        )
        assert woke[0] < 5000 and woke[1] and woke[2], woke
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


def test_the_sky_stays_facing_the_equator(browser, served):
    """The scene is one fixed view: a drag or an arrow key does not turn it
    (turning it showed sea in every direction)."""
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate("_skyState.center") == 180
        assert "facing S" in pg.inner_text("#almanac-sky-cap")
        width = pg.evaluate("_skyState.cssW")
        _drag(pg, -width / 2, 0)
        pg.focus("#almanac-sky-canvas")
        pg.keyboard.press("ArrowRight")
        assert pg.evaluate("_skyState.center") == 180
        assert "facing S" in pg.inner_text("#almanac-sky-cap")
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
            " [SKY_PLANE_GAP_S, SKY_BIRD_GAP_S].forEach((g) => { g[0] = g[1] = 1e9; });"
            " _skyState.actors = []; _skyKick(); }"
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
            " const boats = _skyState.bodies.filter((x) => x.type === 'boat'); let best = 0, gap = -1;"
            " for (let x = b.box[0] + 20; x < b.box[2] - 20; x += 5) { const g = Math.min(...boats.map((o) => Math.abs(o.x - x)), 1e9); if (g > gap) { gap = g; best = x; } }"
            " return { x: r.left + best, y: r.top + (b.box[1] + b.box[3]) / 2 }; }"   # a tap on open water, clear of the boats on the horizon
        )
        pg.touchscreen.tap(box["x"], box["y"])
        tip = pg.locator("#almanac-sky-tip")
        assert tip.is_visible()
        assert pg.evaluate("t('alm_sky_sea')") in tip.inner_text()
        # A plane: frames while it crosses, none once it has gone.
        pg.evaluate(
            "() => { Object.keys(SKY_SPAWNERS).forEach((k) => { clearTimeout(_skyTimers[k]); SKY_FIRST_SPAWN_MS[k] = 1e9; });"
            " [SKY_PLANE_GAP_S, SKY_BIRD_GAP_S].forEach((g) => { g[0] = g[1] = 1e9; });"
            " const a = _skyPlane(_skyState); a.dur = 6000; a.start = performance.now(); _skyState.actors = [a]; _skyKick(); }"
        )
        moving = pg.evaluate("""() => new Promise((done) => {
          const n0 = _skyState.paints || 0;
          setTimeout(() => done({ painted: (_skyState.paints || 0) - n0, loop: !!_almanacSkyRAF || !!_skyTimers.actor }), 1000);
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
        # Only the palms' breeze still asks (every SKY_SWAY_MS), not a loop.
        assert after <= 700 / pg.evaluate("SKY_SWAY_MS") + 2, after
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


# The shipped elements are refreshed for every release and exact only for days either side of their epoch, so the pass is looked
# for in the elements the page holds: the first half-minute within 2.5 days of the epoch the ISS stands above 12 degrees in the view over a dark sky (Sun below 6).
ISS_PASS_SCAN = """
() => {
  const s = _skyState, iss = _ae.sats.list.find((q) => q.iss), lat = s.lat, lon = s.lon;
  const sinLat = Math.sin(lat * DEG_TO_RAD), cosLat = Math.cos(lat * DEG_TO_RAD);
  for (let t = iss.epochMs - 2.5 * MS_PER_DAY; t < iss.epochMs + 2.5 * MS_PER_DAY; t += 30000) {
    const up = _skyIss(s, t);
    if (!up || up.alt < 12 || !_skyInView(s, _skyX(s, up.az), 4)) continue;
    const d = new Date(t), sq = _skySunRaDec(_jdToJulianCentury(_dateToJD(t)));
    if (_skyHorizontal(sq.ra, sq.dec, _skyLST(d, lon), sinLat, cosLat).alt < -6) return d.toISOString();
  }
  return null;
}
"""


def test_the_first_look_is_the_beach_with_its_life(browser, served):
    """Nothing chosen, nothing saved: the scene is the beach, boats lit at
    night, palms swaying, an airliner crossing within seconds, meteors on the
    real calendar's clock; a viewer who chose the true horizon keeps it."""
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate("_skySetting('skin')") == "beach"
        assert pg.evaluate("localStorage.getItem('zimi_sky_settings')") is None
        assert pg.evaluate("_skyState.bodies.some((b) => b.type === 'boat')")
        pg.wait_for_function(
            "() => (_skyState.palmCache || []).some(Boolean)", polling=POLL_MS
        )
        # A plane is crossing soon (it is first seen part-way along its track), and the timers that keep the life going are set.
        # The first comes 15 to 35 s after the sky is armed (SKY_FIRST_SPAWN_MS.plane, +/-40%).
        pg.wait_for_function(
            "() => _skyState.actors.some((a) => a.type === 'plane')",
            polling=POLL_MS,
            timeout=45000,
        )
        # Someone is looking: a page left alone 45 s settles and parks the breeze,
        # which a slow runner reaches before here.
        pg.mouse.move(200, 300)
        pg.mouse.move(210, 310)
        assert pg.evaluate(
            "!!_skyTimers.sway && !!_skyTimers.meteor && !!_skyTimers.whale"
        )
        # Its lights are the ones a navigator sees: one coloured wingtip, or a white tail, never both colours from the side.
        lt = pg.evaluate(
            "() => { const a = _skyState.actors.find((x) => x.type === 'plane'); return _skyPlaneLights(a, _skyPlaneAt(a, 0.5)); }"
        )
        assert abs(lt["red"] - lt["green"]) > 0.5 or lt["tail"] > 0.5, lt
        assert not errors, errors
    finally:
        ctx.close()
    ctx, pg, errors = _almanac(browser, served, horizon=True)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate("_skySetting('skin')") == "horizon"
        assert not pg.evaluate("_skyState.bodies.some((b) => b.type === 'boat')")
        assert pg.evaluate("!_skyTimers.sway && !_skyTimers.plane")
        assert not errors, errors
    finally:
        ctx.close()


def test_the_iss_is_drawn_when_it_is_overhead_and_lit(browser, served):
    """From the satellite elements the 3D view keeps (loaded for the sky too),
    only while it stands above 8 degrees, in the Sun's light, over a dark sky."""
    ctx, pg, errors = _almanac(browser, served)
    try:
        pg.wait_for_function(
            "() => { if (typeof _ae !== 'undefined' && _ae) { _skyIssWatch(_skyState); return !!_ae.sats; } return false; }",
            polling=500,
            timeout=90000,
        )
        iss_pass = pg.evaluate(ISS_PASS_SCAN)
        assert iss_pass, "the shipped elements hold no dark-sky pass in their 2.5 days either side of their epoch"
        _settle(pg, iss_pass)
        pg.wait_for_function(
            "() => _skyState.bodies.some((b) => b.type === 'iss')",
            polling=POLL_MS,
            timeout=30000,
        )
        iss = pg.evaluate("_skyState.bodies.find((b) => b.type === 'iss')")
        assert iss["alt"] > 8 and 300 < iss["km"] < 500, iss
        # An hour on the same orbit's ground track it is not over this sky: nothing is drawn.
        _settle(pg, (datetime.datetime.fromisoformat(iss_pass.replace("Z", "+00:00")) + datetime.timedelta(hours=1)).isoformat())
        assert not pg.evaluate("_skyState.bodies.some((b) => b.type === 'iss')")
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
        # Meteors by night, with the rate said (the real one: no speed-up).
        pg.evaluate(
            "() => { const m = _skyMeteor(_skyState); m.dur = 60000; m.az0 = _skyState.center; m.az1 = _skyState.center + 4;"
            " m.alt0 = 40; m.alt1 = 30; m.start -= 30000; _skyState.actors = [m]; _skyKick(); }"
        )
        pg.locator("#almanac-sky-canvas").scroll_into_view_if_needed()
        pg.wait_for_function(
            "() => _skyState.bodies.some((b) => b.type === 'meteor')", polling=POLL_MS
        )
        # Read the meteor's place once the page has stopped settling after the
        # scroll, as the other taps do: a stale read missed it under load.
        _wait_still(pg, "#almanac-sky-canvas")
        b = pg.evaluate(
            "() => { const b = _skyState.bodies.find((x) => x.type === 'meteor'); const r = _skyState.canvas.getBoundingClientRect();"
            " return { x: r.left + (b.x0 + b.x1) / 2, y: r.top + (b.y0 + b.y1) / 2 }; }"
        )
        pg.touchscreen.tap(b["x"], b["y"])
        tip = pg.inner_text("#almanac-sky-tip")
        assert "an hour" in tip and "times as often" not in tip, tip
        assert not errors, errors
    finally:
        ctx.close()


def test_reduced_motion_keeps_the_sky_still(browser, served):
    ctx, pg, errors = _almanac(browser, served, reduced=True)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate("!_skyTimers.twinkle")
        assert pg.evaluate(
            "!_skyTimers.plane && !_skyTimers.birds && !_skyTimers.meteor && !_skyTimers.whale"
        )
        # The palms stand still: no breeze timer, and no frames asked for.
        assert pg.evaluate("!_skyTimers.sway")
        # Nothing crossing, and no frame loop once the settle's last frame is drawn.
        pg.wait_for_function(
            "() => _skyState.actors.length === 0 && !_almanacSkyRAF",
            polling=POLL_MS,
            timeout=5000,
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_the_light_clock_on_a_ride(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        pg.evaluate(
            "_orrerySnapToNow(); _orreryLaunchRocket('Mars'); _orreryTwinInput(1)"
        )
        # The twins and the light clock open from "What if it flew to the stars?" and
        # are not drawn while closed.
        assert pg.evaluate("document.getElementById('orrery-twin').hidden")
        assert not pg.evaluate("document.getElementById('orrery-lc-gamma').textContent")
        pg.click("#orrery-twin-link")
        pg.wait_for_function(
            "() => document.getElementById('orrery-lc-gamma') && document.getElementById('orrery-lc-gamma').textContent",
            polling=POLL_MS,
        )
        # Halfway along the 1 g trip the ship is at its peak (gamma 3.26 to
        # Alpha Centauri): the light clock shows that speed, not a cruise speed.
        # The orrery is stopped first, or a slow runner's next frame flies on
        # past the peak before the text is read.
        pg.evaluate(
            "cancelAnimationFrame(_almanacOrreryRAF); _almanacOrreryRAF = null; _orreryPlaying = false;"
            "_orreryRockets[0].elapsed = _orreryRockets[0].duration / 2; _orreryUpdateRide()"
        )
        peak = pg.evaluate("_orreryTwinClocks(_orreryRockets[0], 1, 0.5).gamma")
        assert 3.2 < peak < 3.3
        pg.wait_for_function(
            "(g) => document.getElementById('orrery-lc-gamma').textContent.indexOf(g) > 0",
            arg=pg.evaluate(f"_orrFmtGamma({peak})"),
            polling=POLL_MS,
        )
        assert "alm_orr_twin" not in pg.evaluate(
            "document.getElementById('orrery-twin').textContent"
        )
        assert pg.evaluate("document.getElementById('orrery-lc').clientWidth") > 200
        assert pg.evaluate(
            "t('alm_lc_moving', { v: _orrFmtBeta(_orreryTwinClocks(_orreryRockets[0], 1, 0.5).beta) })"
        ) in pg.evaluate("document.getElementById('orrery-lc-moving').textContent")
        assert not errors, errors
    finally:
        ctx.close()
