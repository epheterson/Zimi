"""The Almanac's one clock, in a real browser: the date's parts typed in place, the speed slider and its play button, the strip
pinned to the top, and the same clock in the orrery and the 3D view.

Run one file at a time: pytest tests/test_almanac_clock_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

POLL_MS = 100
SF = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
TOKYO = '{"lat":35.68,"lon":139.69,"name":"Tokyo"}'
GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
LA = "America/Los_Angeles"
ALM_SECBAR_H_PX = 44  # ALM_SECBAR_H
ALM_LINGER_WAIT_MS = 15_000  # ALM_SPD_LINGER_MS, with room for a slow machine


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("almclock")
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


def _page(browser, served, width=390, place=SF, tz=LA, init=""):
    phone = width < 600
    ctx = browser.new_context(
        viewport={"width": width, "height": 844},
        device_scale_factor=2,
        has_touch=phone,
        is_mobile=phone,
        service_workers="block",
        color_scheme="dark",
        timezone_id=tz,
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_app_theme', 'dark'); localStorage.setItem('zimi_almanac_place', %r); }"
        " catch (e) {}" % place
    )
    if init:
        ctx.add_init_script(init)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="domcontentloaded")
    pg.wait_for_selector("#almanac-head-date", timeout=60_000)
    pg.wait_for_function(
        "() => typeof _almRevealing !== 'undefined' && !_almRevealing",
        timeout=60_000,
        polling=POLL_MS,
    )
    return ctx, pg, errors


def _land(pg, iso):
    """Park the clock, paused, on an instant (a typed moment keeps the pace, so a test of typing stands it still first)."""
    pg.evaluate("(iso) => { _almClockSetRate(0); _almClockGoTo(new Date(iso)); }", iso)
    pg.wait_for_function("() => !_almEd", timeout=5000, polling=POLL_MS)


def _open(pg):
    """A tap on the resting clock's time opens it: the slider shows."""
    pg.click("#almanac-head-time .ep[data-p=hour]")
    pg.wait_for_function("() => !document.querySelector('#almanac-head .alm-clock').classList.contains('alm-ck-rest')", timeout=5000)


def _wall(pg):
    """The wall clock of the displayed place at the moment shown, as [y, mo, d, h, mi]."""
    return pg.evaluate(
        "() => { var p = _almTzParts(_almFocusInstant(), _almClockTz()); return [p.y, p.mo, p.d, p.h, p.mi]; }"
    )


def _edit(pg, part, text, key="Enter"):
    pg.click(
        "#almanac-head-date .ep[data-p=%s], #almanac-head-time .ep[data-p=%s]"
        % (part, part)
    )
    pg.wait_for_function(
        "(p) => !!_almEd && _almEd.part === p && document.activeElement && document.activeElement.className === 'ef'",
        arg=part,
        timeout=5000,
        polling=POLL_MS,
    )
    pg.keyboard.type(text)
    pg.keyboard.press(key)
    pg.wait_for_function("() => !_almEd", timeout=10_000, polling=POLL_MS)


def test_each_part_is_typed_where_it_stands(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _land(pg, "2026-11-07T20:34:00Z")  # 12:34 PM on 7 Nov in Los Angeles
        assert _wall(pg) == [2026, 11, 7, 12, 34]
        _edit(pg, "day", "15")
        assert _wall(pg) == [2026, 11, 15, 12, 34]
        _edit(pg, "min", "5")
        assert _wall(pg) == [2026, 11, 15, 12, 5]
        _edit(pg, "hour", "9")  # 12-hour field: keeps PM
        assert _wall(pg) == [2026, 11, 15, 21, 5]
        _edit(pg, "year", "2031")
        assert _wall(pg) == [2031, 11, 15, 21, 5]
        # What shows is what was typed, in the words of the header.
        head = pg.evaluate(
            "() => ({ d: document.getElementById('almanac-head-date').textContent, t: document.getElementById('almanac-head-time').textContent })"
        )
        assert (
            head["d"] == "Saturday, November 15, 2031" and head["t"] == "9:05 PM"
        ), head
        # AM/PM flips on a tap, running back through the twelve hours (PM to AM) rather than jumping. The run is
        # stretched here so a slow software-GL frame rate still lands frames in between.
        pg.evaluate("() => { ALM_CLOCK_FLIP_MS = 6000; }")
        before = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.evaluate(
            "() => { window._ckSeen = []; (function rec() { window._ckSeen.push(_almFocusInstant().getTime()); if (window._ckSeen.length < 400) requestAnimationFrame(rec); })(); }"
        )
        pg.click("#almanac-head-time .ep[data-p=ap]")
        pg.wait_for_function(
            "() => !_almRunToRAF && document.querySelector('#almanac-head-time .ep[data-p=ap]').textContent === 'AM'",
            timeout=30_000,
            polling=POLL_MS,
        )
        assert _wall(pg)[3] == 9
        seen = pg.evaluate("() => window._ckSeen")
        half = 12 * 3600 * 1000
        between = [v for v in seen if before - half < v < before]
        assert between, "the flip jumped instead of running through the hours"
        assert between == sorted(between, reverse=True), "PM to AM runs backwards"
        # And AM to PM runs forward.
        at = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.evaluate("() => { window._ckSeen = []; (function rec() { window._ckSeen.push(_almFocusInstant().getTime()); if (window._ckSeen.length < 400) requestAnimationFrame(rec); })(); }")
        pg.click("#almanac-head-time .ep[data-p=ap]")
        pg.wait_for_function("() => !_almRunToRAF && _almFocusInstant().getTime() === %d" % (at + half), timeout=10_000, polling=POLL_MS)
        fwd = [v for v in pg.evaluate("() => window._ckSeen") if at < v < at + half]
        assert fwd and fwd == sorted(fwd)
        pg.click("#almanac-head-time .ep[data-p=ap]")
        pg.wait_for_function("() => !_almRunToRAF && _almFocusInstant().getTime() === %d" % at, timeout=10_000, polling=POLL_MS)
        # The month is a twelve-cell popover; a pick lands it.
        pg.click("#almanac-head-date .ep[data-p=month]")
        pg.wait_for_selector(".alm-ck-pop", timeout=5000)
        assert pg.locator(".alm-ck-pop button").count() == 12
        pg.click(".alm-ck-pop button[data-m='3']")
        pg.wait_for_function("() => !_almEd", timeout=10_000, polling=POLL_MS)
        assert _wall(pg)[1] == 3 and pg.locator(".alm-ck-pop").count() == 0
        # Typing a day the month does not have lands on its last.
        pg.click("#almanac-head-date .ep[data-p=month]")
        pg.click(".alm-ck-pop button[data-m='2']")
        pg.wait_for_function("() => !_almEd", timeout=10_000, polling=POLL_MS)
        _edit(pg, "day", "31")
        assert _wall(pg)[1:3] == [2, 28]
        assert not errors, errors
    finally:
        ctx.close()


def test_escape_puts_a_part_back_and_a_tap_away_lands_it(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _land(pg, "2026-11-07T20:34:00Z")
        pg.click("#almanac-head-date .ep[data-p=day]")
        pg.wait_for_function("() => !!_almEd", timeout=5000)
        pg.keyboard.type("21")
        pg.keyboard.press("Escape")
        pg.wait_for_function("() => !_almEd", timeout=5000)
        assert _wall(pg)[2] == 7
        assert pg.evaluate(
            "() => document.getElementById('almanac-head-date').textContent"
        ).endswith("7, 2026")
        pg.click("#almanac-head-date .ep[data-p=day]")
        pg.keyboard.type("21")
        pg.mouse.click(5, 600)  # away
        pg.wait_for_function("() => !_almEd", timeout=10_000, polling=POLL_MS)
        assert _wall(pg)[2] == 21
        # Another part lands the first and opens itself.
        pg.click("#almanac-head-date .ep[data-p=day]")
        pg.keyboard.type("3")
        pg.click("#almanac-head-time .ep[data-p=hour]")
        pg.wait_for_function(
            "() => !!_almEd && _almEd.part === 'hour'", timeout=10_000, polling=POLL_MS
        )
        assert _wall(pg)[2] == 3
        pg.keyboard.press("Escape")
        assert not errors, errors
    finally:
        ctx.close()


def test_the_nearest_part_to_the_finger_wins(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _land(
            pg, "2026-11-07T20:34:00Z"
        )  # a one-digit day: a small target between the month and the year
        box = pg.locator("#almanac-head-date .ep[data-p=day]").bounding_box()
        # Six pixels off to the left, outside the day, nearer to it than to the month.
        pg.mouse.click(box["x"] - 3, box["y"] + box["height"] / 2)
        pg.wait_for_function("() => !!_almEd", timeout=5000)
        assert pg.evaluate("() => _almEd.part") == "day"
        pg.keyboard.press("Escape")
        # Well clear of every part: nothing opens.
        pg.mouse.click(box["x"] + box["width"] / 2, box["y"] - 40)
        pg.wait_for_timeout(300)
        assert pg.evaluate("() => !_almEd")
        assert not errors, errors
    finally:
        ctx.close()


def test_a_minus_means_bc(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _land(pg, "2026-11-07T20:34:00Z")
        _edit(pg, "year", "-44")
        assert _wall(pg)[0] == -43  # 44 BC
        head = pg.evaluate(
            "() => document.getElementById('almanac-head-date').textContent"
        )
        assert head.endswith("44 BC"), head
        # The era flips on a tap.
        pg.click("#almanac-head-date .ep[data-p=era]")
        pg.wait_for_function(
            "() => document.getElementById('almanac-head-date').textContent.indexOf('BC') < 0",
            timeout=10_000,
            polling=POLL_MS,
        )
        assert _wall(pg)[0] == 44
        # While the year is typed the field says it the way it is typed.
        pg.click("#almanac-head-date .ep[data-p=year]")
        pg.wait_for_function("() => !!_almEd && _almEd.input", timeout=5000)
        assert pg.evaluate("() => _almEd.input.value") == "44"
        # A number pad has no minus: the era beside the field flips it, and keeps the field's focus.
        assert pg.locator(".alm-ck-era").inner_text() == "AD"
        pg.click(".alm-ck-era")
        assert (
            pg.evaluate("() => _almEd.input.value") == "−44"
            and pg.locator(".alm-ck-era").inner_text() == "BC"
        )
        assert pg.evaluate("() => document.activeElement === _almEd.input")
        pg.keyboard.press("Enter")
        pg.wait_for_function("() => !_almEd", timeout=10_000, polling=POLL_MS)
        assert _wall(pg)[0] == -43
        assert not errors, errors
    finally:
        ctx.close()


def test_the_hour_the_clocks_skip_snaps_forward_and_says_so(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _land(pg, "2026-03-08T09:00:00Z")  # 1:00 AM PST, the hour before the skip
        assert _wall(pg) == [2026, 3, 8, 1, 0]
        _edit(pg, "hour", "2")
        assert _wall(pg) == [2026, 3, 8, 3, 0]
        note = pg.evaluate(
            "() => document.querySelector('#almanac-head .alm-ck-note').textContent"
        )
        assert "2:00" in note and "3:00" in note, note
        assert (
            pg.evaluate(
                "() => document.getElementById('almanac-head-time').textContent"
            )
            == "3:00 AM"
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_the_zone_is_the_displayed_places_not_the_browsers(browser, served):
    ctx, pg, errors = _page(browser, served, place=TOKYO, tz=LA)
    try:
        _land(
            pg, "2026-11-07T07:34:00Z"
        )  # 16:34 in Tokyo, 11:34 PM the day before in Los Angeles
        assert (
            pg.evaluate(
                "() => document.getElementById('almanac-head-time').textContent"
            )
            == "4:34 PM"
        )
        assert "JST" in pg.evaluate(
            "() => document.querySelector('#almanac-head .alm-ck-z').textContent"
        ) or "GMT+9" in pg.evaluate(
            "() => document.querySelector('#almanac-head .alm-ck-z').textContent"
        )
        _edit(pg, "hour", "9")  # 9 PM in Tokyo
        assert _wall(pg) == [2026, 11, 7, 21, 34]
        assert pg.evaluate("() => _almFocusInstant().toISOString()").startswith(
            "2026-11-07T12:34:"
        )
        assert not errors, errors
    finally:
        ctx.close()


def _stop_x(box, pos):
    return box["x"] + 10 + pos / 8 * (box["width"] - 20)


def test_the_slider_drags_continuously_and_lands_on_its_stops(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _open(pg)
        box = pg.locator("#almanac-head .alm-spd-range").bounding_box()
        y = box["y"] + box["height"] / 2
        pg.mouse.move(_stop_x(box, 4), y)
        pg.mouse.down()
        pg.mouse.move(_stop_x(box, 6.1), y)  # near the hour stop: the detent takes it
        pg.wait_for_timeout(150)
        assert pg.evaluate("() => _almRate") == 3600
        pg.mouse.move(_stop_x(box, 6.5), y)  # between the stops: continuous
        pg.wait_for_timeout(150)
        mid = pg.evaluate("() => _almRate")
        assert 3600 < mid < 86400 and abs(mid - 3600 * 24**0.5) < 3600 * 0.5, mid
        state = pg.evaluate(
            "() => ({ r: document.querySelector('#almanac-head .alm-ck-r').textContent, hot: !!document.querySelector('#almanac-head .alm-spd-hot'), now: !document.querySelector('#almanac-head .alm-ck-now').hidden })"
        )
        assert state["hot"] and state["now"] and state["r"].endswith("/s"), state
        fill = pg.evaluate(
            "() => { var s = document.querySelector('#almanac-head .alm-spd'); return [parseFloat(s.style.getPropertyValue('--lo')), parseFloat(s.style.getPropertyValue('--hi'))]; }"
        )
        assert (
            abs(fill[0] - 0.5) < 1e-6 and fill[1] > 0.5
        ), fill  # the fill grows from the middle
        pg.mouse.move(_stop_x(box, 1.1), y)  # past the middle, backwards
        pg.wait_for_timeout(150)
        assert pg.evaluate("() => _almRate") == -86400
        pg.mouse.up()
        # Drag the thumb back to the middle stop: real time again (the clock is parked away from now, so it runs from there at real pace).
        pg.mouse.move(_stop_x(box, 1), y)
        pg.mouse.down()
        pg.mouse.move(_stop_x(box, 3), y)
        pg.mouse.move(_stop_x(box, 4.05), y)
        pg.mouse.up()
        pg.wait_for_function("() => _almRate === 1", timeout=5000)
        # A tap on a unit's mark goes to its stop.
        pg.click("#almanac-head .alm-spd-mark[data-stop='7']", force=True)
        assert pg.evaluate("() => _almRate") == 86400
        assert not errors, errors
    finally:
        ctx.close()


def test_the_middle_button_pauses_and_resumes(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        assert pg.evaluate("() => _almRate") == 1
        _open(pg)
        # At real time the thumb stands on the button: a tap on the thumb pauses.
        box = pg.locator("#almanac-head .alm-spd-range").bounding_box()
        pg.mouse.click(_stop_x(box, 4), box["y"] + box["height"] / 2)
        pg.wait_for_function("() => _almRate === 0", timeout=5000)
        held = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.wait_for_timeout(1200)
        assert (
            pg.evaluate("() => _almFocusInstant().getTime()") == held
        )  # it stands still
        assert (
            pg.evaluate(
                "() => document.querySelector('#almanac-head .alm-spd-play').getAttribute('aria-label')"
            )
            not in (None, "")
        )
        assert not pg.evaluate(
            "() => document.querySelector('#almanac-head .alm-ck-now').hidden"
        )
        # The button shows the state: paused is the pause sign, pressed.
        assert pg.evaluate(
            "() => { var b = document.querySelector('#almanac-head .alm-spd-play'); return b.getAttribute('aria-pressed') === 'true' && b._ic === ALM_CK_PAUSE; }"
        )
        # A faster pace, paused, and resumed to the pace it had.
        pg.evaluate("() => _almClockSetRate(3600)")
        assert pg.evaluate(
            "() => { var b = document.querySelector('#almanac-head .alm-spd-play'); return b.getAttribute('aria-pressed') === 'false' && b._ic === ALM_CK_PLAY; }"
        )
        # Running fast, the parts are not underlined and a tap on one types nothing.
        pg.wait_for_function(
            "() => /rgba\\(0, 0, 0, 0\\)|transparent/.test(getComputedStyle(document.querySelector('#almanac-head-time .ep[data-p=hour]')).textDecorationColor)",
            timeout=5000,
            polling=POLL_MS,
        )
        # The part is redrawn every tick at this pace and can be momentarily empty, so the tap is dispatched, not aimed.
        pg.evaluate(
            "() => { var e = document.querySelector('#almanac-head-time .ep[data-p=hour]'); ['pointerdown', 'pointerup', 'click'].forEach(function (t) { e.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true })); }); }"
        )
        assert pg.evaluate("() => !_almEd")
        # The middle at another pace is 1x; at 1x it pauses; paused it plays at 1x.
        pg.click("#almanac-head .alm-spd-play", force=True)
        assert pg.evaluate("() => _almRate") == 1
        pg.click("#almanac-head .alm-spd-play", force=True)
        assert pg.evaluate("() => _almRate") == 0
        pg.click("#almanac-head .alm-spd-play", force=True)
        assert pg.evaluate("() => _almRate") == 1
        # Backwards runs back.
        pg.evaluate("() => _almClockSetRate(-3600)")
        a = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.wait_for_function("(a) => _almFocusInstant().getTime() < a", arg=a, timeout=30_000, polling=POLL_MS)
        # Now is the way home.
        pg.click("#almanac-head .alm-ck-now")
        pg.wait_for_function("() => _almRate === 1 && !_almFocus", timeout=5000)
        assert pg.evaluate(
            "() => document.querySelector('#almanac-head .alm-ck-now').hidden"
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_the_clock_and_the_section_bar_pin_as_one_strip(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function("() => !!_almSecBar", timeout=60_000, polling=POLL_MS)
        assert pg.evaluate("() => document.getElementById('alm-pin').hidden")
        pg.evaluate("() => document.getElementById('almanac-content').scrollTo(0, 900)")
        pg.wait_for_function(
            "() => !document.getElementById('alm-pin').hidden",
            timeout=5000,
            polling=POLL_MS,
        )
        # At rest the strip is the section bar alone: the time pins only while the clock is in use.
        bare = pg.evaluate("() => [getComputedStyle(document.querySelector('#alm-pin .alm-pin-clock')).display, document.getElementById('alm-pin').getBoundingClientRect().height]")
        assert bare[0] == "none" and bare[1] < ALM_SECBAR_H_PX + 8, bare
        pg.evaluate("() => _almClockOpenUp(true)")
        pg.wait_for_function("() => getComputedStyle(document.querySelector('#alm-pin .alm-pin-clock')).display !== 'none'", timeout=5000, polling=POLL_MS)
        got = pg.evaluate(
            """() => { var pin = document.getElementById('alm-pin'), r = pin.getBoundingClientRect(), c = pin.querySelector('.alm-clock').getBoundingClientRect(), b = document.getElementById('alm-secbar').getBoundingClientRect();
          return { top: r.top, h: r.height, clockBottom: c.bottom, barTop: b.top, bars: document.querySelectorAll('.alm-secbar, .alm-pin').length,
                   sticky: getComputedStyle(document.getElementById('alm-secbar-host')).position, line: ALM_SECBAR_LINE }; }"""
        )
        assert (
            got["bars"] == 2 and got["sticky"] == "sticky"
        )  # one strip: the pin holds the bar, no second sticky bar
        assert (
            got["clockBottom"] <= got["barTop"] + 1
            and abs(got["h"] - got["line"] + 4) <= 2
        ), got
        # The pinned clock is the same clock: tapping its day edits it.
        pg.click("#alm-pin .ep[data-p=day]")
        pg.wait_for_function(
            "() => !!_almEd && _almEd.root.getAttribute('data-v') === 'pin'",
            timeout=5000,
            polling=POLL_MS,
        )
        pg.keyboard.type("12")
        pg.keyboard.press("Enter")
        pg.wait_for_function("() => !_almEd", timeout=10_000, polling=POLL_MS)
        assert _wall(pg)[2] == 12
        assert (
            pg.evaluate(
                "() => document.getElementById('almanac-head-date').textContent"
            ).find("12")
            > 0
        )
        # Back at the top the strip goes.
        pg.evaluate("() => document.getElementById('almanac-content').scrollTo(0, 0)")
        pg.wait_for_function(
            "() => document.getElementById('alm-pin').hidden",
            timeout=5000,
            polling=POLL_MS,
        )
        assert not errors, errors
    finally:
        ctx.close()


def test_one_clock_in_the_page_the_orrery_and_the_3d_view(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=120_000,
        )
        pg.evaluate("() => _almClockSetRate(86400)")
        pg.wait_for_function("() => _almFocusInstant().getTime() > Date.now() + 2 * 3600000", timeout=60_000, polling=POLL_MS)
        pg.evaluate("() => _almClockSetRate(0)")
        pg.wait_for_timeout(300)
        same = pg.evaluate(
            "() => ({ page: _almFocusInstant().getTime(), orrery: _orrerySimTime(), view: _aeDisplayMs() })"
        )
        assert (
            same["page"] == same["orrery"] == same["view"]
            and same["page"] > pg.evaluate("() => Date.now()") + 3600_000
        ), same
        # Into the 3D view: the same moment, the same pace, the same slider.
        pg.evaluate("() => openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
            timeout=120_000,
            polling=200,
        )
        assert pg.evaluate("() => _almRate") == 0
        assert (
            pg.evaluate(
                "() => document.querySelector('#ae-clock .alm-ck-d').textContent"
            )
            != ""
        )
        # Play in the view: forward runs the one clock, the page's moment moves, the view draws it.
        pg.click("#ae-clock .alm-spd-play", force=True)
        pg.wait_for_function("() => _almRate !== 0", timeout=5000)
        a = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.evaluate("() => _almClockSetRate(3600)")
        pg.wait_for_function("(a) => _almFocusInstant().getTime() > a + 60000", arg=a, timeout=30_000, polling=POLL_MS)
        b = pg.evaluate(
            "() => ({ page: _almFocusInstant().getTime(), view: _ae.scene.ms, orrery: _orrerySimTime() })"
        )
        assert (
            b["page"] > a + 60_000
            and b["view"] <= b["page"]
            and b["page"] - b["view"] < 3600_000
        ), b
        # Backwards in the view runs back, and paused in the view holds.
        pg.evaluate("() => _almClockSetRate(-3600)")
        c = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.wait_for_function("(c) => _almFocusInstant().getTime() < c", arg=c, timeout=30_000, polling=POLL_MS)
        pg.click("#ae-clock .alm-spd-play", force=True)   # back to 1x
        assert pg.evaluate("() => _almRate") == 1
        pg.click("#ae-clock .alm-spd-play", force=True)   # and paused
        held = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.wait_for_timeout(700)
        assert (
            pg.evaluate("() => _almFocusInstant().getTime()") == held
            and pg.evaluate("() => _almRate") == 0
        )
        # The view's time stands in a pill beside the date (paused, the clock is in use: its parts are underlined).
        assert pg.evaluate(
            "() => !!document.querySelector('#ae-clock .alm-ck-pill > .alm-ck-t .ep[data-p=hour]')"
        )
        # Typed in the view: the part is the same part.
        pg.click("#ae-clock .ep[data-p=day]")
        pg.wait_for_function(
            "() => !!_almEd && _almEd.root.getAttribute('data-v') === 'foot'",
            timeout=5000,
            polling=POLL_MS,
        )
        pg.keyboard.press("Escape")
        # The picture's centre rides up by half the bar.
        shift = pg.evaluate(
            "() => ({ shift: _ae.infoShift, half: document.getElementById('ae-clock').offsetHeight / 2 })"
        )
        assert abs(shift["shift"] - shift["half"]) < 1.5, shift
        # Closing the view leaves the page on the moment.
        pg.evaluate("() => _aeClose()")
        pg.wait_for_function("() => !_aeIsOpen", timeout=10_000, polling=POLL_MS)
        assert pg.evaluate("() => _almFocusInstant().getTime()") == held
        assert not errors, errors
    finally:
        ctx.close()


def test_the_slider_rests_at_now_and_a_picked_day_keeps_the_pace(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        rests = "() => document.querySelector('#almanac-head .alm-clock').classList.contains('alm-ck-rest')"
        shown = "() => getComputedStyle(document.querySelector('#almanac-head .alm-spd')).display !== 'none'"
        # At now and 1x the clock rests as the plain date and time: no slider, nothing underlined.
        assert pg.evaluate(rests) and not pg.evaluate(shown)
        assert pg.evaluate(
            "() => getComputedStyle(document.querySelector('#almanac-head-time .ep[data-p=hour]')).textDecorationColor"
        ) in ("rgba(0, 0, 0, 0)", "transparent")
        # A tap on the time opens it (and types nothing yet); a tap elsewhere shuts it.
        pg.click("#almanac-head-time .ep[data-p=hour]")
        assert not pg.evaluate(rests) and pg.evaluate(shown) and pg.evaluate("() => !_almEd")
        pg.mouse.click(195, 700)
        pg.wait_for_function(rests, timeout=5000, polling=POLL_MS)
        # A day picked on the calendar: the next day at the same time of day, and the clock runs on at 1x, in step.
        pg.evaluate(
            "() => { var f = _almFocusInstant(); _almSelectDay(_gregorianToJDN(f.getFullYear(), f.getMonth() + 1, f.getDate()) + 1); }"
        )
        assert pg.evaluate("() => [!!_almRunToRAF, _almRate]") == [False, 1]   # straight there, never through the night
        a = pg.evaluate("() => [_almFocusInstant().getTime() - Date.now(), _almRate]")
        assert a[1] == 1 and abs(a[0] - 86_400_000) < 120_000, a
        assert not pg.evaluate(rests)  # away: the slider is back
        pg.wait_for_function(
            "(t) => _almFocusInstant().getTime() > t", arg=pg.evaluate("() => _almFocusInstant().getTime()") + 500,
            timeout=30_000, polling=POLL_MS,
        )  # it runs on
        # Any day lands at once, still at 1x.
        pg.evaluate(
            "() => { var f = _almFocusInstant(); _almSelectDay(_gregorianToJDN(f.getFullYear(), f.getMonth() + 1, f.getDate()) + 5); }"
        )
        assert pg.evaluate("() => [!!_almRunToRAF, _almRate]") == [False, 1]
        # Today again: back at now, and the slider rests a moment later.
        back = pg.evaluate(
            "() => { var f = new Date(); _almSelectDay(_gregorianToJDN(f.getFullYear(), f.getMonth() + 1, f.getDate()));"
            " return [_almFocus, document.querySelector('#almanac-head .alm-clock').classList.contains('alm-ck-rest')]; }"
        )
        assert back == [None, False], back
        pg.wait_for_function(rests, timeout=ALM_LINGER_WAIT_MS, polling=POLL_MS)
        assert not errors, errors
    finally:
        ctx.close()


# The page's wall clock moved to a chosen instant that goes on running (timers stay real): window.__wallTo(iso) sets it, so a
# moment of the minute does not depend on when, or how slowly, the suite runs.
WALL_CLOCK_SHIFT = (
    "(function () { var D = Date, off = 0;"
    " function F() { return arguments.length ? new (Function.prototype.bind.apply(D, [null].concat([].slice.call(arguments))))() : new D(D.now() + off); }"
    " F.prototype = D.prototype; F.now = function () { return D.now() + off; }; F.UTC = D.UTC; F.parse = D.parse; window.Date = F;"
    " window.__wallTo = function (iso) { off = D.parse(iso) - D.now(); }; })();"
)


def test_today_picked_again_comes_back_to_live_across_a_minute_turn(browser, served):
    """A day picked away from now keeps the time of day, seconds too. Dropping them lost up to a minute a pick, and today picked
    again after the minute turned was more than a minute from now: the clock stayed away. Starts at 50 s past the minute."""
    ctx, pg, errors = _page(browser, served, init=WALL_CLOCK_SHIFT)
    try:
        pg.evaluate("() => __wallTo('2026-11-09T20:00:50Z')")
        today = "() => { var f = new Date(); _almSelectDay(_gregorianToJDN(f.getFullYear(), f.getMonth() + 1, f.getDate()) + %d); return _almFocus; }"
        pick = pg.evaluate(
            "() => { var t = Date.now(), f = new Date(); _almSelectDay(_gregorianToJDN(f.getFullYear(), f.getMonth() + 1, f.getDate()) + 2);"
            " return _almFocus.getTime() - t - 2 * 86400000; }"
        )
        assert 0 <= pick < 500, pick   # the same time of day, seconds and all
        pg.wait_for_function("() => new Date().getSeconds() < 40", timeout=30_000, polling=POLL_MS)   # the minute has turned
        assert pg.evaluate(today % 0) is None
        assert not errors, errors
    finally:
        ctx.close()


def test_the_rate_does_not_persist(browser, served):
    """Nothing about the clock is a setting: a new open is at real time, so there is nothing for the synced door to carry."""
    ctx, pg, errors = _page(browser, served)
    try:
        pg.evaluate("() => _almClockSetRate(3600)")
        assert (
            pg.evaluate(
                "() => Object.keys(localStorage).filter(function (k) { return /rate|clock|speed/i.test(k); })"
            )
            == []
        )
        # A run through the hours under way (AM/PM flipped) as it closes: it stops with the page.
        pg.evaluate("() => { _almReduceMotion = function () { return false; }; _almClockRunTo(new Date(Date.now() + 12 * 3600e3), function (at) { _almClockHeld = false; _almClockGoTo(at); }); }")
        pg.evaluate("() => closeAlmanac()")
        pg.wait_for_function("() => _almRate === 1 && !_almClockRunning && !_almRunToRAF && _almFocus === null", timeout=5000)
        pg.wait_for_timeout(2500)   # past the run's length: nothing came back to life
        assert pg.evaluate("() => !_almRunToRAF && !_almClockRunning && _almFocus === null")
        assert not errors, errors
    finally:
        ctx.close()


def test_a_day_picked_keeps_the_place_s_time_of_day(browser, served):
    """The device in Los Angeles, the place Tokyo: a day picked on the calendar is that day at the hour Tokyo's clock shows
    (the device's calendar put 08:00 Nov 8 Tokyo, picked to the 20th, on the 21st)."""
    ctx, pg, errors = _page(browser, served, place=TOKYO)
    try:
        _land(pg, "2026-11-07T23:00:00Z")   # 08:00 Nov 8 in Tokyo, 15:00 Nov 7 in Los Angeles
        assert _wall(pg)[:4] == [2026, 11, 8, 8]
        pg.evaluate("() => _almSelectDay(_gregorianToJDN(2026, 11, 20))")
        pg.wait_for_function("() => !_almRunToRAF", timeout=5000, polling=POLL_MS)
        assert _wall(pg)[:4] == [2026, 11, 20, 8]
        assert not errors, errors
    finally:
        ctx.close()
