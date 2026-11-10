"""Back to 1x by touch, on a phone: the time machine's speed slider on the Almanac page and at the foot of the 3D view.

Running fast (a day a second), one tap on the middle button, even 18 px off it, is real time again, mid-flight in the 3D
view too; a thumb dragged back and let go a finger's width short of the middle lands on 1x; the thumb is grabbed 18 px
above its centre (the band is 44 px tall). At 390x844, touch, device scale factors 2 and 3, with real touches (the CDP's Input.dispatchTouchEvent), not mouse events.

Run: pytest tests/test_almanac_back_to_1x_browser.py -v
"""

import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":40.71,"lon":-74.0,"name":"New York"}'
READY_MS = 240_000
FAST = 86400  # a day a second
OFF_PX = 18  # a finger this far off the target still means it
GRAB_PX = 44
# The pinned strip's slider sits between its date line and the section bar, which keep their taps.
PIN_GRAB_PX = 30

# Where the slider's parts are: its middle button, the thumb's centre, the band a finger grabs it by (measured with
# elementFromPoint through the thumb's x).
GEOM = """(sel) => { var spd = document.querySelector(sel + ' .alm-spd');
  if (!spd || !spd.offsetParent) return null;
  var rng = spd.querySelector('.alm-spd-range'), play = spd.querySelector('.alm-spd-play'), r = rng.getBoundingClientRect(), p = play.getBoundingClientRect();
  var th = parseFloat(getComputedStyle(spd).getPropertyValue('--spd-thumb')), last = +rng.max, v = parseFloat(rng.value);
  var cy = p.top + p.height / 2, tx = r.left + th / 2 + v / last * (r.width - th);
  function on(y) { var e = document.elementFromPoint(tx, y); return e === rng || (e && play.contains(e)); }
  var up = 0, dn = 0; while (up < 40 && on(cy - up - 1)) up++; while (dn < 40 && on(cy + dn + 1)) dn++;
  var at = document.elementFromPoint(tx, cy);
  return { px: p.left + p.width / 2, cy: cy, tx: tx, grab: on(cy) ? up + dn + 1 : 0, at: at && (at.id || at.className || at.tagName) }; }"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("b1x")
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


def _fast(pg):
    pg.evaluate("_almClockSetRate(%d)" % FAST)
    pg.wait_for_function("() => _almRate === %d" % FAST)
    pg.wait_for_timeout(300)


def _drag(pg, cdp, x0, y0, x1, y1, steps=8):
    """A finger: touchStart, moves, touchEnd through the browser's input pipeline."""
    cdp.send(
        "Input.dispatchTouchEvent",
        {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]},
    )
    for i in range(1, steps + 1):
        f = i / steps
        cdp.send(
            "Input.dispatchTouchEvent",
            {
                "type": "touchMove",
                "touchPoints": [{"x": x0 + (x1 - x0) * f, "y": y0 + (y1 - y0) * f}],
            },
        )
        pg.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    pg.wait_for_timeout(250)


def _taps_back_to_real(pg, sel):
    """One tap on the middle button, and taps 18 px off it in four directions, each from a day a second."""
    for dx, dy in ((0, 0), (-OFF_PX, 0), (OFF_PX, 0), (0, -OFF_PX), (0, OFF_PX)):
        _fast(pg)
        g = pg.evaluate(GEOM, sel)
        pg.touchscreen.tap(g["px"] + dx, g["cy"] + dy)
        pg.wait_for_timeout(250)
        assert pg.evaluate("_almRate") == 1, (sel, dx, dy)


@pytest.mark.parametrize("dpr", [2, 3])
def test_back_to_real_time_by_touch(served, dpr):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(
                viewport=VIEW,
                device_scale_factor=dpr,
                has_touch=True,
                is_mobile=True,
                service_workers="block",
            )
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
                % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            cdp = ctx.new_cdp_session(pg)
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_selector("#almanac-head-date", timeout=60_000)
            pg.wait_for_function(
                "() => typeof _almClockSetRate === 'function' && (document.getElementById('alm-veil') || {}).hidden !== false",
                timeout=60_000,
            )
            head = "#almanac-head"
            pg.evaluate("_almClockSetRate(%d)" % FAST)
            pg.wait_for_timeout(300)
            g = pg.evaluate(GEOM, head)
            # The band a finger grabs is 44 px.
            assert g["grab"] >= GRAB_PX, str(g)
            _taps_back_to_real(pg, head)
            # Dragged back and let go short of the middle: within a fingertip, 1x; well short, the slow pace it was left at.
            for short, real in ((6, True), (12, True), (16, True), (36, False)):
                _fast(pg)
                g = pg.evaluate(GEOM, head)
                _drag(pg, cdp, g["tx"], g["cy"], g["px"] + short, g["cy"])
                rate = pg.evaluate("_almRate")
                assert (rate == 1) == real, (short, rate)
            # Grabbed 18 px above the thumb's centre, the thumb still comes.
            _fast(pg)
            g = pg.evaluate(GEOM, head)
            _drag(pg, cdp, g["tx"], g["cy"] - OFF_PX, g["px"], g["cy"] - OFF_PX)
            assert pg.evaluate("_almRate") == 1
            # Scrolled down, the strip pinned to the top: the middle button takes taps 18 px off it, the thumb a 30 px band
            # (the date line and the section bar are that close), and the Now pill and the first section keep their own
            # edges.
            _fast(pg)
            pg.evaluate(
                "() => { var e = document.getElementById('almanac-head'); while (e && !(e.scrollHeight > e.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement; (e || document.scrollingElement).scrollBy(0, 1400); }"
            )
            pin = ".alm-pin-clock"
            pg.wait_for_function(
                "() => { var p = document.querySelector('.alm-pin-clock'); return !!p && !!p.offsetParent; }",
                timeout=10_000,
            )
            pg.wait_for_timeout(300)
            g = pg.evaluate(GEOM, pin)
            assert g["grab"] >= PIN_GRAB_PX, str(g)
            edges = None
            for _ in range(10):  # the strip fades in; its pills settle a moment later
                if edges == ["own", "own"]:
                    break
                pg.wait_for_timeout(300)
                edges = pg.evaluate(
                    """() => { var at = function (el, y) { var r = el.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, y(r));
                  return el.contains(e) ? 'own' : e ? (e.id || e.className || e.tagName) + '@' + Math.round(y(r)) : 'none'; };
                var now = document.querySelector('.alm-pin-clock .alm-ck-now'), sec = document.querySelector('#alm-secbar-slot #alm-secbar-pills > *');
                return [at(now, function (r) { return r.bottom - 1; }), at(sec, function (r) { return r.top + 1; })]; }"""
                )
            assert edges == ["own", "own"], edges
            _taps_back_to_real(pg, pin)
            # The 3D view: a flight to Mars at a day a second; mid-flight a tap 18 px off the middle button is 1x.
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
                timeout=READY_MS,
                polling=200,
            )
            for dx, dy in ((-OFF_PX, 0), (0, OFF_PX)):
                _fast(pg)
                pg.evaluate("_aePreset('mars')")
                pg.wait_for_function("() => !!_ae.fly", timeout=10_000)
                # A person looks, then reaches: the foot has settled into its flight layout.
                pg.wait_for_timeout(400)
                g = pg.evaluate(GEOM, "#ae-clock")
                assert g["grab"] >= GRAB_PX, str(g)
                assert pg.evaluate("!!_ae.fly"), "the flight was over before the tap"
                pg.touchscreen.tap(g["px"] + dx, g["cy"] + dy)
                pg.wait_for_timeout(250)
                assert pg.evaluate("_almRate") == 1, (
                    dx,
                    dy,
                    g,
                    pg.evaluate(
                        "([x, y]) => { var e = document.elementFromPoint(x, y); return e && (e.id || e.className || e.tagName); }",
                        [g["px"] + dx, g["cy"] + dy],
                    ),
                )
                pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=200)
                pg.evaluate("_aePreset('earth')")
                pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=200)
            _fast(pg)
            g = pg.evaluate(GEOM, "#ae-clock")
            _drag(pg, cdp, g["tx"], g["cy"], g["px"] + 12, g["cy"])
            assert pg.evaluate("_almRate") == 1
            assert not errors, errors
        finally:
            br.close()
