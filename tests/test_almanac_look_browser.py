"""Pointing the phone at the sky, in a real browser.

On the shipped files, served by Zimi, in headless Chromium (SwiftShader for
the sky), at a phone's width, with the orientation events a phone sends
simulated:

  1. Opened from the sky, Look asks for motion on a tap (iOS's way) and never
     before; the view follows the compass heading and the tilt (east, west, up
     45, down); denied and no-sensor devices say so and turn by finger;
     closing gives the sky its card back; a held phone costs no frames.
  2. It is the whole sphere. Tipped to the ground the sky does not fade out for
     a globe: it shows what is under the horizon (stars, planets, Sun, Moon in
     their places, the ground as dim glass over them), named, as it names what
     is above. Find is here and nowhere else on the Almanac.
  3. Its way in is an icon of a phone held up to the sky, as large as the gear.

The maths behind it is tests/test_almanac_look.cjs.

Run: pytest tests/test_almanac_look_browser.py -v
"""

import json
import os
import sys
import threading
from datetime import datetime, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Linux CI needs SwiftShader asked for; a Mac has its own and the flags make it crawl.
GL_ARGS = (
    []
    if sys.platform == "darwin"
    else ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
)
VIEW = {"width": 390, "height": 844}
PLACE = {"lat": 37.7749, "lon": -122.4194, "name": "San Francisco"}
POLL_MS = 100
SETTLE_S = 0.6

# What a phone's browser does that headless Chromium does not: iOS's
# permission request, and a way to send its events.
INIT = """
(() => {
  localStorage.setItem('zimi_almanac_place', %s);
  const mode = %s;
  if (mode === 'none') { window.DeviceOrientationEvent = undefined; }
  else if (mode === 'ios' || mode === 'denied') {
    window.DeviceOrientationEvent = window.DeviceOrientationEvent || function () {};
    window.__asked = 0;
    window.DeviceOrientationEvent.requestPermission = () => { window.__asked++; return Promise.resolve(mode === 'denied' ? 'denied' : 'granted'); };
  }
  else if (mode === 'android' && window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) {
    // Chromium 156 has the permission API too: the page asks, as it does on iOS.
    DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted');
  }
  window.__fire = (o, abs) => {
    const e = new Event(abs ? 'deviceorientationabsolute' : 'deviceorientation');
    Object.assign(e, { alpha: o.alpha, beta: o.beta, gamma: o.gamma, absolute: !!abs });
    if (o.heading != null) { e.webkitCompassHeading = o.heading; e.webkitCompassAccuracy = o.acc == null ? 5 : o.acc; }
    window.dispatchEvent(e);
  };
})();
"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("look")
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


def _context(browser, mode="ios", color_scheme="dark"):
    ctx = browser.new_context(
        viewport=VIEW,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        color_scheme=color_scheme,
    )
    ctx.add_init_script(INIT % (json.dumps(json.dumps(PLACE)), json.dumps(mode)))
    return ctx


def _look(browser, served, mode="ios", init=None, in_tap=True, when=None):
    """in_tap=False opens the view without the sky button's tap (as the finder does), so iOS has not
    been asked for motion on the way in and the view's own "Turn on motion" is how it is.
    """
    ctx = _context(browser, mode)
    if init:
        ctx.add_init_script(init)
    pg = ctx.new_page()
    if when:
        pg.clock.set_fixed_time(when)  # an instant held still: what is under the horizon is the same every run
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => !!document.querySelector('.alm-sky-look') && typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
        polling=POLL_MS,
    )
    if in_tap:
        pg.evaluate("() => document.querySelector('.alm-sky-look').click()")
    else:
        pg.evaluate(
            "() => new Promise(r => { const s = document.createElement('script'); s.src = '/static/almanac-look.js?v=45'; s.async = false; s.onload = r; document.head.appendChild(s); }).then(() => openAlmanacLookNow())"
        )
    pg.wait_for_function(
        "() => !!document.getElementById('almanac-look')", polling=POLL_MS
    )
    return ctx, pg, errors


def _tap(pg, selector):
    """A click in the page itself: Playwright's own waits for a still element
    ride on animation frames, which a swiftshader page busy drawing a sky
    gives slowly."""
    pg.evaluate("(s) => document.querySelector(s).click()", selector)


def _fire(pg, alpha, beta, gamma, heading=None, absolute=False):
    for _ in range(3):
        pg.evaluate(
            "([o, a]) => window.__fire(o, a)",
            [
                {"alpha": alpha, "beta": beta, "gamma": gamma, "heading": heading},
                absolute,
            ],
        )
        pg.wait_for_timeout(60)
    pg.wait_for_timeout(int(SETTLE_S * 1000))


def _reading(pg):
    return pg.inner_text("#look-read")


def _reads(pg, prefix, seconds=30):
    """The reading, once the view has caught up with the sensors: a slow page
    draws few frames a second, so this waits for the answer, not for a time."""
    try:
        pg.wait_for_function(
            "(p) => document.getElementById('look-read').textContent.indexOf(p) === 0",
            arg=prefix,
            polling=POLL_MS,
            timeout=seconds * 1000,
        )
    except Exception:
        pass
    return _reading(pg)


def test_look_asks_for_motion_on_the_tap_and_not_before(browser, served):
    ctx, pg, errors = _look(browser, served, "ios", in_tap=False)
    try:
        assert pg.evaluate("() => window.__asked") == 0
        assert pg.is_visible("#look-ask")
        _tap(pg, "#look-ask")
        pg.wait_for_function("() => window.__asked === 1", polling=POLL_MS)
        assert not pg.is_visible("#look-ask")
        assert not errors
    finally:
        ctx.close()


def test_look_follows_the_compass_and_the_tilt(browser, served):
    ctx, pg, _ = _look(browser, served, "ios")
    try:
        _tap(pg, "#look-ask")
        # iOS: alpha is arbitrary; webkitCompassHeading carries north.
        for heading, word in ((0, "N 0"), (90, "E 90"), (180, "S 180"), (270, "W 270")):
            _fire(pg, 33, 90, 0, heading)
            assert _reads(pg, word).startswith(word), (heading, _reading(pg))
        _fire(pg, 33, 135, 0, 180)
        assert _reads(pg, "S 180°   +45").startswith("S 180°   +45")
        _fire(pg, 33, 45, 0, 180)
        assert _reads(pg, "S 180°   −45").startswith("S 180°   −45")
        _fire(pg, 33, 90, 0, 180)
        _reads(pg, "S 180°   0")
    finally:
        ctx.close()


def _painted(pg):
    """What the look-around view has put on its sky at the last paint: the bodies it names or can be tapped on."""
    return pg.evaluate("""() => {
          const s = _skyHost && _skyHost.s;
          return s ? s.bodies.map(b => ({ type: b.type, name: b.name || null, under: !!b.under, alt: b.alt, x: b.x, y: b.y })) : null;
        }""")


def _labels(pg):
    """The names the view writes, as it plans them at the last paint."""
    return pg.evaluate("""() => {
          const s = _skyHost.s, c = document.createElement('canvas').getContext('2d');
          c.font = '600 ' + Math.round(SKY_LABEL_PX * s.dpr) + 'px ' + SKY_FONT;
          return _skyLabelPlan(s, (t) => c.measureText(t).width).map(l => ({ text: l.text, under: l.under }));
        }""")


def _wait_painted(pg, test, arg=None):
    pg.wait_for_function(
        "(a) => { const s = typeof _skyHost !== 'undefined' && _skyHost && _skyHost.s; return !!s && s.eph && (%s)(s, a); }"
        % test,
        arg=arg,
        polling=POLL_MS,
        timeout=60_000,
    )


def test_pointing_down_shows_what_is_under_the_horizon_and_names_it(browser, served):
    """Eric, 2026-10-18: Look is where the sky under the horizon is shown, the ground translucent. Down at 45 degrees
    the stars and whatever planets are below are drawn and named; the sky never fades to anything else.
    """
    ctx, pg, errors = _look(browser, served, "ios")
    try:
        _tap(pg, "#look-ask")
        _fire(pg, 33, 45, 0, 180)  # 45 degrees below the horizon, facing south
        assert _reads(pg, "S 180°   −45").startswith("S 180°   −45")
        _wait_painted(pg, "(s) => s.belowKey && s.below.stars.length > 20")
        # The sky is the whole picture: nothing covers it, and it is not faded.
        assert pg.evaluate(
            "() => document.getElementById('look-sky').style.opacity === '' && !document.getElementById('look-globe')"
        )
        under = [b for b in _painted(pg) if b["under"]]
        assert under, "nothing under the horizon was drawn pointing down"
        assert all(b["alt"] < 0 for b in under), under
        # Above the horizon nothing is marked as under it.
        _fire(pg, 33, 135, 0, 180)
        assert _reads(pg, "S 180°   +45").startswith("S 180°   +45")
        pg.wait_for_function(
            "() => { const s = _skyHost.s; return s.bodies.every(b => !b.under || b.alt < 0); }",
            polling=POLL_MS,
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_what_is_under_the_horizon_is_named_in_its_own_ink(browser, served):
    """At one in the morning in San Francisco the Sun is far under the horizon: pointing at its place, it is drawn
    there and its name is the under kind, in the cool ink, among the names the view writes."""
    ctx, pg, errors = _look(
        browser, served, "none", when=datetime(2026, 10, 19, 8, 0, tzinfo=timezone.utc)
    )
    try:
        pg.wait_for_function(
            "() => typeof _skyHost !== 'undefined' && _skyHost && _skyHost.s && _skyHost.s.eph",
            polling=POLL_MS,
        )
        sun = pg.evaluate(
            "() => { const b = _skyBelowBodies(_skyHost.s); return b.sun ? { az: b.sun.az, alt: b.sun.alt } : null; }"
        )
        assert sun and sun["alt"] < -20, sun
        pg.evaluate(
            "(t) => { _look.target = { az: t.az, alt: t.alt, roll: 0 }; _look.view = { az: t.az, alt: t.alt, roll: 0 }; _look.drawn = null; _lookKick(); }",
            sun,
        )
        pg.wait_for_function(
            "() => _skyHost.s.bodies.some(b => b.under && b.type === 'sun')",
            polling=POLL_MS,
        )
        labels = _labels(pg)
        assert any(l["under"] and l["text"] == "Sun" for l in labels), (sun, labels)
        assert not errors, errors
    finally:
        ctx.close()


def test_find_is_in_look_and_nowhere_else_on_the_almanac(browser, served):
    ctx = _context(browser, "none")
    pg = ctx.new_page()
    try:
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => !!document.querySelector('.alm-sky-look') && typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
            polling=POLL_MS,
        )
        pg.evaluate(
            "() => document.getElementById('almanac-starchart').scrollIntoView({ behavior: 'instant' })"
        )
        pg.wait_for_timeout(1500)
        outside = pg.evaluate(
            """() => [...document.querySelectorAll(
              '[data-sky-find], [data-sky-below], .alm-sky-find, .alm-sky-below, .alm-sky-tool, .alm-sc-tools, .alm-sc-tool, [onclick*="openAlmanacFind"], [onclick*="_skyBelow"]')].length"""
        )
        assert outside == 0
        # In Look it is: the finder's button, and it opens the finder.
        pg.evaluate("() => document.querySelector('.alm-sky-look').click()")
        pg.wait_for_function(
            "() => !!document.getElementById('look-find')", polling=POLL_MS
        )
        _tap(pg, "#look-find")
        pg.wait_for_function(
            "() => !!document.getElementById('sf-sheet')",
            polling=POLL_MS,
            timeout=30_000,
        )
        pg.fill("#sf-input", "Sirius")
        pg.wait_for_function(
            "() => document.querySelectorAll('#sf-list .sf-row').length >= 1",
            polling=POLL_MS,
        )
        pg.keyboard.press("Enter")
        pg.wait_for_function(
            "() => !!document.getElementById('sf-look-chip')", polling=POLL_MS
        )
        # Found under the horizon or above it, the chip says where.
        assert "Sirius" in pg.inner_text("#sf-look-chip")
    finally:
        ctx.close()


def test_the_way_in_is_a_phone_held_up_with_a_star_and_as_large_as_the_gear(
    browser, served
):
    ctx = _context(browser, "none")
    pg = ctx.new_page()
    try:
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_selector(".alm-sky-look", timeout=60_000)
        got = pg.evaluate("""() => {
              const look = document.querySelector('.alm-sky-look'), gear = document.querySelector('.alm-sky-gear');
              const lb = look.getBoundingClientRect(), gb = gear.getBoundingClientRect();
              const l = look.querySelector('svg'), g = gear.querySelector('svg');
              return { lw: lb.width, lh: lb.height, gw: gb.width, gh: gb.height,
                stroke: l.getAttribute('stroke-width') === g.getAttribute('stroke-width'),
                size: l.getBoundingClientRect().width === g.getBoundingClientRect().width,
                phone: !!l.querySelector('rect'), star: !!l.querySelector('path[fill=currentColor]'),
                crosshair: !!l.querySelector('circle') };
            }""")
        assert got["lw"] == got["gw"] == 44 and got["lh"] == got["gh"] == 44, got
        assert got["stroke"] and got["size"], got
        assert got["phone"] and got["star"] and not got["crosshair"], got
    finally:
        ctx.close()


def test_look_takes_android_absolute_readings(browser, served):
    ctx, pg, _ = _look(browser, served, "android")
    try:
        # A Chromium that has the permission API asks, like iOS; one that does not listens at once.
        if pg.is_visible("#look-ask"):
            _tap(pg, "#look-ask")
        for heading in (0, 90, 180, 270):
            _fire(pg, (360 - heading) % 360, 90, 0, None, absolute=True)
            want = "%s %d°" % ("NESW"[heading // 90], heading)
            assert _reads(pg, want).startswith(want), _reading(pg)
        # Chrome fires both events; the relative one must not pull the view.
        pg.evaluate("() => window.__fire({alpha: 10, beta: 90, gamma: 0}, false)")
        pg.wait_for_timeout(300)
        assert _reading(pg).startswith("W 270°")
    finally:
        ctx.close()


def test_look_says_when_the_compass_needs_calibrating(browser, served):
    ctx, pg, _ = _look(browser, served, "ios")
    try:
        _tap(pg, "#look-ask")
        _fire(pg, 33, 90, 0, 180)
        assert not pg.is_visible("#look-note")
        poor = "() => window.__fire({alpha: 33, beta: 90, gamma: 0, heading: 180, acc: 60})"
        for _ in range(10):
            pg.evaluate(poor)
            pg.wait_for_timeout(300)
        assert "figure eight" in pg.inner_text("#look-note")
        pg.evaluate(
            "() => window.__fire({alpha: 33, beta: 90, gamma: 0, heading: 180, acc: 5})"
        )
        pg.wait_for_timeout(300)
        assert not pg.is_visible("#look-note")
    finally:
        ctx.close()


def test_look_without_sensors_or_permission_turns_by_finger(browser, served):
    for mode, words in (("denied", "Motion is off"), ("none", "no motion sensors")):
        ctx, pg, _ = _look(browser, served, mode)
        try:
            if pg.is_visible("#look-ask"):
                _tap(pg, "#look-ask")
            pg.wait_for_function(
                "() => !document.getElementById('look-note').hidden", polling=POLL_MS
            )
            assert words in pg.inner_text("#look-note")
            before = _reading(pg)
            pg.mouse.move(195, 400)
            pg.mouse.down()
            pg.mouse.move(300, 400, steps=6)
            pg.mouse.up()
            pg.wait_for_timeout(400)
            assert _reading(pg) != before
            pg.keyboard.press("ArrowUp")
            pg.wait_for_timeout(200)
        finally:
            ctx.close()


def test_a_held_phone_costs_no_frames_and_closing_gives_the_card_back(browser, served):
    ctx, pg, errors = _look(browser, served, "none")
    try:
        # The Almanac settles first: the veil's cap paints the sky once, and the panels under
        # the calendar load a few seconds after the page is shown. The world clock's once-a-second tick (the page behind Look) is not Look's cost and is not counted.
        pg.wait_for_function("() => !_almRevealing", timeout=10000)
        pg.evaluate(
            "() => { window.__raf = 0; const r = window.requestAnimationFrame.bind(window);"
            " window.requestAnimationFrame = (f) => r((t) => { if (!/_tzClockTick/.test(f.toString())) window.__raf++; f(t); }); }"
        )
        pg.wait_for_function("() => performance.now() > _almShownAt + ALM_PANELS_SETTLE_MS + 4000", timeout=20000)
        pg.evaluate("() => { window.__raf = 0; }")
        pg.wait_for_timeout(3000)
        assert pg.evaluate("() => window.__raf") == 0
        _tap(pg, "#look-close")
        assert pg.query_selector("#almanac-look") is None
        assert pg.evaluate(
            "() => !!document.querySelector('.almanac-sky-wrap #almanac-sky-canvas')"
        )
        assert (
            pg.evaluate("() => SKY_SPAN_DEG") == 240
            and pg.evaluate("() => SKY_ASPECT") == 1.8
        )
        assert not errors
    finally:
        ctx.close()


def _almanac_open(pg):
    return pg.evaluate("() => _almanacOpen")


def test_escape_closes_look_and_leaves_the_almanac(browser, served):
    ctx, pg, _ = _look(browser, served, "none")
    try:
        pg.keyboard.press("Escape")
        pg.wait_for_function(
            "() => !document.getElementById('almanac-look')", polling=POLL_MS
        )
        assert _almanac_open(pg) and pg.is_visible(".almanac-sky-wrap")
        assert pg.evaluate("() => !document.body.classList.contains('look-open')")
    finally:
        ctx.close()


def _look_from_home(browser, served):
    """The Almanac opened from the home page, so Back has somewhere to go."""
    ctx = _context(browser, "none")
    pg = ctx.new_page()
    pg.goto(served + "/", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanac === 'function'", polling=POLL_MS)
    pg.evaluate("() => openAlmanac()")
    pg.wait_for_function(
        "() => !!document.querySelector('.alm-sky-look') && typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
        polling=POLL_MS,
    )
    pg.evaluate("() => document.querySelector('.alm-sky-look').click()")
    pg.wait_for_function(
        "() => !!document.getElementById('almanac-look')", polling=POLL_MS
    )
    return ctx, pg


def test_the_back_gesture_closes_look_first_and_the_almanac_second(browser, served):
    ctx, pg = _look_from_home(browser, served)
    try:
        assert pg.evaluate("() => history.state && history.state.look") == 1
        pg.evaluate("() => history.back()")
        pg.wait_for_function(
            "() => !document.getElementById('almanac-look')", polling=POLL_MS
        )
        assert _almanac_open(pg)
        pg.evaluate("() => history.back()")
        pg.wait_for_function("() => !_almanacOpen", polling=POLL_MS)
        assert pg.evaluate("() => !document.getElementById('almanac-look')")
    finally:
        ctx.close()


def test_closing_look_by_its_button_takes_back_the_step_it_made(browser, served):
    ctx, pg = _look_from_home(browser, served)
    try:
        before = pg.evaluate("() => history.length")
        assert pg.evaluate("() => history.state && history.state.look") == 1
        _tap(pg, "#look-close")
        pg.wait_for_function(
            "() => !document.getElementById('almanac-look')", polling=POLL_MS
        )
        pg.wait_for_function(
            "() => !(history.state && history.state.look)", polling=POLL_MS
        )
        assert _almanac_open(pg)
        # One Back from here leaves the Almanac, not a step that is not there.
        pg.evaluate("() => history.back()")
        pg.wait_for_function("() => !_almanacOpen", polling=POLL_MS)
        assert before >= 3
    finally:
        ctx.close()


def test_closing_the_almanac_takes_look_with_it(browser, served):
    ctx, pg, _ = _look(browser, served, "none")
    try:
        pg.evaluate("() => closeAlmanac()")
        pg.wait_for_function(
            "() => !document.getElementById('almanac-look')", polling=POLL_MS
        )
        assert pg.evaluate("() => !document.body.classList.contains('look-open')")
    finally:
        ctx.close()


def _centre(pg, selector):
    return pg.evaluate(
        "(s) => { const r = document.querySelector(s).getBoundingClientRect();"
        " return [r.left + r.width / 2, r.top + r.height / 2]; }",
        selector,
    )


def _hit(pg, selector):
    """True when what a finger lands on at the control's middle is the control."""
    x, y = _centre(pg, selector)
    return pg.evaluate(
        "([s, x, y]) => { const e = document.elementFromPoint(x, y);"
        " return !!e && !!e.closest(s); }",
        [selector, x, y],
    )


def test_look_controls_are_under_the_finger_not_under_the_sky(browser, served):
    """The sky's canvas once shared the Look button's class and covered every
    control. Taps here are real touches at the control's middle, not clicks."""
    ctx, pg, errors = _look(browser, served, "ios", in_tap=False)
    try:
        for sel in ("#look-close", "#look-ask"):
            assert _hit(pg, sel), sel
        x, y = _centre(pg, "#look-ask")
        pg.touchscreen.tap(x, y)
        pg.wait_for_function("() => window.__asked === 1", polling=POLL_MS)
        x, y = _centre(pg, "#look-close")
        pg.touchscreen.tap(x, y)
        pg.wait_for_function(
            "() => !document.getElementById('almanac-look')", polling=POLL_MS
        )
        assert not errors
    finally:
        ctx.close()


DAYTIME = datetime(2026, 10, 19, 22, 0, tzinfo=timezone.utc)  # 3 pm in San Francisco, the sky blue


def test_look_names_planets_and_bright_stars_by_day(browser, served):
    """Eric, 2026-10-18: "Why not still show things on the blue sky? It only shows sun unless I search for something."
    What the sky's light hides is still marked and named in Look, as it is at night: the Sun's name is not the only one."""
    ctx, pg, errors = _look(browser, served, "none", when=DAYTIME)
    try:
        _wait_painted(pg, "(s) => s.lm < 0 && s.bodies.length > 0")
        # Every planet above the horizon, and every named star as bright as the labelled ones, is a body in daylight.
        want = pg.evaluate(
            """() => { const s = _skyHost.s, e = s.eph;
              return { planets: e.planets.filter(p => p.alt > 0).map(p => p.name),
                       stars: e.stars.filter(t => t.alt > 0 && t.idx >= 0 && _STAR_NAMES[t.idx] && t.mag <= SKY_LABEL_STAR_MAG).length }; }"""
        )
        assert want["planets"] or want["stars"], want
        # Aim at each planet in turn: its mark and its name are there.
        for name in want["planets"]:
            pg.evaluate(
                """(n) => { const p = _skyHost.s.eph.planets.find(q => q.name === n);
                  _look.target = { az: p.az, alt: p.alt, roll: 0 }; _look.view = { az: p.az, alt: p.alt, roll: 0 }; _look.drawn = null; _lookKick(); }""",
                name,
            )
            pg.wait_for_function(
                "(n) => _skyHost.s.bodies.some(b => b.type === 'planet' && b.name === n)",
                arg=name,
                polling=POLL_MS,
            )
            assert any(l["text"] == name for l in _labels(pg)), (name, _labels(pg))
        assert not errors, errors
    finally:
        ctx.close()
