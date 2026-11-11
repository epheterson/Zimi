"""A turn of the stock that leaves no moves ends the game with the stuck sheet, not silently (found playing Aces Up and Canfield).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_stuck_after_stock_browser.py -v
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


def test_the_last_row_of_aces_up_dealt_with_no_moves_says_so(phone, site):
    open_game(phone, site, "acesup", "() => window.ZimiAcesUp && window.ZimiAcesUp.session && window.ZimiAcesUp.session.state", 4)
    # Four kings in the columns and four cards left to deal, no two of one suit: the deal leaves nothing to discard.
    phone.evaluate(
        """() => { const A = window.ZimiAcesUp, Z = window.ZimiCards, K = window.ZimiSolKit, s = A.blankState();
          ['t0', 't1', 't2', 't3'].forEach((t, i) => s.piles[t].push(K.card(Z.make(13, i), true)));
          [[2, 0], [3, 1], [4, 2], [5, 3]].forEach(([r, su]) => s.piles.stock.push(K.card(Z.make(r, su), false)));
          A.session.reset(s); }"""
    )
    phone.wait_for_timeout(1500)
    assert not phone.evaluate("() => /No moves left/.test(document.body.innerText)")
    top = phone.evaluate(
        """() => { const st = window.ZimiAcesUp.session.state.piles.stock, e = document.querySelector('.zc-card[data-id="' + st[st.length - 1].id + '"]');
          const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }"""
    )
    phone.touchscreen.tap(top["x"], top["y"])
    phone.wait_for_function("() => /No moves left/.test(document.body.innerText)", timeout=6000)
    assert not phone.errors
