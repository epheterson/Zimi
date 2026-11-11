"""The Almanac opens at once: the head is on the page without waiting for the sky, and its clock travels into the pinned strip.

On the shipped files, served by Zimi, in headless Chromium at an iPhone's size (390 x 844, touch, mobile), through the same
page and server as test_almanac_phone_defects_browser. The sky's star catalogue is held back so the sky cannot settle: the
page must be shown anyway.

Run: pytest tests/test_almanac_fastopen_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_almanac_phone_defects_browser import (
    PLACE,
    VIEW,
    browser,
    served,
)  # noqa: E402,F401

SHOWN_MS = 3000  # the wait is generous: the machine may be busy

SHOWN = "() => typeof _almShownAt !== 'undefined' && _almShownAt > 0"
HEAD_READY = """() => {
  const d = document.getElementById('almanac-head-date'), t = document.getElementById('almanac-head-time');
  const cards = [...document.querySelectorAll('#almanac-head .alm-card')].filter(c => !c.hidden && c.offsetHeight > 0 && c.textContent.trim().length > 2);
  return !!d && !!t && d.textContent.trim().length > 0 && t.textContent.trim().length > 0 && cards.length >= 6;
}"""


def _context(browser, reduced=False):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        locale="en-US",
        timezone_id="America/Los_Angeles",
        reduced_motion="reduce" if reduced else "no-preference",
        color_scheme="dark",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_app_theme', 'dark');"
        " localStorage.setItem('zimi_almanac_place', %r);"
        " sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (PLACE, PLACE)
    )
    return ctx


def test_the_head_is_shown_while_the_sky_is_still_waiting_for_its_stars(
    browser, served
):
    ctx = _context(browser)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    held = []
    # The star catalogue never comes: the GPU sky cannot be final, as on a phone away from home.
    ctx.route("**/earth/stars-v1.bin*", lambda route: held.append(route))
    try:
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_function("() => typeof openAlmanac === 'function'", timeout=60_000)
        pg.evaluate(
            "() => { window.__shifts = 0; new PerformanceObserver(l => l.getEntries().forEach(e => { if (!e.hadRecentInput) window.__shifts += e.value; })).observe({type: 'layout-shift'}); window.__t0 = performance.now(); openAlmanac(); }"
        )
        pg.wait_for_function(SHOWN, timeout=SHOWN_MS * 10, polling=50)
        assert pg.evaluate(
            HEAD_READY
        ), "the date, the clock and the six cards are readable when the page is shown"
        assert pg.evaluate(
            "!_skyState || !_skyState.settled"
        ), "the sky had not settled: the page did not wait for it"
        pg.wait_for_timeout(1500)
        shift = pg.evaluate("window.__shifts")
        assert shift < 0.02, (
            "nothing jumps once the head is shown (layout shift %s)" % shift
        )
        assert not errors, errors
    finally:
        for r in held:
            try:
                r.abort()
            except Exception:
                pass
        ctx.close()


def test_the_moon_disc_holds_its_place_while_its_map_is_on_the_way(browser, served):
    ctx = _context(browser)
    pg = ctx.new_page()
    held = []
    ctx.route("**/earth/moon-v1.webp*", lambda route: held.append(route))
    try:
        pg.goto(served + "/", wait_until="domcontentloaded")
        pg.wait_for_function("() => typeof openAlmanac === 'function'", timeout=60_000)
        pg.evaluate("openAlmanac()")
        pg.wait_for_function(SHOWN, timeout=SHOWN_MS * 10, polling=50)
        box = pg.evaluate(
            "(() => { const r = document.querySelector('#almanac-head .almanac-moon-sprite').getBoundingClientRect(); return [r.width, r.height, getComputedStyle(document.querySelector('#almanac-head .almanac-moon-sprite')).opacity]; })()"
        )
        assert (
            box[0] > 100 and box[1] > 100
        ), "the disc has its size before its map arrives"
        assert (
            float(box[2]) == 0.0
        ), "...and is clear, not a grey disc that then changes"
    finally:
        for r in held:
            try:
                r.abort()
            except Exception:
                pass
        ctx.close()


SCROLL_HEAD = "(top) => { const sc = document.getElementById('almanac-content'); sc.scrollTop = top; sc.dispatchEvent(new Event('scroll')); }"
PIN = """() => { const p = document.getElementById('alm-pin'), c = document.querySelector('#almanac-head .alm-clock');
  return { p: parseFloat(p.style.getPropertyValue('--alm-pin-p') || '0'), hidden: p.hidden, head: c.style.opacity === '' ? 1 : parseFloat(c.style.opacity) }; }"""


def _open(pg, served):
    pg.goto(served + "/#almanac?t=1893456000", wait_until="load")
    pg.wait_for_function(
        "() => typeof _almSecBarInit === 'function' && document.getElementById('alm-pin') && _almPanelsReady",
        timeout=60_000,
    )


def test_the_clock_travels_into_the_pinned_strip_with_the_scroll(browser, served):
    ctx = _context(browser)
    pg = ctx.new_page()
    try:
        _open(pg, served)
        seen = []
        top = pg.evaluate(
            "document.querySelector('#almanac-head .alm-clock').offsetTop"
        )
        for y in (0, top - 20, top + 5, top + 20, top + 35, top + 50, top + 120):
            pg.evaluate(SCROLL_HEAD, max(0, y))
            seen.append(pg.evaluate(PIN))
        assert (
            seen[0]["p"] == 0 and seen[0]["hidden"]
        ), "at the top only the header's clock"
        mid = [s for s in seen if 0 < s["p"] < 1]
        assert len(mid) >= 2, (
            "between the two there are in-between positions, not a swap: %s" % seen
        )
        assert all(not s["hidden"] for s in mid) and all(
            abs(s["head"] - (1 - s["p"])) < 0.01 for s in mid
        ), seen
        ps = [s["p"] for s in seen]
        assert ps == sorted(ps), "the pinned clock only arrives as the page goes up"
        assert (
            seen[-1]["p"] == 1 and not seen[-1]["hidden"]
        ), "scrolled away, the strip's clock is all there"
    finally:
        ctx.close()


def test_with_reduced_motion_the_clock_swaps_instead_of_travelling(browser, served):
    ctx = _context(browser, reduced=True)
    pg = ctx.new_page()
    try:
        _open(pg, served)
        top = pg.evaluate(
            "document.querySelector('#almanac-head .alm-clock').offsetTop"
        )
        ps = set()
        for y in range(max(0, top - 20), top + 140, 7):
            pg.evaluate(SCROLL_HEAD, y)
            ps.add(pg.evaluate(PIN)["p"])
        assert ps == {0.0, 1.0}, ps
    finally:
        ctx.close()


BOXES = """() => {
  const sc = document.getElementById('almanac-content');
  const at = q => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  return ['#almanac-head .alm-clock', '#almanac-head .almanac-hero', '#almanac-head .almanac-moon-open', '#almanac-head .alm-cards', '#almanac-head .alm-card:nth-of-type(1)',
    '.alm-sky-info', '#almanac-sky-canvas'].map(at);
}"""


@pytest.mark.parametrize("place", [True, False], ids=["a-place-chosen", "no-place-chosen"])
def test_the_first_frame_is_the_page_before_the_scripts_are_read_and_nothing_moves_when_they_are(browser, served, place):
    """The tap shows the head, final in its boxes, with almanac.js still on its way; when it has run and drawn its own,
    every box (the date and time, the Moon's square, the tiles, the sky's caption room and the sky) is where it was."""
    ctx = _context(browser)
    if not place:
        ctx.add_init_script("try { localStorage.removeItem('zimi_almanac_place'); sessionStorage.removeItem('zimi_almanac_location'); } catch (e) {}")
    pg = ctx.new_page()
    held = []
    ctx.route("**/static/almanac.js*", lambda route: held.append(route))
    try:
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_function("() => typeof openAlmanac === 'function'", timeout=60_000)
        pg.evaluate("openAlmanac()")
        pg.wait_for_function("() => !!document.querySelector('#almanac-head .alm-cards')", timeout=60_000)
        assert pg.evaluate("typeof _almShownAt === 'undefined' || !_almanacOpen"), "almanac.js had not run: this is app.js's own frame"
        assert not pg.evaluate("!!document.getElementById('alm-veil')"), "there is no veil"
        first = pg.evaluate(BOXES)
        text = pg.evaluate(
            """() => ({date: document.getElementById('almanac-head-date').textContent, time: document.getElementById('almanac-head-time').textContent,
              phase: document.getElementById('alm-hc-phase').textContent, labels: [...document.querySelectorAll('#almanac-head .alm-card-lbl')].map(e => e.textContent),
              illum: document.getElementById('alm-hc-illum').textContent,
              disc: getComputedStyle(document.querySelector('#almanac-head .almanac-moon-sprite')).visibility})"""
        )
        assert text["date"].strip() and text["time"].strip() and text["phase"].strip(), text
        assert len(text["labels"]) == 6 and not any(l.startswith(("alm_", "tb_")) for l in text["labels"]), text
        assert text["illum"].endswith("%") and text["disc"] == "hidden", text
        assert all(b and b[3] > 0 for b in first), first
        if os.environ.get("FIRST_FRAME_SHOT"):
            pg.screenshot(path=os.environ["FIRST_FRAME_SHOT"])
        for r in held:
            r.continue_()
        pg.wait_for_function(SHOWN, timeout=SHOWN_MS * 20, polling=100)
        pg.wait_for_timeout(500)
        final = pg.evaluate(BOXES)
        assert final == first, "the head and the sky stand where the first frame had them: first %s final %s" % (first, final)
    finally:
        ctx.close()
