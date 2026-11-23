"""Leaving the ground is one continuous picture: the ground's HD tiles thin out as the height grows, and the orbit view's are in before it takes over.

A deep fake Almanac HD (a tile per level, each level its own colour) is served slowly, as a phone on the NAS gets it, and the Earth view stands at
San Francisco and climbs back out. Every animation frame the tiles drawn are read. Filmed on the NAS: the ground's 43 tiles became 1 within 34 ms at
about 2000 km (a coarser tile that was not in yet took the finer ones away, and the globe's own map showed through), then 16 tiles became 157 as the
orbit view took over (the tiles of its camera had not been asked for yet).

Run: pytest tests/test_almanac_hd_climb_browser.py -v
"""

import os
import pathlib
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import test_almanac_hd_browser as hd
from browser_slots import WEBGL_ARGS

GL_ARGS = WEBGL_ARGS + ["--disable-accelerated-2d-canvas"]
TILE_DELAY_S = 1.0   # a tile takes this long to arrive: the climb is over before the view's deeper tiles are in
DEEPEST = 6

# One frame's tiles, and how far the orbit view's own tiles are in once the ground has gone.
SAMPLER = """() => { window.__s = []; window.__stop = false; const t0 = performance.now();
  function snap() {
    const S = _ae.gl, b = S.hd.bodies[0], keys = [];
    b.drawn.forEach(n => { if (n.mesh && n.mesh.visible) keys.push(n.z + '/' + n.x + '/' + n.y); });
    let rdy = null;
    if (!_ae.stand) {
      const leaves = _aeHdSelect(S, b);
      rdy = leaves.filter(l => _aeHdReady(b, _aeHdNode(b, l.z, l.x, l.y))).length / Math.max(1, leaves.length);
    }
    window.__s.push({ t: performance.now() - t0, keys: keys, body: b.parent.visible, stand: _ae.stand ? _ae.stand.mode : null, alt: _ae.stand ? _ae.stand.altKm : null, rdy: rdy });
    if (!window.__stop) requestAnimationFrame(snap);
  }
  requestAnimationFrame(snap); }"""


def _climb(tmp_path_factory, gated):
    """The climb sampled. `gated`: the tiles of levels 2 to 5 are not there (as on a slow link they are not in when the camera gets to them): only the deepest level and the first two are."""
    import threading

    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    import zimi.server as srv
    from zimi.http import ZimHandler

    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    env.setitem(hd.LEVELS, "earth/day", DEEPEST)
    plain = ZimHandler.do_GET
    slow_on = threading.Event()   # (the way down loads what the ground stands on quickly: the slow link is for the climb)

    def slow(self):
        path = self.path.split("?")[0]
        if path.endswith(".webp"):
            if gated and "/earth/day/" in path and path.split("/earth/day/")[1].split("/")[0] in ("2", "3", "4", "5"):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            elif slow_on.is_set():
                time.sleep(TILE_DELAY_S)
        return plain(self)

    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    httpd = hd._serve(pathlib.Path(tmp_path_factory.mktemp("climb")), "flavour")
    env.setattr(ZimHandler, "do_GET", slow)
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(viewport=hd.VIEW, device_scale_factor=1, has_touch=True, is_mobile=True, service_workers="block")
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r);"
            " localStorage.removeItem('zimi_alm_hd_later'); } catch (e) {}" % (hd.PLACE, hd.PLACE)
        )
        pg = ctx.new_page()
        pg.goto("http://127.0.0.1:%d/#almanac" % httpd.server_address[1], wait_until="load")
        pg.wait_for_function("() => typeof openAlmanacEarth === 'function'", timeout=300_000)
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=hd.READY_MS, polling=200)
        pg.wait_for_timeout(2000)
        pg.evaluate("() => _aeStandOpen({ body: 'earth', lat: 37.77, lon: -122.42 })")
        pg.wait_for_function("() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'", timeout=300_000, polling=200)
        pg.wait_for_timeout(5000)
        assert pg.evaluate("() => !!_ae.gl.hd"), "the fake Almanac HD is not in use"
        slow_on.set()
        pg.evaluate(SAMPLER)
        pg.evaluate("() => _aeStandLeave()")
        pg.wait_for_function("() => !_ae.stand", timeout=120_000, polling=100)
        pg.wait_for_timeout(1500)
        pg.evaluate("window.__stop = true")
        samples = pg.evaluate("window.__s")
        br.close()
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old
    env.undo()
    return samples


@pytest.fixture(scope="module")
def climb(tmp_path_factory):
    return _climb(tmp_path_factory, False)


@pytest.fixture(scope="module")
def climb_gated(tmp_path_factory):
    return _climb(tmp_path_factory, True)


def _level(key):
    return int(key.split("/")[0])


def _covers(a, b):
    """Whether tile key `a` is `b`, one above it or one below it."""
    za, xa, ya = map(int, a.split("/"))
    zb, xb, yb = map(int, b.split("/"))
    if za > zb:
        za, xa, ya, zb, xb, yb = zb, xb, yb, za, xa, ya
    return xb >> (zb - za) == xa and yb >> (zb - za) == ya


@pytest.mark.local_gate
def test_the_ground_s_tiles_thin_out_one_step_at_a_time(climb_gated):
    """A tile that goes is replaced by one drawn in the same frame, never by one much coarser: the finer ones stay until the coarser is in."""
    ascent = [s for s in climb_gated if s["stand"] == "ascend" and s["alt"] and s["alt"] > 50]
    # (One sample a frame, and the climb now takes its own time whatever the frame rate: about five frames on software GL at 200 ms each, a few
    # dozen on a GPU. The check below is per pair of frames, so a few still prove the steps; none would prove nothing.)
    assert len(ascent) >= 4, "the climb was not sampled"
    worst = 0
    for prev, cur in zip(ascent, ascent[1:]):
        for gone in set(prev["keys"]) - set(cur["keys"]):
            held = [_level(k) for k in cur["keys"] if _covers(k, gone)]
            if held:
                worst = max(worst, _level(gone) - min(held))
    assert worst <= 2, "tiles were swapped for ones %d levels coarser within a frame" % worst


@pytest.mark.parametrize("which", ["open", "gated"])
def test_no_frame_is_left_without_the_globe_or_a_tile(climb, climb_gated, which):
    ascent = [s for s in (climb if which == "open" else climb_gated) if s["stand"] == "ascend"]
    assert [s["t"] for s in ascent if not s["keys"] and not s["body"]] == []


def test_the_orbit_view_s_tiles_are_in_when_it_takes_over(climb):
    """The first frame after the hand-over has what the orbit view wants already loaded (nothing pops in over the next seconds)."""
    after = [s for s in climb if s["stand"] is None and s["rdy"] is not None]
    assert after, "the hand-over was not sampled"
    assert after[0]["rdy"] >= 0.9, "only %.0f%% of the orbit view's tiles were in at the hand-over" % (100 * after[0]["rdy"])
