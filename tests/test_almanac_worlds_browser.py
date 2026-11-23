"""The 3D view's worlds on an emulated iPhone 15 Pro: what the Go sheet's Planets and Side by side open by a real tap,
the planets' maps staying bound after a way down to a surface and back and after the GPU takes the context, and the
Moon's card keeping its place through a flight within the Moon (not "Moon" and nothing else).

Run: pytest tests/test_almanac_worlds_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import GL_ARGS, PLACE, READY_MS  # noqa: E402
from test_almanac_planets_browser import served  # noqa: E402,F401  (a fixture)

GROUND_MS = 180_000
MARS_GALE = (-5.4, 137.8)
INFO = "() => (_aeHudInfoPaint(true), Array.from(document.querySelectorAll('#ah-info *')).map(e => e.textContent).join('|'))"
MAPS = "() => Object.fromEntries(Object.values(_ae.gl.planets).filter(p => p.uni.map.value).map(p => [p.b.key, !!(p.uni.map.value.image && p.uni.map.value.image.width) && p.uni.mapped.value === 1]))"


@pytest.fixture(scope="module")
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(**pw.devices["iPhone 15 Pro"], service_workers="block")
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
            % (PLACE, PLACE)
        )
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(served + "/#almanac", wait_until="load")
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
        yield pg
        br.close()


def _settled(pg, js="() => !_ae.fly"):
    pg.wait_for_function(
        "() => { _ae.dirty = true; _aeKick(); return (%s)(); }" % js,
        timeout=GROUND_MS,
        polling=300,
    )


def _to(pg, preset):
    pg.evaluate("(p) => _aePreset(p)", preset)
    _settled(pg)


def _go_sheet(pg):
    pg.tap("#ae-find")
    pg.wait_for_selector("#ae-go-top .ae-go-top3", state="visible")


def test_a_tap_on_planets_in_the_go_sheet_opens_the_solar_system(page):
    _to(page, "earth")
    _go_sheet(page)
    page.tap("#ae-go-top [data-ae-go=planets]")
    _settled(page, "() => _ae.preset === 'planets' && !_ae.spin && !_ae.fly")
    assert page.evaluate("() => _ae.target") == "sun"
    assert not page.errors, page.errors


def test_a_tap_on_side_by_side_shows_the_eight_planets_and_the_sun_chip_closes_it(page):
    _to(page, "earth")
    _go_sheet(page)
    page.tap("#ae-go-top [data-ae-go=spin]")
    page.wait_for_function(
        "() => !!_ae.spin && !!_ae.gl.spin && _ae.gl.spin.cells.every(c => c.uni.mapped.value === 1)",
        timeout=GROUND_MS,
        polling=300,
    )
    got = page.evaluate(
        "() => ({ cells: _ae.gl.spin.cells.map(c => c.b.key), names: document.querySelectorAll('[data-ae-spin]').length || null })"
    )
    assert got["cells"] == ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"], got
    page.tap("#ae-chips [data-ae-view='sun']")
    page.wait_for_function("() => !_ae.spin", timeout=60_000)
    assert not page.errors, page.errors


def test_planets_keep_their_maps_after_a_surface_and_back_and_after_the_gpu_takes_the_context(page):
    _to(page, "mars")
    page.wait_for_function(
        "() => { _ae.dirty = true; _aeKick(); return _ae.gl.planets.mars.uni.mapped.value === 1; }",
        timeout=GROUND_MS,
        polling=300,
    )
    before = page.evaluate(MAPS)
    assert before.get("mars") is True, before
    page.evaluate("([b, la, lo]) => _aeStandAt(b, la, lo)", ["mars", *MARS_GALE])
    page.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=200,
    )
    page.evaluate("() => _aeStandLeave()")
    page.wait_for_function("() => !_ae.stand", timeout=60_000, polling=200)
    _settled(page)
    after = page.evaluate(MAPS)
    assert after.get("mars") is True and set(before) <= set(after), (before, after)
    # The GPU taking the context: the view is built again at the same place, and the planet's map comes back with it.
    page.evaluate(
        "() => { window.__lose = _ae.gl.renderer.getContext().getExtension('WEBGL_lose_context'); window.__lose.loseContext(); }"
    )
    page.wait_for_function(
        "() => _ae.gl && _aeReady() && _ae.gl.planets.mars.uni.mapped.value === 1",
        timeout=GROUND_MS,
        polling=300,
    )
    assert page.evaluate(MAPS).get("mars") is True
    assert not page.errors, page.errors


def test_the_moons_card_keeps_its_place_through_a_flight_within_the_moon(page):
    _to(page, "moon")
    still = page.evaluate(INFO)
    assert "°" in still, still
    page.evaluate("() => _aeFlyTo('moon', _ae.dist * 0.4, null, false)")
    seen = []
    for _ in range(6):
        page.wait_for_timeout(200)
        fly = page.evaluate("() => !!_ae.fly")
        seen.append((fly, page.evaluate(INFO)))
    assert any(f for f, _ in seen), seen   # the flight was seen under way
    for fly, text in seen:
        assert text.startswith("Moon") and "°" in text, (fly, text)
    assert not page.errors, page.errors
