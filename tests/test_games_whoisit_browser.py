"""Who Is It played the way a person plays it, on a 390 by 844 phone with touch: a question flips down the faces it rules out,
a wrong guess costs the turn, a whole game is played to the end, and a game left mid-way comes back as it was.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_whoisit_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import game_ready  # noqa: E402
from test_games_dicekids_browser import (
    END_SHEET,
    fits_the_phone,
    open_game,
    sheet_text,
    tap,
)  # noqa: E402
from test_games_persist_browser import browser, served  # noqa: E402,F401

MY_TURN = "() => __whoisit.mine || __whoisit.g.over"
# What Zimi's own strategy would do for the person: ask this question, or guess this face.
PLAN = "() => WhoIsItEngine.zimiMove(__whoisit.g, 0)"
TURN_WAIT_MS = 90000


def play_one_move(page):
    """One turn as a person would play it: tap the question that splits the faces best, or the face and Guess."""
    move = page.evaluate(PLAN)
    if move["kind"] == "ask":
        tap(page, '.wi-q[data-f="%s"]' % move["id"])
    else:
        tap(page, ".wi-face", move["index"])
        tap(page, "#wi-guess")


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_it_fits_the_phone_in_both_themes(served, browser, theme):
    ctx, page, errors = open_game(
        browser, served, "whoisit", theme, ready="__whoisit.g"
    )
    fits_the_phone(page, ["#wi-guess", ".wi-q", ".wi-face"])
    assert (
        page.locator(".wi-face").count() == 24 and page.locator(".wi-q").count() == 15
    )
    assert page.is_disabled(
        "#wi-guess"
    ), "nothing is chosen, so there is nothing to guess"
    assert page.evaluate("document.querySelectorAll('#wi-mine svg').length") == 1
    assert not errors, errors
    ctx.close()


def test_a_question_flips_down_the_faces_it_rules_out(served, browser):
    ctx, page, errors = open_game(browser, served, "whoisit", ready="__whoisit.g")
    tap(page, '.wi-q[data-f="glasses"]')
    left = page.evaluate("__whoisit.g.cands[0].length")
    assert page.locator(".wi-face.wi-down").count() == 24 - left and 0 < left < 24
    assert page.evaluate(
        "document.querySelector('.wi-q[data-f=\"glasses\"]').dataset.a"
    ) in ("yes", "no")
    page.wait_for_function(MY_TURN, timeout=TURN_WAIT_MS)
    assert page.evaluate("__whoisit.g.asked[1].length") == 1, "Zimi asked one question"
    assert "Zimi asked" in page.inner_text("#wi-msg")
    page.locator('.wi-q[data-f="glasses"]').dispatch_event(
        "click"
    )  # asked already: marked disabled, and answers when pressed anyway
    assert "already" in page.inner_text("#wi-msg").lower()
    assert not errors, errors
    ctx.close()


def test_a_wrong_guess_costs_the_turn_and_the_face(served, browser):
    ctx, page, errors = open_game(browser, served, "whoisit", ready="__whoisit.g")
    wrong = page.evaluate(
        "[...Array(24).keys()].find(i => i !== __whoisit.g.secret[0])"
    )
    tap(page, ".wi-face", wrong)
    assert page.evaluate("__whoisit.selected") == wrong and not page.is_disabled(
        "#wi-guess"
    )
    tap(page, "#wi-guess")
    assert page.evaluate("__whoisit.g.cands[0].indexOf(%d)" % wrong) == -1
    assert "flipped down" in page.inner_text("#wi-msg")
    page.wait_for_function(MY_TURN, timeout=TURN_WAIT_MS)
    # a face that is out is marked disabled and answers with a reason when pressed anyway, and changes nothing
    page.locator(".wi-face").nth(wrong).dispatch_event("click")
    assert "flipped down" in page.inner_text("#wi-msg")
    assert page.evaluate("__whoisit.selected") == -1
    assert not errors, errors
    ctx.close()


def test_a_whole_game_is_played_to_the_end(served, browser):
    ctx, page, errors = open_game(browser, served, "whoisit", ready="__whoisit.g")
    moves = 0
    while moves < 60:
        page.wait_for_function(MY_TURN, timeout=TURN_WAIT_MS)
        if page.evaluate("__whoisit.g.over"):
            break
        play_one_move(page)
        moves += 1
    text = sheet_text(page)
    assert "face" in text.lower()
    assert (
        page.locator(END_SHEET + " .wi-reveal-face svg").count() == 1
    ), "the end sheet shows Zimi's face"
    assert page.evaluate("__whoisit.g.over") and page.evaluate(
        "__whoisit.g.winner"
    ) in (0, 1)
    assert not errors, errors
    ctx.close()


def test_it_comes_back_where_it_was_left(served, browser):
    ctx, page, errors = open_game(browser, served, "whoisit", ready="__whoisit.g")
    tap(page, '.wi-q[data-f="hat"]')
    page.wait_for_function(MY_TURN, timeout=TURN_WAIT_MS)
    tap(page, '.wi-q[data-f="long"]')
    page.wait_for_function(MY_TURN, timeout=TURN_WAIT_MS)
    before = page.evaluate(
        "(() => { window.dispatchEvent(new Event('pagehide')); return JSON.stringify(WhoIsItEngine.snapshot(__whoisit.g)); })()"
    )
    page.goto("about:blank")
    page.goto("%s/whoisit.html" % served)
    game_ready(page, "__whoisit.g")
    page.wait_for_function(
        "(b) => JSON.stringify(WhoIsItEngine.snapshot(__whoisit.g)) === b", arg=before
    )
    assert page.locator(".wi-face.wi-down").count() == 24 - page.evaluate(
        "__whoisit.g.cands[0].length"
    )
    assert not errors, errors
    ctx.close()
