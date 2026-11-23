"""Missions in the Almanac's Go to: the group is listed, tapping Apollo 11 starts the player at its first phase (named, timed, on its timeline),
the player stops cleanly, and the touchdown hands over to the site visit with a way back.

Run: pytest tests/test_almanac_missions_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000


def _open_mission(pw, served, mission, locale="en-US", units=None, viewport=VIEW, before=None):
    """A page on the 3D view with `mission` playing, at the phone's size (`before`: a script run first, to leave the view where a test wants it); returns (browser, page, errors)."""
    br = pw.chromium.launch(args=GL_ARGS)
    ctx = br.new_context(viewport=viewport, device_scale_factor=2, has_touch=viewport["width"] < 700, is_mobile=viewport["width"] < 700, service_workers="block", locale=locale)
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); %s } catch (e) {}"
        % (PLACE, PLACE, "localStorage.setItem('zimi_almanac_units', %r);" % units if units else "")
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
    pg.evaluate("openAlmanacEarth({ target: 'moon' })")
    pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
    if before:
        pg.evaluate(before)
        pg.wait_for_timeout(1000)
    pg.evaluate("(id) => _aeMissionStart(id)", mission)
    pg.wait_for_function("() => !!_ae.mission && !!document.getElementById('am-hud')", timeout=120_000, polling=200)
    return br, pg, errors


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("ms")
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


def test_go_to_lists_missions_and_apollo_11_starts_the_player(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(
                viewport=VIEW,
                device_scale_factor=2,
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
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
                timeout=120_000,
            )
            pg.evaluate("openAlmanacEarth({ target: 'moon' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
                timeout=READY_MS,
                polling=200,
            )
            pg.click("#ae-find")
            pg.wait_for_function(
                "() => !document.getElementById('ae-go').hidden && document.querySelectorAll('#ae-go [data-ae-go^=\"ms:\"]').length > 0",
                timeout=60_000,
            )
            keys = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-go [data-ae-go^=\"ms:\"]')).map(b => b.getAttribute('data-ae-go'))"
            )
            assert keys[:2] == ["ms:apollo11", "ms:perseverance"] and "ms:plan" not in keys, keys   # (no planner row in this release)
            # Missions are not flight targets: nothing in the sweep of bodies starts a mission.
            assert pg.evaluate("() => !('ms:apollo11' in AE_TARGETS)")
            pg.click("#ae-go [data-ae-go='ms:apollo11']")
            pg.wait_for_function(
                "() => !!_ae.mission && !!document.getElementById('am-hud')",
                timeout=120_000,
                polling=200,
            )
            hud = pg.evaluate(
                "() => ({ id: _ae.mission.id, phase: document.getElementById('am-hud').dataset.phase, met: (document.querySelector('.ae-pin .alm-ck-d') || {}).textContent, name: (_aeHudInfoPaint(true), document.querySelector('#ah-info b').textContent) })"
            )
            assert hud["id"] == "apollo11" and hud["met"] and hud["name"] == "Apollo 11", hud   # one clock (the chip's) and the mission's name in the info corner
            # The one strip carries the mission's clock in place of the date and time, and the one slider is the pace (no pace button).
            pg.wait_for_function("() => /^T[+\u2212]/.test((document.querySelector('.ae-pin .alm-ck-d') || {}).textContent || '')", timeout=30_000)
            pg.evaluate("() => _aePinSet(true)")   # the slider is in the open capsule
            assert pg.evaluate("() => !document.getElementById('am-speedbtn') && getComputedStyle(document.querySelector('.ae-pin .alm-spd')).display !== 'none'")
            # Leaving the view stops the player and gives the page its clock back.
            pg.evaluate("_amStop(false)")
            assert pg.evaluate(
                "() => !_ae.mission && !document.getElementById('am-hud')"
            )
            assert pg.evaluate("() => !/^T[+\u2212]/.test(document.querySelector('.ae-pin .alm-ck-d').textContent)"), "the date is back"

            assert errors == [], errors
        finally:
            br.close()


@pytest.mark.parametrize("mission", ["apollo11", "perseverance"])
def test_jumping_straight_into_the_touchdown_hands_over_without_an_error(served, mission):
    """Jumping a mission to its hand-off phase (the Moon's surface, Jezero's touchdown) opens the site visit with the way back, and nothing in the page throws."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
            pg.evaluate("openAlmanacEarth({ target: 'moon' })")
            pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
            pg.evaluate("(id) => _aeMissionStart(id)", mission)
            pg.wait_for_function("() => !!_ae.mission && !!document.getElementById('am-hud')", timeout=120_000, polling=200)
            # with the site code and the landmarks already in, the hand-off can run inside the frame that found the phase: the case that threw
            pg.evaluate("() => { _aeSitesLoad(); _aeLmLoad(); }")
            pg.wait_for_function("() => typeof _asData !== 'undefined' && !!_asData && !!_aeLm", timeout=120_000, polling=200)
            pg.evaluate("() => { const m = _amMission(), p = m.phases.filter(q => q.k === m.handoff.phase)[0]; _amJump(m, p.t + 5); }")
            pg.wait_for_function("() => !!_ae.site && !!document.getElementById('am-back')", timeout=120_000, polling=200)
            assert pg.evaluate("() => !_ae.mission")
            assert errors == [], errors
        finally:
            br.close()


@pytest.mark.parametrize(
    "units,locale,suffix,per_km",
    [("ft", "en-US", "mph", 1 / 1.609344), ("m", "en-GB", "km/h", 1.0)],
)
def test_the_speed_reads_in_miles_or_kilometres_an_hour_by_the_readers_units(served, units, locale, suffix, per_km):
    """The speed readout is a figure an hour (36,000 km/h reads where 10 km/s does not), in miles for a reader whose units are feet, in kilometres elsewhere; on the pad it is a walking pace, not 0.018 of a mile a second."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11", locale=locale, units=units)
        try:
            for t, lo, hi in ((-5.0, 0.0, 0.3), (3000.0, 6.0, 12.0)):   # on the pad; in the parking orbit (about 7.8 km/s)
                pg.evaluate("(t) => { const m = _amMission(); _amJump(m, t); _ae.mission.paused = true; _amSyncPlay(); }", t)
                pg.wait_for_function("(t) => _ae.mission.t !== undefined && Math.abs(_ae.mission.t - t) < 30 && !!_ae.mission.follow", arg=t, timeout=60_000, polling=200)
                pg.evaluate("() => { _ae.mission.lastText = 0; _ae.dirty = true; _aeKick(); }")
                pg.wait_for_function(   # the text follows the clock a moment behind: wait for it to catch up
                    "(a) => { const b = document.querySelector('#am-speed b'), s = _ae.mission, m = _amMission(); if (!b || !b.textContent || !s.follow) return false;"
                    " const kms = _amReadings(m, s.follow, s.t, m.phases[Math.max(0, s.phaseIdx)]).speed, num = parseFloat(b.textContent.replace(/[^0-9.]/g, ''));"
                    " _ae.dirty = true; _aeKick(); return Math.abs(num - kms * 3600 * a) <= Math.max(3, 0.02 * num); }",
                    arg=per_km,
                    timeout=60_000,
                    polling=200,
                )
                txt = pg.evaluate("() => document.querySelector('#am-speed b').textContent")
                kms = pg.evaluate("() => _amReadings(_amMission(), _ae.mission.follow, _ae.mission.t, _amMission().phases[Math.max(0, _ae.mission.phaseIdx)]).speed")
                assert suffix in txt.replace("\u202f", " ").replace("\xa0", " "), txt
                num = float("".join(c for c in txt.split(suffix)[0] if c.isdigit() or c == "."))
                assert abs(num - kms * 3600 * per_km) <= max(3.0, 0.02 * num), (txt, kms)   # the text is a moment old: a launch's speed changes in it
                assert lo <= kms <= hi, (t, kms)
            assert errors == [], errors
        finally:
            br.close()


# Every mission's strip, laid out at a moment before, at and after each of its events, and between them: what the labels do against NOW and each other.
_STRIP_JS = """() => {
  const strip = document.getElementById('am-strip'), box = strip.getBoundingClientRect(), cx = box.left + box.width / 2;
  const bad = [], seen = { samples: 0, events: 0, left: 0, right: 0 };
  for (const id of Object.keys(_amData.missions)) {
    const M = _amData.missions[id], ev = _amStripEvents(M), ts = [M.start, M.end];
    ev.forEach((e, j) => { ts.push(e.t - 0.3, e.t, e.t + 0.3); if (j + 1 < ev.length) ts.push((e.t + ev[j + 1].t) / 2); });
    strip.innerHTML = _amStripHtml(M);
    seen.events += ev.length;
    for (const t of ts) {
      _amStripTick(M, {}, t, true);
      seen.samples++;
      const now = strip.querySelector('.am-snow').getBoundingClientRect();
      const L = document.getElementById('am-slab-l'), R = document.getElementById('am-slab-r');
      const l = L.hidden ? null : L.getBoundingClientRect(), r = R.hidden ? null : R.getBoundingClientRect();
      const tag = id + ' t=' + t.toFixed(1);
      if (Math.abs(now.left + now.width / 2 - cx) > 1) bad.push(tag + ' NOW is off centre');
      if (l) { seen.left++; if (l.right > cx + 0.5 || l.left < box.left - 0.5) bad.push(tag + ' left label ' + [l.left, l.right].map(Math.round) + ' (' + L.firstChild.textContent + ')'); }
      if (r) { seen.right++; if (r.left < cx - 0.5 || r.right > box.right + 0.5) bad.push(tag + ' right label ' + [r.left, r.right].map(Math.round) + ' (' + R.firstChild.textContent + ')'); }
      if (l && r && l.right > r.left) bad.push(tag + ' labels meet');
      for (const b of [L, R]) if (!b.hidden && !b.firstChild.textContent) bad.push(tag + ' a label without words');
    }
  }
  return { bad: bad.slice(0, 12), nbad: bad.length, seen };
}"""


@pytest.mark.parametrize("viewport", [VIEW, {"width": 1280, "height": 800}], ids=["390", "1280"])
def test_the_strip_keeps_now_in_the_middle_and_its_labels_apart_for_every_event_of_every_mission(served, viewport):
    """NOW stays at the strip's centre while the events slide past it; the event just gone hangs its label to the left, the next to the right, so they never meet, and neither leaves the window; the labels' hit area is a finger's."""
    from playwright.sync_api import sync_playwright

    from hit_area import undersized

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11", viewport=viewport)
        try:
            pg.evaluate("() => { const m = _amMission(); _ae.mission.paused = true; _amJump(m, 11700); _amSyncPlay(); }")
            pg.wait_for_function("() => !!_ae.mission.follow && document.querySelectorAll('#am-strip .am-smark:not([hidden])').length > 0", timeout=60_000, polling=200)
            # NOW does not move; the marks do
            a = pg.evaluate("() => { const e = document.querySelector('.am-snow').getBoundingClientRect(); return [e.left, [...document.querySelectorAll('.am-smark:not([hidden])')].map(n => n.style.transform)]; }")
            pg.evaluate("() => { _ae.mission.paused = true; const m = _amMission(); _almClockNudge(new Date(_ae.mission.zeroMs + (11700 + 40) * 1000)); _ae.dirty = true; _aeKick(); }")
            pg.wait_for_function("(t) => Math.abs(_ae.mission.t - 11740) < 5 && document.querySelector('.am-smark:not([hidden])').style.transform !== t", arg=a[1][0], timeout=60_000, polling=200)
            b = pg.evaluate("() => { const e = document.querySelector('.am-snow').getBoundingClientRect(); return [e.left, [...document.querySelectorAll('.am-smark:not([hidden])')].map(n => n.style.transform)]; }")
            assert abs(a[0] - b[0]) < 0.5 and a[1] != b[1], (a, b)
            got = pg.evaluate(_STRIP_JS)
            assert got["nbad"] == 0, got
            assert got["seen"]["samples"] > 250 and got["seen"]["left"] > 200 and got["seen"]["right"] > 200, got
            pg.evaluate("() => { const m = _amMission(); document.getElementById('am-strip').innerHTML = _amStripHtml(m); _ae.mission.stripEl = null; _ae.mission.marksEl = null; _amStripTick(m, _ae.mission, 12000, true); }")
            small = [u for u in undersized(pg, noscroll=True) if "am-slab" in u]
            assert not small, small
            assert errors == [], errors
        finally:
            br.close()


# A coast: the camera close to the craft, looking back at where it came from, then ahead; and the pieces that come away, in the picture.
_LOOKS_JS = """() => {
  window.__looks = [];
  clearInterval(window.__samp);
  window.__samp = setInterval(() => { _ae.dirty = true; _aeKick(); const s = _ae.mission; if (s && s.pose) window.__looks.push({ look: s.pose.look.slice(), turn: !!s.turn, body: s.shotBody }); }, 16);
}"""
_COAST_STATE_JS = """() => {
  const s = _ae.mission, p = s.pose, f = s.follow;
  const dir = (b) => _aeNorm(_aeSub(_aeBodyPos(b), p.pos));
  return { body: s.shotBody, turn: !!s.turn, dist: _aeLen(_aeSub(p.pos, f.pos)) / AM_MRE, camDist: s.cam.dist, toEarth: _aeDot(p.look, dir('earth')), toMoon: _aeDot(p.look, dir('moon')), t: s.t };
}"""


def _go_to_share(pg, phase, share):
    pg.evaluate(
        "([pi, p]) => { const m = _amMission(), ph = m.phases[pi], end = _amPhaseEnd(m, pi); _ae.mission.paused = true; _amJump(m, ph.t + (end - ph.t) * p, true); _amSyncPlay(); }",
        [phase, share],
    )
    pg.wait_for_function(
        "([pi, p]) => { const m = _amMission(), ph = m.phases[pi], end = _amPhaseEnd(m, pi), s = _ae.mission; return s.follow && s.phaseIdx === pi && Math.abs(s.t - (ph.t + (end - ph.t) * p)) < (end - ph.t) * 0.01; }",
        arg=[phase, share],
        timeout=90_000,
        polling=200,
    )


def test_a_coast_stands_close_and_looks_back_then_turns_to_look_ahead(served):
    """Apollo 11's coast out: the camera stands about 120 m from the craft all the way, looks back at the Earth for the first 30 percent of the phase, then turns about the craft (over about 2 s, no cut) to look ahead at the Moon; the coast home does the same the other way. With reduced motion the turn is a cut."""
    import math

    from playwright.sync_api import sync_playwright

    def ang(a, b):
        return math.degrees(math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b))))))

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11")
        try:
            coast, home = 6, 17
            ref = pg.evaluate("() => AE_MISSION_REF")
            # reduced motion: the camera takes each shot at once, so what the shots are can be read straight off
            pg.emulate_media(reduced_motion="reduce")
            assert pg.evaluate("() => _aeReduceMotion()")
            pg.evaluate(_LOOKS_JS)
            _go_to_share(pg, coast, ref["turnShare"] - 0.02)
            pg.wait_for_function("() => _ae.mission.shotBody === 'earth'", timeout=60_000, polling=200)
            first = pg.evaluate(_COAST_STATE_JS)
            assert not first["turn"] and abs(first["dist"] - ref["coastM"]) < 0.03 * ref["coastM"], first   # the craft is large: 120 m off
            assert first["toEarth"] > 0.9, first   # looking back at where it came from
            _go_to_share(pg, coast, ref["turnShare"] + 0.02)
            pg.wait_for_function("() => _ae.mission.shotBody === 'moon'", timeout=60_000, polling=200)
            cut = pg.evaluate(_COAST_STATE_JS)
            assert not cut["turn"] and cut["toMoon"] > 0.9 and abs(cut["dist"] - ref["coastM"]) < 0.03 * ref["coastM"], cut   # a cut with reduced motion
            _go_to_share(pg, home, 0.1)
            pg.wait_for_function("() => _ae.mission.shotBody === 'moon'", timeout=60_000, polling=200)   # the coast home: the Moon behind first ...
            _go_to_share(pg, home, 0.6)
            pg.wait_for_function("() => _ae.mission.shotBody === 'earth'", timeout=60_000, polling=200)   # ... then the Earth ahead
            assert pg.evaluate(_COAST_STATE_JS)["toEarth"] > 0.9
            # with motion: the switch turns about the craft, through every direction between
            pg.emulate_media(reduced_motion="no-preference")
            assert not pg.evaluate("() => _aeReduceMotion()")
            _go_to_share(pg, coast, ref["turnShare"] - 0.05)
            pg.wait_for_function("() => _ae.mission.shotBody === 'earth'", timeout=60_000, polling=200)
            pg.evaluate("() => { window.__looks.length = 0; }")
            _go_to_share(pg, coast, ref["turnShare"] + 0.05)
            pg.wait_for_function("() => _ae.mission.shotBody === 'moon' && !_ae.mission.turn", timeout=120_000, polling=100)
            looks = pg.evaluate("() => window.__looks")
            steps = [ang(a["look"], b["look"]) for a, b in zip(looks, looks[1:])]
            assert any(k["turn"] for k in looks) and max(steps) < 45, (len(looks), max(steps))   # a turn, not a cut
            assert sum(steps) > 120, sum(steps)   # about the craft, round to the other side
            assert errors == [], errors
        finally:
            br.close()


def test_the_pieces_that_come_away_are_in_the_picture_beside_the_craft(served):
    """Apollo 11's stagings, the spacecraft's ejection and the lander's leaving: a few seconds after each, the craft and the piece it left are both on the screen."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11")
        try:
            pg.emulate_media(reduced_motion="reduce")   # the camera takes each moment's shot at once
            pg.evaluate("() => { clearInterval(window.__samp); window.__samp = setInterval(() => { _ae.dirty = true; _aeKick(); }, 30); }")
            cases = pg.evaluate(
                "() => { const m = _amMission(); return m.events.filter(e => e.icon === 'split').map(e => ({ en: e.en, t: e.t, born: m.vehicles.filter(v => v.on != null && Math.abs(v.on - e.t) < 2).map(v => v.id) })).filter(c => c.born.length); }"
            )
            assert len(cases) >= 4, cases
            for c in cases:
                pg.evaluate("(t) => { const m = _amMission(); _ae.mission.paused = true; _amJump(m, t); _amSyncPlay(); }", c["t"] + 4)
                pg.wait_for_function("(t) => _ae.mission.follow && Math.abs(_ae.mission.t - t) < 2 && _ae.mission.cam", arg=c["t"] + 4, timeout=90_000, polling=200)
                pg.wait_for_timeout(800)
                got = pg.evaluate(
                    "(born) => { const s = _ae.mission, w = _ae.w, h = _ae.h; "
                    "const inside = (p) => !!p && p.x > 0 && p.x < w && p.y > 0 && p.y < h; "
                    "const seen = (st) => !!st && [0, 8, 16, 24, 32].some(m => inside(_aeProject(_aeAdd(st.pos, _aeScale(st.fwd, m * AM_MRE))))); "
                    "return { follow: seen(s.follow), born: born.map(id => [id, seen(s.state[id])]) }; }",
                    c["born"],
                )
                assert [b for b in got["born"] if b[1]], (c, got)   # the piece that came away is on the screen
            assert errors == [], errors
        finally:
            br.close()
# A mission opens paused and its controls never hide, playing or not.
_STATE_JS = """() => {
  const vis = (id) => { const e = document.getElementById(id) || document.querySelector(id); if (!e) return null; const c = getComputedStyle(e); return c.visibility !== 'hidden' && parseFloat(c.opacity) > 0.5; };
  return { paused: !!_ae.mission.paused, bare: _aeBareOn(), controls: ['ae-back', 'ae-cam', 'am-prev', 'am-next', 'am-play', 'am-track'].map(vis), info: ['ae-clock', 'am-phase-name', 'am-speed', 'am-strip'].map(vis) };
}"""


def test_a_mission_opens_paused_and_its_controls_never_hide(served):
    """Z: a mission opens paused (the person presses play), and while it plays its controls and information stay up: no fade after a few seconds, a tap on the picture hides nothing."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11")
        try:
            st = pg.evaluate(_STATE_JS)
            assert st["paused"] and all(st["controls"]) and all(st["info"]), st
            assert pg.evaluate("() => _almRate") == 0, "paused: the clock stands"
            pg.click("#am-play")
            assert pg.evaluate("() => !_ae.mission.paused")
            pg.wait_for_timeout(4500)   # longer than the old fade
            st = pg.evaluate(_STATE_JS)
            assert not st["paused"] and all(st["controls"]) and all(st["info"]) and not st["bare"], st
            pg.touchscreen.tap(195, 380)   # a tap on the picture
            pg.wait_for_timeout(600)
            st = pg.evaluate(_STATE_JS)
            assert all(st["controls"]) and not st["bare"], st
            assert errors == [], errors
        finally:
            br.close()


def test_the_strip_is_an_arc_curving_up_and_dragging_it_holds_the_mission_then_lets_it_go(served):
    """The line's ends stand lower than the middle where NOW is; touching the line pauses the mission, dragging moves the clock by events, letting go carries on from there; the view's own time strip is there, or gone, by one constant."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11")
        try:
            pg.evaluate("() => { const m = _amMission(), s = _ae.mission; _amJump(m, 11700); s.paused = false; _amSetRate(m, s.phaseIdx < 0 ? 5 : s.phaseIdx); _amSyncPlay(); }")
            pg.wait_for_function("() => !!_ae.mission.follow && document.querySelectorAll('.am-smark:not([hidden])').length > 2", timeout=60_000, polling=200)
            ys = pg.evaluate("() => { const s = document.getElementById('am-strip').getBoundingClientRect(); const p = document.querySelector('#am-strip .am-sline path').getAttribute('d'); return { d: p, sag: AE_MISSION_REF.stripSagPx, w: s.width }; }")
            nums = [float(x) for x in ys["d"].replace("M", " ").replace("Q", " ").replace(",", " ").split()]
            assert nums[1] == nums[5] and nums[3] < nums[1] and abs((nums[1] - nums[3]) - 2 * ys["sag"]) < 0.01, ys   # ends lower than the control point; the middle sits a sag above them
            box = pg.evaluate("() => { const r = document.getElementById('am-strip').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
            x, y = box[0] + box[2] / 2 + 20, box[1] + 24
            t0 = pg.evaluate("() => _ae.mission.t")
            cdp = pg.context.new_cdp_session(pg)   # a finger, not a mouse: the strip is dragged on a phone

            def finger(kind, at=None):
                cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": at[0], "y": at[1]}] if at else []})

            finger("touchStart", (x, y))   # (wherever it lands: on the line, or on an event's name over it)
            pg.wait_for_function("() => _ae.mission.paused", timeout=5000)   # touching holds it
            for step in range(1, 7):
                finger("touchMove", (x - 20 * step, y))
                pg.wait_for_timeout(40)
            pg.wait_for_function("(t) => Math.abs(_ae.mission.t - t) > 1 && _ae.mission.paused", arg=t0, timeout=30_000, polling=100)
            t1 = pg.evaluate("() => _ae.mission.t")
            for step in range(5, -1, -1):   # and back the way it came, still held
                finger("touchMove", (x - 20 * step, y))
                pg.wait_for_timeout(40)
            pg.wait_for_function("(t) => Math.abs(_ae.mission.t - t) > 1 && _ae.mission.paused", arg=t1, timeout=30_000, polling=100)
            finger("touchEnd")
            pg.wait_for_function("() => !_ae.mission.paused", timeout=5000)   # let go: it plays on
            # the view's own time strip: under the mission's bar, or gone
            on = pg.evaluate("() => ({ pin: document.getElementById('ae-pin').offsetHeight, bar: document.querySelector('.am-dock').getBoundingClientRect().top, pinBottom: document.getElementById('ae-pin').getBoundingClientRect().bottom })")
            assert on["pin"] > 0 and on["bar"] >= on["pinBottom"] - 1, on
            pg.evaluate("() => { AE_MISSION_REF.timeStrip = false; _ae.el.classList.add('am-no-time'); _aeMeasureFoot(); }")
            assert pg.evaluate("() => document.getElementById('ae-pin').offsetHeight") == 0
            assert errors == [], errors
        finally:
            br.close()


def test_a_mission_opens_at_a_named_event_and_the_descent_offers_to_stand_at_the_site(served):
    """openAlmanacMission('apollo11', 'liftoff_moon') opens the replay a moment before the lander lifts off and it plays on (no hand-off to the site); the phase before the landing offers Stand at the site, which opens the site view."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11")
        try:
            want = pg.evaluate("() => _amMission().events.filter(e => e.k === 'alm_ms_ev_liftoff_moon')[0].t - 2")
            pg.evaluate("() => openAlmanacMission('apollo11', 'liftoff_moon')")
            pg.wait_for_function("(t) => !!_ae.mission && _ae.mission.follow && Math.abs(_ae.mission.t - t) < 30", arg=want, timeout=120_000, polling=200)
            names = pg.evaluate("() => document.getElementById('am-phase-name').textContent")
            assert names in ("Ascent", "Lunar orbit"), names
            assert pg.evaluate("() => !_ae.site && !!_ae.mission")
            # the phase before the landing: the chip, and the site view from it
            pg.evaluate("() => { _aeSitesLoad(); _aeLmLoad(); }")
            pg.wait_for_function("() => typeof _asData !== 'undefined' && !!_asData && !!_aeLm", timeout=120_000, polling=200)
            pg.evaluate("() => { const m = _amMission(), i = m.phases.findIndex(p => p.k === m.handoff.phase); _ae.mission.paused = true; _amJump(m, m.phases[i - 1].t + 5); _amSyncPlay(); }")
            pg.wait_for_selector("#am-site", timeout=60_000)
            pg.evaluate("() => document.getElementById('am-site').click()")
            pg.wait_for_function("() => !!_ae.site && !_ae.mission", timeout=120_000, polling=200)
            assert errors == [], errors
        finally:
            br.close()


def test_fast_forward_the_real_time_in_the_pill_the_list_of_steps_and_the_sea_at_splashdown(served):
    """"would like a fast forward button, time pill at the top should show the actual time of the real events in addition to the mission
    clock and our current rate of time ... have a chooser to see them listed by time and duration ... splashdown didn't drop it into the ocean"."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11")
        try:
            pill = "() => [document.querySelector('.ae-pin .alm-ck-d').textContent, document.querySelector('.ae-pin .alm-ck-t').textContent]"
            pg.wait_for_function("() => document.querySelector('.ae-pin .alm-ck-t').textContent.indexOf('UTC') >= 0", timeout=30_000)
            met, utc = pg.evaluate(pill)
            assert met.startswith("T") and "1969" in utc and "UTC" in utc, (met, utc)
            # Fast forward: plays, at ten times the phase's own pace, and the pill says the pace.
            pg.click("#am-ff")
            assert pg.evaluate("() => [_ae.mission.paused, _ae.mission.ff, _almRate === _amRateOf(_amMission(), Math.max(0, _ae.mission.phaseIdx)) * 10]") == [False, 10, True]
            pg.wait_for_function("() => document.querySelector('.ae-pin .alm-ck-d').textContent.indexOf('×') >= 0", timeout=10_000)
            pg.click("#am-ff"); pg.click("#am-ff")
            assert pg.evaluate("() => _ae.mission.ff") == 1
            # The list of steps: every phase, with its UTC start and its length; a row goes there.
            pg.click("#am-list")
            rows = pg.evaluate("() => Array.from(document.querySelectorAll('#am-steps [data-i]')).map(b => [b.querySelector('b').textContent, b.querySelector('span').textContent, b.querySelector('em').textContent])")
            assert len(rows) == pg.evaluate("() => _amMission().phases.length") and all("UTC" in r[1] and r[2] for r in rows), rows
            last = len(rows) - 1
            pg.click("#am-steps [data-i='%d']" % last)
            assert pg.evaluate("() => document.getElementById('am-steps').hidden")
            pg.wait_for_function("(i) => _ae.mission.phaseIdx === i", arg=last, timeout=30_000)
            # Splashdown: the sea stands in for the globe under the capsule, at the capsule's own level.
            pg.evaluate("() => { _ae.mission.paused = true; _amJump(_amMission(), 703140); }")
            pg.wait_for_function("() => !!_ae.mission.pad && _ae.mission.pad.group.visible", timeout=30_000)
            sea = pg.evaluate("() => { var P = _ae.mission.pad, c = P.gu.colour.value; return [c.z > c.x, !_ae.gl.earth.visible]; }")
            assert sea == [True, True], sea   # blue over red: the sea, not the Cape's ground
            assert errors == [], errors
        finally:
            br.close()


_SHOT_STATE_JS = """() => {
  setInterval(() => { _ae.dirty = true; _aeKick(); }, 16);
  return null;
}"""
_FRAMED_JS = "() => { const s = _ae.mission; return s && s.pose && s.follow ? [_aeLen(_aeSub(s.pose.pos, s.follow.pos)) / AM_MRE, s.shot.dist] : null; }"


@pytest.mark.parametrize("mission", ["voyager1", "voyager2", "apollo11"])
def test_a_mission_opens_framed_from_any_zoom(served, mission):
    """Opening a mission from the Earth zoomed far out frames its first phase as it does from the close view: the camera stands the shot's distance from the craft it follows. (Voyager's table begins hours after the launch its first phase starts at, so no craft stood anywhere and the view kept the camera where it was.)"""
    from playwright.sync_api import sync_playwright

    framed = {}
    with sync_playwright() as pw:
        for label, before in (("close", None), ("far", "() => { _ae.fly = null; _ae.dist = 60; _ae.dirty = true; _aeKick(); }")):
            br, pg, errors = _open_mission(pw, served, mission, before=before)
            try:
                pg.evaluate(_SHOT_STATE_JS)
                pg.wait_for_function("() => _ae.mission.pose && _ae.mission.follow", timeout=60_000, polling=200)
                pg.wait_for_timeout(1500)
                framed[label] = pg.evaluate(_FRAMED_JS)
                assert errors == [], errors
            finally:
                br.close()
    for label, (got, want) in framed.items():
        assert abs(got - want) < max(1.0, want * 0.05), (label, got, want)   # the camera is at the shot's distance from the craft, not still out where the person left it
    assert abs(framed["close"][0] - framed["far"][0]) < max(1.0, framed["close"][1] * 0.05), framed


def test_the_foot_row_is_one_system_on_a_phone(served):
    """The mission's foot: search, play, the pace pill and the list button are one finger tall (44 px), on one centre line, a gap (8 px) apart, with the view's side margins; the phase arrows are as tall; nothing covers a control."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _open_mission(pw, served, "apollo11")
        try:
            r = pg.evaluate(
                "() => Object.fromEntries(['ae-find', 'am-play', 'am-ff', 'am-list', 'am-prev', 'am-next'].map(id => { const b = document.getElementById(id).getBoundingClientRect(); return [id, [b.left, b.top, b.width, b.height]]; }))"
            )
            row = [r[k] for k in ("ae-find", "am-play", "am-ff", "am-list")]
            assert all(abs(b[3] - 44) < 0.6 for b in row + [r["am-prev"], r["am-next"]]), r
            assert all(abs(b[2] - 44) < 0.6 for b in (r["ae-find"], r["am-play"], r["am-list"], r["am-prev"], r["am-next"])), r
            centres = {round(b[1] + b[3] / 2, 1) for b in row}
            assert max(centres) - min(centres) < 0.6, centres
            for a, b in zip(row, row[1:3]):
                assert abs((b[0] - (a[0] + a[2])) - 8) < 0.6, (a, b)
            assert abs(r["ae-find"][0] - 12) < 0.6 and abs(VIEW["width"] - (r["am-list"][0] + r["am-list"][2]) - 12) < 0.6, r   # the back button's and the right column's margins
            covered = pg.evaluate(
                "() => ['ae-find', 'am-play', 'am-ff', 'am-list', 'am-prev', 'am-next'].filter(id => { const e = document.getElementById(id), b = e.getBoundingClientRect(); return !e.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); })"
            )
            assert covered == [], covered
            assert errors == [], errors
        finally:
            br.close()
