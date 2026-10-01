"""The hero Moon is the 3D Moon: the swap between them, in a real browser.

The Almanac's hero disc (app.js, a flat canvas painted with the page) and
the 3D view's Moon (almanac-earth.js, WebGL) read one clock, one ephemeris
and one shading model. A tap or a drag on the disc swaps it for the 3D
view's first frame, standing where the disc stood, and the view opens
around it; leaving, the Moon flies back into the disc's place. Checked here
on the shipped files, served by Zimi, in headless Chromium (SwiftShader):

  1. The swap is invisible: the last flat frame and the first 3D frame over
     the hero's rectangle, at three focus dates (a crescent, a quarter, a
     near-full Moon). The mean absolute difference must be under 3.5 of 255
     AND under what moving the disc by one device pixel costs the same
     picture: what remains is texture filtering (the 2D disc resamples the
     4096 map to 2048, the GPU filters it with mipmaps) and the limb's
     antialiasing, less than a pixel's shift or a degree's turn would show.
     The three pairs and their difference are saved as PNGs.
  2. One clock: each step of the time machine (the wheel's, the lever's)
     moves the 3D scene to the page's instant in the same call, not a frame
     later; the hero follows in the same call too. A speed in the view runs
     the page's clock, and the page's date header follows.
  3. Leaving restores the page exactly: scroll offset, focus date, the
     Almanac's DOM, with or without reduced motion (a cross-fade then).
  4. The cost: no three.js before the page's first paint (it comes after,
     when idle), the hero needs no frame loop while Live and idle, and
     closing gives the drawing buffer back (a pixel), leaving the Almanac
     the whole context.

Run: pytest tests/test_moon_handoff_live.py -v
(ZIMI_SHOT_DIR=<dir> keeps the screenshots there.)
"""

import io
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
VIEW = {"width": 390, "height": 844}
DPR = 2
MAD_MAX = 3.5
DATES = ["2026-10-14T03:00:00Z", "2026-10-03T12:00:00Z", "2026-09-25T12:00:00Z"]
HERO = "#almanac-head .almanac-moon-open"
# Waits poll on a timer: a page with nothing moving may not ask for frames.
POLL_MS = 100


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    try:
        import numpy  # noqa: F401
        from PIL import Image  # noqa: F401
    except ImportError:
        pytest.skip("numpy and Pillow compare the pictures")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("handoff")
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
def browser(served):
    # After served: its check that a browser can start launches one of its own.
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


@pytest.fixture
def shots(tmp_path):
    d = os.environ.get("ZIMI_SHOT_DIR") or str(tmp_path)
    os.makedirs(d, exist_ok=True)
    return d


def _almanac(browser, served, reduced=False, init=None):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=DPR,
        color_scheme="dark",
        reduced_motion="reduce" if reduced else "no-preference",
    )
    if init:
        ctx.add_init_script(init)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady()",
        timeout=60000,
        polling=POLL_MS,
    )
    # Both Moons on the 4096 map: the hero's sprite, and the 3D view's texture.
    pg.wait_for_function(
        "() => !!_MOON_TEX_HI && _ae.gl.moonUni.moonMap.value &&"
        " _ae.gl.moonUni.moonMap.value.image.width === 4096",
        timeout=60000,
        polling=POLL_MS,
    )
    return ctx, pg, errors


def _settle(pg, iso):
    pg.evaluate("(iso) => _almScrubSettle(new Date(iso))", iso)
    # The hero's sweep to the new moment has ended and its 4096-map sprite is up.
    pg.wait_for_function("() => !_heroMoonOverlay", timeout=20000, polling=POLL_MS)
    pg.wait_for_function(
        """() => { var img = document.querySelector('#almanac-head .almanac-moon-sprite');
      return img && img.getAttribute('src') === _renderMoonSprite(_heroMoonView(_almFocusInstant(), _getLocation()), 200); }""",
        timeout=20000,
        polling=POLL_MS,
    )
    pg.wait_for_timeout(300)


def _rect(pg):
    return pg.evaluate(
        "(s) => { var r = document.querySelector(s).getBoundingClientRect();"
        " return { x: r.x, y: r.y, width: r.width, height: r.height }; }",
        HERO,
    )


def _png(data):
    from PIL import Image

    return Image.open(io.BytesIO(data)).convert("RGB")


def _mad(a, b):
    import numpy as np

    return float(np.abs(np.asarray(a, dtype=float) - np.asarray(b, dtype=float)).mean())


@pytest.mark.parametrize("iso", DATES)
def test_the_first_3d_frame_is_the_hero(browser, served, shots, iso):
    from PIL import Image, ImageChops

    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, iso)
        clip = _rect(pg)
        flat = _png(pg.screenshot(clip=clip))
        # Hold the swap at its first frame (a long flight), so the screenshot
        # is the page as composited with the 3D Moon standing in.
        pg.evaluate(
            "() => { AE_HAND_MS = 1e9; openAlmanacEarth({ target: 'moon', fromHero: true }); }"
        )
        assert pg.evaluate(
            "() => _aeIsOpen && !!_ae.hand && document.getElementById('almanac-view').classList.contains('alm-moon-lifted')"
        )
        assert pg.evaluate("() => _ae.scene.ms") == pg.evaluate(
            "() => _almFocusInstant().getTime()"
        )
        pg.wait_for_timeout(200)
        first = _png(pg.screenshot(clip=clip))
        tag = iso[:13].replace(":", "")
        flat.save(os.path.join(shots, "handoff-%s-flat.png" % tag))
        first.save(os.path.join(shots, "handoff-%s-3d.png" % tag))
        diff = ImageChops.difference(flat, first).point(lambda v: min(255, v * 4))
        diff.save(os.path.join(shots, "handoff-%s-diff.png" % tag))
        mad = _mad(flat, first)
        # The yardstick: the same flat picture moved by one device pixel.
        moved = flat.transform(
            flat.size, Image.AFFINE, (1, 0, 1, 0, 1, 0), resample=Image.BILINEAR
        )
        pixel = _mad(flat, moved)
        print("%s: MAD %.2f, one device pixel's shift %.2f" % (iso, mad, pixel))
        assert mad < MAD_MAX and mad < pixel, (iso, mad, pixel)
        assert not errors, errors
    finally:
        ctx.close()


def test_one_clock_moves_both_views(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, "2026-10-03T12:00:00Z")
        pg.evaluate("() => openAlmanacEarth({ target: 'moon', fromHero: true })")
        pg.wait_for_function(
            "() => _aeIsOpen && !_ae.hand", timeout=10000, polling=POLL_MS
        )
        # The time machine's wheel steps and the lever's frames, as the page
        # runs them, each followed at once by the scene and the hero.
        steps = pg.evaluate("""() => {
          var out = [];
          for (var i = 0; i < 12; i++) {
            if (i % 2) _almScrubStep(i * 3600000);
            else { _almFocus = new Date(_almFocusInstant().getTime() - i * 86400000); _almTravelLive(_almFocus); }
            var f = _almFocusInstant().getTime();
            var v = _heroMoonView(new Date(f), _getLocation());
            out.push({ page: f, scene: _ae.scene.ms,
                       hero: !!_heroMoonOverlay && _heroMoonOverlay._moonBucket === _moonSpriteKey(v, _heroMoonAnimGenSize()) });
          }
          return out;
        }""")
        for s in steps:
            assert s["scene"] == s["page"] and s["hero"], s
        assert len({s["page"] for s in steps}) == len(steps)
        pg.wait_for_timeout(400)  # the wheel's settle
        assert pg.evaluate("() => _ae.scene.ms === _almFocusInstant().getTime()")
        # A speed in the view runs the page's clock; the header follows.
        before = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.click("#ae-time [data-ae-speed='3600']")
        pg.wait_for_function("(t) => _almFocusInstant().getTime() - t > 2 * 3600000", arg=before,
                             timeout=20000, polling=POLL_MS)
        state = pg.evaluate(
            """() => ({ page: _almFocusInstant().getTime(), scene: _ae.scene.ms,
          head: document.getElementById('almanac-head-date').textContent, want: _almClockParts(_almFocusInstant()).date })"""
        )
        # The scene drew the instant the frame ran the clock to.
        assert state["page"] - before > 2 * 3600 * 1000 and state["scene"] == state["page"], state
        assert state["head"] == state["want"], state
        pg.click("#ae-time [data-ae-speed='1']")
        landed = pg.evaluate("() => _almFocusInstant().getTime()")
        pg.wait_for_timeout(300)
        assert (
            pg.evaluate("() => _almFocusInstant().getTime()") == landed
        ), "at real time a set clock holds"
        assert pg.evaluate("() => _ae.scene.ms") == landed
        assert not errors, errors
    finally:
        ctx.close()


# The Almanac as it stands: everything but its clocks of now (the world
# clock's seconds and cities, the time machine's ACTUAL row and its offset
# lamp), which tick whatever else happens.
SNAPSHOT = """() => {
  var c = document.getElementById('almanac-content');
  var copy = c.cloneNode(true);
  copy.querySelectorAll('[id^="alm-clock"], #almanac-tz-pills, [id^="alm-tm-now"], #alm-tm-delta').forEach(function (n) { n.remove(); });
  return { scroll: c.scrollTop, focus: _almFocus ? _almFocus.getTime() : null, html: copy.outerHTML,
           view: document.getElementById('almanac-view').className,
           tm: document.getElementById('alm-tm').className, active: document.activeElement && document.activeElement.className };
}"""


@pytest.mark.parametrize("reduced", [False, True])
def test_leaving_restores_the_page(browser, served, reduced):
    ctx, pg, errors = _almanac(browser, served, reduced=reduced)
    try:
        _settle(pg, "2026-10-14T03:00:00Z")
        pg.evaluate(
            "() => { _almTmShow(); document.getElementById('almanac-content').scrollTop = 60; }"
        )
        pg.wait_for_timeout(600)
        before = pg.evaluate(SNAPSHOT)
        r = _rect(pg)
        cx, cy = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
        # Start a drag on the disc: it lifts into the view and turns.
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        for i in range(1, 12):
            pg.mouse.move(cx + i * 5, cy + i)
        pg.mouse.up()
        pg.wait_for_function(
            "() => _aeIsOpen && !_ae.hand", timeout=10000, polling=POLL_MS
        )
        assert pg.evaluate("() => _ae.target === 'moon'")
        pg.keyboard.press("Escape")
        pg.wait_for_function("() => !_aeIsOpen", timeout=10000, polling=POLL_MS)
        pg.wait_for_timeout(300)
        after = pg.evaluate(SNAPSHOT)
        for k in ("scroll", "focus", "view", "tm"):
            assert after[k] == before[k], (k, before[k], after[k])
        assert after["html"] == before["html"]
        assert "almanac-moon-open" in (after["active"] or "")
        assert not errors, errors
    finally:
        ctx.close()


RAF_COUNTER = """(() => {
  var raf = window.requestAnimationFrame;
  window.__rafBy = {};
  window.requestAnimationFrame = function (f) {
    var k = (f && f.name) || 'anonymous';
    window.__rafBy[k] = (window.__rafBy[k] || 0) + 1;
    return raf.call(window, f);
  };
})();"""


def test_the_cost(browser, served):
    ctx, pg, errors = _almanac(browser, served, init=RAF_COUNTER)
    try:
        timing = pg.evaluate("""() => {
          var fcp = performance.getEntriesByName('first-contentful-paint')[0];
          var three = performance.getEntriesByType('resource').filter(function (e) { return /three-r\\d+/.test(e.name); });
          return { fcp: fcp && fcp.startTime, three: three.map(function (e) { return e.startTime; }) };
        }""")
        assert (
            timing["fcp"]
            and len(timing["three"]) == 1
            and timing["three"][0] > timing["fcp"]
        ), timing
        # Live and idle: the hero asks for no frames; the view, ready behind
        # the page, asks for none either.
        pg.wait_for_timeout(1500)
        pg.evaluate("() => { window.__rafBy = {}; }")
        pg.wait_for_timeout(4000)
        by = pg.evaluate("() => window.__rafBy")
        print("frames asked for in 4 s, Live and idle:", by)
        assert "_aeFrame" not in by and pg.evaluate(
            "() => _ae.raf === 0 && _almFocus === null"
        )
        assert set(by) <= {"_orreryAnimate", "_skyLoop", "tick"}, by
        # What keeps the hero alive is a timer at the minute's turn, and what
        # it does is redraw what moved: the disc, its turn, the clock.
        live = pg.evaluate("""() => {
          var img = document.querySelector('#almanac-head .almanac-moon-sprite');
          var was = { k: img.getAttribute('data-k'), time: document.getElementById('almanac-head-time').textContent };
          var later = new Date(Date.now() + 9 * 3600000);
          _almHeroLiveUpdate(later);
          return { timer: !!_almHeroLiveTimer, was: was, k: img.getAttribute('data-k'),
                   want: _heroMoonView(later, _getLocation()).k.toFixed(4),
                   time: document.getElementById('almanac-head-time').textContent,
                   wantTime: _almClockParts(later).time };
        }""")
        assert (
            live["timer"]
            and live["k"] == live["want"]
            and live["k"] != live["was"]["k"]
        ), live
        assert live["time"] == live["wantTime"] != live["was"]["time"], live
        # The view gives its drawing buffer back on closing, and the context
        # on leaving the Almanac.
        pg.evaluate("() => openAlmanacEarth({ target: 'moon', fromHero: true })")
        pg.wait_for_function(
            "() => _aeIsOpen && !_ae.hand", timeout=10000, polling=POLL_MS
        )
        assert pg.evaluate("() => _ae.gl.renderer.getContext().drawingBufferWidth") > 1
        pg.evaluate("() => _aeClose()")
        pg.wait_for_function("() => !_aeIsOpen", timeout=10000, polling=POLL_MS)
        # One CSS pixel: the device pixels of one at the view's pixel ratio.
        assert pg.evaluate(
            "() => _ae.gl.renderer.getContext().drawingBufferWidth === _ae.gl.dpr"
        )
        lost = pg.evaluate(
            """() => { var gl = _ae.gl.renderer.getContext(); closeAlmanac();
          return { lost: gl.isContextLost(), gone: _ae.gl === null }; }"""
        )
        assert lost == {"lost": True, "gone": True}, lost
        assert not errors, errors
    finally:
        ctx.close()


def test_home_asks_for_no_three(browser, served):
    ctx = browser.new_context(viewport=VIEW, device_scale_factor=DPR)
    pg = ctx.new_page()
    asked = []
    pg.on("request", lambda r: asked.append(r.url))
    try:
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_timeout(3000)
        assert not [u for u in asked if "three-r" in u or "almanac-earth" in u], asked
    finally:
        ctx.close()
