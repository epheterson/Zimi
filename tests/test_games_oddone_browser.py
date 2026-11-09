"""Odd One Out on a 390 x 844 phone: setup, the covers between people, the secret, one word each, the secret vote, the odd
one's guess, the scores and the end. Also: leaving mid-round never shows a secret, and the shelf tile never gives one away.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_oddone_browser.py -v
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

SHOT_DIR = os.environ.get("GAMES_SHOT_DIR")
STATE = "window.__oddone.S"


def open_game(browser, served, dark=False):
    ctx = browser.new_context(
        viewport=VIEW,
        has_touch=True,
        is_mobile=True,
        device_scale_factor=2,
        reduced_motion="reduce",
        color_scheme="dark" if dark else "light",
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("%s/oddone.html" % served)
    game_ready(page, "window.__oddone")
    return ctx, page, errors


def tap(page, locator):
    locator.wait_for(state="visible")
    box = locator.bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    frames(page)


def shot(page, name):
    if SHOT_DIR:
        page.screenshot(path=os.path.join(SHOT_DIR, name + ".png"))


def cover_then(page, button_text_selector="button"):
    """A cover is showing: the person takes the phone."""
    cover = page.locator(".pk-cover")
    cover.wait_for(state="visible")
    tap(page, cover.locator(button_text_selector))
    page.wait_for_function("() => !document.querySelector('.pk-cover')")


def start(page):
    tap(page, page.locator("#oo-go"))


def reveal_all(page, n):
    """Every player takes the phone, looks, hides it. Returns (who saw the picture, who saw the question mark)."""
    saw, qmark = [], []
    for k in range(n):
        cover_then(page)
        page.locator(".oo-secret").wait_for(state="visible")
        (qmark if page.locator(".oo-qmark").count() else saw).append(k)
        if SHOT_DIR and k < 2:
            shot(page, "oddone-secret-%d" % k)
        tap(page, page.locator(".oo-secret ~ button"))
    return saw, qmark


def talk_and_vote(page, n, votes):
    page.locator(".oo-talk").wait_for(state="visible")
    for _ in range(n):
        tap(page, page.locator(".oo-actions button").first)
    shot(page, "oddone-talk-done")
    tap(page, page.locator(".oo-actions button").first)  # Vote
    for v in range(n):
        cover_then(page)
        choices = page.locator(".oo-choice")
        assert choices.count() == n - 1, "a player may vote for everyone but themselves"
        names = [choices.nth(i).inner_text() for i in range(choices.count())]
        target = votes[v]
        tap(page, choices.nth(target if target < v else target - 1))
        assert v >= 0 and page.locator(".oo-choice[aria-pressed=true]").count() == 1
        tap(page, page.locator(".oo-vote ~ button"))
        assert names


def test_a_round_by_touch_one_odd_one_covers_votes_and_scores(served, browser):
    ctx, page, errors = open_game(browser, served)
    shot(page, "oddone-setup")
    start(page)
    n = page.evaluate(STATE + ".n")
    saw, qmark = reveal_all(page, n)
    odd = page.evaluate(STATE + ".r.odd")
    assert qmark == [odd] and len(saw) == n - 1, "everyone but one sees the picture"
    # The group votes for the odd one: they are caught and get a guess.
    votes = [odd if v != odd else (odd + 1) % n for v in range(n)]
    talk_and_vote(page, n, votes)
    cover_then(page)  # the odd one takes the phone to guess
    options = page.locator(".oo-option")
    assert options.count() == 6
    shot(page, "oddone-guess")
    tap(page, options.first)
    page.locator(".oo-result").wait_for(state="visible")
    shot(page, "oddone-result")
    assert page.locator(".oo-scores li").count() == n
    assert page.evaluate("document.documentElement.scrollWidth") <= VIEW["width"]
    assert not errors, errors
    ctx.close()


def test_a_wrong_accusation_lets_the_odd_one_win_without_a_guess(served, browser):
    ctx, page, errors = open_game(browser, served)
    start(page)
    n = page.evaluate(STATE + ".n")
    reveal_all(page, n)
    odd = page.evaluate(STATE + ".r.odd")
    innocent = (odd + 1) % n
    votes = [innocent if v != innocent else (innocent + 1) % n for v in range(n)]
    talk_and_vote(page, n, votes)
    page.locator(".oo-result").wait_for(state="visible")
    assert page.locator(".oo-options").count() == 0
    assert page.evaluate(STATE + ".scores[%d]" % odd) == 2
    ctx.close()


def test_the_game_ends_after_its_rounds_with_a_sheet(served, browser):
    ctx, page, errors = open_game(browser, served)
    start(page)
    n, rounds = page.evaluate(STATE + ".n"), page.evaluate(STATE + ".rounds")
    for r in range(rounds):
        reveal_all(page, n)
        odd = page.evaluate(STATE + ".r.odd")
        innocent = (odd + 1) % n
        votes = [innocent if v != innocent else (innocent + 2) % n for v in range(n)]
        talk_and_vote(page, n, votes)
        page.locator(".oo-result").wait_for(state="visible")
        tap(page, page.locator(".oo-result ~ button"))
    page.locator(".ar-sheet.gs-end .ar-sheet-card").wait_for(state="visible")
    shot(page, "oddone-end")
    assert not errors, errors
    ctx.close()


def test_leaving_mid_round_comes_back_to_a_cover_not_a_secret(served, browser):
    ctx, page, errors = open_game(browser, served)
    start(page)
    cover_then(page)
    page.locator(".oo-secret").wait_for(state="visible")
    tap(page, page.locator(".oo-secret ~ button"))
    before = page.evaluate(
        "JSON.stringify(["
        + STATE
        + ".r.pic, "
        + STATE
        + ".r.odd, "
        + STATE
        + ".k, "
        + STATE
        + ".phase])"
    )
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    url = page.url
    page.goto("about:blank")
    page.goto(url)
    game_ready(page, "window.__oddone")
    page.locator(".pk-cover").wait_for(state="visible")
    assert (
        page.locator(".oo-secret").count() == 0
    ), "a restored game starts at the cover, never at someone's secret"
    assert (
        page.evaluate(
            "JSON.stringify(["
            + STATE
            + ".r.pic, "
            + STATE
            + ".r.odd, "
            + STATE
            + ".k, "
            + STATE
            + ".phase])"
        )
        == before
    )
    ctx.close()


def test_the_shelf_tile_shows_the_group_never_the_picture(served, browser):
    ctx, page, errors = open_game(browser, served)
    start(page)
    cover_then(page)
    page.locator(".oo-secret").wait_for(state="visible")
    tap(page, page.locator(".oo-secret ~ button"))
    pic_svg = page.evaluate(
        "(() => { const p = "
        + STATE
        + ".r.pic; return ZimiPictures.sets[p.cat].pics[p.i][1]; })()"
    )
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    snaps = json.loads(
        page.evaluate("localStorage.getItem('zimi.games.snaps') || '{}'")
    )
    snap = snaps.get("oddone.html")
    assert snap and snap.get("svg"), "a game under way leaves a tile"
    assert pic_svg not in snap["svg"] and "?" in snap["svg"]
    ctx.close()
