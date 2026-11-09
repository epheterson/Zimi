"""Courtier on a 390 x 844 phone: a whole round played by touch, the pass-the-phone cover, and leaving and returning.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_courtier_browser.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, visible  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

COMPUTER_MS = 120000  # a ceiling for the computers to play on a loaded machine
SHOT_DIR = os.environ.get("GAMES_SHOT_DIR")


def open_game(browser, served, seats=None, dark=False):
    ctx = browser.new_context(
        viewport=VIEW,
        has_touch=True,
        is_mobile=True,
        device_scale_factor=2,
        reduced_motion="reduce",
        color_scheme="dark" if dark else "light",
    )
    if seats:
        ctx.add_init_script(
            "localStorage.setItem('zimi.games.courtier.seats', %s)"
            % json.dumps(json.dumps({"kinds": seats}))
        )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("%s/courtier.html" % served)
    game_ready(page, "window.__courtier")
    return ctx, page, errors


def tap(page, locator):
    locator.wait_for(state="visible")
    box = locator.bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    frames(page)


def shot(page, name):
    if SHOT_DIR:
        page.screenshot(path=os.path.join(SHOT_DIR, name + ".png"))


NEEDS_ME = """() => {
  const vis = id => { const e = document.getElementById(id); return !!e && !e.hidden; };
  return vis('cr-round') || vis('cr-peek') || vis('cr-guess') || !!document.querySelector('.ar-sheet.gs-end')
    || !document.getElementById('cr-play').hidden;
}"""


def act(page):
    """Do whatever the person is asked for now: close a sheet, name a card, choose a player, or play a card. Returns False at the end sheet."""
    if page.locator(".ar-sheet.gs-end").count():
        return False
    if page.evaluate("() => !document.getElementById('cr-round').hidden"):
        tap(page, page.locator("#cr-round-next"))
    elif page.evaluate("() => !document.getElementById('cr-peek').hidden"):
        tap(page, page.locator("#cr-peek-ok"))
    elif page.evaluate("() => !document.getElementById('cr-guess').hidden"):
        tap(page, page.locator("#cr-ranks .cr-card").last)
    elif page.locator(".cr-seat.cr-pick").count():
        tap(page, page.locator(".cr-seat.cr-pick").first)
    elif page.locator("#cr-hand button.cr-card[aria-pressed=true]").count():
        tap(
            page, page.locator("#cr-hand button.cr-card[aria-pressed=true]")
        )  # the second tap plays it
    else:
        tap(page, page.locator("#cr-hand button.cr-card[aria-disabled=false]").first)
    return True


def play_until(page, done):
    deadline = page.evaluate("Date.now()") + COMPUTER_MS
    while not page.evaluate(done):
        assert page.evaluate("Date.now()") < deadline, "the game never reached the end"
        page.wait_for_function(NEEDS_ME, timeout=COMPUTER_MS)
        if not act(page):
            break


def test_a_whole_game_by_touch_ends_with_a_sheet_and_never_overflows(served, browser):
    ctx, page, errors = open_game(browser, served)
    shot(page, "courtier-start")
    tap(page, page.locator("#cr-go"))
    page.wait_for_function(
        "() => !document.getElementById('cr-hand').children.length === false"
    )
    shot(page, "courtier-table")
    # Let one round decide the game: everyone else is a favor from the goal.
    page.evaluate(
        "() => { const g = window.__courtier.g; g.players.forEach(p => { p.favors = g.goal - 1; }); }"
    )
    play_until(page, "!!document.querySelector('.ar-sheet.gs-end')")
    assert page.locator(".ar-sheet.gs-end .ar-sheet-card").is_visible()
    assert page.evaluate("document.documentElement.scrollWidth") <= VIEW["width"]
    assert not errors, errors
    shot(page, "courtier-end")
    ctx.close()


def test_every_touch_target_is_at_least_44_pixels(served, browser):
    ctx, page, errors = open_game(browser, served)
    tap(page, page.locator("#cr-go"))
    page.wait_for_function(
        "() => document.querySelectorAll('#cr-hand button.cr-card').length > 0 || !document.getElementById('cr-play').hidden"
    )
    small = page.evaluate(
        """() => [...document.querySelectorAll('#cr-hand button, .cr-actions button, .ar-bar button')]
        .filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(); return [b.id || b.className, Math.round(r.width), Math.round(r.height)]; })
        .filter(x => x[1] < 44 || x[2] < 44)"""
    )
    assert not small, small
    ctx.close()


def test_a_card_that_cannot_be_played_says_why(served, browser):
    ctx, page, errors = open_game(browser, served)
    tap(page, page.locator("#cr-go"))
    page.wait_for_function("() => document.querySelectorAll('#cr-hand button.cr-card').length === 2")
    # Hold the Dowager with the Magister: the Magister must not play, and a tap on it says why.
    page.evaluate("() => { const g = window.__courtier.g; g.turn = 0; g.players[0].hand = [7, 5]; window.__courtier.refresh(); }")
    magister = page.locator("#cr-hand button.cr-card[data-rank='5']")
    assert magister.get_attribute("aria-disabled") == "true"
    tap(page, magister)
    assert page.locator("#cr-msg").inner_text() == "The Dowager must be played"
    assert page.locator("#cr-hand button.cr-card[aria-pressed=true]").count() == 0
    ctx.close()


def test_hot_seat_hides_the_hand_behind_a_cover(served, browser):
    ctx, page, errors = open_game(browser, served, seats=["person", "person", "cpu"])
    tap(page, page.locator("#cr-go"))
    cover = page.locator(".zs-cover")
    cover.wait_for(state="visible")
    assert (
        page.locator("#cr-hand button.cr-card").count() == 0
    ), "the cards must not show under the cover"
    tap(page, cover.locator("button"))
    page.wait_for_function(
        "() => document.querySelectorAll('#cr-hand button.cr-card').length === 2"
    )
    # Play a card by two taps; the next person gets a cover and their cards are not shown until they tap.
    tap(page, page.locator("#cr-hand button.cr-card[aria-disabled=false]").first)
    play_until(
        page,
        "!!document.querySelector('.zs-cover') || !!document.querySelector('.ar-sheet.gs-end')",
    )
    assert page.locator(".zs-cover").is_visible()
    assert page.locator("#cr-hand button.cr-card").count() == 0
    assert not errors, errors
    ctx.close()


def test_leaving_and_returning_keeps_the_table(served, browser):
    ctx, page, errors = open_game(browser, served)
    tap(page, page.locator("#cr-go"))
    play_until(
        page,
        "window.__courtier.g.players.some(p => p.played.length > 0) && window.__courtier.g.turn !== 0 || window.__courtier.g.players.some(p => p.played.length > 1)",
    )
    snap = "JSON.stringify(window.__courtier.g.players.map(p => [p.hand, p.played, p.out, p.favors])) + window.__courtier.g.deck.length"
    before = page.evaluate(
        "(() => { window.dispatchEvent(new Event('pagehide')); return "
        + snap
        + "; })()"
    )
    url = page.url
    page.goto("about:blank")
    page.goto(url)
    game_ready(page, "window.__courtier")
    page.wait_for_function(
        "(b) => { try { return " + snap + " === b; } catch (e) { return false; } }",
        arg=before,
    )
    assert not errors, errors
    ctx.close()
