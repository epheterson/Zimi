"""Orbits show all through a flight between worlds, never fading out while the camera moves.

In headless Chromium at a phone's size, the page's own loop driven on a virtual clock (as test_almanac_iss_browser.py).

Run: pytest tests/test_almanac_orbits_transit_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

FLY = """([to, frames]) => {
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
    if (_ae.fly) out.push({ mars: _aeOrbitShow('mars'), jupiter: _aeOrbitShow('jupiter'), earth: _aeOrbitShow('earth') });
  }
  window.Date = RealDate;
  return out;
}"""


def test_the_orbits_stay_shown_for_the_whole_of_a_flight(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            rows = pg.evaluate(FLY, ["mars", 600])
            assert len(rows) > 30, "it flew"
            for r in rows:
                assert r["mars"] > 0.99 and r["jupiter"] > 0.99 and r["earth"] > 0.99, r
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
