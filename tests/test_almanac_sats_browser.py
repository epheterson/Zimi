"""Every active satellite in the 3D Earth view: the points draw, a filter works, a tap gives a card, the frame time holds.

Zimi serves the shipped catalogue (the snapshot) and the Earth view is driven in headless Chromium at a phone's size.
SATS_SHOTS=<folder> saves screenshots of each state there.

Run: pytest tests/test_almanac_sats_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":40.71,"lon":-74.0,"name":"New York"}'
READY_MS = 400_000
SHOTS = os.environ.get("SATS_SHOTS", "")
# A phone has to hold its frame rate in this view with the whole catalogue drawn. Software GL on a busy desktop is far
# slower than a phone's GPU (a frame here can take a second), so the test bounds the layer's own main-thread work per
# frame (its frame hook, and copying a worker sample into the buffers), not the rate. Both are a fraction of a 16 ms frame.
MAX_LAYER_FRAME_MS = 3
MAX_SAMPLE_COPY_MS = 8
MIN_CATALOGUE = 5000
MIN_DRAWN_SHARE = 0.8


@pytest.fixture(scope="module")
def browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


@pytest.fixture
def served(tmp_path):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    (tmp_path / "zims").mkdir()
    (tmp_path / "data").mkdir()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp_path / "zims"), str(tmp_path / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _frame_ms(pg, frames=90):
    return pg.evaluate(
        """(n) => new Promise(res => { var t = [], l = performance.now(), k = 0;
            function f(now) { t.push(now - l); l = now; _ae.dirty = true; if (++k < n) requestAnimationFrame(f);
              else { t.sort((a, b) => a - b); res(t[Math.floor(n / 2)]); } }
            requestAnimationFrame(f); })""",
        frames,
    )


def _shot(pg, name):
    if SHOTS:
        pg.screenshot(path=os.path.join(SHOTS, name))


FIND_A_DOT = """() => {
  var a = _as.cloud.geometry.attributes, p = a.position.array, v = a.aVel.array, s = a.aSize.array, al = a.aAlpha.array,
      dt = _as.cloud.material.uniforms.dt.value, cz = Math.cos(_as.cloud.rotation.z), sz = Math.sin(_as.cloud.rotation.z);
  for (var i = 0; i < s.length; i++) {
    if (!s[i] || al[i] <= 0) continue;
    var k = i * 3, x = p[k] + v[k] * dt, y = p[k + 1] + v[k + 1] * dt, z = p[k + 2] + v[k + 2] * dt, q = [x * cz - y * sz, x * sz + y * cz, z];
    if (_aeBehindEarth(q)) continue;
    var sc = _aeProject(q);
    if (sc && sc.x > 30 && sc.x < _ae.w - 30 && sc.y > 120 && sc.y < _ae.h - 220) return { i: i, x: sc.x, y: sc.y };
  }
  return null;
}"""
WORKS_OUT_SHOWN = "(() => { var g = _as.data.group, s = _as.cloud.geometry.attributes.aSize.array; for (var i = 0; i < g.length; i++) if (s[i] > 0 && g[i] !== 0) return false; return true; })()"


def test_the_catalogue_draws_filters_and_answers_a_tap(browser, served):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); } catch (e) {}" % PLACE
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    try:
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=READY_MS,
        )
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=READY_MS,
            polling=250,
        )
        # Nothing of the layer is loaded until it is asked for.
        assert pg.evaluate("typeof _asSet") == "undefined"
        base = _frame_ms(pg)
        _shot(pg, "sats-off.png")
        pg.click("#ae-sats-btn")
        pg.wait_for_function(
            "() => typeof _as !== 'undefined' && (_as.state === 'ready' || _as.state === 'failed')",
            timeout=READY_MS,
            polling=250,
        )
        assert pg.evaluate("_as.state") == "ready"
        pg.wait_for_function("() => _as.sampleMs > 0", timeout=READY_MS, polling=250)
        n = pg.evaluate("_as.data.n")
        assert n > MIN_CATALOGUE
        # Points are in the buffer, lit, and nearly all have valid positions.
        drawn = pg.evaluate(
            "(() => { var a = _as.cloud.geometry.attributes.aAlpha.array, c = 0; for (var i = 0; i < a.length; i++) if (a[i] > 0) c++; return c; })()"
        )
        assert drawn > n * MIN_DRAWN_SHARE, (drawn, n)
        assert pg.evaluate("_as.cloud.visible") is True
        # Written where SGP4 puts them: none inside the Earth, none past the Moon.
        radii = pg.evaluate(
            "(() => { var p = _as.cloud.geometry.attributes.position.array, lo = 9, hi = 0; for (var i = 0; i < p.length; i += 3) { var r = Math.hypot(p[i], p[i + 1], p[i + 2]); if (r > 0) { lo = Math.min(lo, r); hi = Math.max(hi, r); } } return [lo, hi]; })()"
        )
        assert radii[0] > 1.0 and radii[1] < 8, radii
        pg.wait_for_timeout(1500)
        _shot(pg, "sats-on.png")
        on = _frame_ms(pg, 30)
        cost = pg.evaluate(
            """() => new Promise(res => { var f = window._asFrame, n = 0, t = 0;
              window._asFrame = function (ms, sc) { var a = performance.now(); f(ms, sc); t += performance.now() - a; n++; };
              var c = _as.cloud.geometry.attributes, r = { pos: new Float32Array(c.position.array), vel: new Float32Array(c.aVel.array) };
              var go = () => { if (n < 12) { _ae.dirty = true; _aeKick(); setTimeout(go, 100); return; }
                window._asFrame = f;
                var ms = _aeDisplayMs(), a2 = performance.now();
                for (var j = 0; j < 20; j++) { c.position.array.set(r.pos); c.aVel.array.set(r.vel); _asAlphas(ms + j * 6000); }
                res({ frame: t / n, copy: (performance.now() - a2) / 20, frames: n }); };
              go(); })"""
        )
        print("frame ms median: off %.1f, on %.1f; layer hook %.3f ms over %d frames, sample copy %.2f ms" % (base, on, cost["frame"], cost["frames"], cost["copy"]))
        assert cost["frame"] < MAX_LAYER_FRAME_MS and cost["copy"] < MAX_SAMPLE_COPY_MS, cost
        # A filter: Starlink alone is most of the sky and less than all of it.
        total = pg.evaluate("_as.shown")
        pg.click("#as-bar [data-v=starlink]")
        some = pg.evaluate("_as.shown")
        assert 0 < some < total, (some, total)
        assert pg.evaluate(WORKS_OUT_SHOWN)
        _shot(pg, "sats-starlink.png")
        pg.click("#as-bar [data-v=starlink]")
        assert pg.evaluate("_as.shown") == total
        # A tap on a dot opens its card with its name and altitude.
        pg.evaluate("_aePreset('earth'); _ae.fly = null")
        hit = pg.evaluate(FIND_A_DOT)
        assert hit
        pg.evaluate("(h) => _aeTap(h.x, h.y)", hit)
        assert pg.evaluate("_as.sel") >= 0
        card = pg.inner_text("#ae-card")
        assert pg.evaluate("_as.data.name[_as.sel]") in card and "km" in card, card
        _shot(pg, "sats-card.png")
        # The passes sheet opens and lists passes or says there are none.
        pg.click("#as-passes")
        pg.wait_for_function("() => _as.passes !== null", timeout=READY_MS, polling=500)
        assert pg.is_visible(".as-sheet")
        _shot(pg, "sats-passes.png")
        # The live sky: at the middle of the first pass, the sky's painter draws that satellite and keeps itself awake.
        painted = pg.evaluate(
            """() => { var p = _as.passes[0]; if (!p) return null; var pl = _asPlace(), cv = document.createElement('canvas'); cv.width = 780; cv.height = 600;
              var s = { W: 780, H: 600, center: 180, span: 360, dpr: 2, lat: pl.lat, lon: pl.lon, nowTime: p.peak, eph: { sunGeoAlt: -12 } };
              var live = window._almFocus; window._almFocus = new Date(p.peak);
              var ctx = cv.getContext('2d'), pix = () => ctx.getImageData(0, 0, 780, 600).data.reduce((n, v, i) => n + (i % 4 === 3 && v ? 1 : 0), 0);
              var before = pix(); _asSkyPaint(ctx, s); window._almFocus = live;
              return { drawn: pix() - before, awake: !!s.issUp, name: _as.data.name[p.i] }; }"""
        )
        assert painted and painted["drawn"] > 0 and painted["awake"], painted
        assert not errors, errors
    finally:
        ctx.close()
