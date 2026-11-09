"""Oh Hell seats five: five chips, four hands that do not touch, a hand played to its sheet by touch and a game that ends.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_ohhell_five_browser.py -v
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



# ── Oh Hell, five players ────────────────────────────────────────────────────

OH = "window.ZimiOhHell"
RECT = """(ids) => ids.map(id => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); if (!e) return null;
  const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; })"""


def five_at_table(browser):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi.games.ohhell.players', '5'); } catch (e) {}"
    )
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    return ctx, page


def boxes_touch(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def test_oh_hell_seats_five_without_the_hands_touching(browser, site):
    ctx, page = five_at_table(browser)
    open_game(
        page,
        site,
        "ohhell",
        "() => window.ZimiOhHell && window.ZimiOhHell.session && window.ZimiOhHell.session.state",
        20,
    )
    st = page.evaluate("() => window.ZimiOhHell.session.state")
    assert (
        st["players"] == 5
        and len(st["hands"]) == 5
        and all(len(h) == 5 for h in st["hands"])
    )
    assert len({c for h in st["hands"] for c in h} | {st["trumpCard"]}) == 26
    assert page.locator(".ct-chip:not(.ct-trump)").count() == 5
    assert page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1")
    # Each of the four other hands is a group of cards of its own, all on the phone, none over another.
    groups = []
    for r in range(1, 5):
        ids = st["hands"][r]
        boxes = page.evaluate(RECT, ids)
        assert all(boxes), "a hand is missing from the table"
        assert all(b[0] >= 0 and b[2] <= PHONE["width"] and b[1] >= 0 for b in boxes)
        groups.append(
            [
                min(b[0] for b in boxes),
                min(b[1] for b in boxes),
                max(b[2] for b in boxes),
                max(b[3] for b in boxes),
            ]
        )
    for i in range(4):
        for j in range(i + 1, 4):
            assert not boxes_touch(
                groups[i], groups[j]
            ), "hands %d and %d overlap: %r %r" % (i + 1, j + 1, groups[i], groups[j])
    mine = page.evaluate(RECT, st["hands"][0])
    assert not any(
        boxes_touch(
            [
                min(b[0] for b in mine),
                min(b[1] for b in mine),
                max(b[2] for b in mine),
                max(b[3] for b in mine),
            ],
            g,
        )
        for g in groups
    )
    assert not page.errors
    ctx.close()


def sheet_up(page):
    return page.evaluate(
        "() => !!document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')"
    )


def test_oh_hell_five_played_by_touch_to_the_hand_sheet(browser, site):
    ctx, page = five_at_table(browser)
    open_game(
        page,
        site,
        "ohhell",
        "() => window.ZimiOhHell && window.ZimiOhHell.session && window.ZimiOhHell.session.state",
        20,
    )
    seen_trick = 0
    for _ in range(600):
        st = page.evaluate("() => window.ZimiOhHell.session.state")
        seen_trick = max(seen_trick, len(st["trick"]))
        if st["phase"] in ("handEnd", "over") or sheet_up(page):
            break
        if st["phase"] == "bid" and st["turn"] == 0:
            bad = page.evaluate(
                "() => window.ZimiOhHell.forbiddenBid(window.ZimiOhHell.session.state, 0)"
            )
            page.locator(".ct-choice", has_text=str(1 if bad != 1 else 2)).first.tap()
            page.wait_for_timeout(200)
        elif st["phase"] == "play" and st["turn"] == 0 and len(st["trick"]) < 5:
            legal = page.evaluate(
                "() => window.ZimiOhHell.legalPlays(window.ZimiOhHell.session.state, 0)"
            )
            tap_card(page, legal[0])
            page.wait_for_timeout(200)
        else:
            page.wait_for_timeout(250)
    page.wait_for_function(
        "() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')",
        timeout=10000,
    )
    st = page.evaluate("() => window.ZimiOhHell.session.state")
    assert st["phase"] == "handEnd" and sum(st["tricks"]) == 5 and seen_trick == 5
    assert len(st["scores"]) == 5
    # With bids and tricks in them the six chips (five players and the trump) still fit the phone's width.
    chips = page.evaluate(
        "() => [...document.querySelectorAll('.ct-chip')].map(e => { const b = e.getBoundingClientRect(); return [b.left, b.right]; })"
    )
    assert len(chips) == 6 and all(l >= 0 and r <= PHONE["width"] for l, r in chips), chips
    assert not page.errors
    ctx.close()


def test_oh_hell_five_last_hand_ends_the_game(browser, site):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    probe = ctx.new_page()
    probe.goto(site + "ohhell.html")
    probe.wait_for_function("() => window.ZimiOhHell")
    state = probe.evaluate("""() => { const H = window.ZimiOhHell, Z = window.ZimiCards;
        let st = H.dealHand(Z.shuffled(Math.random), 5, H.LADDERS.short, 8, [20, 15, 12, 9, 3], 4);
        for (let s = 0; s < 5; s++) st = H.placeBid(st, s, s === 0 ? 1 : 0);
        return st; }""")
    probe.close()
    save = json.dumps(
        {
            "v": 1,
            "at": int(time.time() * 1000),
            "data": {
                "id": "ohhell",
                "state": state,
                "history": [],
                "ms": 4000,
                "ending": None,
            },
        }
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi.games.save.ohhell', %s); } catch (e) {}"
        % json.dumps(save)
    )
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.goto(site + "ohhell.html")
    page.wait_for_selector(".zc-card", state="attached", timeout=10000)
    for _ in range(80):
        st = page.evaluate("() => window.ZimiOhHell.session.state")
        if st["phase"] == "over":
            break
        if st["turn"] == 0 and len(st["trick"]) < 5 and st["hands"][0]:
            legal = page.evaluate(
                "() => window.ZimiOhHell.legalPlays(window.ZimiOhHell.session.state, 0)"
            )
            tap_card(page, legal[0])
            page.wait_for_timeout(200)
        else:
            page.wait_for_timeout(300)
    st = page.evaluate("() => window.ZimiOhHell.session.state")
    assert (
        st["players"] == 5 and st["phase"] == "over"
    ), "the five-player game never ended"
    page.wait_for_function(
        "() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')",
        timeout=10000,
    )
    assert not page.errors
    ctx.close()
