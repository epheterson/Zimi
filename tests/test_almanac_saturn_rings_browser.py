"""Saturn's rings read as bright rings against the planet's bands at the Saturn preset's own framing.

Near edge-on (late 2026) the Sun stands a few degrees over the ring plane and the shader scaled the rings by that angle
down to a floor of 0.12: a charcoal band, far darker than the cream cloud bands. Seen from the lit side the rings keep most
of their light however shallow the angle; the unlit face, and their shadow, are still dimmer.

Run: pytest tests/test_almanac_saturn_rings_browser.py -v -s
"""

import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

# The ring plane's axes and Saturn's radius on the screen, then points on the B ring and A ring around the disc.
PROBE = """() => {
  var p = _ae.gl.planets.saturn, m = p.mesh.matrix.elements, R = _aePlanetBody('saturn').r, c = _aeBodyPos('saturn');
  var cs = _aeProject(c), out = { c: [cs.x, cs.y], pts: [] };
  [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
    [1.55, 1.6, 1.65, 1.7, 1.75, 1.8, 1.85, 1.9, 2.1, 2.15, 2.2].forEach(function (r) {
      var q = [0, 1, 2].map(function (i) { return c[i] + (m[i] * d[0] + m[4 + i] * d[1]) * r * R; }), s = _aeProject(q);
      out.pts.push([s.x, s.y]);
    });
  });
  var e = _aeProject([c[0] + m[0] * R, c[1] + m[1] * R, c[2] + m[2] * R]);
  out.discR = Math.hypot(e.x - cs.x, e.y - cs.y);
  return out;
}"""
DAYS = {"2026-11-21": "Date.UTC(2026, 10, 21, 12)", "2032-06-01": "Date.UTC(2032, 5, 1, 12)"}
MIN_RING_OVER_DISC = 0.75   # the brightest ring pixel against the disc's mean, never charcoal against the planet


def _lum(im, x, y):
    if x < 0 or y < 0 or x >= im.width or y >= im.height:
        return None
    r, g, b = im.getpixel((int(x), int(y)))[:3]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


@pytest.mark.parametrize("day", sorted(DAYS))
def test_saturns_rings_are_not_charcoal_against_its_bands(served, day):
    from PIL import Image
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.evaluate("() => _aeGoTo(%s)" % DAYS[day])
            pg.wait_for_function("() => Math.abs(_aeDisplayMs() - %s) < 1000" % DAYS[day], timeout=60_000, polling=100)
            pg.evaluate("() => _aePreset('saturn')")
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=240_000, polling=200)
            pg.wait_for_timeout(2500)
            d = pg.evaluate(PROBE)
            im = Image.open(io.BytesIO(pg.screenshot())).convert("RGB")
            disc = [_lum(im, d["c"][0] + dx * d["discR"], d["c"][1] + dy * d["discR"]) for dx in (-0.5, 0, 0.5) for dy in (-0.5, 0, 0.5)]
            disc = [v for v in disc if v is not None]
            ring = [_lum(im, x, y) for x, y in d["pts"] if ((x - d["c"][0]) ** 2 + (y - d["c"][1]) ** 2) ** 0.5 > d["discR"] + 4]
            ring = [v for v in ring if v is not None]
            assert ring and disc, d
            mean = sum(disc) / len(disc)
            print(day, "discR", round(d["discR"], 1), "disc mean", round(mean), "ring", [round(v) for v in ring])
            assert max(ring) >= MIN_RING_OVER_DISC * mean, (day, mean, ring)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
