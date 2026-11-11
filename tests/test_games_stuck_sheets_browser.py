"""Forty Thieves and Monte Carlo: the move that leaves nothing to do ends the game with the stuck sheet.

Each game is set to a position one move from being stuck (by its own state), the move is made by a tap on a real card, and the
stuck sheet must come up. STUCK_SHOT_DIR=<dir> keeps a picture of each sheet.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_stuck_sheets_browser.py -v
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


def tap_of(page, card_id):
    return page.evaluate(
        """(id) => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); e.scrollIntoView({ block: 'nearest' });
          const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.2 }; }""",
        card_id,
    )


def shot(page, name):
    if os.environ.get("STUCK_SHOT_DIR"):
        page.screenshot(path=os.path.join(os.environ["STUCK_SHOT_DIR"], name))


def test_forty_thieves_the_last_ace_up_leaves_no_moves(phone, site):
    open_game(phone, site, "fortythieves", "() => window.ZimiFortyThieves && window.ZimiFortyThieves.session && window.ZimiFortyThieves.session.state", 20)
    ace = phone.evaluate(
        """() => { const F = window.ZimiFortyThieves, Z = window.ZimiCards, K = window.ZimiSolKit, s = F.blankState();
          // Nine single cards that build on nothing (no two a rank apart in one suit), and the ace of clubs to go up.
          const single = [[2, 3], [4, 3], [6, 3], [8, 3], [10, 3], [2, 2], [4, 2], [6, 2], [8, 2]];
          single.forEach(([r, su], i) => s.piles[F.S.tableau[i]].push(K.card(Z.make(r, su), true)));
          s.piles[F.S.tableau[9]].push(K.card(Z.make(1, 0), true));
          F.session.reset(s); return Z.make(1, 0); }"""
    )
    phone.wait_for_timeout(1500)
    assert not phone.evaluate("() => /No moves left/.test(document.body.innerText)")
    at = tap_of(phone, ace)
    phone.touchscreen.tap(at["x"], at["y"])
    phone.wait_for_function("() => /No moves left/.test(document.body.innerText)", timeout=8000)
    shot(phone, "fortythieves-stuck.png")
    assert not phone.errors


def test_monte_carlo_the_last_pair_taken_leaves_no_moves(phone, site):
    open_game(phone, site, "montecarlo", "() => window.ZimiMonteCarlo && window.ZimiMonteCarlo.session && window.ZimiMonteCarlo.session.state", 20)
    first = phone.evaluate(
        """() => { const M = window.ZimiMonteCarlo, Z = window.ZimiCards, K = window.ZimiSolKit, s = M.blankState(), SIDE = 5, used = new Set();
          const near = (a, b) => a !== b && Math.abs(Math.floor(a / SIDE) - Math.floor(b / SIDE)) <= 1 && Math.abs(a % SIDE - b % SIDE) <= 1;
          // 25 places whose touching cards never share a rank, but the last two (they touch, and are a pair).
          const rank = [];
          for (let i = 0; i < 25; i++) rank.push(((i % SIDE) + 3 * Math.floor(i / SIDE)) % 13 + 1);
          let spare = 1;
          for (; spare <= 13; spare++) { if (![22, 23, 24].some((j) => rank[j] === spare) && [23, 24].every((i) => [...Array(25).keys()].filter((j) => near(i, j) && j !== 23 && j !== 24).every((j) => rank[j] !== spare))) break; }
          rank[23] = spare; rank[24] = spare;
          rank.forEach((r, i) => { let su = i % 4; while (used.has(Z.make(r, su))) su = (su + 1) % 4; used.add(Z.make(r, su)); s.piles['g' + i].push(K.card(Z.make(r, su), true)); });
          M.session.reset(s); return s.piles.g23[0].id; }"""
    )
    phone.wait_for_timeout(1500)
    assert not phone.evaluate("() => /No moves left/.test(document.body.innerText)")
    at = tap_of(phone, first)
    phone.touchscreen.tap(at["x"], at["y"])
    phone.wait_for_function("() => /No moves left/.test(document.body.innerText)", timeout=8000)
    shot(phone, "montecarlo-stuck.png")
    assert not phone.errors
