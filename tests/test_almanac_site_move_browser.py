"""The way into a landing site and out of it is one smooth move: the camera's lens goes with it, never a snap at either end.

A visit to Apollo 11 is begun in the page; once its drop has a starting pose, the visit's own camera (_asPose) is read at fractions of the move on
a made-up clock. The field of view must leave the orbit view's (35 degrees), arrive at the ground's, and never step more than a couple of degrees
between neighbouring fractions, in the way down and in the way out. It used to be the orbit's 35 degrees up to the visit's first frame and the
ground's 62 from the next one, and back the same way on leaving: the picture zoomed in one frame at each end.

Run: pytest tests/test_almanac_site_move_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_slots import WEBGL_ARGS

VIEW = {"width": 390, "height": 844}
READY_MS = 300_000
MAX_STEP_DEG = 2.0   # between neighbouring fiftieths of the move (the whole swing is 27 degrees)
STEPS = 50

# The visit's lens through a move: `phase` drop (the way in) or rise (the way out), on a clock the test holds.
FOV_JS = """([phase, steps]) => {
  var st = _ae.site, real = performance.now, out = [];
  st.phase = phase; st.from = st.from0; st.t0 = 0; st.dropMs = 1000; st.getIn = false;   // (read from the start of the way in, or of the way out run backwards: both go from the orbit view to the ground)
  try {
    for (var i = 0; i <= steps; i++) {
      var f = i / steps; performance.now = function () { return (phase === 'rise' ? 1 - f : f) * 1000; };
      out.push(_asPose(st, 0).fov);
    }
  } finally { performance.now = real; }
  return out;
}"""


@pytest.fixture(scope="module")
def page(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler
    from playwright.sync_api import sync_playwright

    tmp = tmp_path_factory.mktemp("sitemove")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    httpd = None
    try:
        srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
        srv.load_cache(force=True)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        with sync_playwright() as p:
            browser = p.chromium.launch(args=WEBGL_ARGS)
            try:
                ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, service_workers="block")
                pg = ctx.new_page()
                pg.goto("http://127.0.0.1:%d/#almanac" % httpd.server_address[1], wait_until="load")
                pg.wait_for_function("() => typeof openAlmanacEarth === 'function'", timeout=120_000)
                pg.evaluate("openAlmanacEarth({ target: 'earth' })")
                pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
                pg.evaluate("() => new Promise((ok) => { _aePreset('moon'); _aeWhenSites(() => setTimeout(ok, 300)); })")
                pg.evaluate("() => _aeSiteVisit('moon', _aeLm.moon.filter((r) => r[0] === 'Apollo 11')[0], false)")
                pg.wait_for_function("() => _ae.site && _ae.site.from0 && _ae.site.fr", timeout=READY_MS, polling=100)
                yield pg
            finally:
                browser.close()
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


@pytest.mark.parametrize("phase", ["drop", "rise"])
def test_the_lens_goes_with_the_move(page, phase):
    fov = page.evaluate(FOV_JS, [phase, STEPS])
    assert abs(fov[0] - 35) < 0.5, (phase, fov[0])   # the orbit view's lens at one end
    assert abs(fov[-1] - 62) < 0.5, (phase, fov[-1])   # the ground's at the other
    steps = [abs(b - a) for a, b in zip(fov, fov[1:])]
    assert max(steps) <= MAX_STEP_DEG, (phase, max(steps))
