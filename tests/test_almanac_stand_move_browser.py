"""The way between space and the ground is one smooth move: the view's turn from straight down to the horizon is spread over the fall, never a whip.

The ground's own view (_aeStandView) is stepped through a whole climb and a whole fall on a made-up clock, in the page, with the real function. The
pitch (the way the camera looks up or down) may not turn faster than a hand could follow, anywhere in either move. It used to turn 90 degrees in 0.2 s on
the way up (and 0.5 s on the way down): the camera whipped from the horizon to straight down.

Run: pytest tests/test_almanac_stand_move_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_slots import WEBGL_ARGS

VIEW = {"width": 390, "height": 844}
READY_MS = 240_000
MAX_DEG_PER_S = 220   # over any 100 ms (it peaked at over 400 before, and an eye follows 200 or so)
STEP_MS = 10
WINDOW_MS = 100

# The ground's view stepped through a move: `mode` ascend (from the eye on the ground up to `top` km) or descend (down from `top`).
STEP_JS = """([mode, top, vIn]) => {
  var st = { mode: mode, t0: 0, alt0: 18000, altTop: mode === 'ascend' ? top : 0, userPitch: 0, userYaw: 0, vIn: vIn, fading: true, downFrom: 0,
             fromAlt: AE_STAND_EYE_M / 1000, fromPitch: _aeRad(AE_STAND_PITCH_DEG), handoff: null, direct: false };
  if (mode === 'descend') st.alt0 = top;
  var out = [], t = 0;
  for (var i = 0; i < 2000; i++, t += %d) {
    _aeStandView(st, t);
    out.push([t, st.pitch * 180 / Math.PI, st.altKm]);
    if (st.mode === 'ground' || (st.prog >= 1)) break;
  }
  return out;
}""" % STEP_MS


@pytest.fixture(scope="module")
def page(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler
    from playwright.sync_api import sync_playwright

    tmp = tmp_path_factory.mktemp("standmove")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=WEBGL_ARGS)
        ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, service_workers="block")
        pg = ctx.new_page()
        pg.goto("http://127.0.0.1:%d/#almanac" % httpd.server_address[1], wait_until="load")
        pg.wait_for_function("() => typeof openAlmanacEarth === 'function'", timeout=120_000)
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
        pg.evaluate("() => _aeStandReady()")   # the ground's file
        pg.wait_for_function("() => typeof _aeStandView === 'function'", timeout=READY_MS)
        yield pg
        browser.close()
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _peak_rate(samples):
    """The fastest turn (degrees a second) over any WINDOW_MS of the move."""
    k = WINDOW_MS // STEP_MS
    return max(abs(samples[i + k][1] - samples[i][1]) / ((samples[i + k][0] - samples[i][0]) / 1000.0) for i in range(len(samples) - k))


@pytest.mark.parametrize("mode,top,v_in", [("ascend", 47000, 0), ("ascend", 3000, 0), ("descend", 18000, 0), ("descend", 18000, 1.4)])
def test_the_view_never_whips_through_the_move(page, mode, top, v_in):
    samples = page.evaluate(STEP_JS, [mode, top, v_in])
    assert len(samples) > 100, samples[:3]
    pitches = [s[1] for s in samples]
    assert max(pitches) - min(pitches) > 80, "the view turns from the horizon to straight down"
    assert _peak_rate(samples) <= MAX_DEG_PER_S, (mode, top, _peak_rate(samples))
    # One way only: the pitch never goes back on itself (no wobble at the seams).
    d = [b - a for a, b in zip(pitches, pitches[1:])]
    assert all(x <= 1e-6 for x in d) or all(x >= -1e-6 for x in d), (mode, top)
