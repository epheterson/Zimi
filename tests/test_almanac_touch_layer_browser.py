"""The 3D view's touch layer on a phone: the planet row does not flash while the globe is pinched, and a
finger whose capture was lost does not stay down for good (the view would no longer turn).

Run: pytest tests/test_almanac_touch_layer_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_almanac_padview_browser import GL_ARGS, READY_MS, _page, served  # noqa: E402,F401


def _touch(cdp, kind, *pts):
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i + 1} for i, (x, y) in enumerate(pts)]})


def _open(pw, served, errors):
    br = pw.chromium.launch(args=GL_ARGS)
    pg = _page(br, served, errors=errors)
    pg.evaluate("() => { var o = document.getElementById('setup-overlay'); if (o) o.remove(); }")
    return br, pg


def test_the_rows_discs_are_the_same_discs_while_the_globe_is_pinched(served):  # noqa: F811
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as pw:
        br, pg = _open(pw, served, errors)
        try:
            pg.wait_for_function("() => document.querySelectorAll('#ae-chips canvas.ae-lit-on').length > 0", timeout=READY_MS, polling=250)
            pg.evaluate("() => { document.querySelectorAll('#ae-chips canvas').forEach((c, i) => { c._tag = i; }); window.__lit = document.querySelectorAll('#ae-chips canvas.ae-lit-on').length; }")
            cdp = pg.context.new_cdp_session(pg)
            _touch(cdp, "touchStart", (150, 400), (250, 400))
            for k in range(1, 21):
                _touch(cdp, "touchMove", (150 - 3 * k, 400), (250 + 3 * k, 400))
                pg.wait_for_timeout(25)
            _touch(cdp, "touchEnd")
            pg.evaluate("() => { for (var i = 0; i < 20; i++) _aeMarkViews(); }")
            same = pg.evaluate("() => { var cs = document.querySelectorAll('#ae-chips canvas'); return [cs.length, Array.from(cs).every((c, i) => c._tag === i), document.querySelectorAll('#ae-chips canvas.ae-lit-on').length]; }")
            assert same[0] > 0 and same[1], "the row's discs were rebuilt: %s" % same
            assert same[2] >= pg.evaluate("() => window.__lit"), "and every disc that was lit still is: %s" % same
            assert errors == [], errors
        finally:
            br.close()


def _lose_a_finger(pg, cdp):
    """A finger goes down on the globe, the canvas stops holding it and the lift lands elsewhere: the page never hears it go up."""
    _touch(cdp, "touchStart", (200, 400))
    pg.evaluate("() => { var c = document.getElementById('ae-canvas'); Object.keys(_ae.pointers).forEach(id => c.releasePointerCapture(+id)); c.style.pointerEvents = 'none'; }")
    pg.wait_for_timeout(100)
    _touch(cdp, "touchEnd")
    pg.evaluate("() => { document.getElementById('ae-canvas').style.pointerEvents = ''; }")
    pg.wait_for_timeout(200)


def test_a_finger_whose_capture_was_lost_does_not_stay_down(served):  # noqa: F811
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as pw:
        br, pg = _open(pw, served, errors)
        try:
            cdp = pg.context.new_cdp_session(pg)
            _lose_a_finger(pg, cdp)
            assert pg.evaluate("() => Object.keys(_ae.pointers).length") == 1, "the lift never came: the finger is still counted"
            # the engine's own word for it (WebKit sends this when the element under the finger stops being drawn) puts it away
            pg.evaluate("() => { var id = +Object.keys(_ae.pointers)[0]; document.getElementById('ae-canvas').dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: id })); }")
            assert pg.evaluate("() => Object.keys(_ae.pointers).length") == 0, "a lost capture is a finger up"
            # and with no word at all, the next touch does not count it as a second finger: one finger still turns the view
            _lose_a_finger(pg, cdp)
            before = pg.evaluate("() => _ae.az")
            _touch(cdp, "touchStart", (150, 400))
            for i in range(8):
                _touch(cdp, "touchMove", (150 + 12 * (i + 1), 403 + 3 * i))
                pg.wait_for_timeout(30)
            _touch(cdp, "touchEnd")
            pg.wait_for_timeout(300)
            assert abs(pg.evaluate("() => _ae.az") - before) > 0.02, "one finger turns the view"
            assert pg.evaluate("() => Object.keys(_ae.pointers).length") == 0
            assert errors == [], errors
        finally:
            br.close()


# ── A sheet stands over the controls ──
# (The Go sheet's own X is the search circle, which stands over it at the foot on purpose: 1ba18abd3.)
SHEET_OVER = """(id) => {
  var own = id === 'ae-go' ? 'ae-find' : '', view = _ae.el, el = document.getElementById(id), b = el && _ahSeenBox(el, view), out = { id: id, seen: !!b, under: [], overlapped: [] };
  if (!b) return out;
  for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) {
    var x = b.l + 16 + (b.r - b.l - 32) * i / 2, y = b.t + 16 + (b.b - b.t - 32) * j / 2, top = document.elementFromPoint(x, y);
    if (!top || !(el.contains(top) || (own && top.id === own))) out.under.push((top && (top.id || top.className)) + '@' + Math.round(x) + ',' + Math.round(y));
  }
  Array.prototype.forEach.call(view.querySelectorAll('.ah-hero,.ah-minor'), function (c) {
    var q = _ahSeenBox(c, view);
    if (q && q.l < b.r && q.r > b.l && q.t < b.b && q.b > b.t && c.id !== 'ah-out' && c.id !== own) out.overlapped.push(c.id || c.className);
  });
  return out; }"""
SHEETS = {
    "go": ("() => _aeShowGo(true)", "ae-go"),
    "settings": ("() => _aeShowSettings(true)", "ae-set"),
    "facts": ("() => _aeOpenInfo('earth')", "ae-info"),
    "card": ("() => { _aeSatsAllSet(true); }", "ae-card"),
}


@pytest.mark.parametrize("sheet", sorted(SHEETS))
def test_an_open_sheet_is_over_the_controls_and_no_control_shows_through_it(served, sheet):  # noqa: F811
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as pw:
        br, pg = _open(pw, served, errors)
        try:
            opener, sid = SHEETS[sheet]
            if sheet == "card":
                pg.evaluate(opener)
                pg.wait_for_function("() => typeof _as !== 'undefined' && _as.on && !!_as.data", timeout=60_000, polling=200)
                pg.evaluate("() => _asSelect(5)")
            else:
                pg.evaluate(opener)
            pg.wait_for_function("(id) => { var e = document.getElementById(id); return !!e && !!_ahSeenBox(e, _ae.el); }", arg=sid, timeout=30_000, polling=250)
            pg.wait_for_timeout(1000)   # (the sheet has slid in)
            got = pg.evaluate(SHEET_OVER, sid)
            assert got["seen"], got
            assert not got["under"], "something stands over the sheet: %s" % got
            assert not got["overlapped"], "a control shows through the sheet: %s" % got
            assert errors == [], errors
        finally:
            br.close()


# ── The scene's own things take no touch (a visit's part dots, the Earth chip) ──
from test_almanac_sites_browser import _site, _visit, page as site_page  # noqa: E402,F401
from test_almanac_sites_browser import served as site_served  # noqa: E402,F401


def _dots(pg):
    return pg.evaluate(
        "() => Array.from(document.querySelectorAll('#as-dots i')).filter(i => i.style.display !== 'none' && i._part && i.offsetParent)"
        ".map(i => { var q = i.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2, String(i._part.model)]; })"
        ".filter(p => p[0] > 20 && p[0] < 370 && p[1] > 140 && p[1] < 640)"
    )


def _look_drag(pg, cdp, x, y):
    before = pg.evaluate("() => _ae.site.camera.az")
    _touch(cdp, "touchStart", (x, y))
    for i in range(8):
        _touch(cdp, "touchMove", (x + 12 * (i + 1), y + 2 * (i + 1)))
        pg.wait_for_timeout(30)
    _touch(cdp, "touchEnd")
    pg.wait_for_timeout(300)
    after = pg.evaluate("() => _ae.site.camera.az")
    pg.evaluate("(a) => { _ae.site.camera.az = a; _aeKick(); }", before)
    return after - before


def test_a_visits_part_dots_take_no_touch_a_drag_from_one_turns_the_view_and_a_tap_is_the_parts(site_page):  # noqa: F811
    pg = site_page
    site = _site("Apollo 17")
    _visit(pg, "moon", "Apollo 17", at=site["ms"] + 3 * 3600 * 1000)
    pg.wait_for_function("() => document.querySelectorAll('#as-dots i').length > 0", timeout=60_000, polling=250)
    pg.wait_for_timeout(2500)
    pg.evaluate("() => { var o = document.getElementById('setup-overlay'); if (o) o.remove(); }")
    dots = _dots(pg)
    assert dots, "a visit with a part too small to see has its dot"
    over = pg.evaluate("(ps) => ps.map(p => { var e = document.elementFromPoint(p[0], p[1]); return e && e.id; })", dots)
    assert all(o == "as-layer" for o in over), "the touch surface is under every dot: %s" % list(zip([d[2] for d in dots], over))
    cdp = pg.context.new_cdp_session(pg)
    x, y, model = dots[0]
    on = _look_drag(pg, cdp, x, y)
    beside = _look_drag(pg, cdp, x, y + 90) if 140 < y + 90 < 640 else _look_drag(pg, cdp, x, y - 90)
    assert abs(on) > 0.02 and on == pytest.approx(beside, rel=0.05), (on, beside)
    assert pg.evaluate("() => !_ae.site.tappedPart"), "the drag chose no part"
    _touch(cdp, "touchStart", (x, y))
    _touch(cdp, "touchEnd")
    pg.wait_for_function("() => !!_ae.site.tappedPart", timeout=10_000, polling=100)
    assert pg.evaluate("() => String(_ae.site.tappedPart.model)") == model
    assert pg.evaluate("() => AE_SCENE_TAPS.indexOf('#as-dots i') >= 0 && AE_SCENE_TAPS.indexOf('#as-earthhint') >= 0"), "both are looked up by the tap"
