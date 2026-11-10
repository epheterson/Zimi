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


STANDING = "() => !!(typeof _ae !== 'undefined' && _ae && _ae.stand && _ae.stand.mode === 'ground')"


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
            if m["far"] and _seg_dist(o["x"], o["y"], sx, sy, ex, ey) <= o["r"] + 1:
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


# The 3D view's own frames asked for (requestAnimationFrame(_aeFrame)), over `ms`: the page's other loops (the
# Almanac's, background jobs) are not this view's.
RAF_COUNT = """(ms) => new Promise(res => { let n = 0; const o = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { if (cb === _aeFrame) n++; return o.call(window, cb); };
  setTimeout(() => { window.requestAnimationFrame = o; res(n); }, ms); })"""


@pytest.mark.parametrize("reduced", [False, True])
def test_the_3d_view_asks_for_no_frames_while_nothing_moves(browser, served, reduced):
    ctx, pg, errors = _page(browser, served, reduced=reduced)
    try:
        _open_3d(pg)
        pg.wait_for_timeout(3000)  # the opening's own work done
        # Real time: a picture a second at most, and only when something on screen has moved.
        live = pg.evaluate(RAF_COUNT, 5000)
        assert live <= 6, live
        pg.evaluate("_almClockSetRate(0)")
        pg.wait_for_timeout(1500)
        paused = pg.evaluate(RAF_COUNT, 5000)
        assert paused == 0, paused
        # Time running visibly is drawn every frame; a touch is answered at once.
        pg.evaluate("_almClockSetRate(3600)")
        assert pg.evaluate("_aeBusy()") is True
        pg.evaluate("_almClockSetRate(0)")
        pg.wait_for_timeout(1500)
        drawn = pg.evaluate(
            "() => { const t = _ae.lastRender; _aeTurnBy(0.01, 0); return new Promise(r => setTimeout(() => r(_ae.lastRender > t), 500)); }"
        )
        assert drawn is True
        assert not errors, errors
    finally:
        ctx.close()


HD_BASE = "/w/zimi_almanac_maxi/hd/"


def _with_hd(pg, manifest):
    """The server says the HD set is installed; its list of layers is `manifest` (tiles themselves 404, as on a bare set)."""
    import json

    def sats(route):
        body = route.fetch().json()
        body["hd"] = {"installed": True, "base": HD_BASE, "parts": {}, "mode": "ask"}
        route.fulfill(
            status=200, content_type="application/json", body=json.dumps(body)
        )

    pg.route("**/almanac-satellites*", sats)
    pg.route(
        "**" + HD_BASE + "hd.json",
        lambda r: r.fulfill(
            status=200, content_type="application/json", body=json.dumps(manifest)
        ),
    )
    pg.route(
        "**" + HD_BASE + "craft/index.json",
        lambda r: r.fulfill(
            status=200, content_type="application/json", body='{"models":{}}'
        ),
    )


@pytest.mark.parametrize("craft", [False, True])
def test_the_hd_craft_list_is_asked_for_only_when_the_set_says_it_has_craft(
    browser, served, craft
):
    ctx, pg, errors = _page(browser, served)
    try:
        asked = []
        pg.on(
            "request",
            lambda r: (
                asked.append(r.url) if r.url.endswith("/craft/index.json") else None
            ),
        )
        manifest = {"version": 1, "tile": 512, "ext": "webp", "layers": {}}
        if craft:
            manifest["craft"] = True
        _with_hd(pg, manifest)
        _open_3d(pg)
        pg.wait_for_function("() => !!_ae.hdInstalled", timeout=60_000, polling=200)
        # A craft close enough to want its full model asks for the list (a landing site's model does the same).
        pg.evaluate("() => _aeCraftHdIndexLoad()")
        pg.wait_for_function(
            "() => _aeCraftHd.index !== undefined", timeout=20_000, polling=100
        )
        pg.wait_for_timeout(500)
        assert len(asked) == (1 if craft else 0), asked
        assert not errors, errors
    finally:
        ctx.close()


DAY_OVER_LA_MS = 1794340800000  # 2026-11-10 20:00 UTC: noon in Los Angeles
OVER = """(a) => { _aeGoTo(a.ms); _almClockSetRate(0);
  _aeFlyTo('earth', a.dist, _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(a.lat, a.lon), _aeSceneAt(_aeDisplayMs()).gast)));
  _ae.preset = null; _ae.dirty = true; _aeKick(); }"""
# Drawn and read in the same frame (the canvas keeps no buffer): the middle third's mean colour, and, for a whole globe,
# the bluest point just outside its limb (the air's glow).
PIXELS = """() => new Promise(res => { _ae.dirty = true; _aeKick(); requestAnimationFrame(() => {
  const c = document.getElementById('ae-canvas'), w = c.width, h = c.height, t = document.createElement('canvas'); t.width = w; t.height = h;
  const g = t.getContext('2d'); g.drawImage(c, 0, 0);
  const d = g.getImageData(Math.floor(w / 3), Math.floor(h / 3), Math.floor(w / 3), Math.floor(h / 3)).data, s = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
  const n = d.length / 4, k = w / _ae.w, mid = _aeProject([0, 0, 0]);
  let limb = -1;
  if (mid) { const r = AE_TARGETS.earth.surface * _aeFocalPx() / Math.sqrt(_ae.dist * _ae.dist - 1) * k;
    for (let a = 0; a < 64; a++) { const x = Math.round(mid.x * k + Math.cos(a / 64 * 2 * Math.PI) * r * 1.012), y = Math.round(mid.y * k + Math.sin(a / 64 * 2 * Math.PI) * r * 1.012);
      if (x < 0 || y < 0 || x >= w || y >= h) continue; const p = g.getImageData(x, y, 1, 1).data; limb = Math.max(limb, p[2] - p[0]); } }
  res({ rgb: s.map(v => Math.round(v / n)), limb: limb }); }); })"""


def test_the_ground_reads_from_orbit_and_the_far_globe_keeps_its_blue_limb(
    browser, served
):
    ctx, pg, errors = _page(browser, served)
    try:
        _open_3d(pg)
        pg.evaluate(
            OVER, {"ms": DAY_OVER_LA_MS, "dist": 1.0, "lat": 34.05, "lon": -118.25}
        )  # as near as the view goes
        pg.wait_for_function(
            "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
            timeout=120_000,
            polling=250,
        )
        pg.wait_for_timeout(1500)
        near = pg.evaluate(PIXELS)
        r, g, b = near["rgb"]
        # The ground, not a pale-blue sheet of air over it (it was 118, 177, 251).
        assert b - r < 40 and r + g + b < 360, near
        pg.evaluate(
            OVER, {"ms": DAY_OVER_LA_MS, "dist": 4.0, "lat": 34.05, "lon": -118.25}
        )
        pg.wait_for_function(
            "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
            timeout=120_000,
            polling=250,
        )
        pg.wait_for_timeout(1500)
        far = pg.evaluate(PIXELS)
        assert far["limb"] > 30, far  # the air's blue at the sunlit limb
        assert not errors, errors
    finally:
        ctx.close()
