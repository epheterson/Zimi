"""The Almanac button on an article lands ON the thing, for every kind of thing the 3D view shows.

Each address is the one the server builds for a real Q-ID (zimi/gamelinks.py almanac_3d_links), opened as the button
opens it (a shared link's way in), and the view is checked to be on that thing: a body on the body, a mission in its
replay, the ISS followed, an Earth orbiter the satellites layer knows marked there with the camera beyond it, one it does
not on the Earth with its card, an orbiter of another world at that world, a probe followed, a lander at its site, a crash
at its spot, a landmark flown down to where the map is sharp and the whole world with it centred where it is not.

Run: pytest tests/test_almanac_view_targets_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS

# kind -> (Q-ID, the state the view must reach)
KINDS = {
    "body": ("Q111", "_ae.target === 'mars'"),
    "mission": ("Q43653", "!!_ae.mission && _ae.mission.id === 'apollo11'"),
    "iss": ("Q25271", "_ae.target === 'iss' && !_ae.fly"),
    "earth_orbiter_known": ("Q2513", "_ae.target === 'hubble' && !_ae.fly"),   # a telescope with a model: flown to, as the station is
    "earth_orbiter_unknown": ("Q49002", "_ae.target === 'chandra' && !_ae.fly"),
    "other_world_orbiter": ("Q331778", "_ae.target === 'moon' && !!_ae.sent && _ae.sent.o.id === 'lro'"),
    "probe": ("Q48546", "_ae.target === 'juno'"),
    "lander": ("Q194068", "!!_ae.lm && _ae.lm.body === 'moon' && /Apollo 15/.test(_ae.lm.row[0])"),
    "crash_spot": ("Q1042357", "!!_ae.sent && !!_ae.sent.spot && _ae.target === 'moon'"),
    "landmark_sharp": ("Q631696", "!!_ae.lm && _ae.lm.row[0] === 'Tycho' && _ae.target === 'moon' && !_ae.fly && _ae.dist < _aeClampDist(_aeBodyFitDist('moon')) * 0.9"
                       " && [...document.querySelectorAll('#ae-lms button')].some((b) => b.textContent.includes('Tycho'))"),
    "landmark_small": ("Q24060571", "!!_ae.lm && _ae.lm.row[0] === 'Vallis Krishna' && _ae.target === 'moon'"
                       " && !_ae.fly && Math.abs(_ae.dist - _aeClampDist(_aeBodyFitDist('moon'))) < 1e-6 && _aeLmSharpEnough('moon', _ae.lm.row) === false"
                       " && [...document.querySelectorAll('#ae-lms button')].some((b) => b.textContent.includes('Vallis Krishna'))"),
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("targets")
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


def test_every_kind_is_in_the_closed_set():
    from zimi import gamelinks

    links = gamelinks.almanac_3d_links()
    for kind, (qid, _) in KINDS.items():
        assert qid in links, kind


@pytest.mark.parametrize("kind", list(KINDS))
def test_the_button_lands_on_the_thing(browser, served, kind):
    from zimi import gamelinks

    qid, state = KINDS[kind]
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True,
                              service_workers="block", reduced_motion="reduce", locale="en-US")
    ctx.add_init_script("try { localStorage.setItem('zimi_cap', 'full'); } catch (e) {}")
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    try:
        pg.goto(served + "/#almanac?" + gamelinks.almanac_3d_links()[qid], wait_until="load")
        pg.wait_for_function("() => typeof _aeIsOpen !== 'undefined' && _aeIsOpen", timeout=90_000)
        try:
            pg.wait_for_function("() => { try { return " + state + "; } catch (e) { return false; } }", timeout=60_000, polling=250)
        except Exception:
            raise AssertionError((kind, pg.evaluate("() => ({ target: _ae.target, dist: _ae.dist, sent: _ae.sent && _ae.sent.o.id, lm: _ae.lm && _ae.lm.row && _ae.lm.row[0], mission: _ae.mission && _ae.mission.id, fit: _aeClampDist(_aeBodyFitDist('moon')), sharp: _ae.lm && _aeLmSharpEnough('moon', _ae.lm.row), min: AE_TARGETS.moon && AE_TARGETS.moon.min, fly: !!_ae.fly, hd: !!(_ae.gl.hd), w: _aeBaseMapW('moon', _ae.gl) })")))
        if os.environ.get("ZIMI_TARGET_SHOTS"):
            pg.wait_for_timeout(1500)
            os.makedirs(os.environ["ZIMI_TARGET_SHOTS"], exist_ok=True)
            pg.screenshot(path=os.path.join(os.environ["ZIMI_TARGET_SHOTS"], kind + ".png"))
        assert errors == [], errors
    finally:
        ctx.close()
