"""Opening the Almanac (Eric, 2026-11-10: "I really hate the spinner ever on almanac initial load it used to be
essentially instant"): the veil lifts the frame after the head (date, clock, Moon, six cards) is on the page and does
not wait for the sky; what is drawn is in its place already, so nothing moves when the rest arrives, and the page
answers a touch from the moment it is shown.

Run: pytest tests/test_almanac_open_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
THROTTLE = 4  # CDP CPU slowdown: a mid-range phone is about this behind a laptop
LONG_TASK_BUDGET_MS = 500  # at THROTTLE: ~125 ms of a laptop's time. A long task is 50 ms by definition; a hand
# waits on anything past ~100 ms, and the CI runners need some margin over that.
SETTLE_WINDOW_MS = 3000  # the first seconds after the page is shown are the person's

# Watches the page from the first script: when the open has shown it (almanac.js _almShownAt) it takes a picture of what is
# on the page at that very moment, and it keeps every long task and every request with its time.
WATCH = """
window.__lt = []; window.__reqs = []; window.__reveal = null; window.__up = null;
try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); })
  .observe({type: 'longtask', buffered: true}); } catch (e) {}
try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__reqs.push([e.startTime, e.name]); })
  .observe({type: 'resource', buffered: true}); } catch (e) {}
try { localStorage.setItem('zimi_almanac_place', %r); localStorage.setItem('zimi_app_theme', 'dark');
  localStorage.setItem('zimi_almanac_coast', '{"37.77,-122.42":1}'); } catch (e) {}  // a place come back to: its coast is known
// The sky canvas as a 12 x 12 grid of average colours: small enough to compare, coarse enough that the palms' sway is nothing.
window.__grid = function () {
  var sky = document.getElementById('almanac-sky-canvas'), t = document.createElement('canvas');
  t.width = t.height = 12;
  var c = t.getContext('2d', {willReadFrequently: true});
  c.drawImage(sky, 0, 0, sky.width, sky.height, 0, 0, 12, 12);
  return Array.from(c.getImageData(0, 0, 12, 12).data);
};
// Where the head and the sky stand: they must be in the same place when the rest of the page has arrived.
window.__boxes = function () {
  return ['#almanac-head', '#almanac-sky-canvas', '#almanac-calendar'].map(function (q) {
    var e = document.querySelector(q), r = e ? e.getBoundingClientRect() : null;
    return r ? [Math.round(r.top + (document.getElementById('almanac-content') || {scrollTop: 0}).scrollTop), Math.round(r.height)] : null;
  });
};
(function look() {
  var first = !!document.querySelector('#almanac-head-date') && !!document.querySelector('#almanac-head .alm-cards');
  if (first && window.__up === null) window.__up = performance.now();   // the page's first frame (app.js _almFirstFrame), or the page itself
  if (typeof _almShownAt !== 'undefined' && _almShownAt > 0 && window.__reveal === null) {
    var hero = document.querySelector('#almanac-head img.almanac-moon-sprite');
    var sky = document.getElementById('almanac-sky-canvas'), lit = false;
    try {
      var c = sky.getContext('2d'), px = c.getImageData(0, 0, sky.width, sky.height).data;
      for (var i = 3; i < px.length; i += 4 * 97) if (px[i] > 0) { lit = true; break; }
    } catch (e) {}
    window.__reveal = {
      at: performance.now(), heroLoaded: !!hero && hero.complete && hero.naturalWidth > 0,
      heroWithMaria: typeof _moonTexReady !== 'undefined' && _moonTexReady,
      skySettled: typeof _skyState !== 'undefined' && !!_skyState && !!_skyState.settled, skyLit: lit,
      gpu: typeof _sg !== 'undefined' && !!_sg, gpuStars: typeof _sg !== 'undefined' && !!_sg && _sg.starCount > 0,
      grid: window.__grid(), cards: document.querySelectorAll('#almanac-head .alm-card').length,
      date: (document.getElementById('almanac-head-date') || {}).textContent, time: (document.getElementById('almanac-head-time') || {}).textContent,
      boxes: window.__boxes(),
      calendar: document.querySelectorAll('#almanac-calendar .alm-day').length
    };
  }
  setTimeout(look, 16);
})();
""" % PLACE


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("almopen")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _opened(served, launch_args=()):
    """One cold open of the Almanac on a 390 px phone at THROTTLE, watched until the settle window after the page
    is shown has passed. The page, the long tasks (start, duration) and the requests (start, url) come back.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=list(launch_args))
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            has_touch=True,
            is_mobile=True,
            service_workers="block",
            color_scheme="dark",
        )
        ctx.add_init_script(WATCH)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(served + "/#almanac", wait_until="domcontentloaded")
        ctx.new_cdp_session(pg).send(
            "Emulation.setCPUThrottlingRate", {"rate": THROTTLE}
        )
        pg.wait_for_function(
            "() => window.__reveal !== null", timeout=120_000, polling=100
        )
        at = pg.evaluate("window.__reveal.at")
        pg.wait_for_function(
            "(t) => performance.now() > t + %d" % (SETTLE_WINDOW_MS + 500),
            arg=at,
            timeout=60_000,
            polling=100,
        )
        got = pg.evaluate(
            "() => ({reveal: window.__reveal, up: window.__up, lt: window.__lt, reqs: window.__reqs, grid: window.__grid(), boxes: window.__boxes()})"
        )
        got["errors"] = errors
        ctx.close()
        br.close()
        return got


@pytest.fixture(scope="module")
def opened(served):
    return _opened(served)


@pytest.fixture(scope="module")
def opened_own_work(served):
    """The same open with no WebGL: the page's own work, without a software GL's shader compile (which is seconds on a
    laptop's CPU and milliseconds on a phone's GPU)."""
    return _opened(served, ["--disable-3d-apis"])


def test_the_page_is_there_from_the_start_not_a_cover(opened):
    assert opened["up"] is not None, "the first frame was never seen"
    assert opened["up"] < opened["reveal"]["at"]


def test_the_loading_state_lifts_when_the_head_is_on_the_page(opened):
    """It does not wait for the sky (the GPU, its stars, the Milky Way: seconds on a phone): the date, the clock, the Moon
    and the six cards are there, and so is the month."""
    r = opened["reveal"]
    assert r["heroLoaded"], r
    assert r["cards"] >= 6 and r["calendar"] >= 28, r
    assert (r["date"] or "").strip() and (r["time"] or "").strip(), r
    assert not opened["errors"], opened["errors"]


def test_nothing_moves_when_the_rest_of_the_page_arrives(opened):
    """The sky has its size and the hour's colour before it has a picture, the month its rows: when the sky is drawn and
    the panels come, the head, the sky and the calendar stand where they stood."""
    assert opened["reveal"]["boxes"] == opened["boxes"], (opened["reveal"]["boxes"], opened["boxes"])


def test_the_first_seconds_have_no_long_task(opened_own_work):
    opened = opened_own_work
    at = opened["reveal"]["at"]
    inside = [
        (round(s - at), round(d))
        for s, d in opened["lt"]
        if at <= s < at + SETTLE_WINDOW_MS and d > LONG_TASK_BUDGET_MS
    ]
    assert not inside, (
        "long tasks (offset ms, duration ms) past %d ms at %dx in the %d ms after the page was shown: %r"
        % (LONG_TASK_BUDGET_MS, THROTTLE, SETTLE_WINDOW_MS, inside)
    )


def test_the_3d_views_files_wait_until_they_are_needed(opened):
    """Neither three.js, the space tracks nor the Earth view's own file are asked for while the page is being drawn
    or in the seconds after it is shown (the view's file comes later, when the person is quiet, or at a touch on the
    Moon)."""
    at = opened["reveal"]["at"]
    early = [
        u.rsplit("/", 1)[-1].split("?")[0]
        for t, u in opened["reqs"]
        if t < at + SETTLE_WINDOW_MS
    ]
    for name in (
        "three-r186.min.js",
        "space-tracks-v1.json",
        "almanac-earth.js",
        "almanac-ephem.js",
    ):
        assert name not in early, (name, early)
