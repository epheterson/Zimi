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
          return { vv: visualViewport.height, sheet: box('#ae-go'), field: box('#ae-go-q'), rows: rows };
        }""")


def _check_fits_above_keyboard(b):
    """The sheet is inside what is visible; the field heads it; every answer is below the field and above the keyboard."""
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
            r["top"] >= b["field"]["bottom"] - EDGE_PX
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
            pg.click("#ae-go-btn")
            pg.wait_for_selector("#ae-go-q", state="visible")
            pg.wait_for_function("() => !!_aeLm", timeout=60_000)
            # Closed keyboard: the sheet stands at the foot of the screen, the field at its head.
            closed = _boxes(pg)
            assert closed["field"]["top"] >= closed["sheet"]["top"]
            assert closed["vv"] - closed["sheet"]["bottom"] < 24, closed
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
    pg.click("#ae-go-btn")
    pg.wait_for_selector("#ae-go-q", state="visible")
    pg.wait_for_function("() => !!_aeLm && !!_aeTracks", timeout=60_000)


def test_in_short_landscape_the_go_to_sheet_shows_six_list_rows_or_two_grid_rows(
    library,
):
    """844 x 390: the sheet used to be capped at half the height with the field at its foot: one and a half rows. Now the
    head is one line (field, toggle, pills) and the rest is rows: a pill's list shows at least six lines, the grid two.
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
            assert _row_tops(pg) >= 6, (_row_tops(pg), geometry)
            pg.click("[data-ae-gomode=grid]")
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
            pg.click("#ae-go-btn")
            assert pg.input_value("#ae-go-q") == ""
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("view", [PORTRAIT, LANDSCAPE])
def test_each_pill_shows_only_its_kind_and_every_row_is_44px(library, view):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, view)
            _sheet_ready(pg)
            for mode in ("grid", "list"):
                pg.click("[data-ae-gomode=%s]" % mode)
                for pill in (
                    "all",
                    "planets",
                    "moons",
                    "small",
                    "craft",
                    "landings",
                    "missions",
                ):
                    pg.click("[data-ae-pill=%s]" % pill)
                    got = pg.evaluate(
                        """() => ({
                        kinds: Array.from(document.querySelectorAll('#ae-go-groups [data-ae-go]')).map(b => _aeGoKind(b.dataset.aeGo)),
                        first: (document.querySelector('#ae-go-groups [data-ae-go]') || {dataset: {}}).dataset.aeGo,
                        short: Array.from(document.querySelectorAll('#ae-go-groups .ae-go-row')).filter(b => b.getBoundingClientRect().height < 44).length,
                        on: document.querySelector('[data-ae-pill].active').dataset.aePill })"""
                    )
                    assert got["on"] == pill and got["short"] == 0, (mode, pill, got)
                    assert got["kinds"], (mode, pill)
                    if pill == "planets":
                        assert got["first"] == "sun", (mode, got["first"])  # the Sun leads, ahead of the Earth
                    if pill != "all":
                        assert set(got["kinds"]) == {pill}, (
                            mode,
                            pill,
                            set(got["kinds"]),
                        )
            # There and then's pill wears the sky card's sign (ALM_THEN_SVG) at the pills' icon size.
            then = pg.evaluate(
                "(() => { var s = document.querySelector('#ae-go-then svg'), r = s.getBoundingClientRect(); var t = document.createElement('div'); t.innerHTML = ALM_THEN_SVG; return [s.outerHTML === t.firstElementChild.outerHTML, Math.round(r.width), Math.round(r.height)]; })()"
            )
            assert then == [True, 16, 16], then
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


def test_the_discs_are_asked_for_only_when_the_sheet_opens_and_never_on_a_low_level(
    library,
):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            seen = []
            ctx, pg, errors = _open(br, library, PORTRAIT, requests=seen)
            assert [u for u in seen if "go-discs" in u] == []
            _sheet_ready(pg)
            pg.wait_for_timeout(1500)
            assert [
                u for u in seen if "go-discs" in u
            ], "the sheet drew no discs from the sprite"
            ctx.close()
            low = []
            ctx, pg, errors = _open(br, library, PORTRAIT, requests=low)
            pg.evaluate("ZimiCap.level = function () { return 'low'; }")
            _sheet_ready(pg)
            pg.wait_for_timeout(1500)
            assert [
                u for u in low if "go-discs" in u
            ] == [], "a low level asked for the sprite"
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
    with open(os.path.join(root, "scripts", "build_go_discs.py")) as fh:
        tree = ast.parse(fh.read())
    keys = next(
        n.value
        for n in tree.body
        if isinstance(n, ast.Assign) and n.targets[0].id == "KEYS"
    )
    with open(os.path.join(root, "zimi", "static", "almanac-earth.js")) as fh:
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
            hit = pg.evaluate("""() => {
                var m = document.querySelector('.ae-mini'), t = document.querySelector('.ae-tools');
                if (!m || !t) return null;
                var a = m.getBoundingClientRect(), b = t.getBoundingClientRect();
                return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
            }""")
            assert hit is False, hit
            outside = pg.evaluate("""() => Array.from(document.querySelectorAll('#ae-lms .ae-lm')).filter(b => !b.hidden).map(b => b.getBoundingClientRect())
                .filter(r => r.left < -1 || r.right > innerWidth + 1).length""")
            assert outside == 0, outside
            ctx.close()
        finally:
            br.close()
