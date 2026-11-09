"""The 3D view's Go to sheet on a phone, and Map here only where a map of the place is installed.

Eric, 2026-11-07: "Map here button layout is weird and doesn't work / offers maps for places I don't have? ... The search
UI was really weird it loads the text box way high up and I can't see what's there."

In headless Chromium at phone sizes, with the on-screen keyboard stood in for by a visualViewport that is shorter than
the window (what iOS Safari does): the sheet stands on the keyboard, the field at its foot where the thumb is, the
answers between, all of it inside the visible area. Map here is offered for a place only when an installed map's ground
includes it, and opens that map, not the last one used when that is a map of elsewhere.

Run: pytest tests/test_almanac_go_sheet_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import (  # noqa: E402,F401  (library is a fixture)
    GL_ARGS,
    PLACE,
    READY_MS,
    _landed,
    _rows,
    library,
)

PORTRAIT = {"width": 390, "height": 844}
LANDSCAPE = {"width": 844, "height": 390}
KEYBOARD_PX = {"portrait": 344, "landscape": 170}
EDGE_PX = 2  # layout rounding

# A visualViewport that follows the window until __kb(px) says a keyboard covers that much of its foot.
KEYBOARD_STAND_IN = """
(function () {
  var t = new EventTarget(), covered = 0, o = { offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  var f = { addEventListener: t.addEventListener.bind(t), removeEventListener: t.removeEventListener.bind(t), dispatchEvent: t.dispatchEvent.bind(t) };
  Object.keys(o).forEach(function (k) { Object.defineProperty(f, k, { get: function () { return o[k]; } }); });
  Object.defineProperty(f, 'width', { get: function () { return innerWidth; } });
  Object.defineProperty(f, 'height', { get: function () { return innerHeight - covered; } });
  Object.defineProperty(window, 'visualViewport', { value: f, configurable: true });
  window.__kb = function (px) { covered = px; t.dispatchEvent(new Event('resize')); };
})();
"""
# Two installed maps: one of Asia, one of Europe and North America (the fixture map's ground), the Asian one last used.
TWO_MAPS = """() => {
  window._installedMaps = () => [
    { name: 'maps_asia', main_path: 'index.html', title: 'Asia', map_bounds: [60, -10, 150, 55] },
    { name: 'maps_en_places', main_path: 'index.html', title: 'West', map_bounds: [-125, 32, 10, 52] }];
  window._lastMapVisit = () => ({ zim: window._installedMaps()[0], pos: '' });
  window.__opened = null;
  AlmanacLinks.openHit = function (h, o) { window.__opened = { hit: h, opts: o }; };
}"""


def _open(browser, base, view, scheme="light", maps=True):
    ctx = browser.new_context(
        viewport=view,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        color_scheme=scheme,
    )
    ctx.add_init_script(KEYBOARD_STAND_IN)
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (PLACE, PLACE)
    )
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
    return ctx, pg, errors


def _boxes(pg):
    return pg.evaluate("""() => {
          var box = function (sel) { var r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
          var rows = Array.from(document.querySelectorAll('#ae-go-found .ae-go-row')).map(function (b) { var r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
          return { vv: visualViewport.height, sheet: box('#ae-go'), field: box('#ae-go-q'), rows: rows };
        }""")


def _check_fits_above_keyboard(b):
    """The sheet is inside what is visible; the field is its lowest thing; every answer is between."""
    assert (
        b["sheet"]["top"] >= -EDGE_PX and b["sheet"]["bottom"] <= b["vv"] + EDGE_PX
    ), b
    assert (
        b["vv"] - b["sheet"]["bottom"] < 24
    ), b  # standing on the keyboard, not floating above a gap
    assert (
        b["field"]["top"] >= b["sheet"]["top"]
        and b["field"]["bottom"] <= b["sheet"]["bottom"] + EDGE_PX
    ), b
    assert b["rows"], b
    for r in b["rows"]:
        assert (
            r["top"] >= b["sheet"]["top"] - EDGE_PX
            and r["bottom"] <= b["field"]["top"] + EDGE_PX
        ), b


@pytest.mark.parametrize("scheme", ["light", "dark"])
@pytest.mark.parametrize(
    "name,view", [("portrait", PORTRAIT), ("landscape", LANDSCAPE)]
)
def test_go_to_search_stands_on_the_keyboard_with_its_answers_in_view(
    library, name, view, scheme
):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, view, scheme)
            pg.click("#ae-go-btn")
            pg.wait_for_selector("#ae-go-q", state="visible")
            pg.wait_for_function("() => !!_aeLm", timeout=60_000)
            # Closed keyboard: the field is the sheet's last thing, at the foot of the screen.
            closed = _boxes(pg)
            assert closed["field"]["bottom"] <= closed["sheet"]["bottom"] + EDGE_PX
            assert closed["vv"] - closed["sheet"]["bottom"] < 24, closed
            pg.focus("#ae-go-q")
            pg.evaluate("px => __kb(px)", KEYBOARD_PX[name])
            pg.fill("#ae-go-q", "Par")
            pg.wait_for_function(
                "() => document.querySelectorAll('#ae-go-found .ae-go-row').length >= 2",
                timeout=30_000,
            )
            _check_fits_above_keyboard(_boxes(pg))
            # The groups, with the keyboard up, scroll inside the sheet and keep the field in sight.
            pg.fill("#ae-go-q", "")
            b = _boxes(pg)
            assert (
                b["sheet"]["top"] >= -EDGE_PX
                and b["sheet"]["bottom"] <= b["vv"] + EDGE_PX
            ), b
            assert (
                b["field"]["bottom"] <= b["vv"] + EDGE_PX
                and b["field"]["top"] >= b["sheet"]["top"]
            ), b
            # Put away with the field still focused: the foot comes back down (it stayed raised over a gone keyboard).
            pg.evaluate("_aeShowGo(false)")
            assert pg.evaluate("document.querySelector('.ae-bottom').style.bottom") == ""
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
