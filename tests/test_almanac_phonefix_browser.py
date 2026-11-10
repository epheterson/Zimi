"""Defects a phone-path pass found in the 3D view and the Almanac, each held in a real browser.

On the shipped files, served by Zimi, in headless Chromium with software GL at an iPhone's size (390 x 844, touch,
mobile), through the same page and server as test_almanac_phone_defects_browser. One test per defect, named for it.

Run: pytest tests/test_almanac_phonefix_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_almanac_phone_defects_browser import (
    READY_MS,
    _page,
    browser,
    served,
)  # noqa: E402,F401

OPEN = "() => typeof _aeIsOpen !== 'undefined' && _aeIsOpen && _aeReady() && !_ae.fly"


def _open_3d(pg, target="earth"):
    pg.wait_for_function("() => typeof _aeLoadThree === 'function'", timeout=60_000)
    pg.evaluate("(t) => openAlmanacEarth({ target: t })", target)
    pg.wait_for_function(OPEN, timeout=READY_MS, polling=200)


def _pinch(ctx, pg, cx, cy, d0, d1, steps=10):
    """Two fingers on the screen, from d0 px apart to d1, as a phone sends them."""
    cdp = ctx.new_cdp_session(pg)
    pts = lambda d: [
        {"x": cx - d / 2, "y": cy, "id": 1},
        {"x": cx + d / 2, "y": cy, "id": 2},
    ]  # noqa: E731
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pts(d0)})
    for i in range(1, steps + 1):
        cdp.send(
            "Input.dispatchTouchEvent",
            {"type": "touchMove", "touchPoints": pts(d0 + (d1 - d0) * i / steps)},
        )
        pg.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()


def test_pinching_out_of_the_planets_view_closes_it_without_an_error(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _open_3d(pg)
        pg.click("[data-ae-view='planets']")
        pg.wait_for_function(
            "() => !_ae.fly && _ae.preset === 'planets'", timeout=60_000, polling=200
        )
        for _ in range(6):
            _pinch(ctx, pg, 195, 420, 300, 60)
            pg.wait_for_timeout(300)
            if not pg.evaluate("_aeIsOpen"):
                break
        assert pg.evaluate("_aeIsOpen") is False, "the pull-out closed the view"
        assert not errors, errors
    finally:
        ctx.close()


CHOSEN_MS = (
    1717243200000  # 2024-06-01T12:00:00Z, a date the reader picked before the mission
)
FOCUS = "() => ({ set: !!_almFocus, ms: _almFocusInstant().getTime(), rate: _almRate, now: Date.now() })"


def _fly_apollo_and_go_back(pg):
    pg.evaluate("_aeMissionStart('apollo11')")
    pg.wait_for_function(
        "() => !!(_ae.mission && _almFocusInstant().getFullYear() === 1969)",
        timeout=60_000,
        polling=200,
    )
    pg.click("#back-btn")
    pg.wait_for_function("() => !_aeIsOpen", timeout=20_000, polling=100)
    pg.wait_for_timeout(500)
    return pg.evaluate(FOCUS)


def test_leaving_a_mission_puts_the_almanac_back_at_now(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _open_3d(pg)
        got = _fly_apollo_and_go_back(pg)
        assert got["set"] is False, got  # live again, not a chosen date
        assert abs(got["ms"] - got["now"]) < 60_000, got
        assert got["rate"] == 1, got
        assert "1969" not in pg.inner_text("#almanac-head")
        assert not errors, errors
    finally:
        ctx.close()


def test_leaving_a_mission_puts_back_the_date_the_reader_chose(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function(
            "() => typeof _almScrubSettle === 'function'", timeout=60_000
        )
        pg.evaluate("(ms) => _almScrubSettle(new Date(ms))", CHOSEN_MS)
        _open_3d(pg)
        got = _fly_apollo_and_go_back(pg)
        assert got["set"] is True, got
        assert abs(got["ms"] - CHOSEN_MS) < 60_000, got
        assert not errors, errors
    finally:
        ctx.close()


STANDING = "() => !!(_ae.stand && _ae.stand.mode === 'ground')"


def test_back_from_stand_here_returns_to_the_globe_it_was_entered_from(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        for body, lat, lon in (("earth", 34.05, -118.24), ("mars", 18.4, 77.5)):
            _open_3d(pg, body)
            pg.evaluate("(a) => _aeStandAt(a[0], a[1], a[2])", [body, lat, lon])
            pg.wait_for_function(STANDING, timeout=READY_MS, polling=250)
            pg.click("#back-btn")
            pg.wait_for_function(
                "() => !_ae.stand && !_ae.standPending", timeout=60_000, polling=200
            )
            pg.wait_for_timeout(400)
            assert (
                pg.evaluate("_aeIsOpen") is True
            ), body  # one level out: the globe, not the Almanac page
            assert pg.evaluate("_ae.target") == body
            pg.click("#back-btn")  # and the next one leaves the view
            pg.wait_for_function("() => !_aeIsOpen", timeout=20_000, polling=100)
            pg.wait_for_timeout(400)
        assert pg.evaluate("_almanacOpen") is True
        assert not errors, errors
    finally:
        ctx.close()


def test_back_from_stand_here_entered_from_the_sky_card_returns_to_the_card(
    browser, served
):
    ctx, pg, errors = _page(browser, served)
    try:
        pg.wait_for_function("() => typeof _aeStandOpen === 'function'", timeout=60_000)
        pg.evaluate(
            "() => { window.__back = 0; _aeStandOpen({ lat: 34.05, lon: -118.24, heading: 180, direct: true, back: function () { window.__back++; } }); }"
        )
        pg.wait_for_function(STANDING, timeout=READY_MS, polling=250)
        pg.click("#back-btn")
        pg.wait_for_function(
            "() => !_aeIsOpen && window.__back === 1", timeout=60_000, polling=200
        )
        assert pg.evaluate("_almanacOpen") is True
        assert not errors, errors
    finally:
        ctx.close()


def _go_search(pg, typed):
    pg.fill("#ae-go-q", typed)
    pg.wait_for_timeout(
        1500
    )  # the landmarks at once, the towns after the server's answer
    return pg.evaluate(
        """() => { const found = document.getElementById('ae-go-found'), none = document.getElementById('ae-go-none');
          return { rows: found && !found.hidden ? [...found.querySelectorAll('.ae-go-row')].map(r => r.innerText) : [],
                   none: none && !none.hidden ? none.innerText : '' }; }"""
    )


def test_go_to_finds_a_big_city_with_no_map_and_says_when_nothing_is_found(
    browser, served
):
    ctx, pg, errors = _page(browser, served)
    try:
        _open_3d(pg)
        pg.click("#ae-go-btn")
        pg.wait_for_selector("#ae-go-q", state="visible", timeout=20_000)
        got = _go_search(pg, "Los Angeles")
        assert got["rows"] and got["rows"][0].startswith("Los Angeles"), got
        assert got["none"] == "", got
        got = _go_search(pg, "Qzxqzxq")
        assert got["rows"] == [], got
        assert got["none"] == pg.evaluate("t('no_results')"), got
        _go_search(pg, "Tokyo")
        pg.click("#ae-go-found .ae-go-row")
        pg.wait_for_function(
            "() => !!(_ae.place && _ae.place.name.indexOf('Tokyo') === 0)",
            timeout=20_000,
        )
        assert not errors, errors
    finally:
        ctx.close()


# Today, and two dates when the inner planets line up with the Earth: Venus at inferior conjunction (2026-10-24), and
# Venus and Mercury both near it (2025-03-22).
LINEUPS = [None, 1792843200000, 1742644800000]
MARKS = """() => { const v = _ae.el.getBoundingClientRect();
  return _ae.marksDrawn.map(d => { const e = d.el && document.getElementById(d.el), b = e && e.querySelector('b');
    const named = b && getComputedStyle(b).display !== 'none' && getComputedStyle(e).display !== 'none' && d.body === d.lead, nb = named ? b.getBoundingClientRect() : null;
    return { body: d.body, x: d.x, y: d.y, r: d.r, far: !!(e && e.classList.contains('ae-bm-pos')),
             name: nb ? [nb.left - v.left, nb.top - v.top, nb.right - v.left, nb.bottom - v.top] : null }; }); }"""


def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(
        0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) or 1))
    )
    return ((ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2) ** 0.5


def _label_faults(marks):
    meet = (
        lambda a, b: a[0] < b[2] - 0.5
        and b[0] < a[2] - 0.5
        and a[1] < b[3] - 0.5
        and b[1] < a[3] - 0.5
    )  # noqa: E731
    faults = []
    for m in marks:
        if not m["name"]:
            continue
        n = m["name"]
        # The leader runs from the dot's edge to the nearest point of its name.
        ex, ey = min(max(m["x"], n[0]), n[2]), min(max(m["y"], n[1]), n[3])
        ll = ((ex - m["x"]) ** 2 + (ey - m["y"]) ** 2) ** 0.5 or 1
        sx, sy = (
            m["x"] + (ex - m["x"]) / ll * m["r"],
            m["y"] + (ey - m["y"]) / ll * m["r"],
        )
        for o in marks:
            if o is m:
                continue
            if o["name"] and meet(n, o["name"]):
                faults.append(("names meet", m["body"], o["body"]))
            if meet(
                n, [o["x"] - o["r"], o["y"] - o["r"], o["x"] + o["r"], o["y"] + o["r"]]
            ):
                faults.append(("name on a dot", m["body"], o["body"]))
            if (
                m["far"]
                and _seg_dist(o["x"], o["y"], sx, sy, ex, ey) <= o["r"] + 1
            ):
                faults.append(("leader through a dot", m["body"], o["body"]))
            if m["far"] and o["name"]:
                on = o["name"]
                pts = [
                    (sx + (ex - sx) * k / 64, sy + (ey - sy) * k / 64)
                    for k in range(65)
                ]
                if any(
                    on[0] + 0.5 < x < on[2] - 0.5 and on[1] + 0.5 < y < on[3] - 0.5
                    for x, y in pts
                ):
                    faults.append(("leader through a name", m["body"], o["body"]))
    return faults


def test_planets_view_names_and_leaders_keep_clear_on_lineup_dates(browser, served):
    ctx, pg, errors = _page(browser, served)
    try:
        _open_3d(pg)
        report = {}
        for ms in LINEUPS:
            if ms:
                pg.evaluate("(ms) => { _aeGoTo(ms); _almClockSetRate(0); }", ms)
            pg.click("[data-ae-view='planets']")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.preset === 'planets'; }",
                timeout=60_000,
                polling=200,
            )
            pg.wait_for_timeout(800)
            marks = pg.evaluate(MARKS)
            named = {m["body"] for m in marks if m["name"]}
            assert {"mercury", "venus", "earth", "mars"} <= named, (ms, named)
            report[ms] = _label_faults(marks)
            pg.click("[data-ae-view='earth']")
            pg.wait_for_function(
                "() => !_ae.fly && _ae.target === 'earth'", timeout=60_000, polling=200
            )
        assert not any(report.values()), report
        assert not errors, errors
    finally:
        ctx.close()
