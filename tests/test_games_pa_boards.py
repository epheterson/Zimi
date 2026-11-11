"""The world board games on a phone: a centred status line, and a board that is a board in landscape.

Found by playing Walls, Fourfold, Polyominoes and Color Trail: the status line sat 8px off centre (the thinking dot's room was
kept at its start only), and turned sideways a Walls square was 12px and a Polyominoes square 6px, because the board shrank to
what was left under the buttons.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_pa_boards.py -v
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
CENTRE_TOLERANCE_PX = 1.5
MIN_LANDSCAPE_SQUARE_PX = 18  # a finger's width is ~40, a board square on a short screen can be less, never a few pixels

# page, the board, how many squares along a side
BOARDS = [
    ("walls", "#wl-board", 9),
    ("fourfold", "#ff-board", 4),
    ("polyominoes", "#po-board", 14),
]


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


def open_page(browser, served, name, view):
    ctx = browser.new_context(
        viewport=view, has_touch=True, is_mobile=True, device_scale_factor=2
    )
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, name))
    shell_ready(page)
    page.wait_for_function(
        "document.querySelector('#wk-status') && document.querySelector('#wk-status').textContent.trim().length > 0"
    )
    frames(page, 3)
    return ctx, page


@pytest.mark.parametrize("name", ["walls", "fourfold", "polyominoes", "colortrail"])
def test_the_status_line_is_centred_on_the_screen(served, browser, name):
    ctx, page = open_page(browser, served, name, PORTRAIT)
    off = page.evaluate(
        """() => { const el = document.getElementById('wk-status'), box = el.getBoundingClientRect(), r = document.createRange();
          r.selectNodeContents(el); const t = r.getBoundingClientRect();
          return (t.left + t.right) / 2 - (box.left + box.right) / 2; }"""
    )
    assert abs(off) <= CENTRE_TOLERANCE_PX, (
        "the status text is %.1fpx off the middle of its line" % off
    )
    ctx.close()


def test_in_landscape_a_courtier_hand_can_be_played_without_scrolling(served, browser):
    ctx = browser.new_context(
        viewport=LANDSCAPE, has_touch=True, is_mobile=True, device_scale_factor=2
    )
    page = ctx.new_page()
    page.goto("%s/courtier.html" % served)
    shell_ready(page)
    page.wait_for_selector("#cr-sheet:not([hidden]) #cr-go")
    page.tap("#cr-go")
    page.wait_for_function(
        "document.querySelectorAll('#cr-hand button.cr-card').length > 0 || !document.getElementById('cr-play').hidden",
        timeout=30000,
    )
    frames(page, 4)
    got = page.evaluate(
        """() => { const r = id => document.querySelector(id).getBoundingClientRect(), play = r('#cr-play'), hand = r('#cr-hand');
          return { playBottom: play.bottom, handBottom: hand.bottom, vh: innerHeight, scrolled: scrollY }; }"""
    )
    assert got["playBottom"] <= got["vh"] and got["handBottom"] <= got["vh"], (
        "the hand and Play are below the fold: %s" % got
    )
    ctx.close()


@pytest.mark.parametrize("name,board,n", BOARDS)
def test_in_landscape_the_board_is_a_board_and_everything_stays_on_screen(
    served, browser, name, board, n
):
    ctx, page = open_page(browser, served, name, LANDSCAPE)
    got = page.evaluate(
        """(sel) => { const b = document.querySelector(sel).getBoundingClientRect(), out = [];
          for (const e of document.querySelectorAll('.bg-main > *')) { const r = e.getBoundingClientRect(); if (!r.width) continue;
            if (r.right > innerWidth + 0.5 || r.left < -0.5) out.push(['off the side', e.className || e.id, Math.round(r.left), Math.round(r.right)]); }
          return { width: b.width, bottom: b.bottom, off: out, scrollW: document.documentElement.scrollWidth }; }""",
        board,
    )
    assert got["width"] / n >= MIN_LANDSCAPE_SQUARE_PX, "a square is %.1fpx" % (
        got["width"] / n
    )
    assert not got["off"], got["off"]
    assert got["scrollW"] <= LANDSCAPE["width"], "the page scrolls sideways"
    ctx.close()
