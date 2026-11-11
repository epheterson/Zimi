"""The Menu's panes on a phone: the About link is a finger's size, and the panes hold in Hebrew and landscape.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_pa_menu.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, shell_ready  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.environ.get("PA_GAMES_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
TOUCH_MIN_PX = 44
PAGES = ["pig", "shutthebox", "oddone", "walls", "courtier"]


@pytest.fixture(scope="module")
def served():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def open_about(browser, served, name, view, lang=None):
    ctx = browser.new_context(
        viewport=view, has_touch=True, is_mobile=True, device_scale_factor=2
    )
    page = ctx.new_page()
    page.goto(
        "%s/%s.html%s" % (served, name, "#lang=%s&dir=rtl" % lang if lang else "")
    )
    shell_ready(page)
    page.tap(".gs-menu-btn")
    page.wait_for_selector(".gs-sheet:not([hidden]) .gs-grid .gs-tile")
    tiles = page.locator(".gs-sheet:not([hidden]) .gs-grid .gs-tile")
    tiles.nth(tiles.count() - 1).tap()  # About is the last tile
    page.wait_for_selector(".gs-about .gs-text a", timeout=15000)
    frames(page, 3)
    return ctx, page


@pytest.mark.parametrize("name", PAGES)
@pytest.mark.parametrize(
    "view",
    [{"width": 390, "height": 844}, {"width": 844, "height": 390}],
    ids=["portrait", "landscape"],
)
def test_the_about_link_is_a_finger_tall_and_on_screen(served, browser, name, view):
    ctx, page = open_about(browser, served, name, view)
    box = page.evaluate(
        "(() => { const r = document.querySelector('.gs-about .gs-text a').getBoundingClientRect(); return [r.width, r.height, r.left, r.right]; })()"
    )
    assert box[1] >= TOUCH_MIN_PX, "the About link is %dpx tall" % box[1]
    assert box[2] >= 0 and box[3] <= view["width"], box
    ctx.close()


@pytest.mark.parametrize("name", PAGES)
@pytest.mark.parametrize("lang", ["he", "ar"])
def test_the_about_pane_holds_in_right_to_left(served, browser, name, lang):
    ctx, page = open_about(browser, served, name, {"width": 390, "height": 844}, lang)
    got = page.evaluate(
        """() => { const card = document.querySelector('.gs-sheet:not([hidden]) .ar-sheet-card').getBoundingClientRect(), out = [];
          for (const e of document.querySelectorAll('.gs-sheet:not([hidden]) button, .gs-about a, .gs-about dt, .gs-about dd')) { const r = e.getBoundingClientRect();
            if (r.width && (r.left < card.left - 0.5 || r.right > card.right + 0.5)) out.push([e.className || e.tagName, Math.round(r.left), Math.round(r.right)]); }
          return { out, dir: document.documentElement.dir, scrollW: document.documentElement.scrollWidth }; }"""
    )
    assert got["dir"] == "rtl" and not got["out"] and got["scrollW"] <= 390, got
    ctx.close()
