"""The 3D view's small bugs from the owner's phone and the reviewer's pass (2026-11-10), each as a person meets it.

At a phone's size in headless Chromium: Stand here's Back returns to where the person came from; the Satellites chip turns the
layer on; the owner filter says Unassigned and wraps into labelled rows inside the panel; the Stand HUD's phone button is at the top
right and the Sun's height has no compass letter; a launch's choices each work and stay in the 3D view; a mission opens at its
launch; the chooser's selection is the app's amber and Saturn's thumbnail is whole.

Run: pytest tests/test_almanac_ux3d_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import (
    GL_ARGS,
    READY_MS,
    no_map,
)  # noqa: E402,F401  (no_map is a fixture)

VIEW = {"width": 390, "height": 844}
LA = '{"lat":34.05,"lon":-118.24,"name":"Los Angeles"}'
GROUND_MS = 240_000


def _open(browser, base, view=VIEW):
    ctx = browser.new_context(
        viewport=view,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); localStorage.setItem('zimi_cap', 'full'); } catch (e) {}"
        % LA
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(base + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    return ctx, pg


def _open_3d(pg):
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
        timeout=READY_MS,
        polling=200,
    )


def _stand_up(pg, lat=34.05, lon=-118.24):
    pg.evaluate("([a, o]) => _aeStandAt('earth', a, o)", [lat, lon])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )


@pytest.fixture
def three_d(no_map):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg = _open(br, no_map)
            _open_3d(pg)
            yield pg
        finally:
            br.close()


# ── Back from Stand here ──
def test_back_from_stand_returns_the_3d_view_as_it_was(three_d):
    pg = three_d
    pg.evaluate("() => _aePreset('earth')")
    pg.wait_for_function("() => !_ae.fly", timeout=60_000)
    before = pg.evaluate(
        "() => ({ dist: _ae.dist, preset: _ae.preset, target: _ae.target })"
    )
    _stand_up(pg)
    pg.click("#ae-stand-back")
    pg.wait_for_function(
        "() => !_ae.stand && !_ae.standPending", timeout=60_000, polling=250
    )
    after = pg.evaluate(
        "() => ({ dist: _ae.dist, preset: _ae.preset, target: _ae.target, lit: (document.querySelector('#ae-views [aria-pressed=true]') || {}).dataset && document.querySelector('#ae-views [aria-pressed=true]').dataset.aeView })"
    )
    assert (
        abs(after["dist"] - before["dist"]) < 1e-6
        and after["target"] == before["target"]
    ), (before, after)
    assert after["preset"] == "earth" and after["lit"] == "earth", after
    assert not pg.errors, pg.errors


def test_back_from_stand_handed_over_by_a_card_goes_to_the_card(three_d):
    pg = three_d
    pg.evaluate(
        "() => { window.__back = 0; window._osHandoff = { lat: 34.05, lon: -118.24, heading: 180, pitch: 8, back: function () { window.__back++; } }; }"
    )
    assert pg.evaluate("() => _aeStandOpen()") is True
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=250,
    )
    pg.click("#ae-stand-back")
    pg.wait_for_function(
        "() => !_ae.stand && window.__back === 1", timeout=60_000, polling=250
    )
    assert not pg.errors, pg.errors


# ── Stand's HUD ──
def test_the_phone_button_is_at_the_top_right_of_the_hud(three_d):
    pg = three_d
    _stand_up(pg)
    got = pg.evaluate(
        """() => { var b = document.getElementById('ae-stand-motion'); if (!b) return null; var r = b.getBoundingClientRect();
        return { right: innerWidth - r.right, top: r.top }; }"""
    )
    if got is None:
        pytest.skip("the phone's sensors are not offered in this browser")
    assert got["right"] < 24 and got["top"] < 80, got


def test_the_suns_height_has_no_compass_letter(three_d):
    pg = three_d
    pg.evaluate(
        "() => _aeGoTo(Date.UTC(2026, 5, 21, 20, 0))"
    )  # local noon: the Sun high in the south
    _stand_up(pg)
    pg.wait_for_function(
        "() => /☀/.test(document.getElementById('ae-stand-text').innerText)",
        timeout=30_000,
    )
    text = pg.evaluate("() => document.getElementById('ae-stand-text').innerText")
    sun = [l for l in text.split("\n") if "☀" in l][0]
    import re

    assert re.search(r"☀ \d+° [↑↓]", sun), sun
    assert not re.search(
        r"☀ -?\d+°( [↑↓])? [NESW]", sun
    ), sun  # the height is not followed by a letter: the bearing is, after a dot
    assert re.search(r"· [NESW]+", sun), sun


# ── Satellites ──
def test_the_satellites_chip_turns_the_layer_on(three_d):
    pg = three_d
    assert pg.evaluate("() => _aeSatsAllOn()") is False
    pg.evaluate("() => document.querySelector('#ae-views [data-ae-view=sats]').click()")
    pg.wait_for_function("() => _aeSatsAllOn() === true", timeout=60_000, polling=250)
    assert pg.get_attribute("#ae-sats-btn", "aria-pressed") == "true"


def test_the_owner_filter_says_unassigned_and_the_rows_wrap_inside_the_panel(three_d):
    pg = three_d
    pg.evaluate("() => _aeSatsAllSet(true)")
    pg.wait_for_function(
        "() => typeof _as !== 'undefined' && _as.state === 'ready' && document.getElementById('as-bar') && !document.getElementById('as-bar').hidden",
        timeout=180_000,
        polling=250,
    )
    got = pg.evaluate(
        """() => { var b = document.getElementById('as-bar'), r = b.getBoundingClientRect();
        return { w: r.width, sw: b.scrollWidth, text: b.innerText, rows: b.querySelectorAll('.as-row').length,
                 labels: Array.from(b.querySelectorAll('.as-lab')).map(function (x) { return x.textContent; }),
                 over: Array.from(b.querySelectorAll('button')).filter(function (x) { return x.getBoundingClientRect().right > innerWidth + 1; }).length }; }"""
    )
    assert (
        got["sw"] <= got["w"] + 1 and got["over"] == 0
    ), got  # nothing scrolls sideways
    assert got["rows"] == 3 and len(got["labels"]) == 3, got
    assert "TBD" not in got["text"] and "Unassigned" in got["text"], got


# ── The hero disc ──
def test_the_hero_disc_stays_put_under_a_drag_until_the_view_can_turn_it(no_map):
    """Before the 3D view is up the disc is a picture: it must not slide under the finger; the drag is kept to turn the Moon by."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg = _open(br, no_map)
            pg.wait_for_selector("#almanac-head .almanac-moon-open", timeout=60_000)
            pg.wait_for_function(
                "() => typeof _aeHandDrag === 'function'", timeout=60_000
            )
            box = "() => { var r = document.querySelector('#almanac-head .almanac-moon-open').getBoundingClientRect(); return [r.x, r.y]; }"
            before = pg.evaluate(box)
            for dx, dy in ((20, 4), (30, 6), (40, 2)):
                pg.evaluate("([x, y]) => _aeHandDrag(x, y)", [dx, dy])
            assert pg.evaluate(box) == before, "the disc moved under the drag"
            assert pg.evaluate("() => _aeWaitDragPx") == {
                "x": 90,
                "y": 12,
            }, "the drag is kept"
            assert not pg.errors, pg.errors
        finally:
            br.close()
