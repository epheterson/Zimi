"""Flying to a spacecraft in the 3D view: the model is on its way as the flight starts and is there on arrival.

Eric, 2026-11-07: "flying to smaller things like the 3D models the animation is broken it goes to nothing then pops the
model in it should prepare and zoom right into the model." In headless Chromium at a phone's size, with the model's
file made slow: the flight starts at once, holds at the corner of its approach for the model, then zooms into it; at
every frame of the flight the target is on screen as its dot or its model; it ends the model's own span times a few
off, in the middle of the screen. A model already here is not waited for, and reduced motion goes straight there.

Run: pytest tests/test_almanac_flyto_browser.py -v
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
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
LATE_MS = 2500
# The model's files come late, so a flight has to wait for them.
SLOW_FETCH = (
    "(function(){var of=window.fetch;window.fetch=function(u){var a=arguments;"
    "return /craft-|iss-v1/.test(String(u&&u.url||u))?new Promise(function(r){setTimeout(r,%d)}).then(function(){return of.apply(window,a)}):of.apply(window,a)}})()"
    % LATE_MS
)
# Every frame of a flight, after the view has drawn it: where the target stands on screen, whether the flight waits for
# the model, and how much of the model and of the dot is drawn.
RECORD = """(k) => {
  window.__rec = []; window.__origLabels = window.__origLabels || _aeUpdateLabels;
  _aeUpdateLabels = function () {
    window.__origLabels.apply(this, arguments);
    var f = _ae.fly, S = _ae.gl, I = k === 'iss' ? S.iss : (S.crafts && S.crafts[k]);
    var p = k === 'iss' ? _ae.issPos : _aeProbePos[k], s = p ? _aeProject(p) : null, bm = document.getElementById('ae-bm-' + k);
    var show = I && I.root.visible ? (I.show != null ? I.show : 1) : 0;
    window.__rec.push({ fly: !!f, wait: !!(f && f.waitModel), x: s && s.x, y: s && s.y, show: show, mark: !!bm && !bm.hidden });
  };
  _aePreset(k);
}"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    # Offline and no torrents for this module's server only: set for the session, they turned later modules' download
    # and catalog tests offline on the same worker.
    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("flyto")
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
    env.undo()


def _open(browser, base, slow=True, reduced=False):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        reduced_motion="reduce" if reduced else "no-preference",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (PLACE, PLACE)
    )
    if slow:
        ctx.add_init_script(SLOW_FETCH)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base + "/#almanac", wait_until="load")
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
    pg.wait_for_function(
        "() => { _aeTracksLoad(); return !!_aeTracks && !!_aeProbePos.voyager1; }",
        timeout=60_000,
        polling=200,
    )
    return ctx, pg, errors


def _fly(pg, key):
    """Fly to `key` and return the frames of the flight and where it ended."""
    pg.evaluate(RECORD, key)
    pg.wait_for_function(
        "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
        timeout=90_000,
        polling=200,
    )
    pg.wait_for_timeout(600)
    frames = pg.evaluate("window.__rec")
    end = pg.evaluate(
        """(k) => { _ae.dirty = true; var p = k === 'iss' ? _ae.issPos : _aeProbePos[k]; _aePlaceCamera(); _ae.gl.camera.updateMatrixWorld();
        var s = _aeProject(p), m = k === 'iss' ? 'iss' : AE_CRAFT_MODEL[k], I = k === 'iss' ? _ae.gl.iss : _ae.gl.crafts[k];
        return { x: s.x / _ae.w, y: s.y / _ae.h, spans: _ae.dist / _aeCraftSpanRe(m), shown: !!I && I.root.visible && (I.show == null || I.show === 1),
          target: _ae.target, arrived: _ae.arrived }; }""",
        key,
    )
    return frames, end


def _on_screen(f):
    return (
        f["x"] is not None
        and 0 <= f["x"] <= VIEW["width"]
        and 0 <= f["y"] <= VIEW["height"]
    )


def _check(frames, end, key):
    flying = [f for f in frames if f["fly"]]
    assert flying, frames
    # It starts at once and holds for the model, which is late.
    assert any(f["wait"] for f in flying), "the flight did not wait for the late model"
    # Once the camera has turned to it, no frame of the flight where the target is neither its dot nor its model on the screen.
    seen = [i for i, f in enumerate(flying) if _on_screen(f)]
    assert seen, flying
    for f in flying[seen[0] :]:
        assert _on_screen(f), ("the target left the screen", f)
        assert f["mark"] or f["show"] > 0, ("neither the dot nor the model", f)
    # The model is there at the end: all of it drawn, the dot gone, in the middle, its span a few times off.
    assert end["target"] == key and end["shown"], end
    assert abs(end["x"] - 0.5) < 0.2 and abs(end["y"] - 0.5) < 0.2, end
    assert 2 <= end["spans"] <= 6, end


def test_flights_to_voyager_and_the_station_wait_for_a_late_model_and_end_on_it(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, served)
            for key in ("voyager1", "iss"):
                frames, end = _fly(pg, key)
                _check(frames, end, key)
                # Back to the Earth, then again: the model is here now and not waited for.
                pg.evaluate("_aePreset('earth')")
                pg.wait_for_function(
                    "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                    timeout=90_000,
                    polling=200,
                )
                frames, end = _fly(pg, key)
                assert not any(f["wait"] for f in frames), (
                    key,
                    "a model that was here was waited for",
                )
                assert end["shown"] and 2 <= end["spans"] <= 6, end
                pg.evaluate("_aePreset('earth')")
                pg.wait_for_function(
                    "() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }",
                    timeout=90_000,
                    polling=200,
                )
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_with_reduced_motion_it_goes_straight_to_the_model(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, served, reduced=True)
            pg.evaluate("_aePreset('voyager1')")
            # No flight at all: it waits for the model, and is there.
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); var I = _ae.gl.crafts && _ae.gl.crafts.voyager1; return !_ae.fly && _ae.target === 'voyager1' && !!I && I.root.visible; }",
                timeout=90_000,
                polling=200,
            )
            assert pg.evaluate("_ae.dist / _aeCraftSpanRe('voyager')") < 6
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
