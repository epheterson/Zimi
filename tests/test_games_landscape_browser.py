"""A phone on its side (844 x 390): Snap's button does not sit over the status line.

Found playing the family card games in landscape: the status pill printed over the Snap button.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_landscape_browser.py -v
"""

import functools
import http.server
import json
import os
import threading
import time

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
PHONE = {"width": 390, "height": 844}


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


@pytest.fixture
def phone(browser):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.errors = errors
    yield page
    ctx.close()


def open_game(page, site, name, wait_for, minimum_cards=1):
    page.goto(site + name + ".html")
    page.wait_for_function(wait_for, timeout=8000)
    page.wait_for_function(
        "(n) => document.querySelectorAll('.zc-card[data-id]').length >= n",
        arg=minimum_cards,
        timeout=8000,
    )
    page.wait_for_timeout(2500)  # the deal's cards fly in


def card_point(page, card_id):
    return page.evaluate(
        """(id) => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); if (!e) return null;
        const b = e.getBoundingClientRect(); return { x: b.x + Math.min(10, b.width / 3), y: b.y + b.height * 0.25 }; }""",
        card_id,
    )


def tap_card(page, card_id):
    p = card_point(page, card_id)
    for _ in range(20):
        assert p, "card %s is not on the table" % card_id
        page.wait_for_timeout(120)
        q = card_point(page, card_id)
        if q == p:
            break
        p = q
    page.touchscreen.tap(p["x"], p["y"])


def test_snap_button_and_status_do_not_overlap_on_a_phone_on_its_side(browser, site):
    ctx = browser.new_context(viewport={"width": 844, "height": 390}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    open_game(page, site, "snap", "() => window.ZimiSnap && window.ZimiSnap.session && window.ZimiSnap.session.state", 4)
    rects = page.evaluate(
        """() => { const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
          return { button: r('.sn-snap'), status: r('.ct-status-text'), width: innerWidth }; }"""
    )
    a, b = rects["button"], rects["status"]
    assert not (a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]), "the status line is over the button: %r" % rects
    assert a[0] >= 0 and a[2] <= rects["width"] and a[3] - a[1] >= 44, rects
    assert not errors
    ctx.close()
