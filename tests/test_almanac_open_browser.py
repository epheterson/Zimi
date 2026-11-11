"""Opening the Almanac (Eric, 2026-11-06: "Loading in Kiwix serve is rough ... it says Loading the Almanac... then goes
away before stuff draws and things aren't ready to play with right away"): the veil stays until the first screen is
genuinely on the canvases, nothing that is drawn is drawn over afterwards, and the page answers a touch from the moment
it is shown.

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

# Watches the veil from the first script: when it goes (class alm-veil-out or hidden) it takes a picture of what is
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
(function look() {
  var v = document.getElementById('alm-veil');
  var up = !!v && !v.hidden && !v.classList.contains('alm-veil-out') && getComputedStyle(v).display !== 'none';
  if (up && window.__up === null) window.__up = performance.now();
  if (!up && window.__up !== null && window.__reveal === null) {
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


@pytest.fixture(scope="module")
def opened(served):
    """One cold open of the Almanac on a 390 px phone at THROTTLE, watched until the settle window after the page
    is shown has passed. The page, the long tasks (start, duration) and the requests (start, url) come back.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
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
        # Throttled before the page is asked for, so the cold open is the one measured.
        ctx.new_cdp_session(pg).send(
            "Emulation.setCPUThrottlingRate", {"rate": THROTTLE}
        )
        pg.goto(served + "/#almanac", wait_until="domcontentloaded")
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
            "() => ({reveal: window.__reveal, up: window.__up, lt: window.__lt, reqs: window.__reqs, grid: window.__grid()})"
        )
        got["errors"] = errors
        yield got
        ctx.close()
        br.close()


def test_there_is_a_loading_state_from_the_start(opened):
    assert opened["up"] is not None, "the veil was never seen"
    assert opened["up"] < opened["reveal"]["at"]


def test_the_loading_state_stays_until_the_first_screen_has_drawn(opened):
    """It used to go the moment the page's markup was in, before the Moon had its maria, before the sky had a single
    real frame (a gradient stood in for it for seconds), before the cards had their numbers.
    """
    r = opened["reveal"]
    assert r["heroLoaded"] and r["heroWithMaria"], r
    assert r["cards"] >= 2 and r["calendar"] >= 28, r
    assert r["skyLit"] and r["skySettled"], r
    if r["gpu"]:
        assert r["gpuStars"], "the GPU sky was shown before its stars were in: %r" % r
    assert not opened["errors"], opened["errors"]


def test_nothing_that_is_drawn_is_drawn_over_after_it_is_shown(opened):
    """The first sky is the picture that stays: the GPU, its stars and the Milky Way are all in before it is shown, so
    nothing arrives in the settle window to be drawn over it (the old open showed a gradient, then the sky, then the
    trees and the Sun, seconds apart)."""
    before, after = opened["reveal"]["grid"], opened["grid"]
    mean = sum(abs(a - b) for a, b in zip(before, after)) / len(before)
    assert mean < 6, "the sky changed by %.1f (of 255) on average after it was shown" % mean


def test_the_first_seconds_have_no_long_task(opened):
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
