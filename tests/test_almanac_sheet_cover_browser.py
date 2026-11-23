"""The 3D view's search sheet is a place of its own.

"I want the sheet to cover the planet row, and maybe the search icon should turn into an X, maybe even animate. So it's like, I'm in there, I'm browsing,
I'm seeing everything that there is to do. I close it, and I'm back at my normal main interface."

Open, the sheet has one grab handle, its filter-chip bar is opaque once the list scrolls under it, the search circle is an X that closes it, and the
view's own controls are put away; closed, they are back as they were.

Run: pytest tests/test_almanac_sheet_cover_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_go_sheet_browser import LANDSCAPE, PORTRAIT, _open  # noqa: E402
from test_almanac_places_browser import GL_ARGS, library  # noqa: E402,F401

# The view's own controls that are drawn (laid out, not hidden, not clear), by id or class: neither the sheet, the search circle, the sheet's band, nor the
# picture's own labels and the empty containers the controls sit in.
DRAWN_CONTROLS = """() => {
  var view = document.querySelector('.ae-view'), out = [];
  var skip = function (el) { return el.closest('#ae-go, #ae-find, #ae-band, #ae-labels, #ae-lms, svg') || el.tagName === 'CANVAS'; };
  view.querySelectorAll('button, .ae-pin, .ae-row, .ae-mini, .ae-note, .ae-hint, #ae-clock, #ah-info, .ae-card, .ae-chips').forEach(function (el) {
    if (skip(el)) return;
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || r.width < 4 || r.height < 4) return;
    out.push(el.id || el.className);
  });
  return out.sort();
}"""


def _with_view(library, view, fn, scheme="dark"):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, view, scheme)
            fn(pg)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def _open_sheet(pg):
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-go", state="visible")
    pg.wait_for_timeout(600)   # the circle's turn settles


def test_the_sheet_has_one_grab_handle(library):
    def check(pg):
        _open_sheet(pg)
        assert pg.evaluate("() => document.querySelectorAll('#ae-go .ae-go-grab, #ae-go [class*=grab]').length") == 0
        # the one handle is the sheet's own (its ::before), a drawn bar
        assert pg.evaluate("() => { var cs = getComputedStyle(document.getElementById('ae-go'), '::before'); return cs.display === 'block' && parseFloat(cs.width) > 20 && parseFloat(cs.height) >= 3; }")

    _with_view(library, PORTRAIT, check)


def test_the_chip_bar_is_opaque_after_a_scroll(library):
    def check(pg):
        _open_sheet(pg)
        pg.wait_for_function("() => document.querySelectorAll('#ae-go-groups .ae-go-row').length > 12", timeout=60_000)
        pg.evaluate("() => { var b = document.querySelector('#ae-go .ae-go-body'); b.scrollTop = 400; }")
        pg.wait_for_timeout(300)
        alpha = pg.evaluate("""() => {
          var m = getComputedStyle(document.querySelector('#ae-go .ae-go-body > .ae-go-head')).backgroundColor.match(/[\\d.]+/g);
          return m.length > 3 ? parseFloat(m[3]) : 1;
        }""")
        assert alpha == 1, alpha
        # and the bar is not glass: nothing blurred behind it that would let the rows ghost through
        assert pg.evaluate("() => getComputedStyle(document.querySelector('#ae-go .ae-go-body > .ae-go-head')).backdropFilter") in ("none", "")

    _with_view(library, PORTRAIT, check)


@pytest.mark.parametrize("view", [PORTRAIT, LANDSCAPE], ids=["portrait", "landscape"])
def test_the_search_circle_is_an_x_while_the_sheet_is_open_and_closes_it(library, view):
    def check(pg):
        rest = pg.evaluate("() => { var f = document.getElementById('ae-find'); return [f.getAttribute('aria-label'), f.getAttribute('aria-expanded')]; }")
        assert rest[1] in (None, "false"), rest
        _open_sheet(pg)
        st = pg.evaluate("""() => {
          var f = document.getElementById('ae-find'), cs = getComputedStyle(f), r = f.getBoundingClientRect();
          return { label: f.getAttribute('aria-label'), expanded: f.getAttribute('aria-expanded'), vis: cs.visibility, op: +cs.opacity, pe: cs.pointerEvents,
                   x: +getComputedStyle(f.querySelector('.ae-find-x')).opacity, mag: +getComputedStyle(f.querySelector('.ae-find-mag')).opacity,
                   w: r.width, h: r.height, bottom: r.bottom, left: r.left, onscreen: r.bottom <= innerHeight && r.right <= innerWidth && r.left >= 0,
                   top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === f || f.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
        }""")
        assert st["expanded"] == "true" and st["label"] != rest[0], st
        assert st["vis"] == "visible" and st["op"] > 0.9 and st["pe"] != "none", st
        assert st["x"] == 1 and st["mag"] == 0, st   # the X, not the magnifier
        assert st["w"] >= 44 and st["h"] >= 44 and st["onscreen"] and st["top"], st   # still a 44 px circle, in reach, on top of the sheet
        assert st["bottom"] > view["height"] - 80 and st["left"] < 24, st   # where the magnifier was: bottom left, not on the band's way out
        # it animates with the tokens' settle time, and not at all under reduced motion
        assert pg.evaluate("() => getComputedStyle(document.querySelector('#ae-find .ae-find-x')).transitionDuration") != "0s"
        pg.click("#ae-find")
        pg.wait_for_selector("#ae-go", state="hidden")
        back = pg.evaluate("() => { var f = document.getElementById('ae-find'); return [f.getAttribute('aria-label'), f.getAttribute('aria-expanded'), +getComputedStyle(f.querySelector('.ae-find-mag')).opacity]; }")
        assert back[0] == rest[0] and back[1] == "false", back

    _with_view(library, view, check)


def test_the_x_does_not_animate_under_reduced_motion(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT, "dark")
            pg.emulate_media(reduced_motion="reduce")
            seconds = pg.evaluate("() => getComputedStyle(document.querySelector('#ae-find .ae-find-x')).transitionDuration")
            assert float(seconds.split(",")[0].rstrip("s")) <= 0.00002, seconds   # none, or the tokens' 0.001 ms
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("view", [PORTRAIT, LANDSCAPE], ids=["portrait", "landscape"])
def test_the_views_own_controls_are_put_away_while_the_sheet_is_open_and_come_back(library, view):
    def check(pg):
        before = pg.evaluate(DRAWN_CONTROLS)
        assert len(before) >= 3, before   # the main interface is there to put away (row, minimap, time...)
        _open_sheet(pg)
        assert pg.evaluate(DRAWN_CONTROLS) == [], pg.evaluate(DRAWN_CONTROLS)
        assert "ae-row" in before or "ae-views" in before, before   # the planets row is among what the sheet puts away
        pg.click("#ae-find")
        pg.wait_for_selector("#ae-go", state="hidden")
        pg.wait_for_timeout(600)
        assert pg.evaluate(DRAWN_CONTROLS) == before

    _with_view(library, view, check)
