"""Four things a 390px phone showed in the regression sweep (2026-11-04).

- The reader's search box: what was typed ran under the clear ×.
- An app tile's ⋯ opened a menu with one item, Open, the tap the tile already is.
- Discover: a picture that failed left its card all text, stretched to its
  neighbour's height with a blank half.
- Create, Folder on this server: a left-out file's name pushed "left out ·
  size" onto a line of its own when long and not when short, so the rows
  stopped lining up.
- A page with no <title> was saved as the last part of its path ("Water")
  although the entry's title was known ("Water purification").

A real server (management open, so Create is too) on fixture ZIMs, an emulated phone.
"""

import os
import socket
import subprocess
import sys

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from games_wait import wait_for_server  # noqa: E402

PHONE = dict(
    viewport={"width": 390, "height": 844},
    device_scale_factor=2,
    is_mobile=True,
    has_touch=True,
    service_workers="block",
)
LONG = "a_file_with_a_rather_long_name_that_cannot_fit_beside_its_size.zim"


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    from conftest_zim import build_fixture_zim, build_wiki_fixture_zim

    base = tmp_path_factory.mktemp("polish")
    zims, data, root = base / "zims", base / "data", base / "root"
    for d in (zims, data, root):
        d.mkdir()
    build_wiki_fixture_zim(str(zims / "wikipedia_en_test.zim"))
    build_fixture_zim(str(zims / "survival_en_test.zim"))
    for name in ("a.zim", LONG):
        (root / name).write_bytes(b"ZIM\x04" + b"\0" * 2048)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(
        os.environ,
        ZIMI_TORRENT="0",
        ZIMI_OFFLINE="1",
        ZIMI_RATE_LIMIT="1000000",
        ZIM_DIR=str(zims),
        ZIMI_DATA_DIR=str(data),
        ZIMI_CREATE_ROOT=str(root),
        ZIMI_MANAGE="1",
        ZIMI_MANAGE_OPEN="1",
    )
    env.pop("ZIMI_BUILTIN_ZIMS", None)  # the apps' tiles include Zimi's own
    proc = subprocess.Popen(
        [sys.executable, "-m", "zimi", "serve", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_for_server(port):
            pytest.skip("zimi did not start")
        yield "http://127.0.0.1:%d" % port
    finally:
        proc.terminate()
        proc.wait(timeout=20)


@pytest.fixture(scope="module")
def page(zimi):
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(**PHONE)
        pg = ctx.new_page()
        pg.fresh = lambda: b.new_context(**PHONE).new_page()
        yield pg
        b.close()


def _home(pg, base):
    pg.goto(base + "/", wait_until="load")
    pg.wait_for_function("() => document.querySelector('.app-tile')", timeout=30000)


def test_what_is_typed_stops_short_of_the_clear_button(page, zimi):
    page.goto(zimi + "/?a=survival_en_test%2FA%2FFire", wait_until="load")
    page.wait_for_function(
        "() => typeof readerOpen !== 'undefined' && readerOpen", timeout=30000
    )
    page.fill("#q", "Acrux and a much longer query than the box")
    gap = page.evaluate("""() => {
      const q = document.getElementById('q'), x = document.getElementById('search-clear');
      const r = q.getBoundingClientRect(), cs = getComputedStyle(q);
      return x.getBoundingClientRect().left - (r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth));
    }""")
    assert gap >= 0, f"the text box reaches {-gap:.0f}px under the ×"


def test_an_app_tile_has_a_menu_only_when_it_holds_more_than_open(page, zimi):
    _home(page, zimi)
    # Signed out, an app with no ZIM of its own (Dictionary) has Open alone: no ⋯. The Almanac has its own ZIM.
    feet = page.evaluate(
        "() => { const was = _userSession; _userSession = null;"
        " const r = [_appTileFootHtml('dictionary'), _appTileFootHtml('almanac')]; _userSession = was; return r; }"
    )
    assert "card-more" not in feet[0], feet[0]
    assert "card-more" in feet[1], feet[1]
    # Every ⋯ on the page opens more than Open (read in one go: Home redraws its tiles as the library settles).
    menus = page.evaluate("""() => [...document.querySelectorAll('.app-tile:not(.app-empty) .card-more')].map(btn => {
      _cardMore(btn);
      const n = [...document.querySelectorAll('#zim-ctx-menu > .ctx-item')].length;
      _closeMenu();
      return [btn.closest('.app-tile').dataset.app, n];
    })""")
    assert menus, "no app tile has a menu"
    one = [app for app, n in menus if n < 2]
    assert not one, f"a menu of one item: {one}"


def test_a_discover_card_whose_picture_fails_keeps_a_picture_of_its_source(page, zimi):
    _home(page, zimi)
    page.wait_for_function("() => document.querySelector('.discover-card img.dc-thumb')", timeout=30000)
    # One card's picture fails (a picture the ZIM lists but does not hold), as the sweep's On This Day did; every
    # picture then loads or fails (the row's later ones wait to be scrolled to).
    page.evaluate("""() => {
      const imgs = [...document.querySelectorAll('.discover-card img.dc-thumb')];
      imgs.forEach(i => { i.loading = 'eager'; });
      if (imgs[0]) imgs[0].src = '/w/survival_en_test/I/not-there.png';
      return imgs.length;
    }""")
    page.wait_for_function(
        "() => [...document.querySelectorAll('.discover-card img.dc-thumb')].every(i => i.complete)", timeout=30000
    )
    page.wait_for_timeout(300)
    blank = page.evaluate(
        """() => [...document.querySelectorAll('.discover-card')].filter(c => {
      const pic = c.querySelector('.dc-thumb, .dc-icon-thumb, .dc-today, .dc-star');
      return !pic || pic.hidden || getComputedStyle(pic).display === 'none' || pic.getBoundingClientRect().height < 60;
    }).map(c => c.querySelector('.dc-title') && c.querySelector('.dc-title').textContent)"""
    )
    assert not blank, f"cards with no picture showing: {blank}"


def test_a_left_out_file_keeps_its_name_and_size_on_one_line(page, zimi):
    page.goto(zimi + "/", wait_until="load")
    page.wait_for_function(
        "() => typeof window.openCreate === 'function'", timeout=30000
    )
    page.evaluate("() => window.openCreate()")
    page.locator(".create-chip[onclick*=\"'folder'\"]").click()
    tree = page.locator("#create-folder-tree")
    tree.locator(f'.create-ftree-row[data-path="{LONG}"]').wait_for(timeout=30000)
    lines = page.evaluate(
        """() => [...document.querySelectorAll('#create-folder-tree .create-ftree-row.is-off')].map(r => {
      const n = r.querySelector('.create-ftree-name').getBoundingClientRect(), w = r.querySelector('.create-ftree-what').getBoundingClientRect();
      return [r.dataset.path, Math.abs((n.top + n.bottom) / 2 - (w.top + w.bottom) / 2)];
    })"""
    )
    assert len(lines) == 2, lines
    off = [p for p, d in lines if d > 4]
    assert not off, f"name and size on different lines: {off}"


def test_a_page_with_no_title_is_named_by_its_entry(page, zimi):
    """The fixture's pages have no <title>; the search result is "Water purification".
    A fresh phone: the earlier tests' visits stay out of it."""
    page = page.fresh()
    page.goto(zimi + "/", wait_until="load")
    page.wait_for_function("() => typeof openArticle === 'function'", timeout=30000)
    page.evaluate(
        "() => openArticle('survival_en_test', 'A/Water', 'Water purification')"
    )
    page.wait_for_function(
        "() => { const f = document.getElementById('reader-frame'); return f && f.contentDocument"
        " && f.contentDocument.readyState === 'complete' && /A\\/Water$/.test(f.contentWindow.location.pathname); }",
        timeout=30000,
    )
    page.wait_for_timeout(1000)
    assert page.evaluate("() => document.title").startswith("Water purification"), page.evaluate("() => document.title")
    assert page.evaluate("() => _savedRefOnScreen().title") == "Water purification"
