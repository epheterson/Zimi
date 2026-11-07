"""FreeCell's Hint in the Menu is one bulb with its name under it, and the hint's glow is a ring that shows on pale cards.

A playtester saw two bulbs and no label in the Menu's Hint tile (the page's own icon and the Menu's, no text), and a glow too
thin to find on white cards in the dark theme.

Run: pytest tests/test_games_freecell_hint_browser.py -v
"""

import functools
import http.server
import os
import threading

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)


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
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


def _page(browser, site, scheme="dark", lang="en"):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        color_scheme=scheme,
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(site + "freecell.html#lang=" + lang)
    pg.wait_for_selector(".zc-card", state="attached", timeout=15000)
    pg.wait_for_timeout(1500)
    return pg


def test_the_menus_hint_tile_has_one_icon_and_its_name(browser, site):
    pg = _page(browser, site)
    pg.click(".gs-menu-btn")
    tile = pg.wait_for_selector(".gs-sheet:not([hidden]) #zc-hint")
    got = pg.evaluate(
        "() => { const t = document.getElementById('zc-hint'); return { svgs: t.querySelectorAll('svg').length, label: (t.querySelector('.gs-item-l') || {}).textContent, text: t.textContent.trim() }; }"
    )
    assert got["svgs"] == 1 and got["label"] == "Hint" and got["text"] == "Hint", got
    box = tile.bounding_box()
    assert box["width"] > 90, box  # a tile as wide as its neighbours, not a sliver
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "freecell-menu-hint.png"))


def test_the_menus_hint_tile_is_named_in_the_players_language(browser, site):
    pg = _page(browser, site, lang="es")
    pg.click(".gs-menu-btn")
    pg.wait_for_selector(".gs-sheet:not([hidden]) #zc-hint")
    assert pg.inner_text("#zc-hint").strip() == "Pista"


def test_the_hints_glow_is_a_ring_that_shows_on_a_pale_card(browser, site):
    pg = _page(browser, site)
    pg.evaluate("() => document.getElementById('zc-hint').click()")
    pg.wait_for_selector(".zc-card.zc-glow", timeout=10000)
    shadow = pg.evaluate(
        "() => getComputedStyle(document.querySelector('.zc-card.zc-glow')).boxShadow"
    )
    # a solid ring of the accent at least three pixels out, then the blur
    assert "0px 0px 0px 4px" in shadow, shadow
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "freecell-hint-glow.png"))
