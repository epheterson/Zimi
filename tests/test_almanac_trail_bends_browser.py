"""A craft's path in the 3D view is drawn through its turns: a flyby's hairpin is not two long chords meeting at a corner.

The trail's points are spread by the turn the path makes (a straight cruise needs few, a close pass many), so the sharpest
angle between two drawn segments is never worse than with the points spread evenly in time, and stays small for every craft.

In headless Chromium at a phone's size.

Run: pytest tests/test_almanac_trail_bends_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

# The sharpest turn between two drawn segments of a craft's path (radians), for the instants the trail is drawn through.
TURNS = """() => {
  var jd = _aeDisplayMs() / MS_PER_DAY + JD_UNIX_EPOCH, out = {};
  _aeTracks.probes.forEach(function (k) {
    var t = _aeTracks.tracks[k], from = t.jd0, to = Math.min(jd, t.jd1);
    if (!(to > from)) return;
    var turn = function (times) {
      var ps = Array.from(times).map(function (x) { return _aeTrackAt(t, x) || [0, 0, 0]; }), worst = 0;
      for (var i = 1; i < ps.length - 1; i++) {
        var a = _aeSub(ps[i], ps[i - 1]), b = _aeSub(ps[i + 1], ps[i]), la = _aeLen(a), lb = _aeLen(b);
        if (la > 0 && lb > 0) worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)))));
      }
      return worst;
    };
    var even = [], n = AE_TRAIL_POINTS;
    for (var i = 0; i < n; i++) even.push(from + (to - from) * i / (n - 1));
    var spread = _aeTrailTimes(t, from, to, n);
    out[k] = { even: turn(even), spread: turn(spread), first: spread[0] - from, last: spread[n - 1] - to, sorted: Array.from(spread).every(function (x, i, s) { return i === 0 || x >= s[i - 1]; }) };
  });
  return out;
}"""


def test_a_craft_path_is_drawn_through_its_turns_with_no_hard_bend(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => { _aeTracksLoad(); return !!_aeTracks && _aeTracks.probes.length > 3; }", timeout=60_000, polling=200)
            got = pg.evaluate(TURNS)
            assert got, "probes with a path"
            print({k: (round(v["even"], 2), round(v["spread"], 2)) for k, v in got.items()})
            for k, v in got.items():
                assert v["first"] == 0 and v["last"] == 0 and v["sorted"], (k, v)
                assert v["spread"] <= v["even"] + 1e-9, (k, v)
            better = [k for k, v in got.items() if v["spread"] < v["even"] * 0.9]
            assert "parker" in better and len(better) >= 5, ("the points go to the corners where there are some to find", better)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
