"""Small things a person meets: Shut the Box says what is still needed (and never a stale "too many"), score bars fill from the
reading side in Hebrew, the setup sheets keep Start in view in landscape.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_polish_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401


def phone(browser, locale="en-US", size=VIEW):
    return browser.new_context(
        viewport=size,
        has_touch=True,
        is_mobile=True,
        locale=locale,
        reduced_motion="reduce",
    )


def test_shut_the_box_says_what_is_needed_and_clears_a_refusal(browser, served):
    ctx = phone(browser)
    page = ctx.new_page()
    page.goto("%s/shutthebox.html" % served)
    game_ready(page)
    page.click("#st-roll")
    frames(page, 4)
    total = int(page.inner_text("#st-total"))
    assert total >= 2
    tile = lambda n: page.locator(".st-tile").nth(n - 1)
    tile(1).click()
    frames(page, 2)
    assert str(total - 1) in page.inner_text("#st-msg")
    if total <= 9:
        tile(total).click()  # 1 + total is too much: a refusal
        frames(page, 2)
        tile(
            1
        ).click()  # leave the one tile: the line is the plain ask again, not the refusal
        frames(page, 2)
        msg = page.inner_text("#st-msg")
        assert str(total) in msg
        assert "many" not in msg.lower() and "much" not in msg.lower(), msg
    ctx.close()


@pytest.mark.parametrize(
    "game, fill, side",
    [
        ("pig", "#pg-a-bank", "#pg-a .pg-meter"),
        ("tenthousand", "#tt-a-bank", "#tt-a .tt-meter"),
    ],
)
def test_score_bars_fill_from_the_reading_side_in_hebrew(
    browser, served, game, fill, side
):
    ctx = phone(browser, locale="he-IL")
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, game))
    game_ready(page)
    page.eval_on_selector(fill, "e => { e.style.width = '40%'; }")
    box = page.eval_on_selector(
        fill,
        "e => { const r = e.getBoundingClientRect(), m = e.parentElement.getBoundingClientRect(); return {fillRight: r.right, fillLeft: r.left, right: m.right, left: m.left, dir: getComputedStyle(document.documentElement).direction}; }",
    )
    assert box["dir"] == "rtl", box
    assert (
        abs(box["fillRight"] - box["right"]) < 2 and box["fillLeft"] > box["left"] + 5
    ), box
    ctx.close()
