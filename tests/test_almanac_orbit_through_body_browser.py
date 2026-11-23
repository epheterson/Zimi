"""A body's orbit line passes through the body, at any date: Earth's own, Mars's, Jupiter's, and the Moon's ring round the Earth.

Earth stands at the middle of the scene while the Sun is drawn a fixed distance off, so Earth's line, carried to the Sun,
ran tens of Earth radii from her (a long thin line beside the small dot, seen on an iPhone).

Run: pytest tests/test_almanac_orbit_through_body_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

# Distance (Earth radii) from the body's centre to the nearest point of its orbit polyline, at a clock.
MEASURE = """async (iso) => {
  _almFocus = new Date(iso); _almClockSetRate(0);
  for (var i = 0; i < 40; i++) { _ae.dirty = true; _aeKick(); await new Promise(r => setTimeout(r, 120)); }
  var S = _ae.gl;
  function near(line, c) {
    var a = line.geometry.attributes.position.array, n = line.geometry.drawRange.count, o = line.position, best = 1e30;
    for (var k = 0; k < n; k++) {
      var j = (k + 1) % n;
      var p = [a[k*3]+o.x, a[k*3+1]+o.y, a[k*3+2]+o.z], q = [a[j*3]+o.x, a[j*3+1]+o.y, a[j*3+2]+o.z];
      var d = [q[0]-p[0], q[1]-p[1], q[2]-p[2]], w = [c[0]-p[0], c[1]-p[1], c[2]-p[2]];
      var L = d[0]*d[0]+d[1]*d[1]+d[2]*d[2], t = L > 0 ? Math.max(0, Math.min(1, (w[0]*d[0]+w[1]*d[1]+w[2]*d[2]) / L)) : 0;
      best = Math.min(best, Math.hypot(w[0]-t*d[0], w[1]-t*d[1], w[2]-t*d[2]));
    }
    return best;
  }
  var out = { earth: near(S.earthOrbit.orbit, [0, 0, 0]), earthRadii: 1 };
  ['mars', 'jupiter'].forEach(function (k) { var p = S.planets[k]; out[k] = near(p.orbit, p.pos); out[k + 'Radii'] = p.b.r; });
  out.moon = near(S.moonPath, _ae.scene.moon);
  return out;
}"""

DATES = ["2026-11-21T12:00:00Z", "1977-08-20T14:29:00Z"]


def test_every_orbit_line_runs_through_its_body(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth", orbits="always")
            for iso in DATES:   # the Earth view: her own line and the Moon's ring
                r = pg.evaluate(MEASURE, iso)
                assert r["earth"] < r["earthRadii"], (iso, r)
                assert r["moon"] < 1, (iso, r)
            pg.evaluate("() => _aePreset('planets')")   # the Planets view draws every planet's line
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=200)
            for iso in DATES:
                r = pg.evaluate(MEASURE, iso)
                for k in ("mars", "jupiter"):
                    assert r[k] < r[k + "Radii"], (iso, k, r)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
