"""A drag, a pinch or a tap that starts on a name in the 3D picture, by touch on a phone ("Dragging on
a label still doesn't rotate the body").

The names take no pointer at all, so every touch lands on the canvas: on an iPhone a touch stays with the element it started on, so a label
that took the touch kept the drag from the globe however it was handed on. Checked here on the Earth and the Moon with their landmarks on, with
real touch events (CDP Input.dispatchTouchEvent) at 390 px:
  - every visible name has the canvas under it (the engine-free form of the iPhone's rule: nothing over the picture keeps a touch),
  - a one-finger drag from a name turns the body exactly as the same drag with the names put away,
  - two fingers that start on names pinch the distance,
  - a still tap on a name opens it.

Run: pytest tests/test_almanac_label_touch_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_almanac_padview_browser import (
    GL_ARGS,
    READY_MS,
    _page,
    served,
)  # noqa: E402,F401

NAMES = "() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden && b.offsetParent).map(b => { var q = b.getBoundingClientRect(); return [q.left + Math.min(14, q.width / 2), q.top + q.height / 2, b.textContent]; }).filter(p => p[1] > 140 && p[1] < 640 && p[0] > 20 && p[0] < 260)"


def _touch(cdp, kind, *pts):
    cdp.send(
        "Input.dispatchTouchEvent",
        {
            "type": kind,
            "touchPoints": [
                {"x": x, "y": y, "id": i + 1} for i, (x, y) in enumerate(pts)
            ],
        },
    )


def _drag(pg, cdp, x, y):
    before = pg.evaluate("() => [_ae.az, _ae.el_]")
    _touch(cdp, "touchStart", (x, y))
    for i in range(8):
        _touch(cdp, "touchMove", (x + 12 * (i + 1), y + 3 * (i + 1)))
        pg.wait_for_timeout(30)
    _touch(cdp, "touchEnd")
    pg.wait_for_timeout(300)
    after = pg.evaluate("() => [_ae.az, _ae.el_]")
    pg.evaluate(
        "(v) => { _ae.az = v[0]; _ae.el_ = v[1]; _ae.dirty = true; _aeKick(); }", before
    )  # back where it was, for the next
    pg.wait_for_timeout(200)
    return after[0] - before[0], after[1] - before[1]


@pytest.mark.parametrize("body", ["earth", "moon"])
def test_a_touch_that_starts_on_a_name_is_the_globes(served, body):  # noqa: F811
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _page(br, served, errors=errors)
            cdp = pg.context.new_cdp_session(pg)
            pg.evaluate("(b) => _aePreset(b)", body)
            pg.wait_for_function(
                "(b) => !_ae.fly && _ae.target === b",
                arg=body,
                timeout=READY_MS,
                polling=200,
            )
            pg.evaluate(
                "() => { _aeLmSetLayer(true); _ae.lm = null; _aeRenderCard(); }"
            )
            pg.wait_for_function(
                NAMES.replace("() =>", "() => (") + ").length > 0",
                timeout=60_000,
                polling=250,
            )
            pg.wait_for_timeout(500)
            names = pg.evaluate(NAMES)
            # nothing over the picture keeps a touch: under every name is the canvas
            over = pg.evaluate(
                "(ps) => ps.map(p => { var e = document.elementFromPoint(p[0], p[1]); return e && e.id; })",
                names,
            )
            assert all(o == "ae-canvas" for o in over), list(
                zip([n[2] for n in names], over)
            )
            x, y, name = names[0]
            # a drag from the name turns the body as the same drag with the names put away
            on = _drag(pg, cdp, x, y)
            pg.evaluate("() => { _aeLmSetLayer(false); }")
            pg.wait_for_timeout(300)
            off = _drag(pg, cdp, x, y)
            assert abs(on[0]) > 0.02 and on == pytest.approx(off, rel=0.02, abs=1e-4), (
                name,
                on,
                off,
            )
            assert pg.evaluate("() => !_ae.lm"), "the drag opened nothing"
            pg.evaluate("() => { _aeLmSetLayer(true); }")
            # the names come back on a later frame: wait for them, not a fixed time (slow software GL)
            pg.wait_for_function(
                NAMES.replace("() =>", "() => (") + ").length > 0",
                timeout=60_000,
                polling=250,
            )
            names = pg.evaluate(NAMES)
            x, y, name = names[0]
            # two fingers starting on names (or one on a name, one beside it) pinch
            d0 = pg.evaluate("() => _ae.dist")
            _touch(cdp, "touchStart", (x, y))
            _touch(cdp, "touchStart", (x, y), (x + 60, y + 60))
            for k in range(1, 7):
                _touch(
                    cdp,
                    "touchMove",
                    (x - 8 * k, y - 8 * k),
                    (x + 60 + 8 * k, y + 60 + 8 * k),
                )
                pg.wait_for_timeout(40)
            _touch(cdp, "touchEnd")
            pg.wait_for_timeout(300)
            assert pg.evaluate("() => _ae.dist") < d0 * 0.95, "the pinch zoomed in"
            assert pg.evaluate("() => !_ae.lm"), "and opened nothing"
            # a still tap on a name opens it, the one it named as the finger came down
            pg.evaluate("(d) => { _ae.dist = d; _ae.dirty = true; _aeKick(); }", d0)
            pg.wait_for_timeout(600)
            x, y, name = pg.evaluate(NAMES)[0]
            _touch(cdp, "touchStart", (x, y))
            _touch(cdp, "touchEnd")
            pg.wait_for_function(
                "(n) => _ae.lm && _ae.lm.row && _ae.lm.row[0] === n",
                arg=name,
                timeout=10_000,
            )
            assert errors == [], errors
        finally:
            br.close()


def test_the_globe_still_turns_after_a_drag_that_began_on_a_name_ended_badly(
    served,
):  # noqa: F811
    """A finger that began on a name and ended off the page, a second finger that landed and left, a contact whose up never came: none leaves the globe unable to turn."""
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _page(br, served, errors=errors)
            cdp = pg.context.new_cdp_session(pg)
            pg.evaluate("() => _aePreset('moon')")
            pg.wait_for_function(
                "() => !_ae.fly && _ae.target === 'moon'", timeout=READY_MS, polling=200
            )
            pg.evaluate(
                "() => { _aeLmSetLayer(true); _ae.lm = null; _aeRenderCard(); }"
            )
            pg.wait_for_function(
                NAMES.replace("() =>", "() => (") + ").length > 0",
                timeout=60_000,
                polling=250,
            )
            pg.wait_for_timeout(500)
            x, y, name = pg.evaluate(NAMES)[0]
            # a drag from a name that ends far outside the page, then a second finger that lands and goes
            _touch(cdp, "touchStart", (x, y))
            for i in range(6):
                _touch(cdp, "touchMove", (x - 40 * (i + 1), y + 10 * (i + 1)))
                pg.wait_for_timeout(30)
            _touch(cdp, "touchStart", (x - 240, y + 60), (x + 30, y + 30))
            _touch(cdp, "touchEnd")
            pg.wait_for_timeout(300)
            assert (
                pg.evaluate("() => Object.keys(_ae.pointers).length") == 0
            ), "nothing is left held"
            # a contact whose up never came (what a lost pointer leaves behind)
            pg.evaluate(
                "() => { _ae.pointers[977] = { x: 10, y: 10 }; _ae.pinch = { span: 50, mx: 0, my: 0, span0: 50, dist0: _ae.dist, ang: 0, turned: 0, left: 0, top: 0, hold: null }; }"
            )
            x, y, name = pg.evaluate(NAMES)[0]
            before = pg.evaluate("() => [_ae.az, _ae.el_]")
            _touch(cdp, "touchStart", (x, y))
            for i in range(8):
                _touch(cdp, "touchMove", (x + 12 * (i + 1), y + 3 * (i + 1)))
                pg.wait_for_timeout(30)
            _touch(cdp, "touchEnd")
            pg.wait_for_timeout(300)
            after = pg.evaluate("() => [_ae.az, _ae.el_]")
            assert abs(after[0] - before[0]) > 0.02, ("the globe turned", before, after)
            assert errors == [], errors
        finally:
            br.close()
