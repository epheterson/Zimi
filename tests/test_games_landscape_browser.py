"""A phone on its side (844 x 390): Snap's button does not sit over the status line, and the tray of choices (Oh Hell's bid, Cheat's
Pick and Call) does not cover the other players' hands.

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


def boxes_touch(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


TRAY_AND_HANDS = """(ids) => {
  const p = document.querySelector('.ct-panel');
  if (!p || p.hidden) return null;
  const r = e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
  return { panel: r(p), cards: ids.map(id => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); return e ? r(e) : null; }).filter(Boolean),
           status: r(document.querySelector('.ct-status')), height: innerHeight };
}"""


def landscape(browser):
    ctx = browser.new_context(viewport={"width": 844, "height": 390}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    return ctx, page


def other_hands(page, api):
    st = page.evaluate("() => window.%s.session.state" % api)
    return [c for h in st["hands"][1:] for c in h]


def test_the_bid_tray_of_oh_hell_does_not_cover_a_hand_on_a_phone_on_its_side(browser, site):
    ctx, page = landscape(browser)
    open_game(page, site, "ohhell", "() => window.ZimiOhHell && window.ZimiOhHell.session && window.ZimiOhHell.session.state", 4)
    page.wait_for_function("() => { const p = document.querySelector('.ct-panel'); return p && !p.hidden; }", timeout=8000)
    got = page.evaluate(TRAY_AND_HANDS, other_hands(page, "ZimiOhHell"))
    assert got["cards"], "no opponent hand on the table"
    for c in got["cards"]:
        assert not boxes_touch(got["panel"], c), "the tray covers a hand: %r" % got
    assert not boxes_touch(got["panel"], got["status"]), got
    assert not page.errors
    ctx.close()


def test_the_pick_and_call_tray_of_cheat_does_not_cover_a_hand_on_a_phone_on_its_side(browser, site):
    ctx, page = landscape(browser)
    open_game(page, site, "cheat", "() => window.ZimiCheat && window.ZimiCheat.session && window.ZimiCheat.session.state", 4)
    for _ in range(60):
        st = page.evaluate("() => window.ZimiCheat.session.state")
        if st["phase"] == "play" and st["turn"] == 0:
            break
        if st["phase"] == "call" and st["callers"] and st["callers"][0] == 0:
            break
        page.wait_for_timeout(400)
    if st["phase"] == "play":
        tap_card(page, st["hands"][0][0])  # the tray with Pick/Say appears once a card is lifted
        page.wait_for_timeout(300)
    page.wait_for_function("() => { const p = document.querySelector('.ct-panel'); return p && !p.hidden; }", timeout=8000)
    got = page.evaluate(TRAY_AND_HANDS, other_hands(page, "ZimiCheat"))
    for c in got["cards"]:
        assert not boxes_touch(got["panel"], c), "the tray covers a hand: %r" % got
    assert not boxes_touch(got["panel"], got["status"]), got
    assert not page.errors
    ctx.close()


def test_bridge_win_cascade_skips_cards_the_table_is_not_showing(phone, site):
    """The win's cascade flies the deal's cards; Bridge names both hands of the side, and the partner's are not on the table."""
    open_game(phone, site, "bridge", "() => window.ZimiBridge && window.ZimiBridge.session && window.ZimiBridge.session.state", 10)
    phone.evaluate("() => window.ZimiBridge.session.win(3)")
    phone.wait_for_function("() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')", timeout=15000)
    assert not phone.errors, phone.errors


def tray_clear_of(page, ids):
    got = page.evaluate(TRAY_AND_HANDS, ids)
    assert got and got["cards"], "nothing to compare with the tray"
    for c in got["cards"]:
        assert not boxes_touch(got["panel"], c), "the tray covers a card: %r" % got
    assert not boxes_touch(got["panel"], got["status"]), got
    return got


def wait_for_tray(page):
    page.wait_for_function("() => { const p = document.querySelector('.ct-panel'); return p && !p.hidden && p.children.length; }", timeout=15000)
    page.wait_for_timeout(1200)


def test_the_spades_bid_tray_is_clear_of_the_other_hands_on_a_phone_on_its_side(browser, site):
    ctx, page = landscape(browser)
    open_game(page, site, "spades", "() => window.ZimiSpades && window.ZimiSpades.session && window.ZimiSpades.session.state", 4)
    wait_for_tray(page)
    got = tray_clear_of(page, other_hands(page, "ZimiSpades"))
    assert got["panel"][3] - got["panel"][1] < 110, "the bids are not one row: %r" % got
    assert not page.errors
    ctx.close()


def test_the_cheat_pile_is_clear_of_the_call_tray_on_a_phone_on_its_side(browser, site):
    ctx, page = landscape(browser)
    open_game(page, site, "cheat", "() => window.ZimiCheat && window.ZimiCheat.session && window.ZimiCheat.session.state", 4)
    for _ in range(80):
        st = page.evaluate("() => window.ZimiCheat.session.state")
        if st["phase"] == "call" and st["callers"] and st["callers"][0] == 0 and st["pile"]:
            break
        if st["phase"] == "call" and st["callers"] and st["callers"][0] != 0:
            page.wait_for_timeout(300)
        elif st["phase"] == "play" and st["turn"] == 0:
            tap_card(page, st["hands"][0][0])
            page.locator(".ct-choice.ct-primary").first.tap()
        page.wait_for_timeout(400)
    st = page.evaluate("() => window.ZimiCheat.session.state")
    if not (st["phase"] == "call" and st["callers"] and st["callers"][0] == 0):
        import pytest
        pytest.skip("Zimi never played a card for you to call in time")
    wait_for_tray(page)
    tray_clear_of(page, st["pile"])
    assert not page.errors
    ctx.close()


def test_the_euchre_upcard_is_clear_of_the_order_up_tray_on_a_phone_on_its_side(browser, site):
    ctx, page = landscape(browser)
    open_game(page, site, "euchre", "() => window.ZimiEuchre && window.ZimiEuchre.session && window.ZimiEuchre.session.state", 4)
    for _ in range(60):
        st = page.evaluate("() => window.ZimiEuchre.session.state")
        if st["phase"] == "order1" and st["turn"] == 0:
            break
        page.wait_for_timeout(500)
    st = page.evaluate("() => window.ZimiEuchre.session.state")
    assert st["phase"] == "order1" and st["turn"] == 0, "the order-up round never came to you"
    wait_for_tray(page)
    tray_clear_of(page, [st["upcard"]])
    assert not page.errors
    ctx.close()
