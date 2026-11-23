"""Compact (tiles) library view: no text ever escapes a tile ("lots of text flowing out of the
tiles... bigger or two rows or I dunno but it's baaaad").

Long titles, long language names and a Zimi-made kind badge, at a phone, 1280 and 1600 px wide.

Run: pytest tests/test_compact_tiles_live.py -v
Set ZIMI_SHOTS=<dir> to also write a screenshot per width.
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from test_home_apps_live import HOME  # noqa: E402
from test_home_layout_live import WIDTHS  # noqa: E402

SHOTS = os.environ.get("ZIMI_SHOTS")

# Real-ish names: the long ones are what break a tile.
TITLES = [
    ("wikipedia_en_all_maxi_2026-01.zim", "wikipedia_en_all_maxi", "Wikipedia (English, all maxi)", "eng"),
    ("math.stackexchange.com_en_all_2026-01.zim", "math.stackexchange.com_en_all", "Stack Exchange: Mathematics", "eng"),
    ("wikisource_nds_nl_2026-01.zim", "wikisource_nds_nl", "Wikisource in Nedersaksisch (Low Saxon, Netherlands)", "nds"),
    ("wiktionary_zh_classical_2026-01.zim", "wiktionary_zh_classical", "Wiktionary Literary Chinese", "lzh"),
    ("devdocs_en_react_2026-01.zim", "devdocs_en_react", "Supercalifragilisticexpialidocious-DocumentationBundle", "eng"),
    ("lowtech_2026-01.zim", "lowtech", "Low-tech Magazine", "eng"),
    ("water.zim", "water", "Water", "eng"),
    ("khan_academy_es_2026-01.zim", "khan_academy_es", "Khan Academy en Español (todos los cursos de matemáticas)", "spa"),
]

# Every text-bearing descendant of a tile, and where it sits against the tile.
OVERFLOW = r"""() => {
  const rows = [];
  const tiles = Array.from(document.querySelectorAll('#output .stats-grid.tiles:not(.apps-grid) > .stat-card'));
  for (const tile of tiles) {
    const tb = tile.getBoundingClientRect();
    const kids = Array.from(tile.querySelectorAll('*')).filter(el => el.offsetParent !== null && el.childNodes.length &&
      Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim()));
    for (const el of kids) {
      const r = document.createRange(); r.selectNodeContents(el);
      const ev = el.getBoundingClientRect();
      // Text an element clips (overflow hidden, an ellipsis) shows only inside the element's own box.
      const clips = getComputedStyle(el).overflow !== 'visible';
      const b = clips ? ev : r.getBoundingClientRect();
      const bad = b.left < tb.left - 0.5 || b.right > tb.right + 0.5 || b.bottom > tb.bottom + 0.5 || b.top < tb.top - 0.5 ||
        ev.right > tb.right + 0.5 || ev.left < tb.left - 0.5 || ev.bottom > tb.bottom + 0.5;
      if (bad) rows.push({ tile: tile.dataset.zim, el: el.className || el.tagName, text: el.textContent.trim().slice(0, 40),
        t: [tb.left, tb.top, tb.right, tb.bottom].map(Math.round), b: [b.left, b.top, b.right, b.bottom].map(Math.round) });
    }
  }
  // Tiles of one row share a height.
  const byTop = {};
  for (const tile of tiles) { const b = tile.getBoundingClientRect(); (byTop[Math.round(b.top)] = byTop[Math.round(b.top)] || []).push(Math.round(b.height)); }
  const uneven = Object.values(byTop).filter(h => Math.max(...h) - Math.min(...h) > 1);
  const sw = document.documentElement.scrollWidth, vw = document.documentElement.clientWidth;
  return { n: tiles.length, rows, uneven, sw, vw, heights: tiles.map(t => Math.round(t.getBoundingClientRect().height)) };
}"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("compacttiles")
    zdir, data = tmp / "zims", tmp / "data"
    zdir.mkdir()
    data.mkdir()
    for filename, name, title, lang in TITLES:
        build_fixture_zim(
            str(zdir / filename), {"Name": name, "Title": title, "Language": lang, "Scraper": "mwoffliner 1.14"}
        )
    mp = pytest.MonkeyPatch()
    mp.setenv("ZIMI_APPS", ",".join(srv.APP_NAMES))
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(data))
    srv.load_cache(force=True)
    for z in srv._zim_list_cache:
        z["first_seen"] = time.time() - 60 * 86400
        z["updated_at"] = time.time() - 3600 if z["name"] == "lowtech" else None
    # Wiktionary, Wikisource and Khan Academy read as several languages on their tile.
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


@pytest.mark.parametrize("width", [390, 1280, 1600])
def test_no_text_escapes_a_compact_tile(served, width):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(color_scheme="dark", **WIDTHS[width][0])
            ctx.add_init_script("localStorage.setItem('zimi_library_view','tiles');")
            pg = ctx.new_page()
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            pg.wait_for_selector("#output .stats-grid.tiles .stat-card", timeout=15000)
            pg.wait_for_timeout(600)
            m = pg.evaluate(OVERFLOW)
            if SHOTS:
                pg.screenshot(path=os.path.join(SHOTS, "tiles-%d.png" % width), full_page=True)
            assert m["n"] >= len(TITLES), m
            assert not m["rows"], m["rows"]
            assert not m["uneven"], ("tiles in a row differ in height", m["uneven"])
            assert m["sw"] <= m["vw"], "nothing pushes the page sideways"
        finally:
            br.close()


# A tile's name: the first word (the distinctive one) fully visible and whole, not hyphenated or clipped.
FIRST_WORD = r"""() => {
  const out = [];
  for (const zt of document.querySelectorAll('#output .stats-grid.tiles:not(.apps-grid) > .stat-card .zt')) {
    const node = zt.firstChild; if (!node || node.nodeType !== 3) continue;
    const text = node.textContent, m = text.match(/^\s*(\S+)/); if (!m) continue;
    const r = document.createRange(); r.setStart(node, text.indexOf(m[1])); r.setEnd(node, text.indexOf(m[1]) + m[1].length);
    const rects = Array.from(r.getClientRects()), zb = zt.getBoundingClientRect();
    out.push({ word: m[1], lines: rects.length, inside: rects.every(b => b.bottom <= zb.bottom + 0.5 && b.right <= zb.right + 0.5 && b.left >= zb.left - 0.5),
      zt: Math.round(zb.width), hyph: getComputedStyle(zt).hyphens });
  }
  return out;
}"""

_FULL_AND_TILE_WIDTH = r"""() => {
  const el = document.querySelector('#output .stats-grid:not(.apps-grid) > .stat-card');
  return el ? el.getBoundingClientRect().width : 0;
}"""


def _first_card_width(pw, served, ctxargs, view):
    br = pw.chromium.launch()
    try:
        ctx = br.new_context(color_scheme="dark", **ctxargs)
        ctx.add_init_script("localStorage.setItem('zimi_library_view','%s');" % view)
        pg = ctx.new_page()
        pg.goto(served + "/")
        pg.wait_for_function(HOME, timeout=30000)
        pg.wait_for_selector("#output .stats-grid .stat-card", timeout=15000)
        pg.wait_for_timeout(400)
        return pg.evaluate(_FULL_AND_TILE_WIDTH), (pg.evaluate(FIRST_WORD) if view == "tiles" else None)
    finally:
        br.close()


@pytest.mark.parametrize("width", [390, 820, 1280, 1600])
def test_three_compact_tiles_per_full_card(served, width):
    """"Let's shoot for 3:1 sizing for the compact/full". A full card is within 2.8-3.2 of a compact tile's
    width at every breakpoint, and each name's first word is whole and visible."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        full, _ = _first_card_width(pw, served, WIDTHS[width][0], "list")
        tile, words = _first_card_width(pw, served, WIDTHS[width][0], "tiles")
    assert tile > 0 and full > 0
    assert 2.8 <= full / tile <= 3.2, (width, full, tile, full / tile)
    assert len(words) >= len(TITLES)
    for w in words:
        if w["word"] == TITLES[4][2]:  # the one word wider than any tile: clipped, never past the tile (the overflow test)
            continue
        assert w["inside"], w
        assert w["hyph"] != "auto", w
        assert w["lines"] == 1, ("the first word is split across lines", w)


# Each tile given a kind chip the way _paintProvBadges adds one (last in its name row); then, per row, where each chip's foot is.
CHIP_FEET = r"""() => {
  const tiles = Array.from(document.querySelectorAll('#output .stats-grid.tiles:not(.apps-grid) > .stat-card'));
  for (const t of tiles) { const n = t.querySelector('.name'); if (n && !n.querySelector('.prov-badge')) n.insertAdjacentHTML('beforeend', '<span class="prov-badge">Page</span>'); }
  const rows = {};
  for (const t of tiles) {
    const b = t.querySelector('.prov-badge').getBoundingClientRect(), tb = t.getBoundingClientRect();
    (rows[Math.round(tb.top)] = rows[Math.round(tb.top)] || []).push({ foot: Math.round(b.bottom), gap: Math.round(tb.bottom - b.bottom) });
  }
  return Object.values(rows);
}"""


@pytest.mark.parametrize("width", [390, 1280])
def test_a_rows_kind_chips_share_one_line_at_the_tiles_foot(served, width):
    """A one-line name and a three-line name in one row: their chips sit on the same line, at the foot of the tile."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(color_scheme="dark", **WIDTHS[width][0])
            ctx.add_init_script("localStorage.setItem('zimi_library_view','tiles');")
            pg = ctx.new_page()
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            pg.wait_for_selector("#output .stats-grid.tiles .stat-card", timeout=15000)
            rows = pg.evaluate(CHIP_FEET)
            assert rows, "no tiles"
            for row in rows:
                feet = [c["foot"] for c in row]
                assert max(feet) - min(feet) <= 1, ("chips in a row sit at different heights", row)
                assert all(c["gap"] <= 12 for c in row), ("a chip floats above the tile's foot", row)
        finally:
            br.close()
