"""A body is the same body at every distance: no flat disc is painted over it while its own picture is bigger than the disc.

In headless Chromium at a phone's size (as test_almanac_iss_browser.py).

Run: pytest tests/test_almanac_transit_body_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

DISC_ALPHA = """([body, px]) => {
  var el = document.createElement('i'), m = { x: 100, y: 100, r: 5, el: el, ringed: false, body: body, px: px };
  m.pts = [m];
  _aePaintMarks([m]);
  var cv = document.getElementById('ae-marks-c'), g = cv.getContext('2d'), d = _ae.gl.dpr;
  return g.getImageData(Math.round(100 * d), Math.round(100 * d), 1, 1).data[3];
}"""


def test_a_planets_disc_waits_for_its_body_to_shrink_under_it(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            for body in ("earth", "mars", "jupiter"):
                assert pg.evaluate(DISC_ALPHA, [body, 60]) == 0, (
                    body + ": a disc over a body still 60 px across"
                )
                assert pg.evaluate(DISC_ALPHA, [body, 20]) == 0, (
                    body + ": a disc over a body still 20 px across"
                )
                assert pg.evaluate(DISC_ALPHA, [body, 1]) > 200, (
                    body + ": a body under a pixel is the disc"
                )
            # it fades in between: never a step
            mid = [pg.evaluate(DISC_ALPHA, ["earth", px]) for px in (8, 6, 4, 2)]
            assert mid == sorted(mid) and 0 < mid[0] < mid[-1], mid
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


FLY_KEEP = """([to, frames, key]) => {
  var NOW = Date.now(), PERF = performance.now(), RealDate = Date;
  window.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
  performance.now = function () { return PERF; };
  var cbs = [];
  window.requestAnimationFrame = function (cb) { cbs.push(cb); return cbs.length; };
  window.cancelAnimationFrame = function () {};
  _ae.gl.renderer.render = function () {};
  _almFocus = new RealDate(NOW); _almClockSetRate(1);
  _ae.dirty = true; _ae.raf = 0; if (_ae.idleTimer) clearTimeout(_ae.idleTimer); _ae.idleTimer = 0;
  var out = [];
  function frame(i) {
    NOW += 1000 / 60; PERF += 1000 / 60;
    var pend = cbs; cbs = [];
    if (!_ae.raf && !pend.length) { if (i % 6 === 0) _aeKick(); pend = cbs; cbs = []; }
    pend.forEach(function (cb) { cb(PERF); });
  }
  for (var i = 0; i < 5; i++) frame(i);
  _aePreset(to);
  for (var j = 0; j < frames; j++) {
    frame(j);
    if (_ae.fly) { var s = _aeProject(_aeBodyPos(key)); out.push({ x: s.x, y: s.y, w: _ae.w, h: _ae.h }); }
  }
  window.Date = RealDate;
  return out;
}"""


def test_the_body_a_pull_out_leaves_stays_on_the_screen(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            rows = pg.evaluate(FLY_KEEP, ["planets", 600, "earth"])
            assert len(rows) > 30, "it flew"
            for r in rows:
                assert 0 <= r["x"] <= r["w"] and 0 <= r["y"] <= r["h"], (
                    "the Earth left the screen",
                    r,
                )
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_opening_on_the_moon_starts_on_the_moon_not_the_earth(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            for key in ("moon", "sun"):
                got = pg.evaluate(
                    "(key) => { _ae.fly = null; _ae.hand = null; _aeLinkWant = null; _aeOpenTarget = key; _aeEnter();"
                    " return { from: _ae.fly && _ae.fly.from.target, target: _ae.target, hold: !!(_ae.fly && _ae.fly.hold) }; }",
                    key,
                )
                assert got == {"from": key, "target": key, "hold": False}, (key, got)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
