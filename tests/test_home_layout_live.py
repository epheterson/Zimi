"""Home's layout at every width.

Discover first, then Apps, then Favorites and the library. The library's card grids flow 1 / 2 / 3 / 4 columns at
about 600 / 1200 / 1600 px and never more, Home stopping at ~1600 px, centred. The apps are square launcher tiles,
the same size on a phone and a wide screen, packed from the start edge and never stretched to fill the row. Nothing
pushes a phone's page sideways.

Run: pytest tests/test_home_layout_live.py -v
"""

import json
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from test_home_apps_live import HOME, LIBRARY  # noqa: E402

# More of one kind, so a category holds a full row at the widest width.
MORE = [
    ("devdocs_en_%s_2026-01.zim" % n, {"Name": "devdocs_en_%s" % n, "Title": n.title()})
    for n in ("python", "javascript", "rust", "go", "bash")
]
FAVORITES = ["devdocs_en_python", "devdocs_en_rust"]

WIDTHS = {
    390: (
        dict(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            device_scale_factor=3,
        ),
        1,
    ),
    820: (
        dict(viewport={"width": 820, "height": 1180}, is_mobile=True, has_touch=True),
        2,
    ),
    1280: (dict(viewport={"width": 1280, "height": 800}), 3),
    1600: (dict(viewport={"width": 1600, "height": 1000}), 4),
    1920: (dict(viewport={"width": 1920, "height": 1080}), 4),
}

MEASURE = r"""() => {
  const box = el => el.getBoundingClientRect();
  const out = document.getElementById('output');
  const disc = document.getElementById('discover-row');
  const appsGrid = out.querySelector('.apps-grid');
  const appsHead = appsGrid && appsGrid.previousElementSibling && appsGrid.previousElementSibling.classList.contains('apps-help')
    ? appsGrid.previousElementSibling.previousElementSibling : appsGrid && appsGrid.previousElementSibling;
  const libGrids = Array.from(out.querySelectorAll('.stats-grid:not(.apps-grid)'));
  const tiles = Array.from(out.querySelectorAll('.apps-grid .app-tile'));
  const g = appsGrid && box(appsGrid);
  const c = box(document.querySelector('#main-view .container'));
  return {
    discoverFirst: !!disc && !!appsGrid && !!(disc.compareDocumentPosition(appsGrid) & Node.DOCUMENT_POSITION_FOLLOWING),
    discoverAbove: !!disc && !!appsHead && box(disc).bottom <= box(appsHead).top,
    favAfterApps: (() => { const f = libGrids[0]; return !!f && !!appsGrid && !!(appsGrid.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) && box(f).top >= g.bottom; })(),
    columns: libGrids.map(el => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length),
    tiles: tiles.map(t => { const b = box(t); return [Math.round(b.width), Math.round(b.height)]; }),
    tileIcons: tiles.map(t => { const b = box(t.querySelector('.card-icon')); return [Math.round(b.width), Math.round(b.height)]; }),
    tilesRight: tiles.length ? Math.max.apply(null, tiles.map(t => box(t).right)) : 0,
    tilesLeft: tiles.length ? Math.min.apply(null, tiles.map(t => box(t).left)) : 0,
    grid: g ? { l: g.left, r: g.right } : null,
    container: { l: c.left, r: c.right, w: c.width },
    vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
  };
}"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("homelayout")
    zdir, data = tmp / "zims", tmp / "data"
    zdir.mkdir()
    data.mkdir()
    for filename, meta, _ in LIBRARY:
        build_fixture_zim(str(zdir / filename), meta)
    for filename, meta in MORE:
        build_fixture_zim(str(zdir / filename), meta)
    (data / "collections.json").write_text(
        json.dumps({"version": 1, "favorites": FAVORITES, "collections": {}}),
        encoding="utf-8",
    )
    mp = pytest.MonkeyPatch()
    mp.setenv("ZIMI_APPS", ",".join(srv.APP_NAMES))
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(data))
    srv.load_cache(force=True)
    # CrashCourse's new build landed an hour ago: ZimiTube wears the dot.
    for z in srv._zim_list_cache:
        z["first_seen"] = time.time() - 60 * 86400
        z["updated_at"] = time.time() - 3600 if z["name"] == "crashcourse" else None
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


def _measure(pw, served, width, rtl=False):
    br = pw.chromium.launch()
    try:
        opts, _ = WIDTHS[width]
        ctx = br.new_context(color_scheme="dark", **opts)
        if rtl:
            ctx.add_init_script("localStorage.setItem('zimi_ui_lang','ar');")
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(served + "/")
        pg.wait_for_function(HOME, timeout=30000)
        pg.wait_for_function(
            "() => !!document.querySelector('#discover-row .discover-card')",
            timeout=15000,
        )
        m = pg.evaluate(MEASURE)
        assert not errors, errors
        return m
    finally:
        br.close()


@pytest.mark.parametrize("width", sorted(WIDTHS))
def test_home_flows_with_the_width(served, width):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        m = _measure(pw, served, width)
    cols = WIDTHS[width][1]
    # Discover, then Apps, then the library (Favorites first).
    assert m["discoverFirst"] and m["discoverAbove"], m
    assert m["favAfterApps"], m
    # Every card grid has the columns this width gets, never more than four.
    assert m["columns"] and set(m["columns"]) == {cols}, m["columns"]
    # Home stops at about 1600 px and sits centred.
    assert m["container"]["w"] <= 1600 + 2 * 16 + 1, m["container"]
    assert abs(m["container"]["l"] - (m["vw"] - m["container"]["r"])) <= 1, m[
        "container"
    ]
    # Square tiles, one size, packed from the start edge: the row is not stretched to fill.
    assert m["tiles"] and len(set(map(tuple, m["tiles"]))) == 1, m["tiles"]
    assert (
        len(set(map(tuple, m["tileIcons"]))) == 1
        and m["tileIcons"][0][0] == m["tileIcons"][0][1]
    ), m["tileIcons"]
    assert m["tiles"][0][0] <= 96, "a launcher tile, not a card: %s" % m["tiles"]
    assert abs(m["tilesLeft"] - m["grid"]["l"]) <= 1, m
    if width >= 1280:
        assert (
            m["grid"]["r"] - m["tilesRight"] > 200
        ), "the tiles keep their size and leave the rest of the row"
    # Nothing pushes the page sideways.
    assert m["sw"] <= m["vw"], m


def test_tiles_are_the_same_size_on_a_phone_and_a_wide_screen(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        phone = _measure(pw, served, 390)
        wide = _measure(pw, served, 1920)
    assert phone["tiles"][0] == wide["tiles"][0], (phone["tiles"], wide["tiles"])


def test_right_to_left_packs_from_the_right(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        m = _measure(pw, served, 1920, rtl=True)
    assert abs(m["tilesRight"] - m["grid"]["r"]) <= 1, m
    assert m["sw"] <= m["vw"], m


# The tile's dot leads its name (as a phone marks a fresh app), on the name's line; a tile wears no ⋯, with a mouse or not.
TILE_MARKS = r"""() => {
  const tile = document.querySelector("#output .pick-tiles .app-tile[data-app='tube']");
  const zt = tile.querySelector('.pick-name .zt').getBoundingClientRect();
  const dot = tile.querySelector('.pick-name .rc-dot i');
  const d = dot && dot.getBoundingClientRect();
  const rtl = document.documentElement.dir === 'rtl';
  const more = tile.querySelector('.card-more'), cs = more && getComputedStyle(more);
  return { dot: !!dot, lead: d ? (rtl ? d.left - zt.right : zt.left - d.right) : null, dy: d ? (d.top + d.height / 2) - (zt.top + zt.height / 2) : null,
    moreShown: !!more && !!more.offsetParent && +cs.opacity > 0, badgeShown: dot ? getComputedStyle(dot).visibility !== 'hidden' : null };
}"""


@pytest.mark.parametrize("rtl", [False, True], ids=["ltr", "rtl"])
@pytest.mark.parametrize("width", [390, 1920])
def test_the_new_dot_leads_the_apps_name(served, width, rtl):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(color_scheme="dark", **WIDTHS[width][0])
            if rtl:
                ctx.add_init_script("localStorage.setItem('zimi_ui_lang','ar');")
            pg = ctx.new_page()
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            m = pg.evaluate(TILE_MARKS)
            assert m["dot"] and 0 <= m["lead"] <= 8 and abs(m["dy"]) <= 2, m
            assert not m["moreShown"] and m["badgeShown"], m
        finally:
            br.close()


def test_with_a_mouse_right_click_and_the_keyboard_open_a_tiles_menu(served):
    from playwright.sync_api import sync_playwright

    tile = "#output .pick-tiles .app-tile[data-app='tube']"
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = br.new_context(color_scheme="dark", **WIDTHS[1920][0]).new_page()
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            pg.hover(tile + " .card-icon")
            pg.wait_for_timeout(300)
            m = pg.evaluate(TILE_MARKS)
            assert not m["moreShown"] and m["badgeShown"], m
            for how in ("right-click", "Shift+F10"):
                pg.keyboard.press("Escape")
                pg.wait_for_selector("#zim-ctx-menu.visible", state="hidden", timeout=3000)
                if how == "right-click":
                    pg.click(tile + " .card-icon", button="right")
                else:
                    pg.focus(tile)
                    pg.keyboard.press("Shift+F10")
                pg.wait_for_selector("#zim-ctx-menu.visible [data-action=about-app]", timeout=3000)
        finally:
            br.close()


# How many compact tiles share a row, and how wide a Discover card is.
COMPACT = r"""() => ({
  cols: getComputedStyle(document.querySelector('#output .stats-grid.tiles')).gridTemplateColumns.split(' ').filter(Boolean).length,
  tile: Math.round(document.querySelector('#output .stats-grid.tiles .stat-card').getBoundingClientRect().width),
  disc: Array.from(document.querySelectorAll('#discover-row .discover-card')).map(c => Math.round(c.getBoundingClientRect().width)),
})"""


@pytest.mark.parametrize("width,cols", [(390, 3), (1280, 5), (1600, 6), (1920, 6)])
def test_compact_stays_compact_and_discover_keeps_its_size(served, width, cols):
    """"that should be like 6 of the compact and it's still only four", and the Discover cards
    "were sized nicely before, just more of them visible now"."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(color_scheme="dark", **WIDTHS.get(width, (dict(viewport={"width": width, "height": 900}),))[0])
            ctx.add_init_script("localStorage.setItem('zimi_library_view','tiles');")
            pg = ctx.new_page()
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            pg.wait_for_function("() => !!document.querySelector('#discover-row .discover-card')", timeout=15000)
            m = pg.evaluate(COMPACT)
            assert m["cols"] >= cols and m["tile"] <= 160, m  # 1.16: denser than 1.15, never sparser
            assert set(m["disc"]) == {260}, m
        finally:
            br.close()




# Home is always wide: no width toggle, the container takes the room up to --pick-max.
def test_home_is_always_wide_with_no_width_toggle(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(color_scheme="dark", **WIDTHS[1600][0])
            ctx.add_init_script("localStorage.setItem('zimi_home_width','compact');")  # an old choice is ignored
            pg = ctx.new_page()
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            pg.wait_for_selector("#output .lib-view-toggle", state="attached")
            m = pg.evaluate("""() => ({ toggle: !!document.querySelector('.home-width-toggle'),
              compact: document.body.classList.contains('home-compact'),
              w: Math.round(document.querySelector('#main-view .container').getBoundingClientRect().width) })""")
            assert not m["toggle"] and not m["compact"] and m["w"] > 1500, m
        finally:
            br.close()
