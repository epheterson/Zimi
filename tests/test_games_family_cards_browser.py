"""The family card games (Go Fish, Old Maid, Snap, Oh Hell, Cheat) played through on a 390 px touch phone, a game to its end sheet.

Each is opened with its computer players, played by touch the way a person does (tap a card, tap a player), until the end sheet
comes up; nothing may throw, and the table must fit the phone (no sideways scroll).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_family_cards_browser.py -v
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


def card_point(page, card_id):
    """Where to touch a card of your hand: a strip near its left edge, clear of the card laid over it."""
    return page.evaluate(
        """(id) => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); if (!e) return null;
        const b = e.getBoundingClientRect(); return { x: b.x + Math.min(10, b.width / 3), y: b.y + b.height * 0.25 }; }""",
        card_id,
    )


def tap_card(page, card_id):
    """Touch a card once it has stopped moving (a deal or a sweep in flight would move it from under the finger)."""
    p = card_point(page, card_id)
    for _ in range(20):
        assert p, "card %s is not on the table" % card_id
        page.wait_for_timeout(120)
        q = card_point(page, card_id)
        if q == p:
            break
        p = q
    page.touchscreen.tap(p["x"], p["y"])


def end_sheet_up(page):
    return page.locator(".gs-end, .ar-sheet, .zc-sheet").count() > 0


def no_sideways_scroll(page):
    return page.evaluate(
        "() => document.documentElement.scrollWidth <= window.innerWidth + 1"
    )


def open_game(page, site, name, wait_for):
    page.goto(site + name + ".html")
    page.wait_for_function(wait_for, timeout=8000)
    page.wait_for_selector(".zc-card", state="attached", timeout=8000)


def test_go_fish_played_to_the_end_by_touch(phone, site):
    page = phone
    open_game(
        page,
        site,
        "gofish",
        "() => window.ZimiGoFish && window.ZimiGoFish.session && window.ZimiGoFish.session.state",
    )
    assert no_sideways_scroll(page)
    for _ in range(400):
        st = page.evaluate("() => window.ZimiGoFish.session.state")
        if st["phase"] == "over":
            break
        if st["turn"] == 0 and st["hands"][0]:
            tap_card(page, st["hands"][0][0])
            page.wait_for_timeout(120)
        else:
            page.wait_for_timeout(250)
    st = page.evaluate("() => window.ZimiGoFish.session.state")
    assert st["phase"] == "over", "the game never ended after %d moves" % st["moves"]
    page.wait_for_function(
        "() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')",
        timeout=8000,
    )
    assert not phone.errors


def saved_page(browser, site, name, key, state):
    """A page opened with `state` as the game's kept save (the page takes it up as the game left off)."""
    import json
    import time

    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    save = json.dumps(
        {
            "v": 1,
            "at": int(time.time() * 1000),
            "data": {
                "id": key,
                "state": state,
                "history": [],
                "ms": 4000,
                "ending": None,
            },
        }
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi.games.save.%s', %s); } catch (e) {}"
        % (key, json.dumps(save))
    )
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.goto(site + name + ".html")
    page.ctx = ctx
    return page


def sheet_up(page):
    return page.evaluate(
        "() => !!document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')"
    )


def test_old_maid_played_to_the_end_by_touch(phone, site):
    page = phone
    open_game(
        page,
        site,
        "oldmaid",
        "() => window.ZimiOldMaid && window.ZimiOldMaid.session && window.ZimiOldMaid.session.state",
    )
    assert no_sideways_scroll(page)
    for _ in range(300):
        st = page.evaluate("() => window.ZimiOldMaid.session.state")
        if st["phase"] == "over":
            break
        if st["turn"] == 0:
            source = page.evaluate(
                "() => window.ZimiOldMaid.source(window.ZimiOldMaid.session.state)"
            )
            tap_card(page, st["hands"][source][0])
            page.wait_for_timeout(150)
        else:
            page.wait_for_timeout(250)
    st = page.evaluate("() => window.ZimiOldMaid.session.state")
    assert st["phase"] == "over"
    assert st["result"]["loser"] >= 0 and len(st["hands"][st["result"]["loser"]]) == 1
    page.wait_for_function(
        "() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')",
        timeout=8000,
    )
    assert not phone.errors


# A Snap with a few cards left: a match on show (the restored game does not hurry Zimi into it), then four cards with no match.
SNAP_END = {
    "stacks": [[2, 3, 4], [8, 9, 10]],  # ranks 3, 4, 5 and 9, 10, J
    "piles": [[6], [6 + 13]],  # sevens of clubs and diamonds
    "won": [0, 0],
    "turn": 0,
    "phase": "play",
    "note": None,
    "moves": 4,
    "flips": 2,
}


def test_snap_a_tap_takes_the_match_and_the_game_ends(browser, site):
    page = saved_page(browser, site, "snap", "snap", SNAP_END)
    page.wait_for_selector(".sn-snap", timeout=8000)
    page.wait_for_function(
        "() => window.ZimiSnap.isMatch(window.ZimiSnap.session.state)", timeout=8000
    )
    page.touchscreen.tap(
        *[
            page.locator(".sn-snap").bounding_box()[k]
            + page.locator(".sn-snap").bounding_box()[d] / 2
            for k, d in (("x", "width"), ("y", "height"))
        ]
    )
    page.wait_for_function(
        "() => window.ZimiSnap.session.state.won[0] === 2", timeout=3000
    )
    assert no_sideways_scroll(page)
    page.wait_for_function(
        "() => window.ZimiSnap.session.state.phase === 'over'", timeout=20000
    )
    page.wait_for_function(
        "() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')",
        timeout=8000,
    )
    assert not page.errors
    page.ctx.close()


def test_snap_with_no_match_costs_nothing_to_nothing_and_says_so(browser, site):
    state = dict(SNAP_END, piles=[[6], [7]], won=[5, 0])
    page = saved_page(browser, site, "snap", "snap", state)
    page.wait_for_selector(".sn-snap", timeout=8000)
    box = page.locator(".sn-snap").bounding_box()
    page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_function(
        "() => window.ZimiSnap.session.state.won[0] === 3", timeout=3000
    )
    assert page.evaluate("() => window.ZimiSnap.session.state.note.kind") == "false"
    assert not page.errors
    page.ctx.close()


def test_snap_phone_fit(phone, site):
    page = phone
    open_game(
        page,
        site,
        "snap",
        "() => window.ZimiSnap && window.ZimiSnap.session && window.ZimiSnap.session.state",
    )
    assert no_sideways_scroll(page)
    box = page.locator(".sn-snap").bounding_box()
    assert box["height"] >= 44 and box["x"] >= 0 and box["x"] + box["width"] <= 390
    assert not phone.errors


def bid_by_touch(page, n):
    page.locator(".ct-choice", has_text=str(n)).first.tap()


def test_oh_hell_first_hand_by_touch_to_the_hand_sheet(phone, site):
    page = phone
    open_game(
        page,
        site,
        "ohhell",
        "() => window.ZimiOhHell && window.ZimiOhHell.session && window.ZimiOhHell.session.state",
    )
    assert no_sideways_scroll(page)
    for _ in range(400):
        st = page.evaluate("() => window.ZimiOhHell.session.state")
        if st["phase"] == "handEnd" or st["phase"] == "over" or sheet_up(page):
            break
        if st["phase"] == "bid" and st["turn"] == 0:
            bad = page.evaluate(
                "() => window.ZimiOhHell.forbiddenBid(window.ZimiOhHell.session.state, 0)"
            )
            bid_by_touch(page, 1 if bad != 1 else 2)
            page.wait_for_timeout(200)
        elif (
            st["phase"] == "play"
            and st["turn"] == 0
            and len(st["trick"]) < st["players"]
        ):
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
    assert st["handNo"] == 0 and sum(st["tricks"]) == 5 and st["phase"] == "handEnd"
    assert sum(st["scores"]) == sum(max(0, t) for t in st["tricks"]) + 10 * sum(
        1 for t, b in zip(st["tricks"], st["bids"]) if t == b
    )
    assert not phone.errors


def test_oh_hell_last_hand_ends_the_game(browser, site):
    probe = browser.new_page()
    probe.goto(site + "ohhell.html")
    probe.wait_for_function("() => window.ZimiOhHell")
    state = probe.evaluate(
        """() => { const H = window.ZimiOhHell, Z = window.ZimiCards;
        let st = H.dealHand(Z.shuffled(Math.random), 3, H.LADDERS.short, 8, [20, 15, 12], 2);
        st = H.placeBid(st, 0, 1); st = H.placeBid(st, 1, 0); st = H.placeBid(st, 2, 0); return st; }"""
    )
    probe.close()
    page = saved_page(browser, site, "ohhell", "ohhell", state)
    page.wait_for_selector(".zc-card", state="attached", timeout=10000)
    for _ in range(60):
        st = page.evaluate("() => window.ZimiOhHell.session.state")
        if st["phase"] == "over":
            break
        if st["turn"] == 0 and len(st["trick"]) < 3 and st["hands"][0]:
            legal = page.evaluate(
                "() => window.ZimiOhHell.legalPlays(window.ZimiOhHell.session.state, 0)"
            )
            tap_card(page, legal[0])
        page.wait_for_timeout(300)
    st = page.evaluate("() => window.ZimiOhHell.session.state")
    assert st["phase"] == "over"
    page.wait_for_function(
        "() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')",
        timeout=10000,
    )
    assert not page.errors
    page.ctx.close()
def cheat_total(page):
    return page.evaluate(
        "() => { const s = window.ZimiCheat.session.state; return s.hands.reduce((n, h) => n + h.length, 0) + s.pile.length; }"
    )


def test_cheat_a_few_turns_by_touch_keep_every_card(phone, site):
    page = phone
    open_game(
        page,
        site,
        "cheat",
        "() => window.ZimiCheat && window.ZimiCheat.session && window.ZimiCheat.session.state",
    )
    assert no_sideways_scroll(page)
    mine_played = 0
    for _ in range(200):
        st = page.evaluate("() => window.ZimiCheat.session.state")
        if st["phase"] == "over" or mine_played >= 3:
            break
        if st["phase"] == "call" and st["callers"][0] == 0:
            page.locator(".ct-choice", has_text="Let it go").first.tap()
            page.wait_for_timeout(150)
        elif st["phase"] == "play" and st["turn"] == 0:
            tap_card(page, st["hands"][0][0])
            page.wait_for_timeout(150)
            assert page.locator(".ct-choice.ct-primary").count() == 1
            page.locator(".ct-choice.ct-primary").first.tap()
            mine_played += 1
            page.wait_for_timeout(200)
        else:
            page.wait_for_timeout(250)
    assert mine_played >= 1
    assert cheat_total(page) == 52
    assert not phone.errors


# One card left in your hand, the rank to say: play it, and when the others let it go (or call and find the truth) you are out.
CHEAT_END = {
    "players": 3,
    "hands": [
        [6],
        [0, 14, 28, 40, 41],
        [1, 2, 15, 16, 17],
    ],  # you hold the seven of clubs
    "pile": [3, 4, 5],
    "claim": 7,
    "turn": 0,
    "phase": "play",
    "callers": [],
    "last": None,
    "tells": [{"called": 0, "lied": 0}] * 3,
    "turns": 6,
    "winner": -1,
    "moves": 6,
}


def test_cheat_going_out_wins_the_game(browser, site):
    page = saved_page(browser, site, "cheat", "cheat", CHEAT_END)
    page.wait_for_selector(".zc-card", state="attached", timeout=10000)
    tap_card(page, 6)
    page.locator(".ct-choice.ct-primary").first.tap()
    for _ in range(60):
        st = page.evaluate("() => window.ZimiCheat.session.state")
        if st["phase"] == "over":
            break
        if st["phase"] == "call" and st["callers"][0] == 0:
            page.locator(".ct-choice", has_text="Let it go").first.tap()
        page.wait_for_timeout(300)
    st = page.evaluate("() => window.ZimiCheat.session.state")
    assert st["phase"] == "over" and st["winner"] == 0
    page.wait_for_function(
        "() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')",
        timeout=10000,
    )
    assert not page.errors
    page.ctx.close()
def test_go_fish_with_three_players_asks_by_choosing_whom(browser, site):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi.games.gofish.players', '3'); } catch (e) {}"
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    open_game(
        page,
        site,
        "gofish",
        "() => window.ZimiGoFish && window.ZimiGoFish.session && window.ZimiGoFish.session.state",
    )
    assert page.evaluate("() => window.ZimiGoFish.session.state.players") == 3
    page.wait_for_function("() => document.querySelector('.ct-status-text') && document.querySelector('.ct-status-text').textContent", timeout=8000)
    for _ in range(60):
        st = page.evaluate("() => window.ZimiGoFish.session.state")
        if st["turn"] == 0:
            break
        page.wait_for_timeout(300)
    st = page.evaluate("() => window.ZimiGoFish.session.state")
    assert st["turn"] == 0
    tap_card(page, st["hands"][0][0])
    page.wait_for_selector(".ct-choice", timeout=3000)
    names = page.locator(".ct-choice").all_inner_texts()
    assert len(names) == 3, names  # two players to ask, and Cancel
    asked_before = st["moves"]
    page.locator(".ct-choice").first.tap()
    page.wait_for_function(
        "(n) => window.ZimiGoFish.session.state.moves > n",
        arg=asked_before,
        timeout=3000,
    )
    assert page.evaluate("() => window.ZimiGoFish.session.state.last.seat") == 0
    assert no_sideways_scroll(page)
    assert not errors
    ctx.close()
