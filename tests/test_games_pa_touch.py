"""A primary button that was just tapped keeps its label readable on a touch screen.

A touch screen leaves the last tapped control in :hover. play.css resets the hover look of the play kit's buttons for
touch (@media (hover: none)), and that reset used to reach the primary button too: its label turned from the accent's
white to the page's ink, dark on the accent, for as long as the finger had last touched it (Pig's Roll, Ten Thousand's
Roll, Shut the Box's Roll and every play-kit game's Guess / Start / Draw).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_pa_touch.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.environ.get("PA_GAMES_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)

# page, ready expression, the primary button
PRIMARY = [
    ("pig", "__pig.g", "#pg-roll"),
    ("shutthebox", "__shutthebox.g", "#st-roll"),
    ("tenthousand", "__tenthousand.g", "#tt-roll"),
    ("whoisit", "__whoisit.g", "#wi-guess"),
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


@pytest.mark.parametrize("theme", ["light", "dark"])
@pytest.mark.parametrize("name,ready,sel", PRIMARY)
def test_a_tapped_primary_button_keeps_its_label_colour(
    served, browser, name, ready, sel, theme
):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        has_touch=True,
        is_mobile=True,
        color_scheme=theme,
    )
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, name))
    game_ready(page, ready)
    assert page.evaluate(
        "matchMedia('(hover: none)').matches"
    ), "the emulated phone has no hover"
    colour = lambda: page.evaluate(
        "s => getComputedStyle(document.querySelector(s)).color", sel
    )  # noqa: E731
    page.evaluate(
        "s => { const b = document.querySelector(s); b.disabled = false; b.removeAttribute('aria-disabled'); }",
        sel,
    )
    before = colour()
    page.hover(sel)  # what a finger leaves behind: the control stays in :hover
    frames(page)
    assert page.evaluate("s => document.querySelector(s).matches(':hover')", sel)
    assert (
        colour() == before
    ), "the primary label changed colour while hovered: %s -> %s" % (before, colour())
    ctx.close()


# page, ready expression, a control that lights its border on hover for a mouse
HOVER_BORDER = [
    ("shutthebox", "__shutthebox.g", ".st-tile"),
    ("whoisit", "__whoisit.g", ".wi-q"),
]


@pytest.mark.parametrize("name,ready,sel", HOVER_BORDER)
def test_a_tapped_tile_does_not_stay_lit_on_a_touch_screen(
    served, browser, name, ready, sel
):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True
    )
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, name))
    game_ready(page, ready)
    border = lambda: page.evaluate(
        "s => getComputedStyle(document.querySelector(s)).borderTopColor", sel
    )  # noqa: E731
    before = border()
    page.hover(sel)
    frames(page)
    assert page.evaluate("s => document.querySelector(s).matches(':hover')", sel)
    assert (
        border() == before
    ), "the tile keeps its hover border after a touch: %s -> %s" % (before, border())
    ctx.close()
