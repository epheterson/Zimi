"""Big Two and Tien Len say why a selection will not play in the status line, as the other games do, not in the tray.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_climbing_status_browser.py -v
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



# ── Big Two and Tien Len: the reason is in the status line ───────────────────


@pytest.mark.parametrize(
    "name, api",
    [("bigtwo", "ZimiBigTwo"), ("tienlen", "ZimiTienLen")],
)
def test_the_reason_a_selection_will_not_play_is_in_the_status_line(
    phone, site, name, api
):
    open_game(
        phone,
        site,
        name,
        "() => window.%s && window.%s.session && window.%s.session.state"
        % (api, api, api),
        13,
    )
    for _ in range(60):
        st = phone.evaluate("() => window.%s.session.state" % api)
        if st["turn"] == 0 and st["phase"] == "play":
            break
        phone.wait_for_timeout(300)
    st = phone.evaluate("() => window.%s.session.state" % api)
    assert st["turn"] == 0
    hand = st["hands"][0]
    # A single card that cannot be played now (it is not the opening card, or it does not beat what is on the table).
    why = ""
    for card in hand:
        why = phone.evaluate(
            "(id) => window.%s.whyNot(window.%s.session.state, 0, [id])" % (api, api), card
        )
        if why:
            tap_card(phone, card)
            phone.wait_for_timeout(300)
            break
    assert why, "some card of the hand cannot be played now"
    assert phone.locator(".ct-status-text").inner_text() == why
    assert phone.locator(".ct-lines").count() == 0, "the reason is in the tray as well"
    assert not phone.errors
