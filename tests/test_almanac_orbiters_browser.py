"""Hubble and Chandra in the 3D view: real craft in Earth orbit, each at its SGP4 place with its model.

They are in the Go to sheet's craft list and the Sent list, a tap on either flies to it (the model drawn, on screen, near where
SGP4 puts it), and the card says what it is and how high it is. Chandra's orbit is a long ellipse out to a third of the way to
the Moon, and the view still frames it. In headless Chromium at a phone's size.

Run: pytest tests/test_almanac_orbiters_browser.py -v
"""

import math
import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from browser_slots import WEBGL_ARGS

GL_ARGS = WEBGL_ARGS + ["--disable-accelerated-2d-canvas"]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
ORBITERS = ("hubble", "chandra")
NEAR_CENTRE = 0.2  # of the screen's width: the model stands about where the camera looks


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("orbiters")
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
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport=VIEW, device_scale_factor=1, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
                % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            pg.evaluate("() => openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && !!_aeOrbiter.hubble && !!_aeOrbiter.chandra; }",
                timeout=120_000,
                polling=300,
            )
            pg.evaluate("() => { _aeShowGo(false); _aeSentStart(); _aeTracksLoad(); _aeLmLoad(); }")
            pg.wait_for_function("() => !!_aeSent && !!_aeTracks && !!_aeLm", timeout=60_000)
            yield pg
            assert errors == []
        finally:
            br.close()


def _arrive(pg, key, pick="%s"):
    pg.evaluate("(k) => _aeGoPick(k)", pick % key)
    pg.wait_for_function(
        "(k) => { _ae.dirty = true; _aeKick(); var I = _ae.gl.crafts && _ae.gl.crafts[k]; return _ae.target === k && !_ae.fly && !!I && I.root.visible; }",
        arg=key,
        timeout=120_000,
        polling=300,
    )


def test_both_are_listed_where_a_craft_is_flown_to(page):
    got = page.evaluate(
        """() => ({
          craft: _aeGoGroups().filter(g => g[0] === 'alm_go_craft').map(g => g[1]).reduce((a, b) => a.concat(b), []),
          listed: _aeSentListedObjects().map(o => o.id),
          names: ['hubble', 'chandra'].map(_aeGoName),
          pics: ['hubble', 'chandra'].map(k => _aeGoCraftPic(k).length > 0),
          found: _aeSentFind('hubble').concat(_aeSentFind('x-ray')),
        })"""
    )
    for k in ORBITERS:
        assert k in got["craft"] and k in got["listed"], got
    assert got["names"] == ["Hubble Space Telescope", "Chandra X-ray Observatory"] and all(got["pics"]), got
    assert got["found"] == ["sent:hubble", "sent:chandra"], got
    assert "iss" in got["craft"], "the station is still there"


@pytest.mark.parametrize("key", ORBITERS)
def test_a_flight_ends_on_its_model_at_its_sgp4_place(page, key):
    _arrive(page, key)
    got = page.evaluate(
        """(k) => {
          var I = _ae.gl.crafts[k], p = I.root.position, s = _aeSatOf(k), ms = _aeDisplayMs();
          var st = _aeSatAt(s, ms, _aeEqEq(_ae.scene));
          var scr = _aeProject([p.x, p.y, p.z]);
          return { err: _aeLen(_aeSub([p.x, p.y, p.z], st.pos)) * AE_EARTH_RADIUS_KM, scr: scr && [scr.x / _ae.w, scr.y / _ae.h],
                   up: (_aeLen(st.pos) - 1) * AE_EARTH_RADIUS_KM, span: _aeCraftSpanRe(k) * AE_EARTH_RADIUS_KM * 1000,
                   dot: _aeProbeCraftDot(k), modelPx: _aeCraftPx(_aeCraftSpanRe(k), [p.x, p.y, p.z]), target: _ae.target };
        }""",
        key,
    )
    assert got["err"] < 5, ("the model stands where SGP4 puts it (km)", got)
    assert got["scr"] and abs(got["scr"][0] - 0.5) < NEAR_CENTRE and 0.1 < got["scr"][1] < 0.9, ("on screen", got)
    assert got["dot"] < 0.5 and got["modelPx"] > 100, ("the model, not the dot", got)
    assert abs(got["span"] - {"hubble": 13.3, "chandra": 19.5}[key]) < 0.5, got


def test_the_card_says_what_it_is_and_how_high(page):
    _arrive(page, "hubble")
    page.wait_for_function("() => !document.getElementById('ae-info-btn').hidden", timeout=30_000)
    page.evaluate("() => _aeOpenInfo('hubble')")
    page.wait_for_function("() => /Hubble/.test((document.getElementById('ae-info') || {}).innerText || '')", timeout=30_000)
    text = page.evaluate("() => document.getElementById('ae-info').innerText")
    for word in ("Hubble", "Height", "Speed", "Launched", "1990"):
        assert word in text, (word, text)
    said = page.evaluate("() => { var a = _aeArrival('hubble', _aeDisplayMs()); return a.fact + ' | ' + a.where; }")
    assert "up" in said, said
    height = page.evaluate("() => { var p = _aeOrbiter.hubble.pos; return (Math.hypot(p[0], p[1], p[2]) - 1) * AE_EARTH_RADIUS_KM; }")
    assert 400 < height < 650, height
    page.evaluate("() => _aeCloseInfo(true)")


def test_chandra_is_far_out_and_the_view_frames_it(page):
    _arrive(page, "chandra")
    got = page.evaluate(
        """() => { var p = _aeOrbiter.chandra.pos, r = Math.hypot(p[0], p[1], p[2]), s = _aeSatOf('chandra'), c = _ae.gl.craftRings.chandra;
          var a = 86400 / s.omm.MEAN_MOTION, speed = _aeOrbiter.chandra.speed;
          return { r: r, ring: c && c.visible, ecc: s.omm.ECCENTRICITY, speed: speed, text: document.getElementById('ae-card').innerText }; }"""
    )
    assert got["ecc"] > 0.7 and got["ring"], got
    assert 1.5 < got["r"] < 25, ("between its perigee and apogee, in Earth radii", got)
    assert "height" in page.evaluate("() => _aeInfoRows('chandra', _aeDisplayMs()).map(r => r.id)"), got


def test_the_sent_rows_go_to_them(page):
    for key in ORBITERS:
        page.evaluate("() => { _aePreset('earth'); }")
        page.wait_for_function("() => !_ae.fly", timeout=60_000, polling=300)
        _arrive(page, key, "sent:%s")
        assert page.evaluate("() => _ae.target") == key


def test_the_station_still_flies(page):
    page.evaluate("() => _aePreset('earth')")
    page.wait_for_function("() => !_ae.fly", timeout=60_000, polling=300)
    page.evaluate("() => _aeGoPick('iss')")
    page.wait_for_function("() => { _ae.dirty = true; _aeKick(); return _ae.target === 'iss' && !_ae.fly && _ae.gl.iss && _ae.gl.iss.root.visible; }", timeout=120_000, polling=300)
    assert math.isfinite(page.evaluate("() => _aeLen(_ae.issPos)"))
