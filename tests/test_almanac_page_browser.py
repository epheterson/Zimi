"""The Almanac page follows the time machine, and its map is quiet where it should be.

- the world clocks (face, digits, cards) read the time travelled to, not the real now
- the night's edge on the map is drawn in every frame of a run, and its declination does not step at midnight
- beside the city under the map there is the locate-me button and no map button

Run: pytest tests/test_almanac_page_browser.py -v
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
from test_almanac_corners_browser import _open, base  # noqa: E402,F401

SHOT = os.environ.get("ALM_SHOTS", "")


def _shot(pg, name):
    if SHOT:
        os.makedirs(SHOT, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOT, name))


def test_the_world_clocks_read_the_time_travelled_to(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errs = _open(pw, base)
        pg.wait_for_selector(".alm-tz-city-card", state="attached", timeout=60000)
        # New York, 2031-03-14 15:00 UTC: 11:00 in the morning there (EDT), a year the real clock is not in.
        pg.evaluate(
            "() => { _almFocus = new Date(Date.UTC(2031, 2, 14, 15, 0, 0)); _almRate = 0; _almRepaintFocus(); }"
        )
        pg.wait_for_function(
            "() => [...document.querySelectorAll('.alm-tz-city-time')].some(e => /11:00/.test(e.textContent))", timeout=10000
        )
        face = pg.evaluate("() => document.getElementById('almanac-tz-label').textContent")
        pg.locator("#almanac-tz-pills").scroll_into_view_if_needed()
        _shot(pg, "tz-clock-travelled.png")
        # A second goes by: the clock stays where the time machine put it.
        pg.wait_for_timeout(2200)
        after = pg.evaluate("() => [...document.querySelectorAll('.alm-tz-city-time')].map(e => e.textContent)")
        br.close()
        assert not errs, errs
        assert any("11:00" in x for x in after), (after, face)


def test_the_hand_stands_still_when_the_clock_is_held(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errs = _open(pw, base)
        pg.wait_for_selector("#almanac-tz-hand", state="attached", timeout=60000)
        pg.evaluate("() => { _almFocus = new Date(Date.UTC(2031, 2, 14, 15, 0, 30)); _almRate = 0; _almRepaintFocus(); }")
        pg.wait_for_timeout(1500)
        state = pg.evaluate("() => { const a = document.getElementById('almanac-tz-hand')._anim; return [a.playState, a.currentTime]; }")
        br.close()
        assert not errs, errs
        assert state[0] == "paused" and abs(state[1] - 30000) < 1500, state


def test_the_night_edge_is_drawn_in_every_frame_of_a_run(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errs = _open(pw, base)
        pg.wait_for_selector("#almanac-sunmap-canvas", state="attached", timeout=60000)
        pg.locator("#almanac-sunmap").scroll_into_view_if_needed()
        pg.wait_for_timeout(800)
        pg.evaluate(
            "() => { window.__draws = 0; const f = window._sunMapTravelDraw;"
            " window._sunMapTravelDraw = function (x) { window.__draws++; return f(x); }; _almClockSetRate(3600); }"
        )
        pg.wait_for_timeout(2000)
        draws = pg.evaluate("() => { const n = window.__draws; _almClockSetRate(0); return n; }")
        _shot(pg, "sunmap-run.png")
        br.close()
        assert not errs, errs
        # 2 s at 60 fps is 120 frames; the old pace was one draw in 400 to 1000 ms (2 to 5).
        assert draws >= 30, draws


def test_the_sun_declination_is_continuous_across_midnight(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errs = _open(pw, base)
        a, b = pg.evaluate(
            "() => { const d = new Date(2031, 2, 14, 23, 59, 59), e = new Date(2031, 2, 15, 0, 0, 1);"
            " return [_solarDeclination(_solarB(_dayOfYearFraction(d))), _solarDeclination(_solarB(_dayOfYearFraction(e)))]; }"
        )
        whole = pg.evaluate(
            "() => [_solarDeclination(_solarB(_dayOfYear(new Date(2031, 2, 14, 23, 59, 59)))),"
            " _solarDeclination(_solarB(_dayOfYear(new Date(2031, 2, 15, 0, 0, 1))))]"
        )
        br.close()
        assert not errs, errs
        assert abs(a - b) < abs(whole[0] - whole[1]) / 100, (a, b, whole)


def test_beside_the_city_there_is_locate_me_and_no_map_button(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errs = _open(pw, base)
        pg.wait_for_selector("#almanac-loc-name", state="attached", timeout=60000)
        n = pg.evaluate(
            "() => { const row = document.getElementById('almanac-loc-name').parentElement;"
            " return [row.querySelectorAll('.alm-here-icon').length, row.querySelectorAll('[onclick*=\"_almMapHere\"]').length]; }"
        )
        pg.locator("#almanac-loc-name").scroll_into_view_if_needed()
        _shot(pg, "sunmap-location-row.png")
        br.close()
        assert not errs, errs
        assert n == [1, 0], n


def test_a_row_naming_the_almanac_zim_opens_the_almanac_page(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(viewport={"width": 390, "height": 844}, service_workers="block").new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
        pg.goto(base + "/")
        pg.wait_for_function("() => typeof openZimOrApp === 'function'", timeout=60000)
        pg.evaluate("() => openZimOrApp('zimi_almanac')")
        pg.wait_for_function("() => document.body.classList.contains('almanac-mode')", timeout=60000)
        path = pg.evaluate("() => location.pathname + location.hash")
        br.close()
        assert not errs, errs
        assert path == "/#almanac", path


def test_the_activity_rows_go_through_the_one_opener():
    src = open(os.path.join(os.path.dirname(HERE), "zimi", "static", "manage.js"), encoding="utf-8").read()
    row = src[src.index("var zim = _actZim(r.subject)"):][:2500]
    assert "openZimOrApp(" in row and "enterSource(" not in row


def test_a_tapped_library_card_for_the_almanac_opens_the_almanac_page(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(viewport={"width": 390, "height": 844}, service_workers="block").new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
        pg.goto(base + "/")
        pg.wait_for_function("() => typeof enterSource === 'function'", timeout=60000)
        pg.evaluate("() => enterSource('zimi_almanac', true)")
        pg.wait_for_function("() => document.body.classList.contains('almanac-mode')", timeout=60000)
        path = pg.evaluate("() => location.pathname + location.hash")
        br.close()
        assert not errs, errs
        assert path == "/#almanac", path
