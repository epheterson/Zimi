"""Defects found playing the arcade, library, puzzle and word games on a phone: each test fails on the code before the fix.

Run: pytest tests/test_games_pt_rest.py -v
Set ZIMI_GAMES_DIR to run the same tests against another copy of the games folder (to prove them against older code).
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import shell_ready  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.environ.get("ZIMI_GAMES_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
VIEW = {"width": 390, "height": 844}


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


@pytest.fixture()
def phone(browser):
    ctx = browser.new_context(
        viewport=VIEW, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    page = ctx.new_page()
    yield page
    ctx.close()


def test_menu_opens_over_the_pass_the_phone_cover(phone, site):
    """Between people the cover hides the table but stops below the bar so Menu stays in reach: the Menu's sheet must come up over the cover, not under it."""
    phone.goto(site + "bluff.html")
    shell_ready(phone)
    phone.wait_for_selector(".pk-cover")
    phone.locator(".gs-menu-btn").tap()
    phone.wait_for_selector(".gs-sheet:not([hidden]) .ar-sheet-card", state="visible")
    top = phone.evaluate("""() => {
          const card = document.querySelector('.gs-sheet:not([hidden]) .ar-sheet-card').getBoundingClientRect();
          const el = document.elementFromPoint(card.x + card.width / 2, card.y + card.height / 2);
          return !!el.closest('.gs-sheet');
        }""")
    assert top, "the Menu opened under the pass-the-phone cover"


def test_stacker_board_keeps_its_scale_when_the_browser_drops_canvas_state(phone, site):
    """After a game over and New game the board was drawn at half size in a corner: the canvas had lost its scale. Every draw lays the scale again."""
    phone.goto(site + "stacker.html")
    shell_ready(phone)
    phone.wait_for_function("() => document.getElementById('st-board').getContext('2d').getTransform().a === 2")
    phone.evaluate("() => { const c = document.getElementById('st-board'); c.width = c.width; }")   # what losing the canvas's state does
    assert phone.evaluate("() => document.getElementById('st-board').getContext('2d').getTransform().a") == 1
    phone.emulate_media(color_scheme="dark")   # the game draws again when the theme changes
    phone.wait_for_function("() => document.getElementById('st-board').getContext('2d').getTransform().a === 2")
