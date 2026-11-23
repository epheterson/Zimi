"""The 3D view's controls get out of the way: a tap on empty space (or the space bar) hides every control and the page's
own header, and brings them back.

A tap on a body does not hide them; a focused field keeps its own space; Side by side has nothing to tap; an open sheet
is not hidden under the finger that puts it away. A line says so once a session: a finger's words on a phone, a mouse's
on a desktop.

Run: pytest tests/test_almanac_controls_toggle_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_go_sheet_browser import PORTRAIT, _open  # noqa: E402
from test_almanac_places_browser import GL_ARGS, library  # noqa: E402,F401

EMPTY = (14, 500)  # left of the globe on a phone: nothing there
GLOBE = (195, 330)

STATE = """() => {
  var shown = function (sel) {
    var e = document.querySelector(sel);
    if (!e) return false;
    var cs = getComputedStyle(e);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.5;
  };
  var bar = document.querySelector('.topbar');
  return {
    bare: _ae.el.classList.contains('ae-bare'),
    held: document.body.classList.contains('chrome-held'),
    top: shown('#ae-rim'),   // the surface/space circle stands for the corner's controls
    bottom: shown('.ae-bottom'),
    gear: shown('#ae-clock'),   // and the time chip
    header: shown('#ae-back'),   // the way out (the page's own bar is not drawn in the 3D view): it goes with the rest
    hint: document.getElementById('ae-hint').classList.contains('ae-show'),
    hintText: document.getElementById('ae-hint').textContent,
  };
}"""


def _state(pg):
    return pg.evaluate(STATE)


def _settle(pg, bare):
    pg.wait_for_function(
        "(b) => _ae.el.classList.contains('ae-bare') === b && !_ae.el.classList.contains('ae-bare-anim')"
        " && (getComputedStyle(document.querySelector('.ae-bottom')).visibility === 'hidden') === b"
        " && (getComputedStyle(document.getElementById('ae-back')).visibility === 'hidden') === b",
        arg=bare,
        timeout=5000,
    )


def _run(library, body, scheme="light", view=PORTRAIT):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, view, scheme)
            body(pg)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_tap_on_empty_space_hides_every_control_and_the_header_and_a_second_tap_brings_them_back(
    library,
):
    def body(pg):
        # The controls fade in once the view is ready; a slow frame stretches that fade, so wait for it before judging.
        pg.wait_for_function(
            "() => { var s = (%s)(); return s.top && s.bottom && s.gear && s.header; }" % STATE,
            timeout=30_000,
            polling=250,
        )
        s = _state(pg)
        assert s["top"] and s["bottom"] and s["gear"] and s["header"], s
        pg.touchscreen.tap(*EMPTY)
        _settle(pg, True)
        s = _state(pg)
        assert s["bare"] and s["held"], s
        assert not (s["top"] or s["bottom"] or s["gear"] or s["header"]), s
        # The picture is still drawn and still answers a drag.
        assert pg.evaluate("() => !!_ae.gl && !_ae.failed")
        pg.touchscreen.tap(*EMPTY)
        _settle(pg, False)
        s = _state(pg)
        assert not s["bare"] and not s["held"], s
        assert s["top"] and s["bottom"] and s["gear"] and s["header"], s

    _run(library, body)


def test_a_tap_on_a_body_does_not_hide_the_controls(library):
    def body(pg):
        pg.touchscreen.tap(*GLOBE)
        pg.wait_for_timeout(600)
        assert not _state(pg)["bare"]

    _run(library, body)


def test_the_h_key_toggles_and_a_focused_field_keeps_its_letters(library):
    def body(pg):
        pg.evaluate("() => document.activeElement && document.activeElement.blur()")   # focus on the page, not the canvas
        assert pg.evaluate("() => document.activeElement === document.body")
        pg.keyboard.press("h")
        _settle(pg, True)
        assert not _state(pg)["header"]
        pg.keyboard.press("h")
        _settle(pg, False)
        assert _state(pg)["header"]
        # In the Go to field a space is a space.
        pg.click("#ae-find")   # the search disc opens the Go sheet (it raises no keyboard: the field takes the letters once it is tapped)
        pg.click("#ae-go-q")
        pg.keyboard.type("new york")
        assert pg.input_value("#ae-go-q") == "new york"
        assert not _state(pg)["bare"]

    _run(library, body)


def test_a_tap_that_puts_a_sheet_away_does_not_hide_the_controls_too(library):
    def body(pg):
        pg.evaluate("() => _aeShowSettings(true)")
        pg.touchscreen.tap(*EMPTY)
        pg.wait_for_timeout(500)
        s = _state(pg)
        assert not s["bare"] and s["top"], s
        assert pg.evaluate("() => !_ae.setOpen")

    _run(library, body)


def test_the_page_header_comes_back_when_the_view_closes_bare(library):
    def body(pg):
        pg.touchscreen.tap(*EMPTY)
        _settle(pg, True)
        pg.evaluate("() => _aeClose()")
        pg.wait_for_function("() => !_aeIsOpen", timeout=20000)
        assert pg.evaluate(
            "() => !document.body.classList.contains('chrome-held') && !_ae.el.classList.contains('ae-bare')"
        )

    _run(library, body)

# The picture's own box and the body in it: where the canvas, the view and the page's bar stand, and the body's centre and radius on screen.
FRAME = """() => {
  var c = document.getElementById('ae-canvas').getBoundingClientRect(), v = _ae.el.getBoundingClientRect(), b = document.querySelector('.topbar').getBoundingClientRect();
  var cam = _ae.gl.camera, p = _aeProject(_aeTargetPos()), pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
  var r = pxPerRad * Math.tan(Math.asin(Math.min(1, AE_TARGETS[_ae.target].surface / _ae.dist)));
  return { canvas: [c.left, c.top, c.width, c.height], view: [v.left, v.top, v.width, v.height], bar: [b.top, b.height], body: [p.x, p.y, r] };
}"""


def test_hiding_the_controls_never_moves_or_resizes_the_picture(library):
    """The picture is the whole view with the header and controls over it: the canvas box, the view's box and the header's own box are
    the same to the pixel before and after, and so are the picture's own pixels where nothing of the chrome stands."""

    def body(pg):
        before = pg.evaluate(FRAME)
        pg.touchscreen.tap(*EMPTY)
        _settle(pg, True)
        after = pg.evaluate(FRAME)
        assert before["canvas"] == after["canvas"] and before["view"] == after["view"], (before, after)
        assert before["bar"] == after["bar"], (before, after)
        assert all(abs(a - b) <= 1 for a, b in zip(before["body"], after["body"])), (before, after)  # the body's centre and radius, within a pixel
        assert before["canvas"][3] == pg.evaluate("() => innerHeight"), before  # the whole screen, under the header
        pg.touchscreen.tap(*EMPTY)
        _settle(pg, False)
        assert pg.evaluate(FRAME) == before

    _run(library, body)
