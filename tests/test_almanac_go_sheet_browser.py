"""The 3D view's Go to sheet on a phone, and Map here only where a map of the place is installed.

Eric, 2026-11-07: "Map here button layout is weird and doesn't work / offers maps for places I don't have? ... The search
UI was really weird it loads the text box way high up and I can't see what's there."

In headless Chromium at phone sizes, with the on-screen keyboard stood in for by a visualViewport that is shorter than
the window (what iOS Safari does): the sheet stands on the keyboard, the field at its foot where the thumb is, the
answers between, all of it inside the visible area. Map here is offered for a place only when an installed map's ground
includes it, and opens that map, not the last one used when that is a map of elsewhere.

The view's own controls, the Go to sheet and the settings sheet each give a finger 44 x 44 on a phone (what waits for a
layout change is named at HIT_WAITING).

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

from hit_area import undersized  # noqa: E402

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


def _open(browser, base, view, scheme="light", maps=True, requests=None, lang=None):
    ctx = browser.new_context(
        viewport=view,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        color_scheme=scheme,
    )
    ctx.add_init_script(KEYBOARD_STAND_IN)
    if requests is not None:
        ctx.on("request", lambda r: requests.append(r.url))
    if lang:
        ctx.add_init_script('try { localStorage.setItem("zimi_ui_lang", %r); } catch (e) {}' % lang)
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
          var body = document.querySelector('#ae-go .ae-go-body');
          return { vv: visualViewport.height, sheet: box('#ae-go'), field: box('#ae-go-q'), rows: rows, scrolls: !!body && body.scrollHeight > body.clientHeight + 1 };
        }""")


def _check_fits_above_keyboard(b):
    """The sheet is inside what is visible, above the keyboard, with its own field at its head; every answer is in the sheet and above the keyboard."""
    assert (
        b["sheet"]["top"] >= -EDGE_PX and b["sheet"]["bottom"] <= b["vv"] + EDGE_PX
    ), b
    assert b["field"]["top"] >= b["sheet"]["top"] - EDGE_PX and b["field"]["bottom"] <= b["sheet"]["bottom"], b  # the field is the sheet's own, inside it
    assert b["rows"], b
    for r in b["rows"][: 1 if b.get("scrolls") else None]:   # a short screen scrolls the answers inside the sheet: the first is whole, the rest are a scroll away
        assert (
            r["top"] >= b["sheet"]["top"] - EDGE_PX
            and r["bottom"] <= b["sheet"]["bottom"] + EDGE_PX
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
            pg.click("#ae-find")
            pg.wait_for_selector("#ae-go", state="visible")
            pg.wait_for_function("() => !!_aeLm", timeout=60_000)
            # Closed keyboard: the sheet stands at the foot, its own field at its head.
            closed = _boxes(pg)
            assert closed["field"]["top"] >= closed["sheet"]["top"] - EDGE_PX and closed["sheet"]["bottom"] > closed["vv"] - 100, closed
            pg.focus("#ae-go-q")
            pg.evaluate("px => __kb(px)", KEYBOARD_PX[name])
            pg.fill("#ae-go-q", "Paris")
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
            assert b["field"]["top"] >= b["sheet"]["top"] - EDGE_PX, b  # the sheet's own field, at its head, in sight
            assert pg.is_visible("#ae-go-groups"), b
            last = pg.evaluate(
                """() => { var rows = document.querySelectorAll('#ae-go-groups .ae-go-row'), r = rows[rows.length - 1];
                r.scrollIntoView({ block: 'nearest' }); var a = r.getBoundingClientRect(), s = document.getElementById('ae-go').getBoundingClientRect();
                return [a.top >= s.top - 1, a.bottom <= s.bottom + 1, a.bottom <= visualViewport.offsetTop + visualViewport.height + 1]; }"""
            )
            assert last == [True, True, True], ("the groups' last row cannot be scrolled into the sheet above the keyboard", last)
            # Put away with the field still focused: the foot comes back down (it stayed raised over a gone keyboard).
            pg.evaluate("_aeShowGo(false)")
            assert pg.evaluate("document.querySelector('.ae-bottom').style.bottom") == ""
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def _row_tops(pg):
    """How many distinct lines of rows the open sheet shows whole, between its head and its foot."""
    return pg.evaluate("""() => {
        var body = document.querySelector('#ae-go .ae-go-body').getBoundingClientRect(), tops = {};
        document.querySelectorAll('#ae-go-groups .ae-go-row').forEach(function (b) {
            var r = b.getBoundingClientRect();
            if (r.top >= body.top - 1 && r.bottom <= body.bottom + 1) tops[Math.round(r.top)] = 1;
        });
        return Object.keys(tops).length;
    }""")


def _sheet_ready(pg):
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-go", state="visible")
    pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)


def test_in_short_landscape_the_go_to_sheet_shows_five_list_rows_or_two_grid_rows(
    library,
):
    """844 x 390: the sheet used to be capped at half the height with the field at its foot: one and a half rows. Now the
    head is one line (the field and the pills, pinned) and the rest is rows: a section shows at least five list lines, or two of the grid.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, LANDSCAPE)
            _sheet_ready(pg)
            head = pg.evaluate(
                "document.querySelector('#ae-go .ae-go-head').getBoundingClientRect().height"
            )
            assert head <= 64, head
            pg.click("[data-ae-gomode=list]")
            pg.click("[data-ae-pill=landings]")
            geometry = pg.evaluate(
                """() => ['#ae-go', '.ae-go-head', '.ae-go-body', '#ae-go-groups .ae-go-row'].map(function (q) {
                    var r = document.querySelector(q).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })"""
            )
            assert _row_tops(pg) >= 5, (_row_tops(pg), geometry)   # (the field is pinned beside the pills now, one list line fewer than six)
            pg.click("[data-ae-gomode=grid]")
            pg.click("[data-ae-pill=moons]")   # (the selector stands at the list's top: back to a section of bodies)
            assert _row_tops(pg) >= 2, _row_tops(pg)
            ctx.close()
        finally:
            br.close()


def test_go_to_search_filters_bodies_by_either_name_and_enter_goes(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sheet_ready(pg)
            pg.fill("#ae-go-q", "tit")
            keys = pg.evaluate(
                "Array.from(document.querySelectorAll('#ae-go-groups [data-ae-go]')).map(b => b.dataset.aeGo)"
            )
            assert keys[0] == "titan" and "saturn" not in keys, keys
            # A body is found by its English name whatever the language shown.
            assert pg.evaluate("_aeGoFind('jupiter')")[0] == "jupiter"
            pg.fill("#ae-go-q", "saturn")
            pg.press("#ae-go-q", "Enter")
            pg.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !_ae.fly && _ae.target === 'saturn'; }",
                timeout=60_000,
                polling=200,
            )
            assert pg.evaluate("document.getElementById('ae-go').hidden")
            # Opened again, the field is empty and the bodies are back.
            pg.click("#ae-find")
            assert pg.input_value("#ae-go-q") == ""
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("view", [PORTRAIT, LANDSCAPE])
def test_each_pill_brings_its_section_and_lights_and_every_row_is_44px(library, view):
    """The pills are the one list's sections, as on the Almanac's page: a tap brings that section's heading up under them and
    lights the pill (Sent is a list of its own); every row is a finger tall."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, view)
            _sheet_ready(pg)
            pg.wait_for_function("() => !!_aeLm", timeout=60_000)
            for mode in ("grid", "list"):
                pg.click("[data-ae-gomode=%s]" % mode)
                for pill, head in (
                    ("all", None),
                    ("planets", "alm_go_planets"),
                    ("moons", "alm_go_moons"),
                    ("small", "alm_go_dwarfs"),
                    ("sent", None),
                    ("landings", "alm_go_landings"),
                ):
                    pg.click("[data-ae-pill=%s]" % pill)
                    if pill == "sent":
                        pg.wait_for_selector(".ae-sent-row", state="attached", timeout=60_000)
                    got = pg.evaluate(
                        """(head) => { var body = document.querySelector('.ae-go-body'), b = body.getBoundingClientRect(), h = head && document.querySelector('#ae-go-groups h4[data-g="' + head + '"]');
                        return {
                        rows: document.querySelectorAll('#ae-go-groups [data-ae-go]').length,
                        short: Array.from(document.querySelectorAll('#ae-go-groups .ae-go-row')).filter(b => b.getBoundingClientRect().height < 44).length,
                        top: body.scrollTop, head: h ? Math.round(h.getBoundingClientRect().top - b.top) : null, room: Math.round(b.height),
                        on: Array.from(document.querySelectorAll('[data-ae-pill].active')).map(p => p.dataset.aePill) }; }""",
                        head,
                    )
                    assert got["on"] == [pill] and got["short"] == 0 and got["rows"], (mode, pill, got)
                    if pill in ("all", "sent"):
                        assert got["top"] == 0, (mode, pill, got)
                    else:
                        assert got["head"] is not None and 0 <= got["head"] < got["room"] - 44, (mode, pill, got)   # its heading in view, under the pills
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_scrolling_the_list_lights_the_section_and_only_the_pills_stay(library):
    """Scrolled, the field, the Grid/List selector and the one row of pills stay at the top, and the lit pill is the section under them."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sheet_ready(pg)
            pg.click("[data-ae-gomode=grid]")
            one = pg.evaluate("() => { var p = Array.from(document.querySelectorAll('[data-ae-pill]')).map(b => Math.round(b.getBoundingClientRect().top)); return new Set(p).size; }")
            assert one == 1, "the pills are one row"
            seg = pg.evaluate("() => !!document.querySelector('.ae-go-seg').closest('.ae-go-find')")
            assert seg, "the selector stands at the search field's end"
            got = pg.evaluate(
                """() => { var body = document.querySelector('.ae-go-body'), h = document.querySelector('#ae-go-groups h4[data-g="alm_go_moons"]');
                body.scrollTop += h.getBoundingClientRect().top - body.getBoundingClientRect().top + 40;
                body.dispatchEvent(new Event('scroll'));
                var b = body.getBoundingClientRect(), q = document.getElementById('ae-go-q').getBoundingClientRect(), s = document.querySelector('.ae-go-seg').getBoundingClientRect(), p = document.querySelector('.ae-go-pills').getBoundingClientRect();
                return { on: Array.from(document.querySelectorAll('[data-ae-pill].active')).map(x => x.dataset.aePill), field: q.bottom <= b.top, seg: s.bottom <= b.top, pills: p.top >= b.top - 1 && p.height > 0 }; }"""
            )
            assert got["on"] == ["moons"], got
            assert not got["field"] and not got["seg"], ("the field and the selector stay pinned with the pills", got)
            assert got["pills"], ("the pills stay above the list", got)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_view_toggle_is_remembered_on_the_device(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sheet_ready(pg)
            assert pg.evaluate(
                "document.getElementById('ae-go-groups').classList.contains('ae-go-grid')"
            )
            pg.click("[data-ae-gomode=list]")
            assert not pg.evaluate(
                "document.getElementById('ae-go-groups').classList.contains('ae-go-grid')"
            )
            assert pg.evaluate("localStorage.getItem('zimi_go_view')") == "list"
            pg.reload(wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeGoView === 'function'",
                timeout=120_000,
            )
            assert pg.evaluate("_aeGoView()") == "list"
            ctx.close()
        finally:
            br.close()


def test_the_discs_are_asked_for_when_the_view_draws_them_and_never_on_a_low_level(
    library,
):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            seen = []
            ctx, pg, errors = _open(br, library, PORTRAIT, requests=seen)
            # (the chooser row at the foot draws its balls from the sprite as soon as the view is up, so it is asked for here)
            _sheet_ready(pg)
            pg.wait_for_timeout(1500)
            assert [
                u for u in seen if "go-discs" in u
            ], "the sheet drew no discs from the sprite"
            ctx.close()
            low = []
            ctx, pg, errors = _open(br, library, PORTRAIT, requests=low)
            asked = len([u for u in low if "go-discs" in u])   # (the view's row was drawn before the level was set)
            pg.evaluate("ZimiCap.level = function () { return 'low'; }")
            _sheet_ready(pg)
            pg.wait_for_timeout(1500)
            assert len([u for u in low if "go-discs" in u]) == asked, "a low level asked for the sprite again"
            assert pg.evaluate(
                "document.getElementById('ae-go-groups').classList.contains('ae-go-flat')"
            )
            ctx.close()
        finally:
            br.close()


def test_the_sprite_order_in_the_view_is_the_scripts():
    import ast
    import re

    root = os.path.dirname(HERE)
    with open(os.path.join(root, "scripts", "build_go_discs.py"), encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    keys = next(
        n.value
        for n in tree.body
        if isinstance(n, ast.Assign) and n.targets[0].id == "KEYS"
    )
    with open(os.path.join(root, "zimi", "static", "almanac-earth.js"), encoding="utf-8") as fh:
        m = re.search(r"var AE_GO_DISC_KEYS = \[(.*?)\];", fh.read(), re.S)
    assert re.findall(r"'([a-z0-9]+)'", m.group(1)) == [k.value for k in keys.elts]
def test_in_a_right_to_left_language_the_controls_do_not_sit_on_the_minimap(library):
    """Hebrew: the control column is on the left, where the minimap used to be (it was placed by `left`, not by the side);
    a landing's long name stays inside the screen."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT, lang="he")
            assert pg.evaluate("document.documentElement.dir") == "rtl"
            pg.evaluate("_aePreset('moon')")
            pg.wait_for_function("() => !!_aeLm", timeout=60_000)
            pg.wait_for_timeout(1500)
            if os.environ.get("ALM_SHOTS"):
                pg.screenshot(path=os.path.join(os.environ["ALM_SHOTS"], "hebrew_moon.png"))
            outside = pg.evaluate("""() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden).map(b => b.getBoundingClientRect())
                .filter(r => r.left < -1 || r.right > innerWidth + 1).length""")
            assert outside == 0, outside
            ctx.close()
        finally:
            br.close()


# Not measured here: the shell's top bar (the shell's tests do), the footer clock's parts (a tap takes the nearest part within
# a slop, so their box is bigger than the drawn one) and the minimap (the settings sheet is drawn over it).
HIT_WAITING = ".topbar, .ep, .ae-lm"   # (a landmark name is hit up to 44 px with its text 26: tests/test_almanac_landmarks_bodies_browser.py measures that)


def _still(pg):
    """Every finite CSS transition and animation over: a press's dip or a bar sliding in is not the control's size."""
    pg.wait_for_function("() => document.getAnimations().every(a => a.playState !== 'running' || a.effect.getComputedTiming().endTime === Infinity)", timeout=10_000, polling=50)


def test_the_3d_views_controls_give_a_finger_44px(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _still(pg)
            short = undersized(pg, skip=HIT_WAITING, noscroll=True)
            pg.click("#ae-find")
            pg.wait_for_selector("#ae-go", state="visible")
            _still(pg)
            short += undersized(pg, skip=HIT_WAITING + ", #ae-views, #ae-fly-btn, #ae-locate, #ae-cam", noscroll=True)   # (the sheet stands over the strip and the corner column)
            _still(pg)
            short += undersized(pg, skip=HIT_WAITING + ", #ae-views, #ae-fly-btn, #ae-locate, #ae-cam", scroller=".ae-go-body")  # every row of its list, as it scrolls
            pg.evaluate("_aeShowGo(false)")
            pg.evaluate("_aeShowSettings(true)")
            pg.wait_for_selector(".ae-set-choice", state="visible")
            _still(pg)
            short += undersized(pg, skip=HIT_WAITING + ", #ae-views", noscroll=True)   # (the settings sheet stands over the name pill and the strip: not reachable while it is open)
            pg.evaluate("_aeShowSettings(false)")
            pg.evaluate("() => _aePreset('sats')")  # Satellites: the layer on, and its filter chips in the band's drawer
            pg.evaluate("() => _aeShowGo(true)")
            pg.click("#ae-band [data-ae-drawer=sats]", timeout=60_000)
            pg.wait_for_selector(".as-bar .ae-btn", state="visible", timeout=60_000)   # (the satellites' own bar, not the landing site's tools)
            _still(pg)
            short += undersized(pg, skip=HIT_WAITING, noscroll=True)
            pg.evaluate("_aeMissionStart('apollo11')")  # a mission: its marks, track and event chips
            pg.wait_for_selector("#am-track", state="visible", timeout=60_000)
            pg.wait_for_timeout(2000)
            _still(pg)
            short += undersized(pg, skip=HIT_WAITING, noscroll=True)
            assert not errors, errors
            ctx.close()
            assert not short, "\n".join(sorted(set(short)))
        finally:
            br.close()


def _sent_ready(pg):
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-go", state="visible")
    pg.click("[data-ae-pill=sent]")
    pg.wait_for_selector(".ae-sent-row", state="attached", timeout=60_000)


def test_every_craft_the_sheet_shows_wears_its_model_render_not_a_drawn_icon(library):
    """The Go sheet's craft rows (the ISS, the missions, the probes, a landing's lander) show their model's render from the sent sheet
    wherever a render exists, and never a drawn glyph in its place."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sheet_ready(pg)
            pg.wait_for_function("() => !!_aeSent && !!_aeSent.pics", timeout=60_000)
            pg.evaluate("() => _aeGoRender()")
            got = pg.evaluate(
                """() => ['iss', 'ms:voyager1', 'ms:apollo11', 'voyager1', 'juno', 'parker'].map(k => {
                  var row = document.querySelector('#ae-go-groups [data-ae-go="' + k + '"]'), o = _aeGoCraftObj(k), has = o && _aeSent.pics[o.model] !== undefined;
                  return [k, !!row, !!has, !row ? null : !!row.querySelector('.ae-go-thumb .ae-sent-img'), !row ? null : !!row.querySelector('.ae-go-thumb .ae-go-glyph')]; })"""
            )
            for k, shown, has, img, glyph in got:
                if shown and has and k != "ms:apollo11":   # (the Apollo missions wear the rocket mark: the landing site beside has the lander's render)
                    assert img and not glyph, (k, "a craft with a render shows it, not an icon", got)
            assert any(g[1] and g[3] for g in got), ("at least one craft row shows a render", got)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_failed_sent_script_is_asked_for_once_not_by_every_render(library):
    """The sheet's craft rows ask for the Sent script from a render; when it fails the rows keep their glyphs and the script is not
    asked for again by the render that failure causes."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            seen = []
            ctx, pg, errors = _open(br, library, PORTRAIT, requests=seen)
            ctx.route("**/almanac-sent.js*", lambda route: route.abort())
            pg.click("#ae-find")
            pg.wait_for_selector("#ae-go", state="visible")
            pg.wait_for_timeout(3000)
            asked = [u for u in seen if "almanac-sent.js" in u]
            assert len(asked) == 1, asked
            ctx.close()
        finally:
            br.close()


def test_the_sent_pill_loads_when_first_opened_and_every_row_is_a_44px_target(library):
    """Everything sent away from Earth is one pill: its index and script are fetched when the pill is first shown, never with the
    view or the sheet. Landing sites, probes, the ISS, what ended and what was lost are rows with a picture, a name, a year and
    where it is now."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            seen = []
            ctx, pg, errors = _open(br, library, PORTRAIT, requests=seen)
            _sheet_ready(pg)
            pg.wait_for_timeout(500)
            # (the sheet's craft rows need their model renders, so the index is asked for with it; never with the view alone)
            pg.click("[data-ae-pill=sent]")
            pg.wait_for_selector(".ae-sent-row", state="attached", timeout=60_000)
            assert [u for u in seen if "almanac-sent.js" in u], "the pill's script was not asked for"
            assert [u for u in seen if "sent-v1.json" in u], "the pill's index was not asked for"
            pg.wait_for_timeout(800)
            assert [u for u in seen if "sent-thumbs" in u], "the pill's renders were not asked for"
            assert pg.evaluate("document.querySelectorAll('.ae-sent-img').length") >= 40
            for mode in ("grid", "list"):  # the Sent pill is a list whichever the sheet is set to; the toggle is not shown there
                pg.evaluate("localStorage.setItem('zimi_go_view', '%s')" % mode)
                pg.click("[data-ae-pill=planets]")
                pg.click("[data-ae-pill=sent]")
                pg.wait_for_selector(".ae-sent-row", state="attached")
                got = pg.evaluate(
                    """() => ({
                      rows: document.querySelectorAll('#ae-go-groups .ae-sent-row').length,
                      short: Array.from(document.querySelectorAll('#ae-go-groups .ae-go-row')).filter(b => b.getBoundingClientRect().height < 44).length,
                      pic: Math.round(document.querySelector('.ae-sent-row .ae-sent-img').getBoundingClientRect().width),
                      row: Math.round(document.querySelector('.ae-sent-row').getBoundingClientRect().height),
                      seg: (function () { var s = document.querySelector('#ae-go .ae-go-seg'); return s ? getComputedStyle(s).display : 'none'; })(),
                      cols: document.querySelector('#ae-go-groups').className,
                      first: document.querySelector('.ae-sent-row').innerText })"""
                )
                assert got["rows"] >= 70 and got["short"] == 0 and got["pic"] == 64 and got["row"] == 76 and got["seg"] == "none" and "ae-go-grid" not in got["cols"], (mode, got)
            words = pg.evaluate(
                "Array.from(document.querySelectorAll('.ae-sent-row')).map(b => b.innerText).join('|')"
            )
            for expect in ("On the Moon", "On Mars", "Leaving the Sun", "Crashed 1965"):
                assert expect in words, (expect, words[:400])
            for left_out in ("Lost 1993", "Burned up 2003", "Position unknown"):   # no model or no place to go to today: kept in the data, not listed
                assert left_out not in words, (left_out, words[:400])
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_standing_row_lands_at_its_site_and_a_lost_row_draws_no_marker(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            pg.click("[data-ae-go='sent:apollo-11']")
            pg.wait_for_function("() => _ae.lm && _ae.lm.row[0] === 'Apollo 11'", timeout=30_000)
            assert pg.inner_text("#ae-card h3, #ae-card .ae-sc-text b").strip() == "Apollo 11"   # (the site card once the sites are in, the plain card before)
            marks = pg.evaluate("AE_MARKED.length")
            pg.click("#ae-find")
            pg.wait_for_selector(".ae-sent-row", state="attached")
            pg.evaluate("_aeGoPick('sent:marsobserver')")
            pg.wait_for_function("() => !!_ae.sent", timeout=30_000)
            card = pg.inner_text("#ae-card")
            assert "Mars Observer" in card and "Position unknown" in card and "1993" in card, card
            assert pg.evaluate("_ae.lm") is None
            assert pg.evaluate("AE_MARKED.length") == marks, "a lost thing drew a marker"
            assert pg.evaluate("_ae.preset") == "mars", "the view went to the body it was last near"
            # An ended one goes to where it ended and says so.
            pg.click("#ae-find")
            pg.wait_for_selector(".ae-sent-row", state="attached")
            pg.evaluate("_aeGoPick('sent:galileo')")
            pg.wait_for_function("() => !!_ae.sent && _ae.sent.o.id === 'galileo'", timeout=30_000)
            assert "Burned up 2003" in pg.inner_text("#ae-card")
            assert pg.evaluate("_ae.preset") == "jupiter"
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_search_disc_opens_go_to_from_the_bottom_with_its_own_field(library):
    """The strip's first disc is search: Go to opens from the bottom with its own field focused, the page's own bar stays unseen,
    and what is typed finds bodies; leaving the view leaves nothing of the page's field changed."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            assert pg.evaluate("() => !document.getElementById('ae-go-btn') && !document.querySelector('#ae-pin .pill')")
            assert pg.evaluate("() => !document.querySelector('#ae-chips #ae-find') && !document.getElementById('ae-find').hidden && !document.getElementById('ae-go-q')")
            pg.click("#ae-find")
            pg.wait_for_selector("#ae-go", state="visible")
            assert pg.evaluate("() => document.activeElement && document.activeElement.id") != "ae-go-q"   # no keyboard on open: a finger raises it
            assert pg.evaluate("() => { var r = document.getElementById('ae-go').getBoundingClientRect(); return r.bottom > innerHeight - 100 && r.top > 60; }")   # it stands at the bottom, tall, under the band (test_almanac_sheet_ufo_browser.py holds the height)
            pg.keyboard.type("jupiter")
            pg.wait_for_function("() => document.querySelector('#ae-go .ae-go-row[data-ae-go=jupiter]')")
            assert pg.evaluate("() => document.getElementById('q').value === ''")
            pg.evaluate("() => _aeClose()")
            pg.wait_for_function("() => !_aeIsOpen")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_row_is_a_destination_for_a_vehicle_already_driving_on_that_body(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            # A drive is stood in for within one call, so no frame runs on the stand-in.
            got = pg.evaluate(
                """() => {
                  var calls = [], was = window._aeDriveGoTo;   // the sites' file is lazy: there may be none yet
                  window._aeDriveGoTo = function (t) { calls.push(t); return { ok: true }; };
                  _ae.site = { body: 'moon' };
                  _aeSentPick('sent:apollo-17');
                  var lmAfter = _ae.lm;
                  _ae.site = null; if (was) window._aeDriveGoTo = was; else delete window._aeDriveGoTo;
                  return { calls: calls, lm: lmAfter };
                }"""
            )
            c = got["calls"]
            assert len(c) == 1 and c[0]["name"] == "Apollo 17" and abs(c[0]["lat"] - 20.2) < 0.5, got
            assert got["lm"] is None, "the view flew away from the vehicle"
            # With no vehicle on that body the row is a flight, as ever.
            pg.evaluate("_aeSentPick('sent:apollo-17')")
            pg.wait_for_function("() => _ae.lm && _ae.lm.row[0] === 'Apollo 17'", timeout=30_000)
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_sent_list_is_sectioned_by_where_it_is_counted_and_searched_by_name_year_and_world(library):
    import json

    from playwright.sync_api import sync_playwright

    with open(os.path.join(os.path.dirname(HERE), "zimi", "static", "earth", "sent-v1.json"), encoding="utf-8") as f:
        objs = json.load(f)["objects"]
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            heads = pg.evaluate("Array.from(document.querySelectorAll('.ae-sent-h')).map(h => h.querySelector(':scope > span:not(.ae-go-thumb)').innerText.trim().toLowerCase())")
            want = ["on the moon", "on mars", "on venus", "on titan", "orbiting earth", "orbiting the moon", "orbiting mars", "orbiting jupiter", "out in the solar system", "leaving the sun", "ended", "lost"]
            assert [h for h in heads if h in want] == [h for h in want if h in heads] and "ended" in heads and "lost" not in heads, heads
            listed = pg.evaluate("_aeSentListedObjects().length")
            assert 60 < listed < len(objs), (listed, len(objs))   # only what has its model and a place to go to today
            assert pg.inner_text(".ae-sent-count") == "%d things sent from Earth" % listed
            counts = pg.evaluate("Array.from(document.querySelectorAll('.ae-sent-h b')).map(b => +b.textContent)")
            assert sum(counts) == listed, counts
            assert pg.evaluate("getComputedStyle(document.querySelector('.ae-sent-h')).position") == "sticky"
            assert pg.evaluate("Math.round(document.querySelector('.ae-sent-h').getBoundingClientRect().height)") == 34
            # Typed inside the pill: every word must meet the name, the year or the world.
            pg.fill("#ae-go-q", "mars 1975")
            pg.wait_for_selector("#ae-go-groups [data-ae-go]")
            got = pg.evaluate("Array.from(document.querySelectorAll('#ae-go-groups [data-ae-go]')).map(b => b.dataset.aeGo)")
            assert "sent:viking-1" in got and "sent:viking-2" in got and all(k.startswith("sent:") for k in got), got
            assert "sent:mars2" not in got and "sent:mars3" not in got, "a craft with no place to go to today is not found"
            assert "sent:mro" not in got
            pg.fill("#ae-go-q", "apollo moon")
            got = pg.evaluate("Array.from(document.querySelectorAll('#ae-go-groups [data-ae-go]')).map(b => b.dataset.aeGo)")
            assert "sent:apollo-11" in got and "sent:voyager1" not in got, got
            pg.fill("#ae-go-q", "")
            # An orbiter still working goes to its world and says its place in the orbit is not shown; every row has a model now, so none says its shape is generic.
            pg.evaluate("_aeGoPick('sent:mro')")
            pg.wait_for_function("() => !!_ae.sent && _ae.preset === 'mars'", timeout=30_000)
            card = pg.inner_text("#ae-card")
            assert "Orbiting Mars" in card and "Place in orbit not shown" in card and "Shape is generic" not in card, card
            pg.click("#ae-find")
            pg.wait_for_selector(".ae-sent-row", state="attached")
            pg.click("[data-ae-go='sent:vega-1']")
            pg.wait_for_function("() => _ae.lm && _ae.lm.row[0] === 'Vega 1'", timeout=30_000)
            assert "Shape is generic" not in pg.inner_text("#ae-card")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_list_is_about_today_wherever_the_clock_is_and_a_tap_brings_the_clock_to_the_thing(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            pg.evaluate("_aeGoTo(Date.UTC(1969, 6, 20, 12))")  # the view's clock where a visit to Apollo 11 leaves it
            pg.click("#ae-find") if pg.is_hidden("#ae-go") else None
            text = pg.evaluate("document.getElementById('ae-go-groups').innerText")   # (the Sent pill is a list whichever the sheet is set to)
            assert "Not launched" not in text and "In flight" not in text, "a thing launched by today reads as not launched"
            assert "Plan a flight" not in text and pg.evaluate("document.querySelectorAll('#ae-go-groups .ae-sent-foot').length") == 0, "no planner in this release"
            heights = pg.evaluate("Array.from(document.querySelectorAll('#ae-go-groups .ae-sent-row')).map(b => Math.round(b.getBoundingClientRect().height))")
            assert set(heights) == {76}, sorted(set(heights))
            # A site: the clock comes to its landing. A craft: to now.
            pg.click("[data-ae-go='sent:apollo-15']")
            pg.wait_for_function("() => _ae.lm && _ae.lm.row[0] === 'Apollo 15'", timeout=30_000)
            assert pg.evaluate("_aeDisplayMs()") >= pg.evaluate("Date.UTC(1971, 6, 30)")
            card = pg.inner_text("#ae-card")
            assert "Not launched" not in card and "Position unknown" not in card, card
            pg.evaluate("_aeGoTo(Date.UTC(1969, 6, 20, 12))")
            pg.click("#ae-find")
            pg.wait_for_selector(".ae-sent-row", state="attached")
            pg.click("[data-ae-go='sent:voyager1']")
            pg.wait_for_function("() => _ae.preset === 'voyager1'", timeout=30_000)
            assert abs(pg.evaluate("_aeDisplayMs() - Date.now()")) < 86_400_000
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_lost_row_leaves_no_craft_in_view_and_an_ended_one_with_a_model_shows_it(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            pg.click("[data-ae-go='sent:voyager1']")
            pg.wait_for_function("() => _ae.preset === 'voyager1'", timeout=30_000)
            pg.click("#ae-find")
            pg.wait_for_selector(".ae-sent-row", state="attached")
            pg.evaluate("_aeGoPick('sent:marsobserver')")
            pg.wait_for_function("() => _ae.preset === 'mars' && !!_ae.sent", timeout=30_000)
            assert pg.evaluate("_ae.arrived") != "voyager1"
            pg.click("#ae-find")
            pg.wait_for_selector(".ae-sent-row", state="attached")
            pg.evaluate("_aeGoPick('sent:phobos1')")  # no world to be near: the whole system
            pg.wait_for_function("() => _ae.preset === 'planets' && !!_ae.sent", timeout=30_000)
            pg.click("#ae-find")
            pg.wait_for_selector(".ae-sent-row", state="attached")
            pg.evaluate("_aeGoPick('sent:cassini')")
            pg.wait_for_function("() => _ae.sent && _ae.sent.o.id === 'cassini'", timeout=30_000)
            card = pg.inner_text("#ae-card")
            assert "Saturn" in card and "2017" in card and "Shape is generic" not in card, card
            assert pg.evaluate("document.querySelectorAll('#ae-card .ae-sent-head .ae-sent-img').length") == 1
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_sent_sheet_follows_the_red_tokens(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            pg.evaluate("document.documentElement.classList.add('night-red')")
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            pg.wait_for_selector(".ae-sent-img", state="attached")
            pg.add_style_tag(content="*{transition:none!important}")   # (the pill's colours ease in: measure them settled)
            pg.wait_for_function("() => document.querySelector('[data-ae-pill=sent]').classList.contains('active')", timeout=30_000)
            pg.wait_for_timeout(300)
            got = pg.evaluate(
                """() => {
                  var c = function (q, p) { var e = document.querySelector(q); return e ? getComputedStyle(e)[p] : null; };   // no row has a silhouette now: every one has a picture
                  return { pill: c('[data-ae-pill=sent]', 'color'), pillBg: c('[data-ae-pill=sent]', 'backgroundColor'), text: c('.ae-go', 'color'),
                    sil: c('.ae-sent-sil', 'color'), pic: c('.ae-sent-img', 'filter'), small: c('.ae-sent-text small', 'color'), text2: getComputedStyle(document.documentElement).getPropertyValue('--text2') };
                }"""
            )
            assert got["pic"] != "none" and "grayscale" in got["pic"], got
            assert got["pill"] != got["pillBg"] and got["pillBg"] == "rgba(255, 32, 16, 0.16)", got  # the active pill is a red tint (the amber glow in the red tokens) with its outline, not a solid red
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_row_is_a_destination_for_the_ship_while_it_flies(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            # A flight is stood in for within one call (no frame runs on the stand-in), the ship's own entry recording what it was told.
            got = pg.evaluate(
                """() => {
                  var calls = [], was = window._aeFlyGoTo;
                  window._aeFlyGoTo = function (t) { calls.push(t); return { ok: true }; };
                  _ae.ship = {};
                  _aeSentPick('sent:apollo-17'); var site = _ae.lm && _ae.lm.row[0];
                  _aeSentPick('sent:iss');
                  _aeSentPick('sent:marsobserver'); var lost = !!_ae.sent;
                  _ae.ship = null; window._aeFlyGoTo = was;
                  return { calls: calls, site: site, lost: lost, preset: _ae.preset };
                }"""
            )
            assert got["calls"] == ["moon", "earth", "mars"], got
            assert got["site"] is None and not got["lost"], "a card opened in a flight: " + repr(got)
            assert got["preset"] != "mars", "the camera flew as well as the ship"
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("key,mode", [("planets", "system"), ("spin", "sbs")])
def test_the_whole_views_picked_while_flying_leave_the_ship_and_open(library, key, mode):
    # The sheet's Solar system and Side by side tiles did nothing in the UFO: the ship swallowed the pick.
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            pg.evaluate("() => enterFly()")
            pg.wait_for_function("() => !!(_ae.ship && _ae.ship.craft)", timeout=60_000)
            pg.evaluate("(k) => _aeGoPick(k === 'spin' ? AE_SPIN_KEY : k)", key)
            pg.wait_for_function("(m) => _aeMode() === m", arg=mode, timeout=20_000)
            assert not pg.evaluate("() => !!_ae.ship"), "the ship is still flying under the view"
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_every_orbiting_and_tracked_row_has_a_finite_place_in_the_view_today_and_in_2030(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            bad = pg.evaluate(
                """() => {
                  var bad = [], when = [Date.now(), Date.UTC(2030, 0, 1)];
                  _aeSent.objects.forEach(function (o) {
                    var w = o.where, key = w.track || (w.iss ? 'iss' : w.body);
                    if (['orbiting', 'tracked', 'leaving'].indexOf(o.state) < 0) return;
                    when.forEach(function (ms, i) {
                      var tr = w.track && _aeTracks.tracks[w.track], jd = ms / MS_PER_DAY + JD_UNIX_EPOCH;
                      if (tr && (jd < tr.jd0 || jd > tr.jd1)) { if (i === 0) bad.push(o.id + ' no table today'); return; }   // past its table: shown as unknown, never guessed
                      var p = _aeBodyPos(key, _aeSceneAt(ms));
                      if (!p || !p.every(isFinite)) bad.push(o.id + ' ' + i);
                    });
                  });
                  return bad;
                }"""
            )
            assert bad == [], bad
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_lost_thing_is_drawn_as_a_faint_tumbling_stand_in_near_its_world_until_its_card_goes(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sent_ready(pg)
            pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)
            pg.evaluate("_aeGoPick('sent:marsobserver')")
            pg.wait_for_function("() => !!_ae.sentGhost && _ae.sentGhost.line.visible", timeout=30_000)
            card = pg.inner_text("#ae-card")
            assert "Last contact" in card and "1993" in card and "not tracked" in card and "Position unknown" in card, card
            first = pg.evaluate("_ae.sentGhost.line.rotation.x")
            pg.wait_for_timeout(600)
            assert pg.evaluate("_ae.sentGhost.line.rotation.x") != first, "it does not tumble"
            near = pg.evaluate(
                """() => { var p = _ae.sentGhost.line.position, m = _aeBodyPos('mars'), r = AE_TARGETS.mars.surface;
                  return Math.hypot(p.x - m[0], p.y - m[1], p.z - m[2]) / r; }"""
            )
            assert 1.2 < near < 2.2, near
            assert pg.evaluate("_ae.sentGhost.line.material.opacity") < 0.7
            pg.click("#ae-card-x")
            pg.wait_for_function("() => !_ae.sentGhost", timeout=30_000)
            # No world to be near, nothing drawn.
            pg.click("#ae-find")
            pg.wait_for_selector(".ae-sent-row", state="attached")
            pg.evaluate("_aeGoPick('sent:phobos1')")
            pg.wait_for_function("() => !!_ae.sent", timeout=30_000)
            pg.wait_for_timeout(500)
            assert pg.evaluate("!_ae.sentGhost")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()



ROUND_JS = """() => [...document.querySelectorAll('.ae-btn.ae-round')].filter(b => b.offsetWidth).map(b => {
  const s = getComputedStyle(b), a = getComputedStyle(b, '::after'), r = b.getBoundingClientRect();
  return { id: b.id || b.className, w: r.width, h: r.height, border: s.borderTopColor, bg: s.backgroundColor, ink: s.color,
           pressed: b.getAttribute('aria-pressed') === 'true', blur: s.backdropFilter || s.webkitBackdropFilter, radius: s.borderTopLeftRadius, hit: [parseFloat(a.width), parseFloat(a.height)] };
})"""


@pytest.mark.parametrize("red", [False, True])
def test_the_round_buttons_are_one_size_and_one_material(library, red):
    """The 3D view's round buttons (the right-hand column, the rim and camera, the drive and mission buttons): 32 drawn, a 44 hit
    area, one glass recipe from the tokens (Red: black, a red hairline, no blur), selected is an outline, never a fill."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            if red:
                pg.evaluate("document.documentElement.classList.add('night-red')")
                # (a disc's fill eases over to the red glass; the ease runs in frames, so a slow renderer takes longer: wait for its end, not a time)
                pg.wait_for_function("() => ['ae-find','ae-rim','ae-locate','ae-orbits-btn'].every(i => { const e = document.getElementById(i); return !e || getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0.6)'; })", timeout=30000)
            rows = pg.evaluate(ROUND_JS)
            assert len(rows) >= 4, rows
            assert {(round(r["w"]), round(r["h"])) for r in rows if r["id"] in ("ae-back", "ae-fly-btn", "ae-rim", "ae-locate", "ae-cam")} == {(44, 44)}, rows   # the top bar's two circles and the corner's: one size, a finger's own
            assert all(r["hit"][0] >= 44 and r["hit"][1] >= 44 for r in rows), rows
            rows = [r for r in rows if r["id"] not in ("ae-back", "ae-fly-btn")]   # (the two circles of the top capsule have the capsule's glass, not their own)
            # the minor discs (locate, and Landmarks and Orbits stacked over it) are a rank below in their ink only
            minor = ("ae-locate", "ae-lm-btn", "ae-orbits-btn")
            assert len({(r["border"], r["bg"], r["ink"], r["blur"], r["radius"]) for r in rows if r["id"] not in minor}) <= 2, rows
            assert len({(r["border"], r["bg"], r["blur"], r["radius"]) for r in rows}) <= 2, rows
            glass = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--glass-blur').trim()")
            assert (glass == "none") == red, glass
            if red:
                bad = [(r["id"], r["bg"], r["border"]) for r in rows if not r["pressed"] and not (r["bg"] == "rgba(0, 0, 0, 0.6)" and r["border"] == "rgb(92, 14, 6)")]
                assert not bad, bad
            else:
                assert all("blur(16px)" in (r["blur"] or "") for r in rows), rows
            look = "() => { const s = getComputedStyle(document.getElementById('ae-locate')); return [s.borderTopColor, s.backgroundColor]; }"
            was = pg.evaluate(look)
            pg.evaluate("document.getElementById('ae-locate').setAttribute('aria-pressed', 'true')")
            sel = pg.evaluate(look)
            assert sel[0] != was[0] and sel[1] == was[1], (sel, was)  # an outline: the border changes, the fill does not
            assert not errors, errors
            ctx.close()
        finally:
            br.close()



SHEET_JS = """(sel) => { const e = document.querySelector(sel), s = getComputedStyle(e); const sizes = new Set();
  e.querySelectorAll('*').forEach(n => { if (n.closest('.pill, .ae-btn, .ae-card-x, .ae-go-x, .alm-dismiss-x')) return; if ([...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) sizes.add(parseFloat(getComputedStyle(n).fontSize)); });
  return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, shadow: s.boxShadow !== 'none', sizes: [...sizes] }; }"""
CLOSE_JS = """(sel) => { const b = document.querySelector(sel), r = b.getBoundingClientRect(), p = b.parentElement.getBoundingClientRect(); return [r.width, r.height, r.top - p.top, p.right - r.right]; }"""
SCALE_PX = {11, 13, 15, 17, 20}  # tokens.css: caption, small, body, title, sheet


def test_the_go_sheet_the_cards_and_the_settings_are_one_sheet(library):
    """Opaque (#141416), radius 14, the popup shadow, one close control (44 square, the top end corner), and every size from the scale (the pill, the buttons and the close glyph are their own components)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            seen = []
            pg.click("#ae-find")
            pg.wait_for_selector("#ae-go:not([hidden])", state="visible")
            seen.append(("go", pg.evaluate(SHEET_JS, "#ae-go"), None))   # its way out is the band's circle and a swipe down, not a corner x
            pg.evaluate("_aeShowGo(false)")
            pg.evaluate("_aeShowSettings(true)")
            pg.wait_for_selector(".ae-set-choice", state="visible")
            seen.append(("set", pg.evaluate(SHEET_JS, "#ae-drawer"), pg.evaluate(CLOSE_JS.replace("b.parentElement", "document.getElementById('ae-drawer')"), "#ae-set .alm-dismiss-x")))   # (the settings are the drawer: its glass, its corner)
            pg.evaluate("_aeShowSettings(false)")
            pg.evaluate("() => { _ae.place = { kind: 'landmark', name: 'Mount Everest', label: 'Mount Everest', lat: 27.99, lon: 86.93, article: null }; _aeRenderCard(); }")
            pg.wait_for_selector("#ae-card-x", state="visible")
            seen.append(("card", pg.evaluate(SHEET_JS, "#ae-card"), pg.evaluate(CLOSE_JS, "#ae-card-x")))
            for name, look, close in seen:
                assert look["bg"] == "rgb(14, 14, 16)" and look["radius"] == "22px" and look["shadow"], (name, look)   # one panel colour (the sheet's pinned head is opaque, so the sheet is too): the chip's edge and radius
                assert close is None or (close[0] == 44 and close[1] == 44 and close[2] <= 1 and close[3] <= 1), (name, close)
                assert set(look["sizes"]) <= SCALE_PX, (name, look["sizes"])
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_a_pill_lists_each_name_plain_and_only_a_same_named_pair_says_which(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT)
            _sheet_ready(pg)
            pg.wait_for_function("() => !!_aeLm", timeout=60_000)
            pg.click("[data-ae-pill=landings]")
            names = pg.evaluate("() => Array.from(document.querySelectorAll('#ae-go-groups h4[data-g=alm_go_landings] + .ae-go-list .ae-go-row span:not(.ae-go-thumb)')).map(e => e.textContent)")
            assert names and not any("·" in n for n in names), names
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
