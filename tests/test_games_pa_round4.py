"""Small text, touch targets, Hebrew and Arabic names, and landscape boards on the older families.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_pa_round4.py -v
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
PORTRAIT = {"width": 390, "height": 844}
LANDSCAPE = {"width": 844, "height": 390}
MIN_TEXT_PX = 11
TOUCH_PX = 44

SMALL_TEXT = """(min) => { const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('script,style,[hidden],.ar-back,.ar-game-art')) continue;
    if (![...e.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) continue;
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let px = parseFloat(cs.fontSize);
    if (e instanceof SVGElement && e.getScreenCTM) { const m = e.getScreenCTM(); if (m) px *= Math.hypot(m.a, m.b); }
    if (px < min - 0.01) out.push([Math.round(px * 10) / 10, (e.textContent || '').trim().slice(0, 20)]);
  } return out.slice(0, 6); }"""


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


def open_page(browser, served, name, view, lang=None, ready=None):
    ctx = browser.new_context(
        viewport=view, has_touch=True, is_mobile=True, device_scale_factor=2
    )
    page = ctx.new_page()
    page.goto(
        "%s/%s.html%s" % (served, name, "#lang=%s&dir=rtl" % lang if lang else "")
    )
    if name != "index":
        shell_ready(page)
    if ready:
        page.wait_for_selector(ready, timeout=30000)
    page.wait_for_timeout(400)
    frames(page, 3)
    return ctx, page


def open_shelf(browser, served, view, lang=None):
    ctx, page = open_page(browser, served, "index", view, lang, ".sh-chip")
    page.wait_for_function("document.querySelectorAll('.ar-game').length > 20")
    return ctx, page


def test_cribbage_board_numbers_are_readable(served, browser):
    ctx, page = open_page(browser, served, "cribbage", PORTRAIT, ready=".cb-tick")
    assert page.evaluate(SMALL_TEXT, MIN_TEXT_PX) == []
    ctx.close()


@pytest.mark.parametrize("view", [PORTRAIT, LANDSCAPE], ids=["portrait", "landscape"])
def test_no_shelf_text_is_under_11_px(served, browser, view):
    ctx, page = open_shelf(browser, served, view)
    assert page.evaluate(SMALL_TEXT, MIN_TEXT_PX) == []
    ctx.close()


def test_a_shelf_chip_can_be_hit_44_px_tall(served, browser):
    """The chip draws 28px; its hit area (a coarse pointer's ::before) reaches 44px: a tap 20px above or below its middle is its own."""
    ctx, page = open_shelf(browser, served, PORTRAIT)
    bad = page.evaluate(
        """(need) => { const out = [];
          for (const c of document.querySelectorAll('.sh-nav .sh-chip')) { const r = c.getBoundingClientRect(); if (!r.width || r.left < 0 || r.right > innerWidth) continue;   // a chip the row has scrolled half away is not tapped there
            const x = r.left + r.width / 2;
            for (const dy of [-need / 2 + 2, need / 2 - 2]) { const hit = document.elementFromPoint(x, r.top + r.height / 2 + dy);
              if (!(hit && hit.closest('.sh-chip') === c)) out.push([c.textContent.trim().slice(0, 14), dy, hit && (hit.className.baseVal || hit.className || hit.tagName)]); } }
          return out; }""",
        TOUCH_PX,
    )
    assert not bad, bad
    ctx.close()


@pytest.mark.parametrize("lang", ["he", "ar", "de"])
def test_the_logic_puzzle_names_on_the_shelf_are_in_the_players_language(
    served, browser, lang
):
    ctx, page = open_shelf(browser, served, PORTRAIT, lang)
    names = page.evaluate(
        """() => ['net', 'bridges', 'towers', 'tents', 'light up'].length && ['puzzles/net.html', 'puzzles/bridges.html', 'puzzles/towers.html', 'puzzles/tents.html'].map(h => { const a = document.querySelector('a.ar-game[href="' + h + '"] strong'); return a ? a.textContent.trim() : null; })"""
    )
    english = ["Net", "Bridges", "Towers", "Tents"]
    same = [n for n, e in zip(names, english) if n in (None, e)]
    # German keeps no English word for these four: Netz, Brücken, Türme, Zelte
    assert not same, (lang, names)
    ctx.close()


@pytest.mark.parametrize("name", ["hearts", "gofish", "euchre", "cribbage"])
def test_the_undo_button_of_a_card_game_is_translated(served, browser, name):
    ctx, page = open_page(browser, served, name, PORTRAIT, "he", "#zc-undo")
    page.wait_for_function("document.getElementById('zc-undo').textContent.trim() !== 'Undo'", timeout=8000)
    ctx.close()


@pytest.mark.parametrize(
    "name,board,min_px",
    [
        ("checkers", ".ck-board", 240),
        ("reversi", ".rv-board", 240),
        ("go", ".go-board", 200),
    ],
)
def test_in_landscape_a_grid_board_is_a_board(served, browser, name, board, min_px):
    ctx, page = open_page(browser, served, name, LANDSCAPE, ready=board)
    got = page.evaluate(
        """(sel) => { const b = document.querySelector(sel).getBoundingClientRect(), off = [];
          for (const e of document.querySelectorAll('.bg-main > *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 0.5 || r.left < -0.5)) off.push(e.className); }
          return { w: b.width, bottom: b.bottom, off, scrollW: document.documentElement.scrollWidth }; }""",
        board,
    )
    assert (
        got["w"] >= min_px and not got["off"] and got["scrollW"] <= LANDSCAPE["width"]
    ), got
    ctx.close()
