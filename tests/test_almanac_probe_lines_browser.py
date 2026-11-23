"""A probe's line in the Almanac's 3D view (almanac-earth.js _aeUpdateProbes): only the road already travelled, ending at the probe itself, nothing drawn ahead.
At three dates the line's last vertex is where the marker stands and no vertex is from the probe's future; under time travel the line grows and shrinks with the
clock; a probe not yet launched has none.

Run: pytest tests/test_almanac_probe_lines_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
VIEW = {"width": 390, "height": 844}
READY_MS = 600_000
JD_UNIX_EPOCH = 2440587.5


@pytest.fixture(scope="module")
def page_(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from playwright.sync_api import sync_playwright

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("probes")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(viewport=VIEW, device_scale_factor=1, has_touch=True, is_mobile=True, service_workers="block")
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.errors = errors
        pg.goto(base + "/#almanac", wait_until="load")
        pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=READY_MS)
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
        pg.evaluate("() => _aeTracksLoad()")
        pg.wait_for_function("() => !!_aeTracks", timeout=120_000)
        yield pg
        br.close()
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


LINE = """([key, unix]) => new Promise((resolve) => {
  _aeGoTo(unix * 1000);
  _aePreset(key);
  const start = performance.now();
  const poll = () => {
    const S = _ae.gl, tr = S.probes && S.probes.trails[key], jd = _ae.scene.ms / 86400000 + 2440587.5;
    if ((!_ae.fly && tr && tr.visible && tr.times && Math.abs(tr.times[tr.times.length - 1] - jd) < 1e-6 && Math.abs(jd - (unix / 86400 + 2440587.5)) < 1e-3) || performance.now() - start > 30000) {
      const a = tr ? tr.geometry.attributes.position.array : null, n = a ? a.length / 3 : 0, p = _aeProbePos[key];
      resolve(tr && tr.visible ? { jd: jd, last: [a[(n - 1) * 3] + tr.position.x, a[(n - 1) * 3 + 1] + tr.position.y, a[(n - 1) * 3 + 2] + tr.position.z], pos: p, times: Array.from(tr.times), jd0: _aeTracks.tracks[key].jd0, ring: S.probes.orbits[key].visible, alpha: [a && tr.geometry.attributes.color.array[3], tr.geometry.attributes.color.array[(n - 1) * 4 + 3]] } : { visible: false });
    } else requestAnimationFrame(poll);
  };
  poll();
})"""


@pytest.mark.parametrize("key,dates", [("voyager1", [(1980, 6, 1), (2012, 9, 1), (2026, 6, 1)]), ("juno", [(2016, 8, 1), (2020, 1, 1), (2025, 6, 1)])])
def test_a_probes_line_ends_at_the_probe_and_nothing_is_drawn_ahead(page_, key, dates):
    import calendar

    for y, m, d in dates:
        unix = calendar.timegm((y, m, d, 12, 0, 0))
        r = page_.evaluate(LINE, [key, unix])
        assert r.get("visible", True), (key, y)
        # The last vertex (the points are held relative to the craft, the line standing at it: b3259c83a) is the probe's own place (the marker and the model stand there): within a thousandth of an Earth radius.
        assert max(abs(a - b) for a, b in zip(r["last"], r["pos"])) < 1e-3, (key, y, r["last"], r["pos"])
        # No vertex is from its future, none before it was launched, and they run in time order.
        times = r["times"]
        assert times[-1] <= r["jd"] + 1e-6 and times[0] >= r["jd0"] - 1e-6, (key, y)
        assert all(b >= a for a, b in zip(times, times[1:])), (key, y)
        # The ellipse it is on (the way ahead) is not drawn, and the path fades up from its start to the probe.
        assert r["ring"] is False, (key, y)
        assert r["alpha"][0] < r["alpha"][1] <= 1.0, r["alpha"]
    assert not page_.errors, page_.errors


def test_the_line_grows_and_shrinks_with_the_clock_and_is_absent_before_launch(page_):
    import calendar

    early = page_.evaluate(LINE, ["voyager1", calendar.timegm((1980, 1, 1, 12, 0, 0))])
    late = page_.evaluate(LINE, ["voyager1", calendar.timegm((2020, 1, 1, 12, 0, 0))])
    assert late["times"][-1] > early["times"][-1] and late["times"][0] == pytest.approx(early["times"][0], abs=1e-6)  # the same start (launch), the end moves with the clock
    again = page_.evaluate(LINE, ["voyager1", calendar.timegm((1980, 1, 1, 12, 0, 0))])
    assert again["times"][-1] == pytest.approx(early["times"][-1], abs=1e-3)  # and back
    before = page_.evaluate(LINE, ["voyager1", calendar.timegm((1970, 1, 1, 12, 0, 0))])
    assert before == {"visible": False}, before


def test_a_far_planets_shading_is_made_without_world_coordinates(page_):
    """A planet thousands of Earth radii out has float32 steps of kilometres in its world position: its eye and ring vectors come from the camera-relative matrix
    and the body's own rotation instead, and its programs still link (Mars, Saturn with rings)."""
    r = page_.evaluate(
        """async () => { _aeGoTo(Date.UTC(2026, 10, 14, 12)); _aePreset('saturn'); const S = _ae.gl, out = { src: [AE_PLANET_FRAG, AE_RING_FRAG].map(f => f.indexOf('cameraPosition') < 0 && f.indexOf('vWorld - center') < 0), linked: {} };
          for (let i = 0; i < 300 && !_ae.fly === false; i++) await new Promise(r => setTimeout(r, 100));
          await new Promise(r => setTimeout(r, 2500));
          const gl = S.renderer.getContext();
          ['saturn', 'mars'].forEach(k => { const m = S.planets[k].mesh, pr = S.renderer.properties.get(m.material), cp = pr && pr.currentProgram; out.linked[k] = cp ? gl.getProgramParameter(cp.program, gl.LINK_STATUS) : null; });
          const ring = S.planets.saturn.ring, rp = ring && S.renderer.properties.get(ring.material), rc = rp && rp.currentProgram; out.linked.ring = rc ? gl.getProgramParameter(rc.program, gl.LINK_STATUS) : null;
          return out; }"""
    )
    assert r["src"] == [True, True], r
    assert r["linked"]["saturn"] is True and r["linked"]["ring"] is True, r
    assert not page_.errors, page_.errors


def test_the_probe_in_view_shows_its_road_with_orbits_off_and_others_stay_hidden(page_):
    import calendar

    page_.evaluate("() => { try { _aeSetOrbits(false); } catch (e) {} }")
    page_.evaluate("([u]) => { _aeGoTo(u * 1000); _aePreset('voyager1'); }", [calendar.timegm((2026, 6, 1, 12, 0, 0))])
    page_.wait_for_function("() => !_ae.fly && _ae.target === 'voyager1'", timeout=60_000, polling=200)
    page_.wait_for_timeout(2500)   # (the flight's own lines fade out in 1.5 s)
    r = page_.evaluate("() => ({ on: _aeOrbitsOn(), mine: _ae.gl.probes.trails.voyager1.visible, others: Object.keys(_ae.gl.probes.trails).filter(k => k !== 'voyager1' && _ae.gl.probes.trails[k].visible) })")
    assert r["on"] is False and r["mine"] is True and r["others"] == [], r
