"""Driving a rover on the Moon and on Mars (almanac-sites.js, almanac-sites-drive.js) on a rendered page: how far it goes
for its speed, that the wheels stay on the ground, the two cameras, the speed-up, the one-thumb stick, the way back to the
lander, that the driving code is fetched only when Drive is first pressed, and that every drive control gives a finger 44 px.
Headless Chromium at a phone's size, software GL (a frame takes about a second, so the physics runs on its fixed step
through the page's own test hooks).

Run: pytest tests/test_almanac_drive_browser.py -v
"""

import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_almanac_sites_browser as base  # noqa: E402
from hit_area import undersized  # noqa: E402

base.GL_ARGS.append("--disable-accelerated-2d-canvas")
served = base.served
page = base.page

LRV_MS, MARS_MS, BOOST = 3.61, 0.042, 4
ACCEL = 5.0  # m/s^2, the drive file's AS_ACCEL


def _pose(pg):
    return pg.evaluate("() => _aeSiteState().rover")


def _hold(pg, keys, seconds):
    pg.evaluate(
        """([k, s]) => { var i = _ae.site.input.keys; ['f','b','l','r'].forEach(n => i[n] = !!k[n]); _aeSiteAdvance(s);
        ['f','b','l','r'].forEach(n => i[n] = false); }""",
        [keys, seconds],
    )


def _run_distance(pg, fast, seconds=6):
    pg.evaluate("() => { _ae.site.rover.hdg = Math.PI; }")  # south: open ground on both sites
    p0 = _pose(pg)
    pg.evaluate("(b) => { _ae.site.input.fast = b; }", fast)
    _hold(pg, {"f": 1}, seconds)
    pg.evaluate("() => { _ae.site.input.fast = false; _asTimeScale(_ae.site, false); }")
    p1 = _pose(pg)
    return math.hypot(p1["x"] - p0["x"], p1["y"] - p0["y"])


def _expected(vmax, seconds):
    return vmax * seconds - vmax * vmax / (
        2 * ACCEL
    )  # a ramp up at the acceleration, then the top speed


def test_the_driving_code_is_fetched_only_when_drive_is_first_pressed(page):
    page.evaluate(
        "() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }"
    )
    assert page.evaluate("() => typeof _asRoverStep") == "undefined"
    base._visit(page, "moon", "Apollo 15", drive=True)
    assert page.evaluate("() => typeof _asRoverStep") == "function"
    assert page.evaluate("() => typeof _asSeatLocal") == "function"


def test_the_lunar_rover_covers_the_distance_its_top_speed_allows(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    d = _run_distance(page, False)
    assert d == pytest.approx(_expected(LRV_MS, 6), rel=0.05)
    assert d < LRV_MS * 6, "never faster than the vehicle's top speed"


STICK_SPEED = "() => { var e = document.getElementById('ah-read'); return e ? e.textContent : null; }"   # the speed is the info corner's reading, bottom left


def test_pushing_further_runs_the_drive_at_x10_and_the_clock_runs_with_it_only_while_it_lasts(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _almClockSetRate(1)")
    d = _run_distance(page, False)
    assert page.evaluate("() => _almRate") == 1
    dfast = _run_distance(page, True, 6)
    assert dfast > 7 * d, "pushed further, the vehicle goes about ten times as fast"
    page.evaluate(
        "() => { var s = _ae.site; s.input.fast = true; s.input.keys.f = true; _aeSiteAdvance(3); s.speedAt = 0; _asSpeedShow(s); }"
    )
    assert page.evaluate("() => _almRate") == 10, "the universe runs at the pace the drive is sped up to (the time chip shows it)"
    shown = page.evaluate(STICK_SPEED)
    bar = page.evaluate("() => document.querySelector('.ae-pin .alm-ck-r').textContent")
    page.evaluate("() => { var s = _ae.site; s.input.fast = false; s.input.keys.f = false; _aeSiteAdvance(0.1); }")
    assert page.evaluate("() => _almRate") == 1, "the person's own pace is back the moment the speed-up ends"
    assert any(u in shown for u in ("mph", "km/h", "mi/h")), shown
    assert not any(w in shown for w in ("ft", " m ")), "one number with its unit: no heading, no distance"
    assert not any(u in bar for u in ("mph", "km/h", "mi/h")), "the speed is the chip's own reading, never the clock's rate: " + bar


def test_the_speed_is_the_time_chips_own_reading_with_no_bubble_of_its_own(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    assert page.evaluate("() => !document.getElementById('as-speed') && !document.getElementById('as-rate')")
    page.evaluate("() => { var s = _ae.site; s.speedAt = 0; _asSpeedShow(s); }")
    parked = page.evaluate(STICK_SPEED)
    assert parked.startswith("0"), parked
    page.evaluate("() => { var s = _ae.site; s.input.keys.f = true; _aeSiteAdvance(2); s.speedAt = 0; _asSpeedShow(s); s.input.keys.f = false; }")
    moving = page.evaluate(STICK_SPEED)
    assert moving != parked and not moving.startswith("0 "), (parked, moving)
    # the bar is the whole date and time, as everywhere, and the speed is a line of the info corner (no bubble of its own, nothing in the chip)
    bar = page.evaluate(
        """() => { var q = s => document.querySelector(s).getBoundingClientRect(), d = document.querySelector('.ae-pin .alm-ck-d');
        return { date: getComputedStyle(d).display !== 'none' && d.textContent.length > 4, compact: _ae.el.classList.contains('ae-strip-compact'),
          clear: document.getElementById('ah-info').contains(document.getElementById('ah-read')) && !document.getElementById('ae-clock').contains(document.getElementById('ah-read')) && !document.getElementById('as-spd') }; }"""
    )
    assert bar["date"] and not bar["compact"] and bar["clear"], bar


def test_a_held_stick_dims_the_sliders_far_ends_and_the_slider_stops_at_the_cap(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { _almStripCap(60); }")
    assert page.evaluate("() => document.querySelector('.ae-pin .alm-spd').classList.contains('alm-spd-capped')")
    page.evaluate(
        "() => { var r = document.querySelector('.ae-pin .alm-spd-range'); r.value = r.max; r.dispatchEvent(new Event('input', { bubbles: true })); }"
    )
    assert page.evaluate("() => _almRate") <= 60
    page.evaluate("() => { _almStripCap(0); _almClockSetRate(1); }")
    assert not page.evaluate("() => document.querySelector('.ae-pin .alm-spd').classList.contains('alm-spd-capped')")


def test_the_rate_cap_a_held_key_set_goes_when_the_drive_is_left(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.keyboard.down("w")
    page.wait_for_function("() => _almStripCapRate > 0", timeout=60_000, polling=100)
    page.evaluate("() => _aeSiteExit()")
    assert page.evaluate("() => _almStripCapRate") == 0
    page.keyboard.up("w")


def test_a_key_held_when_the_window_loses_focus_is_let_go(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.keyboard.down("w")
    page.wait_for_function("() => _ae.site.input.keys.f === true", timeout=60_000, polling=100)
    page.evaluate("() => window.dispatchEvent(new Event('blur'))")
    assert page.evaluate("() => !_ae.site.input.keys.f")
    page.keyboard.up("w")
    page.evaluate("() => _aeSiteExit()")


def test_tapping_the_slider_centre_is_real_pace_and_the_date_stays(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _almClockSetRate(3600)")
    t0 = page.evaluate("() => _aeDisplayMs()")
    page.evaluate("() => document.querySelector('.ae-pin .alm-spd-play').click()")
    assert page.evaluate("() => _almRate") == 1
    assert abs(page.evaluate("() => _aeDisplayMs()") - t0) < 120_000, "the instant stays where it is"
    page.evaluate("() => _almClockSetRate(1)")


def test_the_rim_lights_the_ground_dot_at_a_site_and_in_a_drive(page):
    """On the ground the lit dot is the ground one (16,16): at a site on its button, in a drive on the state the (hidden) button would show."""
    page.add_style_tag(content="*{transition:none!important}")
    base._visit(page, "moon", "Apollo 15")
    page.wait_for_function("() => document.getElementById('ae-rim').dataset.kind === 'leave'", timeout=30_000)
    site = page.evaluate("() => { var g = document.querySelector('#ae-rim .ae-rim-glyph'); return [g.classList.contains('ae-rim-ground'), getComputedStyle(g.querySelector('.ae-rim-lit')).transform]; }")
    assert site == [True, "matrix(1, 0, 0, 1, 10, 10)"], ("site: the ground dot", site)
    base._visit(page, "moon", "Apollo 15", drive=True)
    drive = page.evaluate("() => [getComputedStyle(document.getElementById('ae-rim')).display, _aeRimState().svg.indexOf('ae-rim-ground') > -1]")
    assert drive == ["flex", True], ("drive: the surface/space button stays (top right), and its state is the ground dot", drive)


def test_the_site_card_is_its_face_name_and_year_with_stand_here_and_its_rover_and_no_x(page):
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    page.evaluate("() => _aeNow()")
    page.evaluate("(b) => _aePreset(b)", "moon")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => _aeLmOpen('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0])")
    page.wait_for_function("() => !!document.getElementById('as-drive') && !!document.getElementById('as-visit')", timeout=120_000, polling=250)
    got = page.evaluate(
        """() => { var c = document.getElementById('ae-card'), d = document.getElementById('as-drive').getBoundingClientRect(), v = document.getElementById('as-visit').getBoundingClientRect(), r = c.getBoundingClientRect();
          return { text: c.innerText.replace(/\\s+/g, ' '), x: !!document.getElementById('ae-card-x'), site: !!c.querySelector('.ae-sitecard'), face: !!c.querySelector('.ae-sc-face'), h: r.height, w: r.width,
            drive: [d.width, d.height, getComputedStyle(document.getElementById('as-drive')).backgroundColor], walk: [v.width, v.height] }; }"""
    )
    assert got["site"] and got["face"] and not got["x"] and "Apollo 15" in got["text"] and "1971" in got["text"], got
    assert "Landing site" not in got["text"] and "Landed" not in got["text"], got   # no kind line, no long date
    assert got["drive"][:2] == [44, 44] and got["walk"][1] == 44 and got["walk"][0] > 44 and got["h"] <= 90, got   # See it is a word; the rover a round button
    assert "See it" in got["text"] and "Stand here" not in got["text"], got
    page.evaluate("() => { _ae.lm = null; _aeRenderCard(); }")


def test_leaving_the_drive_takes_its_chrome_with_it(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { var s = _ae.site; s.input.keys.f = true; _aeSiteAdvance(2); s.speedAt = 0; _asSpeedShow(s); s.input.keys.f = false; _asAutoGo(s, s.rover.x + 40, s.rover.y); s.autoAt = 0; _asAutoShow(s); }")
    assert page.evaluate(STICK_SPEED)
    page.evaluate("() => _aeSiteExit()")
    gone = page.evaluate(
        "() => ['as-stick', 'as-rest'].map(i => { var e = document.getElementById(i); return !e || (e.hidden && !e.textContent); }).concat(['ah-read', 'ah-sub'].map(i => !document.getElementById(i).textContent)).concat([!document.getElementById('as-hud').classList.contains('as-driving')])"
    )
    assert all(gone), gone


def test_a_tap_on_the_vehicle_is_a_wheelie(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    at = page.evaluate(
        "() => { var s = _ae.site, r = s.rover, p = _aeProject(_asToWorld(s.fr, [r.x, r.y, r.z + AS_WHEEL_TAP_Z_M])); return p ? [p.x, p.y] : null; }"
    )
    if at is None:
        pytest.skip("the vehicle is off the picture")
    page.evaluate("(a) => { var l = document.getElementById('as-layer'); _asAutoTap(_ae.site, a[0], a[1], l.clientWidth, l.clientHeight); }", at)
    assert page.evaluate("() => _ae.site.input.wheelie") is True
    assert page.evaluate("() => _aeSiteState().auto") is None, "and not a destination"


def test_the_stick_has_two_rings_and_the_far_one_is_amber(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    cdp = page.context.new_cdp_session(page)
    _fingers(cdp, "touchStart", (1, 120, 700))
    _fingers(cdp, "touchMove", (1, 120, 700 - 30))
    _until(page, "_ae.site.input.sy > 0.3")
    assert page.evaluate("() => _ae.site.input.fast") is False
    _fingers(cdp, "touchMove", (1, 120, 700 - 100))
    _until(page, "_ae.site.input.fast === true")
    assert page.evaluate("() => document.getElementById('as-stick').classList.contains('as-fast')")
    _fingers(cdp, "touchEnd")
    _until(page, "_ae.site.input.fast === false && _ae.site.input.sy === 0")
    assert not page.evaluate("() => document.getElementById('as-stick').classList.contains('as-fast')")


def test_driving_shows_the_stick_the_camera_the_rim_and_the_strip_and_nothing_else(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.wait_for_timeout(600)
    seen = page.evaluate(
        """() => Array.from(document.querySelectorAll('#ae-view button')).filter(b => {
          var r = b.getBoundingClientRect(), c = getComputedStyle(b);
          if (b.closest('.ae-pin')) return false;
          for (var p = b; p && p.id !== 'ae-view'; p = p.parentElement) { var s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.1) return false; }
          return r.width > 2 && r.height > 2 && c.display !== 'none'; }).map(b => b.id || b.className)"""
    )
    assert sorted(seen) == ["ae-back", "ae-find", "ae-fly-btn", "ae-rim", "as-menu-btn"], seen   # the way out, search, the always-there UFO (80524a4a) and the surface/space button in their corners, and the one drive button
    assert page.evaluate("() => getComputedStyle(document.querySelector('.as-strip') || document.body).display") == "none" or not page.evaluate("() => !!document.querySelector('.as-strip')")
    # The drive's button is a small disc of the controls layer: 44 px, on the small discs' line just above the corner's foot (the
    # way back to space), in its column.
    r = page.evaluate(
        """() => { var b = document.getElementById('as-menu-btn').getBoundingClientRect(), f = document.getElementById('ae-rim').getBoundingClientRect();
          return [b.width, b.height, f.top - b.bottom, (b.left + b.right) / 2 - (f.left + f.right) / 2, f.width, innerWidth - f.right, innerHeight - f.bottom]; }"""
    )
    assert r == [44, 44, 16, 0, 44, 12, 12], ("a 44 px disc over the corner foot, one band gap above it, in its column", r)


def test_one_ring_at_a_time_the_parked_ring_gives_way_to_the_thumbs(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    assert page.evaluate("() => +getComputedStyle(document.getElementById('as-rest')).opacity") > 0.3
    cdp = page.context.new_cdp_session(page)
    _fingers(cdp, "touchStart", (1, 200, 700))
    _until(page, "!document.getElementById('as-stick').hidden")
    page.wait_for_timeout(400)
    assert page.evaluate("() => +getComputedStyle(document.getElementById('as-rest')).opacity") == 0
    _fingers(cdp, "touchEnd")
    _until(page, "document.getElementById('as-stick').hidden")
    assert page.evaluate("() => +getComputedStyle(document.getElementById('as-rest')).opacity") > 0.3


def test_the_landing_cards_stand_here_is_the_amber_one_and_the_rover_only_where_its_mission_had_one(page):
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); var c = document.getElementById('as-css'); if (c) c.remove(); }")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => _aeLmOpen('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0])")
    page.wait_for_function("() => !!document.getElementById('as-drive')", timeout=120_000, polling=250)
    box = page.evaluate("() => { var b = document.getElementById('as-visit'), d = document.getElementById('as-drive'), c = getComputedStyle(b); return [c.height, c.backgroundColor, b.textContent, d.getAttribute('aria-label'), getComputedStyle(d).backgroundColor]; }")
    assert box[:3] == ["44px", "rgb(245, 158, 11)", "See it"] and box[3] == "Drive a rover here" and box[4] != box[1], box   # amber, the primary verb, a word; the rover quiet beside it
    # Apollo 11 had no rover: its card is See it alone ("that horrible cone thing and rover icon").
    page.evaluate("() => _aeLmOpen('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 11')[0])")
    page.wait_for_function("() => !!document.getElementById('as-visit')", timeout=120_000, polling=250)
    assert page.evaluate("() => !document.getElementById('as-drive')")


def test_the_sites_own_bar_stands_below_the_header_and_the_strip(page):
    base._visit(page, "moon", "Apollo 15")
    page.wait_for_timeout(800)
    gap = page.evaluate("() => document.querySelector('.as-tools .ae-btn:not([hidden])').getBoundingClientRect().top - document.getElementById('ae-pin').getBoundingClientRect().bottom")
    assert gap >= 0, gap


def test_hiding_the_controls_only_fades_them_in_a_drive_and_the_picture_does_not_move(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.wait_for_timeout(600)
    frame = """() => { var c = document.getElementById('ae-canvas').getBoundingClientRect(), v = document.getElementById('ae-view').getBoundingClientRect(), b = document.querySelector('.topbar').getBoundingClientRect();
      return { canvas: [c.left, c.top, c.width, c.height], view: [v.left, v.top, v.width, v.height], bar: [b.top, b.height], body: document.body.getBoundingClientRect().top }; }"""
    before = page.evaluate(frame)
    page.evaluate("() => _aeBare(true)")
    page.wait_for_function("() => !_ae.el.classList.contains('ae-bare-anim') && ['as-menu-btn', 'ae-pin', 'as-rest'].every(i => getComputedStyle(document.getElementById(i)).visibility === 'hidden')", timeout=60_000, polling=200)
    after = page.evaluate(frame)
    assert after == before, (before, after)
    faded = page.evaluate(
        """() => ['as-menu-btn', 'as-rest'].map(id => { var c = getComputedStyle(document.getElementById(id)); return [id, c.display !== 'none', c.visibility, +c.opacity]; })
          .concat([['pin', true, getComputedStyle(document.getElementById('ae-pin')).visibility, +getComputedStyle(document.getElementById('ae-pin')).opacity]])"""
    )
    assert all(d and v == "hidden" and o == 0 for _, d, v, o in faded), faded   # faded, never display:none
    page.evaluate("() => _aeBare(false)")
    page.wait_for_function("() => !_ae.el.classList.contains('ae-bare-anim') && ['as-menu-btn', 'ae-pin', 'as-rest'].every(i => getComputedStyle(document.getElementById(i)).visibility === 'visible')", timeout=60_000, polling=200)
    assert page.evaluate(frame) == before


INSIDE = """() => {
  var vw = innerWidth, vh = innerHeight, out = [];
  Array.prototype.forEach.call(document.querySelectorAll('#ae-view button, #ae-view .alm-spd-range, #ae-view input'), function (b) {
    var r = b.getBoundingClientRect(), skip = r.width < 2 || r.height < 2;
    for (var p = b; p && p.id !== 'ae-view' && !skip; p = p.parentElement) { var s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.1) skip = true; }
    if (skip) return;
    if (b.closest('.ae-go, .ae-set, .ae-info, .ae-card, .ae-hd-card, .as-strip')) return;   // sheets stand off the screen until they are called
    if (b.closest('#ae-chips') && b.closest('#ae-chips').getBoundingClientRect().right <= vw + 1 && b.closest('#ae-chips').getBoundingClientRect().bottom <= vh + 1) return;   // the strip scrolls: its own box is what must be inside
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) out.push([b.id || b.className || b.tagName, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]);
  });
  return out;
}"""


def test_every_visible_3d_control_is_inside_the_viewport_in_every_mode(page):
    """A round button given a position by a shared rule would leave the corner it is placed in: look, a site, driving, a mission and flight each keep every control on the screen."""
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.wait_for_timeout(500)
    assert page.evaluate(INSIDE) == [], "look"
    base._visit(page, "moon", "Apollo 15")
    page.wait_for_timeout(800)
    assert page.evaluate(INSIDE) == [], "site"
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.wait_for_timeout(800)
    assert page.evaluate(INSIDE) == [], "drive"
    page.evaluate("() => { _aeSiteLeave(true); _aePreset('moon'); }")
    page.evaluate("() => _aeMissionStart('apollo11')")
    page.wait_for_function("() => !!_ae.mission && !!document.getElementById('am-hud')", timeout=120_000, polling=200)
    page.wait_for_timeout(800)
    assert page.evaluate(INSIDE) == [], "mission"
    page.evaluate("() => _amStop(false)")
    page.evaluate("() => _aePreset('earth')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => enterFly()")
    page.wait_for_function("() => !!_ae.ship", timeout=300_000, polling=250)
    page.wait_for_timeout(800)
    assert page.evaluate(INSIDE) == [], "fly"
    page.evaluate("() => _afStop()")
    page.evaluate("() => _aeLetGo()")   # (leaving the ship holds the picture until a hand lets it go)
    page.wait_for_function("() => !_ae.ship && !_ae.shipExit && !_ae.fly", timeout=60_000, polling=250)   # the chase view's ease into the orbit view is done: the next test starts still


HELD_JS = """([lat, lon, steps, stepMs]) => {
  var t0 = _aeDisplayMs(), out = [];
  for (var i = 0; i <= steps; i++) {
    if (i) _aeGoTo(t0 + i * stepMs);
    _aeUpdate(_aeDisplayMs());
    var sc = _aeSceneAt(_aeDisplayMs()), p = _aeProject(_aeFixedToScene(_aeGeodeticToFixed(lat, lon), sc.gast));
    out.push([p.x, p.y]);
  }
  return out;
}"""


def test_a_held_you_stays_still_on_the_screen_while_the_clock_turns_the_planet(page):
    """With You shown the camera turns with the planet: over ten seconds at x1000 the point moves under 2 px; without it the planet turns it away."""
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); _almClockSetRate(1); }")
    page.evaluate("() => _aeLetGo()")   # (leaving the ship holds the picture until a hand lets it go)
    page.wait_for_function("() => !_ae.ship && !_ae.shipExit && !_ae.hand", timeout=60_000, polling=250)
    page.evaluate("() => _aePreset('earth')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => { _ae.you = null; _ae.pick = null; _ae.dist = Math.max(_ae.dist, 3.5); _aeUpdate(_aeDisplayMs()); }")
    spot = page.evaluate("() => { var sc = _aeSceneAt(_aeDisplayMs()); return [_aeDeg(_ae.el_), _aeDeg(_ae.az) - _aeDeg(sc.gast)]; }")
    free = page.evaluate(HELD_JS, [spot[0], spot[1], 10, 1_000_000])
    drift = max(abs(p[0] - free[0][0]) + abs(p[1] - free[0][1]) for p in free)
    assert drift > 20, "the planet turns the point away when nothing is held: %s" % drift
    page.evaluate("() => _aeGoTo(_aeDisplayMs() - 10 * 1000000)")
    page.evaluate("(s) => { _ae.you = { lat: s[0], lon: s[1] }; _aeUpdate(_aeDisplayMs()); }", spot)
    held = page.evaluate(HELD_JS, [spot[0], spot[1], 10, 1_000_000])
    drift = max(abs(p[0] - held[0][0]) + abs(p[1] - held[0][1]) for p in held)
    assert drift < 2, "a held You stays where it is: %s" % drift
    page.evaluate("() => { _ae.you = null; _aeUpdate(_aeDisplayMs()); }")


def test_the_tap_ring_goes_when_its_pick_does(page):
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => _aeStandReady()")
    page.evaluate("() => { var h = _aeStHit('moon', _ae.w / 2, _ae.h / 2); _ae.pick = { body: 'moon', lat: h.lat, lon: h.lon }; _aeStandMarkPick(); _aeUpdate(_aeDisplayMs()); }")
    assert not page.evaluate("() => document.getElementById('ae-pick').hidden"), "the ring is up on the tapped spot"
    page.evaluate("() => { _ae.pick = null; _ae.dirty = true; _aeDraw(performance.now()); }")   # cleared by any path but its own close button
    assert page.evaluate("() => document.getElementById('ae-pick').hidden"), "and goes with it"


def test_a_held_point_stays_put_when_the_controls_are_hidden_by_a_tap_but_a_drag_lets_it_go(page):
    """The tap on empty space that hides the controls is a press: it must not free the held You or tapped point."""
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); _almClockSetRate(1); }")
    page.evaluate("() => _aeLetGo()")   # (leaving the ship holds the picture until a hand lets it go)
    page.wait_for_function("() => !_ae.ship && !_ae.shipExit && !_ae.hand", timeout=60_000, polling=250)
    page.evaluate("() => _aePreset('earth')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => { _ae.you = null; _ae.pick = null; _ae.dist = Math.max(_ae.dist, 3.5); _aeUpdate(_aeDisplayMs()); }")
    spot = page.evaluate("() => { var sc = _aeSceneAt(_aeDisplayMs()); return [_aeDeg(_ae.el_), _aeDeg(_ae.az) - _aeDeg(sc.gast)]; }")
    page.evaluate("(s) => { _ae.you = { lat: s[0], lon: s[1] }; _aeUpdate(_aeDisplayMs()); }", spot)
    # a press with no movement (what hides the controls) while the clock runs
    page.evaluate("() => { _ae.drag = { x: 5, y: 5, x0: 5, y0: 5, moved: false }; _aeUpdate(_aeDisplayMs()); _ae.drag = null; _aeBare(true); }")
    held = page.evaluate(HELD_JS, [spot[0], spot[1], 10, 1_000_000])
    drift = max(abs(p[0] - held[0][0]) + abs(p[1] - held[0][1]) for p in held)
    assert drift < 2, "hiding the controls kept the held point where it was: %s" % drift
    page.evaluate("() => { _aeBare(false); _ae.drag = { x: 5, y: 5, x0: 5, y0: 5, moved: true }; _aeUpdate(_aeDisplayMs()); _ae.drag = null; }")
    page.evaluate("() => _aeGoTo(_aeDisplayMs() - 10 * 1000000)")
    free = page.evaluate(HELD_JS, [spot[0], spot[1], 10, 1_000_000])
    assert max(abs(p[0] - free[0][0]) + abs(p[1] - free[0][1]) for p in free) > 20, "a real drag lets it go"
    page.evaluate("() => { _ae.you = null; _aeUpdate(_aeDisplayMs()); }")


def test_a_tapped_spot_and_its_ring_do_not_outlive_leaving_the_globe_by_any_path(page):
    """Tap a point, then go into a visit and out again: no pick and no orange ring is left (closing the view is _aeFinishClose's, not exercised here: the page is shared)."""
    ring_gone = "() => { var r = document.getElementById('ae-pick'); return !_ae.pick && (!r || r.hidden); }"
    tap = "() => { var h = _aeStHit('moon', _ae.w / 2, _ae.h / 2); _ae.pick = { body: 'moon', lat: h.lat, lon: h.lon }; _aeStandMarkPick(); _aeUpdate(_aeDisplayMs()); }"
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => _aeStandReady()")
    page.evaluate(tap)
    assert not page.evaluate("() => document.getElementById('ae-pick').hidden")
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { _aeSiteLeave(true); _aePreset('moon'); }")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.wait_for_function(ring_gone, timeout=30_000)



def test_the_mars_rover_drives_in_mars_gravity_and_keeps_to_the_ground(page):
    base._visit(page, "mars", "Perseverance", drive=True)
    assert page.evaluate("() => _ae.site.info.g") == pytest.approx(3.71, abs=0.01)
    d = _run_distance(page, False)
    assert d == pytest.approx(_expected(MARS_MS, 6), rel=0.05)
    r = _pose(page)
    assert all(abs(w["z"] - w["ground"] - 0.263) < 1e-3 for w in r["wheels"])


@pytest.mark.parametrize("body,site,eye_m", [("moon", "Apollo 15", 2.4), ("mars", "Perseverance", 2.1)])
def test_three_views_by_name_in_the_drive_menu(page, body, site, eye_m):
    base._visit(page, body, site, drive=True)

    def eye():
        return page.evaluate(
            """() => { var st = _ae.site, c = _asCameraLocal(st, 0.016), r = st.rover;
              return { d: Math.hypot(c.pos[0] - r.x, c.pos[1] - r.y), h: c.pos[2] - r.z, view: st.view, seat: st.seat }; }"""
        )

    def pick(i):
        page.click("#as-menu-btn", timeout=240_000)
        assert page.evaluate("() => !document.getElementById('as-menu').hidden")
        page.click("#as-menu [data-as-view='%d']" % i, timeout=240_000)
        assert page.evaluate("() => document.getElementById('as-menu').hidden"), "choosing closes it"

    wide = eye()
    assert wide["view"] == 0 and not wide["seat"] and wide["d"] > 10, "it opens in the wide chase"
    page.click("#as-menu-btn", timeout=240_000)
    names = page.evaluate("() => Array.from(document.querySelectorAll('#as-menu [data-as-view]')).filter(b => !b.hidden).map(b => [b.textContent, b.getAttribute('aria-checked')])")
    assert names == [["Wide", "true"], ["Near", "false"], ["Seat", "false"]], names
    page.keyboard.press("Escape")
    pick(1)
    near = eye()
    assert near["view"] == 1 and 4 < near["d"] < wide["d"] - 3, "the near chase, closer"
    pick(2)
    seat = eye()
    assert seat["view"] == 2 and seat["seat"] and seat["d"] < 1.5 and abs(seat["h"] - eye_m) < 0.2
    pick(0)
    assert eye()["view"] == 0, "and wide again"


def test_the_drive_menu_closes_by_a_tap_outside_and_walks_or_zooms_out(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.click("#as-menu-btn", timeout=240_000)
    page.mouse.click(120, 300)
    assert page.evaluate("() => document.getElementById('as-menu').hidden"), "a tap outside puts it away"
    page.click("#as-menu-btn", timeout=240_000)
    page.click("#as-menu [data-as-go=out]", timeout=240_000)
    page.wait_for_function("() => !_ae.site", timeout=120_000, polling=250)
    assert page.evaluate("() => _ae.target") == "moon", "zoomed back out to the body"
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.click("#as-menu-btn", timeout=240_000)
    page.evaluate("() => { var r = _ae.site.rover; r.hdg = 0.6; window.__orbitMoved = false; var d0 = _ae.dist; (function s() { if (_ae.fly || Math.abs(_ae.dist - d0) > 1e-9) window.__orbitMoved = true; if (!(_ae.stand && _ae.stand.live)) requestAnimationFrame(s); })(); }")
    page.click("#as-menu [data-as-go=walk]", timeout=240_000)
    # Walk around: out of the seat onto the same ground beside it, facing where the rover faced; the rover stays
    page.wait_for_function("() => _ae.site && _ae.site.outOf && _ae.site.eye && _ae.site.eye.on && _ae.site.phase === 'stand'", timeout=240_000, polling=250)
    got = page.evaluate("() => ({ moved: window.__orbitMoved, rover: !!_ae.site.rover, yaw: ((_ae.site.eye.yaw) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) })")
    assert not got["moved"], "walking from the rover goes down no trip to orbit and back"
    assert got["rover"], "the rover stays where it stopped"
    assert got["yaw"] == pytest.approx((-0.6) % (2 * 3.141592653589793), abs=0.02), "and the walker faces where the rover faced"
    page.evaluate("() => _aeSiteLeave(true)")


def test_the_seat_looks_where_the_rover_heads_and_a_drag_turns_the_head(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _asViewSet(_ae.site, 2)")

    def bearing():
        return page.evaluate(
            """() => { var st = _ae.site, c = _asCameraLocal(st, 0.016), dx = c.focus[0] - c.pos[0], dy = c.focus[1] - c.pos[1];
              return { b: Math.atan2(-dx, dy), hdg: st.rover.hdg }; }"""
        )

    a = bearing()
    assert a["b"] == pytest.approx(a["hdg"], abs=0.02)
    _hold(page, {"f": 1, "l": 1}, 1.0)
    a = bearing()
    assert a["b"] == pytest.approx(a["hdg"], abs=0.1), "the view turns with the vehicle"
    page.evaluate(
        "() => { _ae.site.look.yaw = 0.8; _ae.site.look.touched = performance.now(); }"
    )
    assert abs(bearing()["b"] - a["hdg"]) > 0.5, "a drag looks aside"


def _touch(cdp, kind, x, y):
    pts = [] if kind == "touchEnd" else [{"x": x, "y": y, "id": 1}]
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": pts})


def _until(pg, expr, ms=120_000):
    """A touch reaches the page after the frame in flight (a software renderer's frame is seconds): wait for what it sets."""
    pg.wait_for_function("() => " + expr, timeout=ms, polling=200)


def test_one_thumb_on_the_lower_half_is_the_stick_and_letting_go_brakes(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    cdp = page.context.new_cdp_session(page)
    p0 = _pose(page)
    _touch(cdp, "touchStart", 250, 640)  # the lower RIGHT half is the stick too
    _touch(cdp, "touchMove", 250, 570)
    _until(page, "_ae.site.input.sy > 0.9 && Math.abs(_ae.site.input.sx) < 0.1")
    page.evaluate("() => _aeSiteAdvance(3)")
    p1 = _pose(page)
    assert math.hypot(p1["x"] - p0["x"], p1["y"] - p0["y"]) > 5
    _touch(cdp, "touchMove", 310, 640)
    _until(page, "_ae.site.input.sx > 0.5")  # sideways steers
    _touch(cdp, "touchEnd", 0, 0)
    _until(page, "_ae.site.input.sy === 0 && _ae.site.input.sx === 0")
    page.evaluate("() => _aeSiteAdvance(3)")
    assert abs(_pose(page)["v"]) < 0.01, "released, it has stopped"
    # a press on the upper half is the head, not the stick
    _touch(cdp, "touchStart", 200, 200)
    _touch(cdp, "touchMove", 200, 160)
    _until(page, "_ae.site.look.pitch !== 0")
    assert page.evaluate("() => _ae.site.input.sy") == 0
    _touch(cdp, "touchEnd", 0, 0)


def test_the_ground_follows_far_from_the_lander(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { _ae.site.input.fast = true; }")
    _hold(page, {"f": 1}, 40)
    page.evaluate("() => { _ae.site.input.fast = false; _aeSiteAdvance(1); }")
    r = _pose(page)
    assert math.hypot(r["x"], r["y"]) > 300
    assert all(
        abs(w["z"] - w["ground"] - 0.41) < 1e-3 for w in r["wheels"]
    ), "still on drawn ground, no void"


def _get_in(pg):
    """Called up where one stands, the rover falls in from over the top of the picture and, once down, one drives it with the picture as it was."""
    pg.wait_for_function("() => _ae.site && _ae.site.rover && !_ae.site.rover.airborne && _ae.site.drive && _ae.site.phase === 'stand'", timeout=base.STAND_MS, polling=250)


def _drive_from_stand(pg, body, lat, lon):
    pg.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    pg.evaluate("(b) => _aePreset(b)", body)
    pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=250)
    pg.evaluate("([b, la, lo]) => _aeStandAt(b, la, lo)", [body, lat, lon])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground' && !!document.getElementById('ae-stand-drive')",
        timeout=base.STAND_MS,
        polling=500,
    )
    pg.evaluate("() => document.getElementById('ae-stand-drive').click()")
    _get_in(pg)
    pg.wait_for_function(
        "() => { var s = typeof _aeSiteState === 'function' && _aeSiteState(); return s && s.drive && s.phase === 'stand' && s.ready && s.rover; }",
        timeout=base.STAND_MS,
        polling=500,
    )
    return pg.evaluate("() => _aeSiteState()")


@pytest.mark.parametrize(
    "body,lat,lon,gravity,vehicle,hub",
    [("moon", 12.0, 21.0, 1.62, "lrv-body", 0.41), ("titan", -10.6, 192.3, 1.35, "perseverance-body", 0.263)],
)
def test_drive_from_stand_here_puts_the_rover_of_its_kind_on_that_ground(page, body, lat, lon, gravity, vehicle, hub):
    st = _drive_from_stand(page, body, lat, lon)
    assert abs(st["lat"] - lat) < 1e-6 and abs(st["lon"] - lon) < 1e-6
    assert page.evaluate("() => _ae.site.info.rover.body") == vehicle
    assert page.evaluate("() => _ae.site.info.g") == pytest.approx(gravity, abs=0.01)
    d = _run_distance(page, False)
    vmax = page.evaluate("() => _ae.site.info.rover.vmax")
    assert d == pytest.approx(_expected(vmax, 6), rel=0.05)
    r = _pose(page)
    assert all(abs(w["z"] - w["ground"] - hub) < 1e-3 for w in r["wheels"])
    page.evaluate("() => _aeSiteLeave(true)")


def test_a_gas_giant_has_no_drive_control(page):
    for body in ("jupiter", "saturn", "uranus", "neptune"):
        assert page.evaluate("(b) => AE_DRIVE_BODIES.indexOf(b) < 0 && !_aeStandable(b)", body)


def test_reduced_motion_keeps_the_seat_level(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    tilt = """(rm) => { var st = _ae.site, was = _aeReduceMotion; _aeReduceMotion = () => rm; st.rover.pitch = 0.2; st.seatTilt = 0;
      for (var i = 0; i < 200; i++) _asSeatLocal(st, 0.016); _aeReduceMotion = was; st.rover.pitch = 0; return st.seatTilt; }"""
    assert page.evaluate(tilt, True) == 0
    assert page.evaluate(tilt, False) > 0.1, "the slope tips the view a little otherwise"


def test_the_clock_keeps_running_while_driving_and_the_sun_moves(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    z0 = page.evaluate("() => _aeSiteState().sunZ")
    page.evaluate("() => _aeGoTo(_aeDisplayMs() + 5 * 86400000)")
    _hold(page, {"f": 1}, 2)
    page.wait_for_function("(z) => Math.abs(_aeSiteState().sunZ - z) > 0.01", arg=z0, timeout=120_000, polling=250)


@pytest.mark.parametrize(
    "keys,what",
    [(["w"], "fwd"), (["s"], "back"), (["a"], "left"), (["d"], "right"), (["w", "a"], "left"), (["w", "d"], "right")],
)
def test_wasd_each_move_without_a_click_on_the_canvas(page, keys, what):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { document.activeElement && document.activeElement.blur(); }")
    p0 = _pose(page)
    for k in keys:
        page.keyboard.down(k)
    page.wait_for_function("() => Object.values(_ae.site.input.keys).some(Boolean)", timeout=60_000, polling=100)
    page.evaluate("() => _aeSiteAdvance(2)")
    for k in keys:
        page.keyboard.up(k)
    p1 = _pose(page)
    ahead = -(p1["x"] - p0["x"]) * math.sin(p0["hdg"]) + (p1["y"] - p0["y"]) * math.cos(p0["hdg"])
    if what == "fwd":
        assert ahead > 3
    elif what == "back":
        assert ahead < -1
    else:
        assert (p1["hdg"] - p0["hdg"]) * (1 if what == "left" else -1) > 0.2, "%s turns %s" % (keys, what)
    page.wait_for_function("() => !Object.values(_ae.site.input.keys).some(Boolean)", timeout=60_000, polling=100)


@pytest.mark.parametrize("key,what", [("ArrowUp", "fwd"), ("ArrowDown", "back"), ("ArrowLeft", "left"), ("ArrowRight", "right")])
def test_the_arrows_mirror_wasd(page, key, what):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { _ae.site.rover.hdg = Math.PI; }")
    p0 = _pose(page)
    page.keyboard.down(key)
    page.wait_for_function("() => Object.values(_ae.site.input.keys).some(Boolean)", timeout=60_000, polling=100)
    page.evaluate("() => _aeSiteAdvance(2)")
    page.keyboard.up(key)
    p1 = _pose(page)
    ahead = -(p1["x"] - p0["x"]) * math.sin(p0["hdg"]) + (p1["y"] - p0["y"]) * math.cos(p0["hdg"])
    if what == "fwd":
        assert ahead > 3
    elif what == "back":
        assert ahead < -1
    else:
        assert (p1["hdg"] - p0["hdg"]) * (1 if what == "left" else -1) > 0.2, "%s turns %s" % (key, what)


def test_space_is_a_wheelie_e_is_nothing_and_v_and_escape_work(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.keyboard.press("e")
    page.evaluate("() => new Promise(r => setTimeout(r, 200))")
    assert page.evaluate("() => _ae.site.input.wheelie") is False and not page.evaluate("() => _aeSiteState().rover.airborne"), "E is not a hop any more"
    before = page.evaluate("() => _ae.site.rover.pitch")
    p0 = _pose(page)
    page.keyboard.press(" ")
    page.wait_for_function("() => !!_ae.site.rover.wheelie", timeout=60_000, polling=50)   # the wheelie starts
    page.evaluate("() => { const s = _ae.site; s.rover.wheelie = performance.now() - AS_WHEELIE_MS / 2; _aeSiteAdvance(0.05); }")   # its peak
    peak = page.evaluate("() => _ae.site.rover.body ? _ae.site.rover.body.holder.rotation.x : null")
    assert peak is not None and peak > before + 0.3, (peak, before)  # the nose comes up
    page.evaluate("() => { _ae.site.rover.wheelie = performance.now() - AS_WHEELIE_MS * 0.7; }")
    page.evaluate("() => { const r = _ae.site.rover; r.wheelie = performance.now() - AS_WHEELIE_MS * 0.4; _aeSiteAdvance(0.5); }")
    p1 = _pose(page)
    assert math.hypot(p1["x"] - p0["x"], p1["y"] - p0["y"]) > 0.02, "and it lurches forward a little"
    assert not page.evaluate("() => _aeSiteState().rover.airborne"), "it stays on the ground"
    seat = page.evaluate("() => _ae.site.view || 0")
    page.keyboard.press("v")
    assert page.evaluate("() => _ae.site.view || 0") != seat, "V swaps the camera"
    page.keyboard.press("Escape")
    page.wait_for_function("() => !_ae.site", timeout=60_000, polling=200)


def test_keys_do_not_drive_while_a_text_field_has_focus(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { var i = document.createElement('input'); i.id = 'zz-text'; document.body.appendChild(i); i.focus(); }")
    page.keyboard.press("w")
    page.keyboard.down("a")
    page.keyboard.down("ArrowLeft")
    page.evaluate("() => new Promise(r => setTimeout(r, 300))")
    assert not page.evaluate("() => Object.values(_ae.site.input.keys).some(Boolean)")
    page.keyboard.up("a")
    page.keyboard.up("ArrowLeft")
    page.evaluate("() => document.getElementById('zz-text').remove()")


def test_the_autopilot_drives_to_a_place_and_stops_on_it(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    r = _pose(page)
    tx, ty = r["x"] - 80 * math.sin(r["hdg"] + 0.6), r["y"] + 80 * math.cos(r["hdg"] + 0.6)
    assert page.evaluate("(t) => _aeDriveGoTo({ x: t[0], y: t[1] })", [tx, ty])["ok"]
    page.evaluate("() => { _ae.site.autoAt = 0; _aeSiteAdvance(0.2); }")
    chip = page.evaluate("() => document.getElementById('ah-sub').textContent")
    assert chip and "min" in chip or "s" in chip, chip
    page.evaluate("() => _aeSiteAdvance(45)")
    r = _pose(page)
    assert math.hypot(r["x"] - tx, r["y"] - ty) < 4 and page.evaluate("() => _aeSiteState().auto") is None
    assert abs(r["v"]) < 0.5


def test_a_touch_on_the_stick_takes_the_wheel_back_from_the_autopilot(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    r = _pose(page)
    assert page.evaluate("(t) => _aeDriveGoTo({ x: t[0], y: t[1], name: 'far' })", [r["x"] + 900, r["y"] + 900])["ok"]
    page.evaluate("() => _aeSiteAdvance(3)")
    assert page.evaluate("() => _aeSiteState().auto") is not None
    page.evaluate("() => { _ae.site.input.sy = 0.6; _aeSiteAdvance(0.1); _ae.site.input.sy = 0; }")
    assert page.evaluate("() => _aeSiteState().auto") is None


def test_one_tap_anywhere_sets_off_and_a_press_that_moves_is_the_stick(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    cdp = page.context.new_cdp_session(page)
    page.evaluate("() => { AS_TAP_MS = 1e9; }")  # the software renderer holds a frame for seconds between a touch's two events
    # a place on the ground well ahead (where the horizon falls on the screen moves with the camera: a fixed point there was sometimes the sky,
    # which is not a place), and the lower half where the stick lives (right of the corner's name, whose reach a tap there opens the facts panel
    # with: a press at the lower left is the panel's)
    ahead = page.evaluate("""() => { var s = _ae.site, r = s.rover, x = r.x - Math.sin(r.hdg) * 30, y = r.y + Math.cos(r.hdg) * 30;
      var p = _aeProject(_asToWorld(s.fr, [x, y, _asGroundAt(s, x, y, false)])); return p && [Math.round(p.x), Math.round(p.y)]; }""")
    assert ahead and ahead[1] < 0.6 * 844, ahead
    for x, y in [tuple(ahead), (280, 700)]:
        _touch(cdp, "touchStart", x, y)
        _touch(cdp, "touchEnd", 0, 0)
        _until(page, "_aeSiteState().auto !== null")
        t = page.evaluate("() => _aeSiteState().auto")
        r = _pose(page)
        assert t["go"] is True and 2 < math.hypot(t["x"] - r["x"], t["y"] - r["y"]) < 4000
        page.evaluate("() => _aeSiteAdvance(2)")
        assert _pose(page)["v"] > 1, "one tap sends the vehicle"
        page.evaluate("() => _asAutoStop(_ae.site)")
    _touch(cdp, "touchStart", 280, 700)
    _touch(cdp, "touchMove", 280, 640)  # a press that moves
    _until(page, "_ae.site.input.sy > 0.5")
    assert page.evaluate("() => _aeSiteState().auto") is None
    _touch(cdp, "touchEnd", 0, 0)
    _until(page, "_ae.site.input.sy === 0")


def test_goto_takes_a_latitude_and_longitude_and_refuses_what_is_too_far(page):
    st = base._visit(page, "moon", "Apollo 15", drive=True)
    r = _pose(page)
    per_m = 180 / (math.pi * 1737400)
    ok = page.evaluate("(t) => _aeDriveGoTo({ lat: t[0], lon: t[1] })", [st["lat"] + 300 * per_m, st["lon"]])
    assert ok["ok"] and 250 < ok["distM"] < 350 and ok["seconds"] == pytest.approx(ok["distM"] / LRV_MS)
    page.evaluate("() => _asAutoStop(_ae.site)")
    far = page.evaluate("() => _aeDriveGoTo({ x: 50000, y: 0 })")
    assert far["ok"] is False and far["reason"] == "far" and far["distM"] > 20000, "a place in the flat frame beyond its reach is refused"
    assert page.evaluate("() => _aeSiteState().auto") is None


def test_the_bumper_slides_the_rover_round_the_lander_and_never_into_it(page):
    st = base._visit(page, "moon", "Apollo 15", drive=True)
    lander = page.evaluate(
        "() => { var ps = _ae.site.parts.filter(p => !p.hubs && p.model !== 'lrv-body' && p.model !== 'lrv-wheel').sort((a, b) => b.size - a.size); return { x: ps[0].x, y: ps[0].y, size: ps[0].size }; }"
    )
    # 14 m off, driving at a point a metre beside its centre
    page.evaluate(
        "(l) => { var r = _ae.site.rover; r.x = l.x - 14; r.y = l.y - 1; r.hdg = -Math.PI / 2; r.v = 0; _ae.site.input.keys.f = true; }", lander
    )
    worst, moved = 1e9, 0.0
    for _ in range(10):
        page.evaluate("() => _aeSiteAdvance(1)")
        r = _pose(page)
        worst = min(worst, math.hypot(r["x"] - lander["x"], r["y"] - lander["y"]))
        moved = max(moved, abs(r["y"] - (lander["y"] - 1)))
    page.evaluate("() => { _ae.site.input.keys.f = false; }")
    mv = page.evaluate("() => _ae.move")
    assert mv and mv["vehicle"] == "rover" and mv["near"] == "moon" and mv["coveredM"] > 1 and mv["place"] and abs(mv["place"]["lat"]) <= 90, ("the drive tells its move as the craft does", mv)
    assert worst > lander["size"] * 0.4, "never inside it (%.1f m from its middle, its footprint %.1f)" % (worst, lander["size"] * 0.4)
    assert moved > 0.5, "and it slid aside rather than stopping dead"


def test_held_straight_at_a_small_part_it_goes_round_and_on(page):
    base._visit(page, "mars", "Perseverance", drive=True)
    # Ingenuity stands 16 m dead ahead of the start
    page.evaluate("() => { var r = _ae.site.rover; r.x = 12; r.y = -11; r.hdg = 0; r.v = 0; _ae.site.input.keys.f = true; }")
    # At the rover's own pace (a Mars rover covers centimetres a second) the 21 m past it are minutes of driving, not seconds: the test is the way round, so it
    # is given the time the way takes at whatever that pace is.
    top = page.evaluate("() => { _aeSiteAdvance(5); return Math.abs(_ae.site.rover.v); }")
    assert top > 0, "the rover does not move"
    page.evaluate("(s) => _aeSiteAdvance(s)", min(3600, 2.5 * 21 / top))
    page.evaluate("() => { _ae.site.input.keys.f = false; }")
    assert _pose(page)["y"] > 10, "it got past the part it was pressed on, and kept going (y %.1f)" % _pose(page)["y"]


def test_the_body_never_turns_over_on_a_wall_of_ground(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate(
        "() => { var w = _asWheelsGround; window.__wg = w; _asWheelsGround = function () { var g = w.apply(this, arguments); g.pitch = 2; g.roll = -2; return g; }; }"
    )
    try:
        page.evaluate("() => _aeSiteAdvance(2)")
        r = _pose(page)
        assert abs(r["pitch"]) <= 0.5 + 1e-6 and abs(r["roll"]) <= 0.5 + 1e-6
    finally:
        page.evaluate("() => { _asWheelsGround = window.__wg; _aeSiteAdvance(2); }")
    assert abs(_pose(page)["pitch"]) < 0.3, "upright again on level ground"


def _fingers(cdp, kind, *pts):
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, x, y in pts]})


def test_a_second_finger_never_drops_the_first(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    cdp = page.context.new_cdp_session(page)
    _fingers(cdp, "touchStart", (1, 100, 640))
    _fingers(cdp, "touchMove", (1, 100, 590))
    _until(page, "_ae.site.input.sy > 0.5")
    h0 = page.evaluate("() => _ae.site.rover.hdg")
    _fingers(cdp, "touchStart", (1, 100, 590), (2, 300, 250))  # a second finger on the upper half
    _fingers(cdp, "touchMove", (1, 100, 590), (2, 260, 200))
    _until(page, "Math.abs(_ae.site.rover.hdg - %r) > 0.05" % h0)   # (driving: the second finger's drag steers)
    assert page.evaluate("() => _ae.site.input.sy") > 0.5, "the stick is still held"
    _fingers(cdp, "touchEnd", (2, 260, 200))
    page.evaluate("() => new Promise(r => setTimeout(r, 400))")
    assert page.evaluate("() => _ae.site.input.sy") > 0.5, "and when the second lets go"
    assert page.evaluate("() => _aeSiteState().auto") is None, "a second finger's tap is not a destination"
    _fingers(cdp, "touchEnd")
    _until(page, "_ae.site.input.sy === 0")


def test_a_minute_of_thumb_driving_answers_at_once_and_never_stalls(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    cdp = page.context.new_cdp_session(page)
    p0 = _pose(page)
    _fingers(cdp, "touchStart", (1, 195, 700))
    _fingers(cdp, "touchMove", (1, 195, 690))  # barely a dead zone's worth
    _until(page, "_ae.site.input.sy > 0")
    page.evaluate("() => _aeSiteAdvance(0.1)")
    assert abs(_pose(page)["v"]) > 0.1, "moving within 100 ms of game time of the first push"
    farthest = 0.0
    for dx, dy in [(0, -50), (40, -45), (-40, -45), (0, -50), (50, -20), (-50, -20), (0, 30), (0, -50)] * 2:
        _fingers(cdp, "touchMove", (1, 195 + dx, 700 + dy))
        page.evaluate("() => _aeSiteAdvance(4)")
        r = _pose(page)
        farthest = max(farthest, math.hypot(r["x"] - p0["x"], r["y"] - p0["y"]))
    _fingers(cdp, "touchEnd")
    _until(page, "_ae.site.input.sy === 0")
    page.evaluate("() => _aeSiteAdvance(2)")
    assert farthest > 30 and abs(_pose(page)["v"]) < 0.01
    assert not page.errors, page.errors


def test_a_far_place_is_a_journey_at_its_own_multiple_and_arrival_drives_on(page):
    st = base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _almClockSetRate(1)")
    per_deg = 1737400 * math.pi / 180
    lat = st["lat"] + 90_000 / per_deg
    res = page.evaluate("(t) => _aeDriveGoTo({ lat: t[0], lon: t[1], name: 'Far' })", [lat, st["lon"]])
    assert res["ok"] and res["trip"] and 89_000 < res["distM"] < 91_500
    assert page.evaluate("() => _almRate") == 1, "the shared clock is the person's: a journey never sets it"
    rate = page.evaluate("() => _ae.site.auto.trip.mult")
    assert rate > 1, "the journey runs at a multiple of its own"
    left0 = page.evaluate("() => _aeSiteState().auto.trip.left")
    page.evaluate("() => _aeSiteAdvance(5)")
    left1 = page.evaluate("() => _aeSiteState().auto.trip.left")
    done = left0 - left1
    assert 0.4 * LRV_MS * 5 * rate < done <= 1.02 * LRV_MS * 5 * rate, "it counts down at real speed times the clock's rate (turning to the bearing first)"
    page.evaluate("() => { _ae.site.autoAt = 0; _asAutoShow(_ae.site); }")
    assert any(u in page.evaluate("() => document.getElementById('ah-sub').textContent") for u in ("km", "mi"))
    for _ in range(40):
        if page.evaluate("() => !_ae.site || !_ae.site.auto"):
            break
        page.evaluate("() => _aeSiteAdvance(5)")
    page.wait_for_function(
        "(t) => { var s = typeof _aeSiteState === 'function' && _aeSiteState(); return s && s.drive && s.phase === 'stand' && s.ready && Math.abs(s.lat - t) < 1e-6; }",
        arg=lat, timeout=base.STAND_MS, polling=500,
    )
    assert page.evaluate("() => _almRate") == 1, "the clock is back where it was"


def _haversine_m(la1, lo1, la2, lo2, radius=1737400):
    k = math.pi / 180
    a = math.sin((la2 - la1) * k / 2) ** 2 + math.cos(la1 * k) * math.cos(la2 * k) * math.sin((lo2 - lo1) * k / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def _land(page, lat):
    page.wait_for_function(
        "(t) => { var s = typeof _aeSiteState === 'function' && _aeSiteState(); return s && s.drive && s.phase === 'stand' && s.ready && s.rover && Math.abs(s.lat - t) < 0.5; }",
        arg=lat, timeout=base.STAND_MS, polling=500,
    )


def test_a_fifty_kilometre_haul_completes_and_arrives_within_100_m(page):
    st = base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _almClockSetRate(1)")
    per_deg = 1737400 * math.pi / 180
    lat = st["lat"] + 50_000 / per_deg
    res = page.evaluate("(t) => _aeDriveGoTo({ lat: t[0], lon: t[1], name: 'Far' })", [lat, st["lon"]])
    assert res["ok"] and res["trip"]
    assert page.evaluate("() => _ae.site.auto.trip.mult") >= res["seconds"] / 60, "the multiple is the stop that makes it last about a minute"
    for _ in range(60):
        if page.evaluate("() => !_ae.site || !_ae.site.auto"):
            break
        page.evaluate("() => _aeSiteAdvance(2)")
    _land(page, lat)
    now = page.evaluate("() => _aeSiteState()")
    assert _haversine_m(now["rover"]["lat"], now["rover"]["lon"], lat, st["lon"]) < 100, "it is where it was going"
    assert page.evaluate("() => _almRate") == 1, "and the clock is back"


def test_the_chip_says_the_real_time_in_days_and_hours_with_progress(page):
    st = base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _almClockSetRate(1)")
    per_deg = 1737400 * math.pi / 180
    res = page.evaluate("(t) => _aeDriveGoTo({ lat: t[0], lon: t[1], name: 'Apollo 17' })", [st["lat"] + 1_180_000 / per_deg, st["lon"]])
    assert res["ok"] and 3.7 * 86400 < res["seconds"] < 3.9 * 86400
    page.evaluate("() => { _ae.site.autoAt = 0; _aeSiteAdvance(5); _ae.site.autoAt = 0; _asAutoShow(_ae.site); }")
    chip = page.evaluate("() => document.getElementById('ah-sub').textContent")
    import re
    assert "Apollo 17" in chip and re.search(r"\d\s*(days?|d)\b", chip) and re.search(r"\d\s*(hours?|hr|h)\b", chip), chip
    assert page.evaluate("() => document.getElementById('ah-sub').querySelector('svg')") is not None, "time sped up is a picture"
    page.evaluate("() => _asAutoStop(_ae.site)")


def test_a_hand_on_the_stick_mid_journey_lands_where_the_vehicle_has_got_to(page):
    st = base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _almClockSetRate(1)")
    per_deg = 1737400 * math.pi / 180
    lat = st["lat"] + 600_000 / per_deg
    assert page.evaluate("(t) => _aeDriveGoTo({ lat: t[0], lon: t[1] })", [lat, st["lon"]])["trip"]
    page.evaluate("() => _aeSiteAdvance(8)")
    gone = page.evaluate("() => { var T = _ae.site.auto.trip; return T.total - T.left; }")
    assert gone > 1000
    page.evaluate("() => { _ae.site.input.sy = 1; _aeSiteAdvance(0.1); _ae.site.input.sy = 0; }")
    _land(page, st["lat"] + (gone / per_deg))
    now = page.evaluate("() => _aeSiteState()")
    assert abs(_haversine_m(now["rover"]["lat"], now["rover"]["lon"], st["lat"], st["lon"]) - gone) < 100, "where the great circle had brought it"
    assert page.evaluate("() => _almRate") == 1


def test_a_touch_cancels_a_short_journey_where_it_stands_and_the_clock_was_never_touched(page):
    st = base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _almClockSetRate(1)")
    lat = st["lat"] + 200_000 / (1737400 * math.pi / 180)
    assert page.evaluate("(t) => _aeDriveGoTo({ lat: t[0], lon: t[1] })", [lat, st["lon"]])["trip"]
    assert page.evaluate("() => _almRate") == 1
    page.evaluate("() => { _ae.site.input.sy = 1; _aeSiteAdvance(0.1); _ae.site.input.sy = 0; }")
    assert page.evaluate("() => _aeSiteState().auto") is None and page.evaluate("() => _almRate") == 1


def test_leaving_a_visit_puts_the_clock_back_where_it_was(page):
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    x = 1_780_000_000_000  # a moment in 2026
    base._visit(page, "moon", "Apollo 15", drive=True, at=x)
    page.evaluate("() => _aeGoTo(_ae.site.def.ms)")  # the visit's own jump to the landing day
    assert abs(page.evaluate("() => _aeDisplayMs()") - x) > 1e9
    page.evaluate("() => _aeSiteExit()")
    assert abs(page.evaluate("() => _aeDisplayMs()") - x) < 60_000


def test_the_phones_back_leaves_the_drive_for_the_body_in_the_3d_view(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    assert page.evaluate("() => !!(history.state && history.state.aeFull)"), "the visit is a step of its own"
    page.go_back()
    page.wait_for_function("() => !_ae.site", timeout=60_000, polling=200)
    assert page.evaluate("() => _aeIsOpen && _ae.target") == "moon"


@pytest.mark.parametrize("body,site,model", [("moon", "Apollo 15", "lrv-body"), ("mars", "Perseverance", "perseverance-body")])
def test_a_site_with_its_own_parked_vehicle_is_driven_not_copied(page, body, site, model):
    st = base._visit(page, body, site, drive=True)
    assert page.evaluate("(m) => _ae.site.parts.filter(p => p.model === m).length", model) == 1, "one vehicle, not two"
    pd = page.evaluate("() => { var p = _ae.site.start; return p ? [p.x, p.y] : null; }")
    r = st["rover"]
    assert pd and math.hypot(r["x"] - pd[0], r["y"] - pd[1]) < 0.01, "it began where the parked one stood"


def test_the_drive_controls_wait_for_the_ground_and_red_mode_is_not_white(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    assert not page.evaluate("() => document.getElementById('as-hud').classList.contains('as-wait')")
    page.evaluate("() => document.documentElement.classList.add('night-red')")
    try:
        colour = page.evaluate("() => [getComputedStyle(document.getElementById('ah-sub')).color, getComputedStyle(document.querySelector('#ah-info>span')).color, getComputedStyle(document.querySelector('.ae-pin .alm-ck-r')).color, getComputedStyle(document.querySelector('.ae-pin .alm-ck-t')).color]")
        assert colour[0] == colour[1] and colour[0] != "rgba(255, 255, 255, 0.82)"
        assert colour[2] != "rgb(245, 158, 11)" and colour[3] != "rgb(255, 255, 255)", "the strip is through the Red tokens"
    finally:
        page.evaluate("() => document.documentElement.classList.remove('night-red')")


def test_the_drive_stick_and_the_thumbnails_are_red_in_red_mode(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => document.documentElement.classList.add('night-red')")
    try:
        got = page.evaluate("""() => { var st = document.querySelector('.as-stick, .as-rest'), pic = document.querySelector('.as-pic');
          return { stick: st && getComputedStyle(st).borderTopColor, pic: pic ? getComputedStyle(pic).filter : 'none-found' }; }""")
        assert got["stick"] and "255, 255, 255" not in got["stick"], got
        assert got["pic"] in ("none-found",) or got["pic"] != "none", got
    finally:
        page.evaluate("() => document.documentElement.classList.remove('night-red')")


def test_every_menu_row_is_a_normal_row_with_a_small_glyph(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.click("#as-menu-btn")
    page.wait_for_function("() => !document.getElementById('as-menu').hidden")
    rows = page.evaluate("() => Array.from(document.querySelectorAll('#as-menu button')).filter(b => !b.hidden).map(b => [b.textContent.trim(), Math.round(b.getBoundingClientRect().height), Math.round(b.querySelector('svg').getBoundingClientRect().width)])")
    assert len(rows) >= 4 and all(r[1] == 44 and r[2] == 20 for r in rows), rows
    page.keyboard.press("Escape")


def test_the_menu_is_walked_with_the_arrow_keys(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.click("#as-menu-btn")
    page.wait_for_function("() => !document.getElementById('as-menu').hidden")
    first = page.evaluate("() => { var b = Array.from(document.querySelectorAll('#as-menu button')).filter(x => !x.hidden && x.offsetParent); return [b.length, b.map(x => x.getAttribute('data-as-go') || x.getAttribute('data-as-view'))]; }")
    assert first[0] >= 2, first
    page.keyboard.press("ArrowDown")
    a = page.evaluate("() => document.activeElement.getAttribute('data-as-go') || document.activeElement.getAttribute('data-as-view')")
    page.keyboard.press("ArrowDown")
    b = page.evaluate("() => document.activeElement.getAttribute('data-as-go') || document.activeElement.getAttribute('data-as-view')")
    assert a in first[1] and b in first[1] and a != b, (a, b, first)
    page.keyboard.press("Escape")
    page.wait_for_function("() => document.getElementById('as-menu').hidden")


def test_stand_here_on_open_sea_offers_no_drive(page):
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    page.evaluate("() => _aePreset('earth')")
    page.wait_for_function("() => !_ae.fly", timeout=120_000, polling=250)
    page.evaluate("() => _aeStandAt('earth', 0, -140)")  # the middle of the Pacific
    page.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground' && !!document.getElementById('ae-stand-back')",
        timeout=base.STAND_MS, polling=500,
    )
    assert page.evaluate("() => !!_aeTerrainHeight('earth', 0, -140, 0).sea")
    assert not page.evaluate("() => !!document.getElementById('ae-stand-drive')")
    page.evaluate("() => _aeStandDrop(true)")


def test_a_kick_inside_a_frame_does_not_start_a_second_chain_of_frames(page):
    """The cause of a drive at 11 fps on a phone-sized GPU: every kick made while a frame was drawn left another chain of
    frames running beside the first, never ending, so a long visit drew several times for each picture shown."""
    base._visit(page, "moon", "Apollo 15", drive=True)
    out = page.evaluate(
        """() => {
          var pending = [], ids = 1e6, draws = 0, raf = window.requestAnimationFrame, draw = window._aeDraw;
          window.requestAnimationFrame = function (cb) { pending.push(cb); return ++ids; };
          window._aeDraw = function () { draws++; _aeKick(); };   // a kick inside the draw, as the site's code makes
          _ae.raf = 0; _aeKick();
          var first = pending.shift(); first(1000);               // one frame, with a kick inside it
          var res = { pendingAfterFrame: pending.length, draws: draws };
          var orphan = pending.shift(); _ae.raf = _aeRaf(); var d0 = draws;   // an older chain's callback, then a newer ask
          orphan(2000);
          res.orphanDraws = draws - d0;
          window.requestAnimationFrame = raf; window._aeDraw = draw; _ae.raf = 0; _aeKick();
          return res;
        }"""
    )
    assert out["draws"] == 1 and out["pendingAfterFrame"] == 1, "a frame with a kick in it leaves one chain going, not two"
    assert out["orphanDraws"] == 0, "an older chain's callback does nothing"


def test_the_vehicle_starts_facing_the_lander(page):
    st = base._visit(page, "moon", "Apollo 15", drive=True)
    r = st["rover"]
    lander = page.evaluate("() => { var p = _ae.site.parts.filter(p => p.model === 'lm')[0]; return [p.x, p.y]; }")
    ahead = (-math.sin(r["hdg"]), math.cos(r["hdg"]))
    to = (lander[0] - r["x"], lander[1] - r["y"])
    cos = (ahead[0] * to[0] + ahead[1] * to[1]) / math.hypot(*to)
    assert cos > 0.99, "the lander is dead ahead of the start (cos %.3f)" % cos


def test_every_drive_control_gives_a_finger_44px(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    short = undersized(page, skip=".topbar, .ep", noscroll=True)
    ours = [s for s in short if "as-" in s]
    assert not ours, "\n".join(ours)
    assert not page.errors, page.errors


@pytest.mark.parametrize("size", [(390, 844), (1280, 800)])
def test_no_two_top_controls_cross_at_a_site_or_driving(page, size):
    """The view's strip is whole at a landing site and while driving, the same one: nothing is drawn over anything."""
    from hit_area import top_overlaps

    page.set_viewport_size({"width": size[0], "height": size[1]})
    base._visit(page, "moon", "Apollo 15")
    page.wait_for_timeout(800)
    assert page.evaluate("() => getComputedStyle(document.getElementById('ae-pin')).display") != "none"
    crossed = top_overlaps(page)
    assert not crossed, "at the site: " + "; ".join(crossed)
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.wait_for_timeout(800)
    crossed = top_overlaps(page)
    assert not crossed, "driving: " + "; ".join(crossed)


def test_drive_from_stand_never_leaves_the_ground_on_the_way(page):
    """Pressing Drive while standing: the camera goes from where it stood to the drive's view, never up to the orbit view and back down."""
    pg = page
    pg.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); }")
    pg.evaluate("(b) => _aePreset(b)", "moon")
    pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=250)
    pg.evaluate("([b, la, lo]) => _aeStandAt(b, la, lo)", ["moon", 12.0, 21.0])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground' && !!document.getElementById('ae-stand-drive')",
        timeout=base.STAND_MS,
        polling=500,
    )
    pg.evaluate(
        """() => { window.__up = []; window.__stop = false;
        function s() { var c = _ae.gl.camera, m = _aeBodyPos('moon');
          window.__up.push(Math.hypot(c.position.x - m[0], c.position.y - m[1], c.position.z - m[2]) / AE_MOON_RADIUS_RE);
          if (!window.__stop) requestAnimationFrame(s); }
        requestAnimationFrame(s); document.getElementById('ae-stand-drive').click(); }"""
    )
    _get_in(pg)
    pg.wait_for_function(
        "() => { var s = typeof _aeSiteState === 'function' && _aeSiteState(); return s && s.drive && s.phase === 'stand' && s.ready && s.rover; }",
        timeout=base.STAND_MS,
        polling=500,
    )
    pg.evaluate("() => { window.__stop = true; }")
    heights = pg.evaluate("() => window.__up")
    assert len(heights) >= 2
    assert max(heights[1:]) < 1.02, max(heights)   # (the first sample is the camera object before any frame of the drive drew) within 2% of the Moon's radius (35 km) the whole way: no zoom out to the orbit view
    pg.evaluate("() => _aeSiteLeave(true)")


def test_the_tread_marks_follow_each_wheel_round_a_bend(page):
    """A tyre's mark is a ribbon of points along the path the wheel really took: unbroken, a tyre's width, bending when the vehicle steers."""
    base._visit(page, "moon", "Apollo 15", drive=True)
    _hold(page, {"f": 1}, 2)
    _hold(page, {"f": 1, "l": 1}, 3)
    r = page.evaluate(
        """() => { var T = _ae.site.tracks, n = T.head[0], pts = [], width = [];
          for (var i = 0; i < n; i++) { var a = 2 * i, b = 2 * i + 1; pts.push([(T.pos[a * 3] + T.pos[b * 3]) / 2, (T.pos[a * 3 + 1] + T.pos[b * 3 + 1]) / 2]);
            width.push(Math.hypot(T.pos[a * 3] - T.pos[b * 3], T.pos[a * 3 + 1] - T.pos[b * 3 + 1])); }
          return { n: n, pts: pts, width: width, ring: [T.head[0], T.head[1]] }; }"""
    )
    pts = r["pts"]
    assert r["n"] >= 10 and r["ring"][0] == r["ring"][1], r["ring"]
    gaps = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    assert max(gaps) < 0.9, max(gaps)  # one unbroken line
    assert all(0.15 < w < 0.3 for w in r["width"]), (min(r["width"]), max(r["width"]))  # a tyre's width, narrow
    # It bends: the heading of the last stretch is turned from the first's.
    h0 = math.atan2(pts[3][1] - pts[0][1], pts[3][0] - pts[0][0])
    h1 = math.atan2(pts[-1][1] - pts[-4][1], pts[-1][0] - pts[-4][0])
    assert abs(math.atan2(math.sin(h1 - h0), math.cos(h1 - h0))) > 0.3, (h0, h1)
    page.evaluate("() => _aeSiteLeave(true)")


def test_one_thumb_drives_and_the_other_steers_by_dragging_the_scene(page):
    """the stick and the look drag are independent pointers: the drive goes on forward while the dragged scene turns the heading, smoothly."""
    base._visit(page, "moon", "Apollo 15", drive=True)
    cdp = page.context.new_cdp_session(page)

    def touch(kind, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in pts]})

    page.evaluate(
        "() => { window.__h = []; window.__stop = false; (function s() { var r = _ae.site.rover; window.__h.push([r.hdg, r.v, r.x, r.y, _asCameraLocal ? 0 : 0]); if (!window.__stop) requestAnimationFrame(s); })(); }"
    )
    touch("touchStart", [(0, (70, 640))])
    for y in (610, 570, 540):
        touch("touchMove", [(0, (70, y))])
        page.wait_for_timeout(50)
    page.wait_for_function("() => _ae.site.rover.v > 0.3", timeout=120_000, polling=100)
    h0 = page.evaluate("() => _ae.site.rover.hdg")
    touch("touchStart", [(0, (70, 540)), (1, (300, 400))])
    for x in range(300, 200, -10):
        touch("touchMove", [(0, (70, 540)), (1, (x, 400))])
        page.wait_for_timeout(40)
    page.wait_for_timeout(300)
    h1 = page.evaluate("() => ({ hdg: _ae.site.rover.hdg, v: _ae.site.rover.v, stick: !document.getElementById('as-stick').hidden, keys: _ae.site.input.sy })")
    touch("touchEnd", [])
    page.evaluate("() => { window.__stop = true; }")
    hs = page.evaluate("() => window.__h")
    assert h1["hdg"] - h0 == pytest.approx(-100 * 0.006, abs=0.25), ("the heading followed the drag", h0, h1)
    assert h1["v"] > 0.3 and h1["stick"], ("the drive went on under the other thumb", h1)
    steps = [abs(b[0] - a[0]) for a, b in zip(hs, hs[1:])]
    assert max(steps) < 0.12, ("the heading jumped between frames", max(steps))


@pytest.mark.local_gate
def test_the_rover_on_the_moon_at_night_is_not_in_the_dark(page):
    """the Moon's night side of a drive went black (the ground's exposure was set for the orbit view's day while the visit's ground was thought to be high up): at night the
    ground is lit by the Earth at the eye's own exposure, with the headlights on."""
    import io

    import numpy as np
    from PIL import Image

    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => _aeGoTo(_aeDisplayMs() + 14.8 * 86400000)")   # a lunar day later: the Sun is down
    page.wait_for_function("() => _ae.site && _ae.site.fr && _ae.site.fr.sunLocal[2] < -0.1", timeout=120_000, polling=250)
    page.wait_for_timeout(1500)
    im = Image.open(io.BytesIO(page.screenshot())).convert("L")
    w, h = im.size
    ground = np.asarray(im.crop((0, h // 2, w, 3 * h // 4))).astype(float)   # the ground ahead of and around the rover, between the horizon and the stick
    assert ground.mean() > 25, ("the ground is black at night", ground.mean())
    assert page.evaluate("() => _ae.site.lamps && _ae.site.lamps.some(l => l.mesh.visible)"), "and the headlights are on"


def test_holding_the_stick_full_speeds_the_rover_up_and_easing_ends_it(page):
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { _ae.site.rover.hdg = Math.PI; }")
    def run(seconds):
        p0 = _pose(page)
        page.evaluate("(s) => { _ae.site.input.sx = 0; _ae.site.input.sy = 1; _aeSiteAdvance(s); }", seconds)
        p1 = _pose(page)
        return math.hypot(p1["x"] - p0["x"], p1["y"] - p0["y"])
    first = run(1.0)          # before the boost: the rover's own pace
    run(3.0)                  # the stick stays full
    boosted = run(1.0)
    assert boosted > first * 3, (first, boosted)
    assert page.evaluate("() => _asBoost(_ae.site)") > 3
    page.evaluate("() => { _ae.site.input.sy = 0.5; _aeSiteAdvance(0.1); }")
    assert page.evaluate("() => _asBoost(_ae.site)") == 1, "easing the stick ends the boost"
    page.evaluate("() => { _ae.site.input.sy = 0; }")


def test_the_rovers_lamps_throw_no_light_on_the_ground_while_it_is_still_falling_in(page):
    """"At night the rover lights appear on the ground before it falls from the sky": the pool of light is the lamps', so it is there once the rover is down."""
    base._visit(page, "moon", "Apollo 15", drive=True)
    got = page.evaluate(
        """() => { var st = _ae.site, fr = st.fr, r = st.rover, was = r.airborne; st.fr = Object.assign({}, fr, { sunLocal: [0, 0, -1] });
      r.airborne = true; _asLampStep(st); var air = st.lamps.map(l => l.mesh.visible);
      r.airborne = false; _asLampStep(st); var down = st.lamps.map(l => l.mesh.visible);
      st.fr = fr; r.airborne = was; return { air: air, down: down }; }"""
    )
    assert got["air"] and not any(got["air"]), got
    assert got["down"] and all(got["down"]), got
    page.evaluate("() => _aeSiteExit()")


def test_a_driving_key_pressed_while_the_called_up_rover_falls_in_is_kept_for_when_it_is_down(page):
    """"I tried to use WASD but it didn't work to move it just the drag thing": a key in the fall was walked with or dropped."""
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("() => { var s = _ae.site; s.input.keys = {}; s.drive = false; s.outOf = true; s.calledUp = true; s.atEye = false; document.activeElement && document.activeElement.blur(); }")
    page.keyboard.down("w")
    got = page.evaluate("() => ({ keys: _ae.site.input.keys.f, walk: !!(_ae.site.eye && _ae.site.eye.keys && _ae.site.eye.keys.f) })")
    page.keyboard.up("w")
    page.evaluate("() => { var s = _ae.site; s.drive = true; s.outOf = false; s.atEye = true; }")
    assert got["keys"] and not got["walk"], got
    page.evaluate("() => _aeSiteExit()")


@pytest.mark.parametrize(
    "tag",
    ["<input type=range id=zz-f>", "<input type=checkbox id=zz-f>", "<button id=zz-f>x</button>", "<input type=text id=zz-f style='display:none'>"],
)
def test_wasd_drive_whatever_control_was_clicked_last(page, tag):
    """a slider, a checkbox, a button or a text field left hidden keeps the focus and must not swallow W."""
    base._visit(page, "moon", "Apollo 15", drive=True)
    page.evaluate("(h) => { var d = document.createElement('div'); d.innerHTML = h; document.body.appendChild(d); var e = document.getElementById('zz-f'); e.focus && e.focus(); }", tag)
    page.keyboard.down("w")
    got = page.evaluate("() => !!_ae.site.input.keys.f")
    page.keyboard.up("w")
    page.evaluate("() => { var e = document.getElementById('zz-f'); e.parentNode.remove(); }")
    assert got, tag
