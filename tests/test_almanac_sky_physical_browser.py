"""The physical sky in a real browser: what the GPU draws, how often, and what the view takes.

On the shipped files, served by Zimi, in headless Chromium (SwiftShader's
WebGL2) at a phone's width, San Francisco chosen as the place:

  1. The GPU sky draws: the 9,096 stars and the Milky Way panorama load, and a
     bright star stands where the ephemeris puts it.
  2. On demand: an idle sky asks for no frame at all, and a live clock that has
     not turned the sky a pixel paints nothing.
  3. The view: a lens answers the direction it was pointed at, and with WebGL2
     missing the panorama turns instead and the sky still draws.
  4. Red night mode: nothing but red, and the switch is readable and announced.
  5. The honest defaults: the beach with its life over the physical sky, a dark
     site, no constellation lines; the true horizon is a choice that stays
     chosen; a guessed place is said to be guessed.

The numbers behind it are held in tests/test_almanac_sky_physical.cjs.

Run: pytest tests/test_almanac_sky_physical_browser.py -v
"""

import json
import re
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
VIEW = {"width": 390, "height": 844}
PLACE = {"lat": 37.7749, "lon": -122.4194, "name": "San Francisco"}
NIGHT = "2026-08-10T08:00:00Z"  # 01:00 in San Francisco, Sagittarius low in the south
HORIZON = "localStorage.setItem('zimi_sky_settings', '{\"skin\":\"horizon\"}');"   # the true horizon, chosen
POLL_MS = 100
WAIT_MS = 170000  # a loaded runner compiles shaders slowly

NO_WEBGL2 = (
    "const g = HTMLCanvasElement.prototype.getContext;"
    "HTMLCanvasElement.prototype.getContext = function (t, ...a) { return t === 'webgl2' ? null : g.call(this, t, ...a); };"
)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("physsky")
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
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


def _ms(iso):
    from datetime import datetime

    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _almanac(browser, served, place=PLACE, init="", **ctx_args):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        **ctx_args,
    )
    if place:
        ctx.add_init_script(
            "localStorage.setItem('zimi_almanac_place', %s);"
            % json.dumps(json.dumps(place))
        )
    if init:
        ctx.add_init_script(init)
    pg = ctx.new_page()
    pg.set_default_timeout(WAIT_MS)
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
        polling=POLL_MS,
    )
    # The sky stands under the Moon's numbers and its words, below the first screen: bring it into view, as a reader does.
    pg.evaluate(
        "() => document.querySelector('.almanac-sky-wrap').scrollIntoView({ behavior: 'instant', block: 'center' })"
    )
    return ctx, pg, errors


def _settle(pg, iso):
    pg.evaluate("(iso) => _almScrubSettle(new Date(iso))", iso)
    pg.wait_for_function(
        "(t) => _skyState && _skyState.nowTime === t && !_skyState.moonAnim && _skyState.baseBodies",
        arg=_ms(iso),
        polling=POLL_MS,
    )


def _drawn(pg):
    """Until the GPU sky has its data and has painted with it."""
    pg.wait_for_function(
        "() => _sgReady() && _sg.starCount === 9096 && _sg.mwReady && _skyState.paintedTime === _skyState.nowTime",
        polling=POLL_MS,
    )


def test_the_gpu_sky_draws_the_catalogue_where_the_ephemeris_puts_it(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        _drawn(pg)
        # Vega's place in the painted sky against the 2D ephemeris's.
        pg.evaluate("() => _skyKick()")
        pg.wait_for_timeout(500)
        got = pg.evaluate("""() => {
              const s = _skyState, st = s.eph.stars.find((x) => x.idx === 50);   // Vega
              if (!st) return { missing: true };
              const p = _skyScreen(s, st.az, st.alt);
              const c = document.createElement('canvas'); c.width = s.W; c.height = s.H;
              const x = c.getContext('2d', { willReadFrequently: true });
              x.drawImage(s.base, 0, 0);
              const R = 8, d = x.getImageData(Math.round(p.x) - R, Math.round(p.y) - R, 2 * R + 1, 2 * R + 1).data;
              let near = 0, sum = 0;
              for (let j = 0; j <= 2 * R; j++) for (let i = 0; i <= 2 * R; i++) {
                const k = 4 * (j * (2 * R + 1) + i), v = d[k] + d[k + 1] + d[k + 2];
                sum += v; if (Math.hypot(i - R, j - R) <= 2) near = Math.max(near, v);
              }
              return { near: near, mean: sum / ((2 * R + 1) ** 2), alt: st.alt, at: [p.x, p.y] };
            }"""
        )
        assert not got.get("missing"), "Vega is up at 01:00 in August"
        # A bright point within two pixels of where the ephemeris puts it, well above its surroundings.
        assert got["near"] > 450 and got["near"] > 3 * got["mean"], got
        # Stars and the panorama are the shipped ones, and the sky is not blank.
        assert pg.evaluate("_sg.starCount") == 9096 and pg.evaluate("_sg.mwReady")
        lit = pg.evaluate(
            "() => { const s = _skyState, x = s.canvas.getContext('2d', { willReadFrequently: true }); const d = x.getImageData(0, 0, s.W, Math.round(s.H * 0.7)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n; }"
        )
        assert lit > 400, (
            "thousands of stars, not an empty sky (%d bright pixels)" % lit
        )
        assert not errors, errors
    finally:
        ctx.close()


SYDNEY = {"lat": -33.8688, "lon": 151.2093, "name": "Sydney"}
JULY_MIDNIGHT = "2026-07-20T14:30:00Z"  # winter midnight in Sydney: the galactic centre high in the south


def test_the_milky_way_stands_on_the_galactic_plane_brightest_at_the_centre(browser, served):
    ctx, pg, errors = _almanac(browser, served, place=SYDNEY)
    try:
        _settle(pg, JULY_MIDNIGHT)
        got = pg.evaluate(
            """async () => {
              const s = _skyState, e = s.eph, M = _sgHorizonMatrix(e.P, e.lst, s.lat);
              const eq = (l, b) => { const v = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)], G = SG_EQ_TO_GAL;
                return [0, 1, 2].map((j) => G[j] * v[0] + G[3 + j] * v[1] + G[6 + j] * v[2]); };
              const aa = (l, b) => _skyAltAzOf(M, eq(l * Math.PI / 180, b * Math.PI / 180));
              const gc = aa(0, 0);
              ZimiSky.setView({ az: gc.az, alt: gc.alt, fov: 90 });
              await new Promise((r) => { const t = setInterval(() => { if (_skyState.lens && _skyState.paintedTime === _skyState.nowTime && _sg.mwReady && !_skyState.baseDirty) { clearInterval(t); r(); } }, 100); });
              const c = document.createElement('canvas'); c.width = s.W; c.height = s.H;
              const x = c.getContext('2d', { willReadFrequently: true });
              x.drawImage(s.base, 0, 0);
              const lum = (az, alt) => { const p = _skyScreen(s, az, alt), R = 5, d = x.getImageData(Math.round(p.x) - R, Math.round(p.y) - R, 2 * R + 1, 2 * R + 1).data; let t = 0;
                for (let i = 0; i < d.length; i += 4) t += d[i] + d[i + 1] + d[i + 2]; return t / ((2 * R + 1) ** 2) / 3; };
              const at = (l, b) => { const a = aa(l, b); return lum(a.az, a.alt); };
              return { gc: at(0, 0), plane: at(25, 0), north: at(0, 25), south: at(0, -25), far: at(180, 0), gcAlt: gc.alt };
            }"""
        )
        assert got["gcAlt"] > 40, got
        # The centre outshines the plane away from it, which outshines the sky off the plane on both sides.
        off = min(got["north"], got["south"])
        assert got["gc"] > 1.2 * got["plane"] and got["gc"] > 2 * off and got["plane"] > off, got
        assert not errors, errors
    finally:
        ctx.close()


HOST = (
    "() => { const h = document.createElement('div'); h.id = 'lookhost'; h.style.cssText = 'position:fixed;left:0;top:0;width:390px;height:700px;z-index:99999';"
    " document.body.appendChild(h); window.__host = h; return AlmanacSkyView.mount(h, %s); }"
)


def test_the_look_around_view_draws_the_whole_sphere_on_demand_and_leaves_the_card_alone(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate(HOST % json.dumps(PLACE)) is True
        pg.wait_for_function("() => document.querySelector('#lookhost canvas') && _sg.starCount === 9096 && _sg.mwReady", polling=POLL_MS)
        lit = (
            "() => { const c = document.querySelector('#lookhost canvas'), x = c.getContext('2d', { willReadFrequently: true });"
            " const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0, r = 0, g = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] > 120) n++; r += d[i]; g += d[i + 1]; } return { n, r, g, w: c.width, h: c.height }; }"
        )
        # Straight up, and across the sky at several bearings, and down: always painted, with stars to the top.
        for az, alt, fov in [(0, 90, 100), (90, 80, 60), (200, 45, 120), (310, 75, 20), (45, 0, 90), (180, -50, 90)]:
            pg.evaluate("([a, b, c]) => AlmanacSkyView.setView(window.__host, a, b, c)", [az, alt, fov])
            pg.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
            got = pg.evaluate(lit)
            if alt >= 0:
                assert got["n"] > 20, ((az, alt, fov), got)
        assert got["w"] == 780 and got["h"] == 1400, got
        # The field of view is held to the pinch's range.
        pg.evaluate("AlmanacSkyView.setView(window.__host, 0, 0, 500)")
        assert pg.evaluate("_skyHost.look.fov") == pg.evaluate("SKY_LENS_FOV[1]") >= 120
        pg.evaluate("AlmanacSkyView.setView(window.__host, 0, 0, 0.1)")
        assert pg.evaluate("_skyHost.look.fov") == pg.evaluate("SKY_LENS_FOV[0]") <= 20
        # No timer while the view is still, and a burst of turns is one frame (read in one turn, so no other
        # module's clock can be counted); an idle view never draws. The turns above
        # may still have a frame pending (a slow page has not run it yet), and a
        # burst joins a pending frame instead of asking for another: let it land first.
        pg.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
        turn = pg.evaluate(
            "() => { let t = 0, f = 0; const st = window.setTimeout, raf = window.requestAnimationFrame;"
            " window.setTimeout = function () { t++; return st.apply(this, arguments); };"
            " window.requestAnimationFrame = function () { f++; return raf.apply(this, arguments); };"
            " for (let i = 0; i < 30; i++) AlmanacSkyView.setView(window.__host, 100 + i, 40, 80);"
            " window.setTimeout = st; window.requestAnimationFrame = raf; return [t, f]; }"
        )
        assert turn == [0, 1], "thirty turns asked for %s timers and frames" % turn
        pg.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
        pg.evaluate("() => { window.__draws = 0; const d = window._skyHostDraw; window._skyHostDraw = function () { window.__draws++; return d.apply(this, arguments); }; }")
        pg.wait_for_timeout(4000)
        assert pg.evaluate("window.__draws") == 0, "an idle view drew"
        # Red night mode applies in the view too.
        pg.evaluate("ZimiSky.setRedMode(true)")
        red = pg.evaluate(lit)
        assert red["r"] > 0 and red["g"] < 0.12 * red["r"], red
        pg.evaluate("ZimiSky.setRedMode(false)")
        # Unmounted, the card works as before.
        pg.evaluate("AlmanacSkyView.unmount(window.__host)")
        assert pg.evaluate("document.querySelector('#lookhost canvas')") is None and pg.evaluate("_skyHost") is None
        pg.evaluate("_skyState.baseDirty = true; _skyKick()")
        pg.wait_for_function("() => !_skyState.baseDirty && _skyState.baseBodies.length", polling=POLL_MS)
        assert not errors, errors
    finally:
        ctx.close()


COUNT = (
    "window.__kicks = 0; window.__paints = 0;"
    "const k = window._skyKick; window._skyKick = function () { window.__kicks++; return k.apply(this, arguments); };"
    "const p = window._skyPaintBase; window._skyPaintBase = function () { window.__paints++; return p.apply(this, arguments); };"
)


def test_an_idle_sky_asks_for_no_frame_and_a_live_tick_that_moved_nothing_paints_nothing(
    browser, served
):
    ctx, pg, errors = _almanac(browser, served, init=HORIZON)   # the beach's breeze asks for twelve frames a second; this is the still sky
    try:
        _settle(pg, NIGHT)
        _drawn(pg)
        pg.wait_for_timeout(1500)
        pg.evaluate("() => { " + COUNT + " }")
        # Ten seconds of nothing: no frame requested by the sky, nothing painted.
        pg.wait_for_timeout(10000)
        counts = pg.evaluate("() => [window.__kicks, window.__paints, _almanacSkyRAF]")
        assert counts == [0, 0, None], counts
        # A live tick half a minute on: the sky has not turned a pixel, so no paint.
        pg.evaluate(
            "() => { _almFocus = null; _skyState.baseDirty = false; const t = _skyState.paintedTime;"
            " _skyCompute(_skyState, new Date(t + 30000), true); window.__quiet = _skyState.baseDirty; }"
        )
        assert pg.evaluate("window.__quiet") is False
        # ... and ten minutes on it has.
        pg.evaluate(
            "() => { _skyCompute(_skyState, new Date(_skyState.paintedTime + 600000), true); window.__moved = _skyState.baseDirty; }"
        )
        assert pg.evaluate("window.__moved") is True
        assert not errors, errors
    finally:
        ctx.close()


def test_the_beach_with_its_life_is_the_default_and_the_true_horizon_a_choice_that_stays_chosen(
    browser, served
):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate("_skySetting('skin')") == "beach"
        assert (
            pg.evaluate("_skySetting('dial')") == 0
            and pg.evaluate("_skySetting('lines')") == "off"
        )
        pg.wait_for_function(
            "() => _skyTimers.sway && _skyTimers.plane && _skyTimers.meteor", polling=POLL_MS
        )
        # The beach's sea mirrors the sky that was drawn: the strip is kept and read.
        ground = pg.evaluate("() => _skyState.ground")
        assert ground and len(ground["hor"]) == 3 and len(ground["avg"]) == 3, ground
        assert pg.evaluate("_skyState.reflect.width") > 10
        # The true horizon: chosen, it stops every one of them, and is kept across a reload.
        pg.evaluate("_skySet('skin', 'horizon')")
        pg.wait_for_function(
            "() => !_skyTimers.sway && !_skyTimers.plane && !_skyTimers.meteor", polling=POLL_MS
        )
        pg.reload(wait_until="load")
        pg.wait_for_function(
            "() => typeof _skyState !== 'undefined' && _skyState && _skyState.eph",
            polling=POLL_MS,
        )
        assert pg.evaluate("_skySetting('skin')") == "horizon"
        assert not errors, errors
    finally:
        ctx.close()


def test_a_lens_answers_the_direction_it_was_pointed_at(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        pg.evaluate("ZimiSky.setView({ az: 200, alt: 55, fov: 100 })")
        pg.wait_for_function(
            "() => _skyState.lens && _skyState.paintedTime === _skyState.nowTime",
            polling=POLL_MS,
        )
        view = pg.evaluate("ZimiSky.getView()")
        assert (
            view["mode"] == "lens"
            and abs(view["az"] - 200) < 1e-6
            and abs(view["alt"] - 55) < 1e-6
            and view["fov"] == 100
        )
        mid = pg.evaluate(
            "() => { const r = _skyState.canvas.getBoundingClientRect(); return ZimiSky.pointAt(r.left + r.width / 2, r.top + r.height / 2); }"
        )
        assert abs(mid["az"] - 200) < 0.2 and abs(mid["alt"] - 55) < 0.2, mid
        there = pg.evaluate("ZimiSky.screenOf(200, 55)")
        w = pg.evaluate("_skyState.cssW"), pg.evaluate("_skyState.canvas.clientHeight")
        assert (
            abs(there["x"] - w[0] / 2) < 0.5
            and abs(there["y"] - w[1] / 2) < 0.5
            and there["visible"]
        ), there
        assert pg.evaluate("ZimiSky.screenOf(20, -30).visible") is False
        # The lens and the stars agree: Vega, if in view.
        pg.evaluate("ZimiSky.setView({ az: 100, alt: 40, fov: 60 })")
        pg.wait_for_function(
            "() => _skyState.paintedTime === _skyState.nowTime && _skyState.lens.az === 100",
            polling=POLL_MS,
        )
        pg.evaluate("ZimiSky.resetView()")
        assert pg.evaluate("ZimiSky.getView().mode") == "pano"
        assert not errors, errors
    finally:
        ctx.close()


def test_without_webgl2_the_panorama_turns_and_the_sky_still_draws(browser, served):
    ctx, pg, errors = _almanac(browser, served, init=NO_WEBGL2)
    try:
        _settle(pg, NIGHT)
        pg.wait_for_timeout(1500)
        assert pg.evaluate("_sgReady()") is False
        pg.evaluate("ZimiSky.setView({ az: 120, alt: 30, fov: 150 })")
        pg.wait_for_function(
            "() => _skyState.paintedTime === _skyState.nowTime", polling=POLL_MS
        )
        view = pg.evaluate("ZimiSky.getView()")
        assert view["mode"] == "pano" and view["az"] == 120 and view["fov"] == 150, view
        assert pg.evaluate("ZimiSky.supportsLens()") is False
        lit = pg.evaluate(
            "() => { const s = _skyState, x = s.canvas.getContext('2d', { willReadFrequently: true }); const d = x.getImageData(0, 0, s.W, s.H).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n; }"
        )
        assert lit > 100, "the Canvas 2D sky draws its stars (%d)" % lit
        # The facts and settings are the same.
        assert "local solar time" in pg.inner_text("#almanac-sky-facts").lower()
        assert not errors, errors
    finally:
        ctx.close()


def test_without_webgl2_the_look_around_is_drawn_by_canvas_and_never_empty(browser, served):
    ctx, pg, errors = _almanac(browser, served, init=NO_WEBGL2)
    try:
        _settle(pg, NIGHT)
        assert pg.evaluate(HOST % json.dumps(PLACE)) is True
        for az, alt, fov in [(180, 40, 90), (0, 90, 60), (270, 10, 120)]:
            pg.evaluate("([a, b, c]) => AlmanacSkyView.setView(window.__host, a, b, c)", [az, alt, fov])
            pg.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
            lit = pg.evaluate(
                "() => { const c = document.querySelector('#lookhost canvas'), x = c.getContext('2d', { willReadFrequently: true }); const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0, v = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] > 120) n++; v = Math.max(v, d[i + 2]); } return { n, v }; }"
            )
            assert lit["n"] > 5 and lit["v"] > 20, ((az, alt, fov), lit)
        assert pg.evaluate("_sgReady()") is False
        assert not errors, errors
    finally:
        ctx.close()


def test_red_night_mode_is_red_and_the_switch_is_readable(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        _drawn(pg)
        pg.evaluate(
            "window.__red = []; document.addEventListener('zimisky:red', (e) => window.__red.push(e.detail.on))"
        )
        assert pg.evaluate("ZimiSky.redMode()") is False
        pg.evaluate("ZimiSky.setRedMode(true)")
        pg.wait_for_function(
            "() => _skyState.paintedTime === _skyState.nowTime && !_skyState.baseDirty",
            polling=POLL_MS,
        )
        pg.wait_for_timeout(800)
        assert pg.evaluate("ZimiSky.redMode()") is True and pg.evaluate(
            "window.__red"
        ) == [True]
        assert pg.evaluate(
            "document.querySelector('.almanac-sky-wrap').classList.contains('sky-red')"
        )
        ch = pg.evaluate(
            "() => { const s = _skyState, x = s.canvas.getContext('2d', { willReadFrequently: true }); const d = x.getImageData(0, 0, s.W, s.H).data; let r = 0, g = 0, b = 0, top = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; top = Math.max(top, d[i]); } return { r, g, b, top }; }"
        )
        assert ch["r"] > 0 and ch["g"] < 0.12 * ch["r"] and ch["b"] < 0.08 * ch["r"], ch
        pg.evaluate("ZimiSky.setRedMode(false)")
        assert pg.evaluate("window.__red") == [True, False]
        # It is the one switch every view shares (the Red theme in localStorage zimi_app_theme, the night-red class on <html>):
        # the sky wrote it, and follows it when another view flips it.
        assert pg.evaluate("localStorage.getItem('zimi_app_theme')") is None
        pg.evaluate("ZimiSky.setRedMode(true)")
        assert pg.evaluate("localStorage.getItem('zimi_app_theme')") == "red"
        pg.evaluate("localStorage.removeItem('zimi_app_theme'); document.documentElement.classList.remove('night-red'); ZimiSky.setRedMode(false)")
        pg.evaluate("window.__red = []; document.documentElement.classList.add('night-red')")
        pg.wait_for_function("() => window.__red.length === 1 && ZimiSky.redMode()", polling=POLL_MS)
        assert pg.evaluate("window.__red") == [True]
        pg.evaluate("document.documentElement.classList.remove('night-red')")
        pg.wait_for_function("() => window.__red.length === 2 && !ZimiSky.redMode()", polling=POLL_MS)
        assert not errors, errors
    finally:
        ctx.close()


def test_a_guessed_place_is_said_to_be_guessed_and_named(browser, served):
    ctx, pg, errors = _almanac(
        browser, served, place=None, timezone_id="America/Los_Angeles"
    )
    try:
        _settle(pg, NIGHT)
        pg.wait_for_function(
            "() => document.getElementById('almanac-sky-facts').innerText.length > 20",
            polling=POLL_MS,
        )
        pg.wait_for_function("() => document.getElementById('almanac-sky-guess').innerText.length > 10", polling=POLL_MS)
        text = pg.inner_text("#almanac-sky-guess")
        assert "guessed" in text.lower() and "Los Angeles" in text, text
        assert not errors, errors
    finally:
        ctx.close()
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        pg.wait_for_function(
            "() => document.getElementById('almanac-sky-facts').innerText.length > 20",
            polling=POLL_MS,
        )
        text = pg.inner_text("#almanac-sky-facts") + pg.inner_text("#almanac-sky-guess")
        assert "guessed" not in text.lower(), text
        for label in ("sunrise", "moon", "solar time"):
            assert label in text.lower(), (label, text)
    finally:
        ctx.close()


def test_a_planets_phase_is_drawn_as_the_share_that_is_lit(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        got = pg.evaluate(
            """() => { const out = {}; for (const k of [0.04, 0.3, 0.5, 0.8, 0.97]) {
              const c = document.createElement('canvas'); c.width = c.height = 120; const x = c.getContext('2d', { willReadFrequently: true });
              _skyDrawPhase(x, 60, 60, 40, k, 0.7, '#ffffff', 1);
              const d = x.getImageData(0, 0, 120, 120).data; let lit = 0;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 200) lit++;
              out[k] = lit / (Math.PI * 1600); } return out; }"""
        )
        for k, share in got.items():
            assert abs(share - float(k)) < 0.04, got
        assert not errors, errors
    finally:
        ctx.close()


def _frames(pg, n=2):
    pg.evaluate("(n) => new Promise((r) => { const go = (k) => (k ? requestAnimationFrame(() => go(k - 1)) : r()); go(n); })", n)


def test_the_twilight_gradient_is_smooth_with_the_sun_between_14_and_18_degrees_down(browser, served):
    """Posterised bands over the western horizon at SF 2026-10-15 02:40 to 03:05 UT: half-float underflow in the tables."""
    ctx, pg, errors = _almanac(browser, served)
    try:
        for iso in ("2026-10-15T02:40:00Z", "2026-10-15T02:52:00Z", "2026-10-15T03:05:00Z"):
            _settle(pg, iso)
            _drawn(pg)
            pg.evaluate("ZimiSky.setView({ az: 262, alt: 12, fov: 45 })")
            pg.wait_for_function("() => _skyState.lens && !_skyState.baseDirty", polling=POLL_MS)
            _frames(pg)
            steps = pg.evaluate(
                """() => { const s = _skyState, x = s.base.getContext('2d', { willReadFrequently: true });
                  const hor = _skyScreen(s, 262, 0).y, rows = [];
                  const x0 = Math.round(s.W * 0.3), w = Math.round(s.W * 0.4);
                  for (let y = 0; y < Math.min(hor - 6, s.H - 1); y++) {
                    const d = x.getImageData(x0, y, w, 1).data; let r = 0, g = 0, b = 0;
                    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
                    const n = d.length / 4; rows.push([r / n, g / n, b / n]);
                  }
                  let worst = 0;
                  for (let k = 3; k < rows.length; k++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(rows[k][c] - rows[k - 3][c]));
                  return { worst: worst, n: rows.length, sun: s.eph.sunGeoAlt }; }"""
            )
            assert steps["n"] > 100 and steps["worst"] < 7, (iso, steps)
        assert not errors, errors
    finally:
        ctx.close()


def test_a_full_moon_sky_is_dark_blue_with_hundreds_of_stars(browser, served):
    ctx, pg, errors = _almanac(browser, served, place={"lat": 32.7767, "lon": -96.797, "name": "Dallas"})
    try:
        _settle(pg, "2026-10-26T06:00:00Z")
        _drawn(pg)
        _frames(pg)
        got = pg.evaluate(
            """() => { const s = _skyState, x = s.base.getContext('2d', { willReadFrequently: true });
              const d = x.getImageData(0, 0, s.W, Math.round(s.H * 0.7)).data; let peaks = 0, sky = [0, 0, 0], n = 0;
              const W = s.W, H = Math.round(s.H * 0.7);
              for (let y = 2; y < H - 2; y += 1) for (let i = 2; i < W - 2; i += 1) {
                const k = 4 * (y * W + i), v = d[k] + d[k + 1] + d[k + 2];
                const bg = (d[k - 8] + d[k - 7] + d[k - 6] + d[k + 8] + d[k + 9] + d[k + 10]) / 2;
                if (v > bg + 45) peaks++;
                if (i > W * 0.7 && y < H * 0.5) { sky[0] += d[k]; sky[1] += d[k + 1]; sky[2] += d[k + 2]; n++; }
              }
              return { peaks: peaks, sky: sky.map((v) => v / n), lm: s.lm }; }"""
        )
        assert got["peaks"] > 300, got
        assert got["sky"][2] > got["sky"][0] and got["sky"][2] < 80, got   # blue, and dark
        assert not errors, errors
    finally:
        ctx.close()


def test_the_milky_way_reads_away_from_the_centre_too(browser, served):
    """Toward Cygnus (l = 90) from a northern dark sky: the plane against the sky on either side."""
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        got = pg.evaluate(
            """async () => {
              const s = _skyState, e = s.eph, M = _sgHorizonMatrix(e.P, e.lst, s.lat);
              const eq = (l, b) => { const v = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)], G = SG_EQ_TO_GAL;
                return [0, 1, 2].map((j) => G[j] * v[0] + G[3 + j] * v[1] + G[6 + j] * v[2]); };
              const aa = (l, b) => _skyAltAzOf(M, eq(l * Math.PI / 180, b * Math.PI / 180));
              const c = aa(90, 0);
              ZimiSky.setView({ az: c.az, alt: Math.max(c.alt, 20), fov: 80 });
              await new Promise((r) => { const t = setInterval(() => { if (_sgReady() && _sg.mwReady && _skyState.lens && !_skyState.baseDirty) { clearInterval(t); r(); } }, 100); });
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              const x = s.base.getContext('2d', { willReadFrequently: true });
              const lum = (l, b) => { const a = aa(l, b), p = _skyScreen(s, a.az, a.alt), R = 7, d = x.getImageData(Math.round(p.x) - R, Math.round(p.y) - R, 2 * R + 1, 2 * R + 1).data;
                const v = []; for (let i = 0; i < d.length; i += 4) v.push(d[i] + d[i + 1] + d[i + 2]); v.sort((p2, q) => p2 - q); return v[v.length >> 1] / 3; };
              return { plane: lum(90, 0), north: lum(90, 22), south: lum(90, -22), alt: c.alt }; }"""
        )
        off = max(got["north"], got["south"])
        assert got["alt"] > 20 and got["plane"] > off + 6 and got["plane"] > 1.5 * off, got
        assert not errors, errors
    finally:
        ctx.close()


def test_every_bright_star_can_be_tapped_and_its_figure_comes_with_it(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    fetched = []
    pg.on("request", lambda r: fetched.append(r.url))
    try:
        _settle(pg, NIGHT)
        _drawn(pg)
        pg.wait_for_function("() => _skyNames && _skyTapStars > 500", polling=POLL_MS)
        # Nothing asks for the constellations while the default (no lines) stands.
        _frames(pg)
        assert not any("constellations-v1" in u for u in fetched), fetched
        got = pg.evaluate(
            """() => { const bodies = _skyState.baseBodies.filter((b) => b.type === 'star' && b.idx < 0 && b.desig && b.mag < 3.4);
              return { n: _skyState.baseBodies.filter((b) => b.type === 'star').length, named: bodies.length, first: bodies[0] || null }; }"""
        )
        assert got["n"] > 150 and got["named"] > 3, got
        b = got["first"]
        pg.evaluate("document.getElementById('almanac-sky-canvas').scrollIntoView({ block: 'center' })")
        pg.wait_for_timeout(300)
        pos = pg.evaluate("([x, y]) => { const r = _skyState.canvas.getBoundingClientRect(); return { x: r.left + x, y: r.top + y }; }", [b["x"], b["y"]])
        pg.mouse.click(pos["x"], pos["y"])
        pg.wait_for_function("() => !document.getElementById('almanac-sky-tip').hidden", polling=POLL_MS)
        tip = pg.inner_text("#almanac-sky-tip")
        assert b["desig"] in tip and "magnitude" in tip.lower(), (tip, b)
        box = pg.locator("#almanac-sky-tip").bounding_box()
        assert not (box["x"] <= pos["x"] <= box["x"] + box["width"] and box["y"] <= pos["y"] <= box["y"] + box["height"]), ("the tip covers what was tapped", box, pos)
        pg.wait_for_function("() => !!_skyConst && _skyState.reveal", polling=POLL_MS)
        assert any("constellations-v1" in u for u in fetched)
        assert pg.evaluate("_skyState.reveal") == b["con"]
        # A tap on empty sky takes the figure away again.
        pg.evaluate("_skyHideTip()")
        assert pg.evaluate("_skyState.reveal") is None
        assert not errors, errors
    finally:
        ctx.close()


def test_a_lost_gpu_context_is_given_back_and_taken_again_and_dispose_frees_it(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        _drawn(pg)
        pg.evaluate("window.__gl = []; document.addEventListener('zimisky:gl', (e) => window.__gl.push(e.detail.ready))")
        pg.evaluate("_sg.gl.getExtension('WEBGL_lose_context').loseContext()")
        pg.wait_for_function("() => window.__gl.length >= 1 && window.__gl[0] === false", polling=POLL_MS)
        # The next paint starts it again.
        pg.evaluate("_skyKickDirty()")
        pg.wait_for_function("() => _sgReady() && _sg.starCount === 9096 && _sg.mwReady && !_skyState.baseDirty", polling=POLL_MS)
        assert pg.evaluate("window.__gl.includes(true)")
        # Dispose gives it all back, and nothing is left to draw with.
        pg.evaluate("_sgDispose()")
        assert pg.evaluate("_sg") is None and pg.evaluate("_sgReady()") is False
        assert not errors, errors
    finally:
        ctx.close()


def test_the_sky_view_tables_are_drawn_once_for_one_place_of_the_sun(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        _drawn(pg)
        n = pg.evaluate(
            """() => { const gl = _sg.gl, real = gl.drawArrays; let n = 0; gl.drawArrays = function () { n++; return real.apply(this, arguments); };
              const s = _skyState, a = _skyGLParams(s); _sgDraw(a); const first = n; n = 0; _sgDraw(a); const second = n;
              a.sunAltGeo += 0.01; a.moonAlt += 0.01; n = 0; _sgDraw(a); const third = n;
              a.sunAltGeo += 1; n = 0; _sgDraw(a); const moved = n; gl.drawArrays = real; return [first, second, third, moved]; }"""
        )
        # One quad for the sky; a table more for each light that has moved (the Sun, at night, is too far down to have one).
        assert n[1] == 1 and n[2] == 1 and n[3] <= 2, n
        assert not errors, errors
    finally:
        ctx.close()


def test_the_credit_and_the_zone_city_are_on_the_card_without_bearings(browser, served):
    ctx, pg, errors = _almanac(browser, served)
    try:
        _settle(pg, NIGHT)
        _drawn(pg)
        pg.wait_for_function("() => document.getElementById('almanac-sky-facts').innerText.length > 10", polling=POLL_MS)
        text = pg.inner_text("#almanac-sky-facts") + pg.inner_text("#almanac-sky-guess")
        # Each rise and set card is two lines, the event and its time: no compass bearing (Eric, 2026-10-29).
        assert not re.search(r"\b(N|NE|E|SE|S|SW|W|NW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW) \d+\u00b0", text), text
        assert "guessed" not in text.lower() and "about" not in text.lower(), text
        # The Milky Way's credit lives in About this data, off the card (the folded-calendar pass).
        assert "Brunier" not in text, text
        credit = pg.evaluate("(document.querySelector('#almanac-view .alm-about-credit') || {}).textContent || ''")
        assert "ESO/S. Brunier" in credit, credit
    finally:
        ctx.close()
    ctx, pg, errors = _almanac(browser, served, place=None, timezone_id="America/Chicago")
    try:
        _settle(pg, NIGHT)
        pg.wait_for_function("() => document.getElementById('almanac-sky-guess').innerText.length > 10", polling=POLL_MS)
        text = pg.inner_text("#almanac-sky-facts") + pg.inner_text("#almanac-sky-guess")
        # Chicago's own sunrise on 10 August is about 6:10: not the hour-early guess of an Atlantic longitude.
        assert "Chicago" in text and "about" in text.lower(), text
        # The sunrise's time is the Moon's block's own card (not said twice): Chicago's, not an Atlantic longitude's.
        sunrise = pg.inner_text("#alm-hc-sunrise")
        assert re.match(r"[56]:\d\d AM", sunrise), sunrise
        assert pg.evaluate("Math.round(_skyState.lat * 10) / 10") == 41.9
    finally:
        ctx.close()
