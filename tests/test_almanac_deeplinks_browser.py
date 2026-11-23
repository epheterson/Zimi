"""Deep links into the Almanac's modes, in a real browser: do the thing, copy the address, open it in a fresh page, land in the
same state. One test a mode: a landing visit, a drive, and the rest as they come. The address itself (parse and format
symmetry, junk ignored) is tests/test_almanac_deeplinks.cjs.

Run one file at a time: pytest tests/test_almanac_deeplinks_browser.py -v
"""

import math
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
READY_MS = 300_000
STAND_MS = 480_000
WRITE_WAIT_TIMEOUT_MS = 30_000
MOMENT = "2031-03-05T12:34:00Z"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("almdeeplinks")
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


def _open(browser, served, hash_="#almanac"):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=1,
        service_workers="block",
        color_scheme="dark",
        timezone_id="America/Los_Angeles",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_app_theme', 'dark'); localStorage.setItem('zimi_almanac_place', %r); }"
        " catch (e) {}" % PLACE
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.logs = []
    pg.on("console", lambda m: pg.logs.append(m.text) if m.type in ("error", "warning") else None)
    pg.goto(served + "/" + hash_, wait_until="domcontentloaded")
    pg.wait_for_selector("#almanac-head-date", state="attached", timeout=60_000)
    pg.wait_for_function(
        "() => typeof _almRevealing !== 'undefined' && !_almRevealing", timeout=60_000
    )
    return ctx, pg


def _view_up(pg, body="moon"):
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function'", timeout=240_000
    )
    pg.evaluate("(b) => openAlmanacEarth({ target: b })", body)
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=READY_MS,
        polling=200,
    )
    pg.evaluate("() => { _aeLmLoad(); _aeSitesLoad(); }")
    pg.wait_for_function(
        "() => !!_aeLm && typeof _aeSiteVisit === 'function' && !!_asData", timeout=120_000
    )


def _paused_at(pg, iso):
    pg.evaluate(
        "(iso) => { _almClockSetRate(0); _almClockGoTo(new Date(iso)); }", iso
    )
    pg.wait_for_function("() => !_almEd", timeout=60_000)


def _hash_has(pg, must_have):
    pg.wait_for_function(
        "(m) => m.every(function (k) { return location.hash.indexOf(k) >= 0; })",
        arg=must_have,
        timeout=WRITE_WAIT_TIMEOUT_MS,
    )
    pg.wait_for_timeout(1200)  # the write that follows the state last changed
    return pg.evaluate("() => location.hash")


def _site_stood(pg):
    _site_stood_wait(pg)


def _site_stood_wait(pg):
    pg.wait_for_function(
        "() => { var s = typeof _aeSiteState === 'function' && _aeSiteState(); return s && s.phase === 'stand' && s.ready; }",
        timeout=STAND_MS,
        polling=500,
    )


def _display_s(pg):
    return pg.evaluate("() => Math.round(_aeDisplayMs() / 1000)")


def test_a_drive_comes_back_in_the_drivers_seat_where_the_rover_was(browser, served):
    ctx, pg = _open(browser, served)
    try:
        _paused_at(pg, MOMENT)
        _view_up(pg, "moon")
        pg.evaluate(
            "() => _aeSiteVisit('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0], true)"
        )
        _site_stood(pg)
        pg.wait_for_function("() => !!_ae.site.rover", timeout=STAND_MS)
        pg.evaluate("() => { _ae.site.input.keys.f = true; _ae.site.input.keys.l = true; }")
        for _ in range(12):
            pg.evaluate("() => _aeSiteAdvance(0.5)")
        pg.evaluate(
            "() => { var i = _ae.site.input.keys; i.f = i.l = false; _ae.site.rover.v = 0; _asViewSet(_ae.site, 2); }"
        )
        want = pg.evaluate(
            "() => ({ r: _aeSiteState().rover, seat: _ae.site.seat, s: Math.round(_aeDisplayMs() / 1000) })"
        )
        assert want["seat"] is True
        h = _hash_has(pg, ["m=drive", "v=moon", "t="])
        assert "c=" not in h, "the globe's camera is not part of a drive: " + h
    finally:
        ctx.close()

    ctx2, pg2 = _open(browser, served, h)
    try:
        _site_stood(pg2)
        pg2.wait_for_function("() => !!_aeSiteState().rover", timeout=STAND_MS)
        got = pg2.evaluate(
            "() => ({ r: _aeSiteState().rover, st: _aeSiteState(), seat: _ae.site.seat, drive: _ae.site.drive, name: _ae.site.def.name, s: Math.round(_aeDisplayMs() / 1000) })"
        )
        assert got["drive"] is True and got["name"] == "Apollo 15"
        assert got["seat"] is True, "the seat view is the camera kind"
        assert math.hypot(got["r"]["x"] - want["r"]["x"], got["r"]["y"] - want["r"]["y"]) < 1.0
        dh = (math.degrees(got["r"]["hdg"] - want["r"]["hdg"]) + 540) % 360 - 180
        assert abs(dh) < 2.0, dh
        assert got["s"] == want["s"], "the clock is the link's, to the second"
        assert not pg2.errors, pg2.errors
    finally:
        ctx2.close()


def test_a_landing_visit_comes_back_with_its_orbit_camera(browser, served):
    ctx, pg = _open(browser, served)
    try:
        _paused_at(pg, MOMENT)
        _view_up(pg, "moon")
        pg.evaluate(
            "() => _aeSiteVisit('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 11')[0], false)"
        )
        _site_stood(pg)
        pg.evaluate(
            "() => { var c = _ae.site.camera; c.az = _aeRad(70); c.el = _aeRad(33); c.dist = 21; }"
        )
        h = _hash_has(pg, ["m=site", "v=moon", "t="])
    finally:
        ctx.close()
    ctx2, pg2 = _open(browser, served, h)
    try:
        _site_stood(pg2)
        got = pg2.evaluate(
            "() => ({ name: _ae.site.def.name, drive: _ae.site.drive, c: _ae.site.camera, s: Math.round(_aeDisplayMs() / 1000) })"
        )
        assert got["name"] == "Apollo 11" and got["drive"] is False
        assert abs(math.degrees(got["c"]["az"]) - 70) < 1 and abs(math.degrees(got["c"]["el"]) - 33) < 1
        assert abs(got["c"]["dist"] - 21) < 0.1
        assert not pg2.errors, pg2.errors
    finally:
        ctx2.close()


def test_a_drive_anywhere_comes_back_at_its_spot(browser, served):
    ctx, pg = _open(browser, served)
    try:
        _paused_at(pg, MOMENT)
        _view_up(pg, "mars")
        pg.evaluate("() => _aeDriveHere('mars', -4.1234, 137.4321)")
        _site_stood(pg)
        pg.wait_for_function("() => !!_ae.site.rover", timeout=STAND_MS)
        pg.evaluate("() => { _ae.site.input.keys.f = true; }")
        for _ in range(6):
            pg.evaluate("() => _aeSiteAdvance(0.5)")
        pg.evaluate("() => { _ae.site.input.keys.f = false; _ae.site.rover.v = 0; }")
        want = pg.evaluate("() => _aeSiteState()")
        h = _hash_has(pg, ["m=drive", "v=mars", "t="])
        assert "-4.1234" in h and "137.4321" in h, h
    finally:
        ctx.close()
    ctx2, pg2 = _open(browser, served, h)
    try:
        _site_stood(pg2)
        pg2.wait_for_function("() => !!_aeSiteState().rover", timeout=STAND_MS)
        got = pg2.evaluate("() => _aeSiteState()")
        assert got["drive"] is True and got["body"] == "mars"
        assert abs(got["lat"] - -4.1234) < 1e-4 and abs(got["lon"] - 137.4321) < 1e-4
        assert math.hypot(got["rover"]["x"] - want["rover"]["x"], got["rover"]["y"] - want["rover"]["y"]) < 1.0
        assert not pg2.errors, pg2.errors
    finally:
        ctx2.close()


def test_stand_here_comes_back_facing_the_same_way_and_zoomed(browser, served):
    ctx, pg = _open(browser, served)
    try:
        _paused_at(pg, MOMENT)
        _view_up(pg, "moon")
        pg.evaluate("() => _aeStandAt('moon', 12.5, 24.25)")
        pg.wait_for_function(
            "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
            timeout=STAND_MS,
            polling=500,
        )
        pg.evaluate(
            "() => { var st = _ae.stand; st.userYaw = _aeRad(-37) - st.yaw; st.userPitch = _aeRad(14) - _aeRad(AE_STAND_PITCH_DEG); st.zoom = 0.5; st.dirty = true; }"
        )
        h = _hash_has(pg, ["m=stand", "v=moon", "t="])
    finally:
        ctx.close()
    ctx2, pg2 = _open(browser, served, h)
    try:
        pg2.wait_for_function(
            "() => _ae && _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
            timeout=STAND_MS,
            polling=500,
        )
        got = pg2.evaluate(
            "() => { var st = _ae.stand; return { lat: st.lat, lon: st.lon, head: _aeDeg(st.yaw + st.userYaw), pitch: _aeDeg(st.userPitch) + AE_STAND_PITCH_DEG, zoom: st.zoom }; }"
        )
        assert abs(got["lat"] - 12.5) < 1e-5 and abs(got["lon"] - 24.25) < 1e-5
        assert abs(((got["head"] + 37 + 540) % 360) - 180) < 0.2
        assert abs(got["pitch"] - 14) < 0.2 and abs(got["zoom"] - 0.5) < 0.002
        assert not pg2.errors, pg2.errors
    finally:
        ctx2.close()


def test_a_mission_replay_comes_back_at_its_moment_and_paused(browser, served):
    ctx, pg = _open(browser, served)
    try:
        _view_up(pg, "earth")
        pg.evaluate("() => _aeMissionStart('apollo11')")
        pg.wait_for_function(
            "() => _ae.mission && _ae.mission.t !== undefined", timeout=STAND_MS, polling=500
        )
        pg.evaluate(
            "() => { var s = _ae.mission, m = _amMission(); s.paused = true; _amJump(m, m.start + 3600); _amSyncPlay(); }"
        )
        pg.wait_for_function(
            "() => Math.abs(_ae.mission.t - (_amMission().start + 3600)) < 2", timeout=60_000
        )
        want = pg.evaluate(
            "() => ({ t: _ae.mission.t, s: Math.round(_aeDisplayMs() / 1000) })"
        )
        h = _hash_has(pg, ["m=mission", "k=apollo11,"])
    finally:
        ctx.close()
    ctx2, pg2 = _open(browser, served, h)
    try:
        pg2.wait_for_function(
            "() => _ae && _ae.mission && _ae.mission.t !== undefined", timeout=STAND_MS, polling=500
        )
        got = pg2.evaluate(
            "() => ({ id: _ae.mission.id, t: _ae.mission.t, paused: _ae.mission.paused, s: Math.round(_aeDisplayMs() / 1000) })"
        )
        assert got["id"] == "apollo11" and got["paused"] is True
        assert abs(got["t"] - want["t"]) < 1.0
        assert got["s"] == want["s"]
        assert not pg2.errors, pg2.errors
    finally:
        ctx2.close()


def test_a_selected_landmark_and_a_sent_row_come_back_with_the_sheet_closed(browser, served):
    ctx, pg = _open(browser, served)
    try:
        _view_up(pg, "moon")
        pg.evaluate("() => _aeLmOpen('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0])")
        h = _hash_has(pg, ["x=lm%3Amoon%3AApollo%2015"])
        pg.evaluate("() => { _aeSentStart(); }")
        pg.wait_for_function("() => !!_aeSent", timeout=60_000)
        sid = pg.evaluate(
            "() => _aeSent.objects.filter(o => _aeSentNow(o).go === 'body')[0].id"
        )
        pg.evaluate("(id) => _aeSentGo(AE_SENT + id)", sid)
        pg.wait_for_function("(id) => _ae.sent && _ae.sent.o.id === id", arg=sid, timeout=60_000)
        h2 = _hash_has(pg, ["x=sent%3A" + sid])
    finally:
        ctx.close()
    ctx2, pg2 = _open(browser, served, h)
    try:
        pg2.wait_for_function("() => _ae && _ae.lm && _ae.lm.row", timeout=STAND_MS, polling=500)
        assert pg2.evaluate(
            "() => [_ae.lm.body, _ae.lm.row[0], document.getElementById('ae-go').hidden]"
        ) == ["moon", "Apollo 15", True]
        assert not pg2.errors, pg2.errors
    finally:
        ctx2.close()
    ctx3, pg3 = _open(browser, served, h2)
    try:
        pg3.wait_for_function("(id) => _ae && _ae.sent && _ae.sent.o.id === id", arg=sid, timeout=STAND_MS, polling=500)
        assert pg3.evaluate("() => document.getElementById('ae-go').hidden") is True
        assert not pg3.errors, pg3.errors
    finally:
        ctx3.close()


def test_a_flight_comes_back_with_the_ship_facing_the_same_way(browser, served):
    ctx, pg = _open(browser, served)
    try:
        _paused_at(pg, MOMENT)
        _view_up(pg, "earth")
        pg.evaluate("() => enterFly()")
        pg.wait_for_function("() => !!_ae.ship", timeout=120_000)
        pg.evaluate(
            "() => { var sh = _ae.ship; _afLinkPlace([6.5, -2.25, 1.75, 0.6, 0.64, 0.48, 1]); }"
        )
        h = _hash_has(pg, ["m=fly", "v="])
        assert "c=" not in h, h
        want = pg.evaluate("() => ({ view: _ae.ship.view })")
    finally:
        ctx.close()
    ctx2, pg2 = _open(browser, served, h)
    try:
        pg2.wait_for_function("() => _ae && _ae.ship && _ae.ship.craft", timeout=STAND_MS, polling=500)
        got = pg2.evaluate("() => ({ pos: _ae.ship.pos, view: _ae.ship.view })")
        dot = sum(a * b for a, b in zip(got["view"], want["view"]))
        assert dot > math.cos(math.radians(1.0)), dot
        assert math.dist(got["pos"], [6.5, -2.25, 1.75]) < 3.0
        assert not pg2.errors, pg2.errors
    finally:
        ctx2.close()
