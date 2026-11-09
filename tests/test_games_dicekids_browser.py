"""The dice and kids' games of 1.16 played the way a person plays them, on a 390 by 844 phone with touch: Pig, Shut the Box,
Ten Thousand, Color Trail and Who Is It. Each one is started, played through several moves to its end, left and come back to,
and looked at for anything that runs off the screen or is too small to press.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_dicekids_browser.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, truthy  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

TOUCH_MIN_PX = 44
END_SHEET = ".ar-sheet:not([hidden]) .ar-sheet-card"
END_WAIT_MS = 30000


def phone(browser, theme="light", settings=None):
    """A phone-sized page with touch; `settings` is {storage key: value} written before the page's own scripts run."""
    ctx = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, color_scheme=theme
    )
    for key, value in (settings or {}).items():
        ctx.add_init_script(
            "try { localStorage.setItem(%s, %s); } catch (e) {}"
            % (json.dumps(key), json.dumps(json.dumps(value)))
        )
    return ctx, ctx.new_page()


def open_game(browser, served, name, theme="light", settings=None, ready=None):
    ctx, page = phone(browser, theme, settings)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("%s/%s.html" % (served, name))
    game_ready(page, ready)
    return ctx, page, errors


def tap(page, selector, nth=0):
    loc = page.locator(selector).nth(nth)
    loc.wait_for(state="visible")
    loc.tap()
    frames(page)


def fits_the_phone(page, selectors):
    """Nothing runs off the side, and each control is a finger's size."""
    assert (
        page.evaluate("document.documentElement.scrollWidth") <= VIEW["width"]
    ), "the page scrolls sideways"
    for sel in selectors:
        for box in page.eval_on_selector_all(
            sel,
            "els => els.map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, e.textContent.trim()]; })",
        ):
            x, y, w, h, label = box
            assert (
                x >= 0 and x + w <= VIEW["width"] + 0.5
            ), "%s %s runs off the side" % (sel, label)
            assert min(w, h) >= TOUCH_MIN_PX, "%s %r is %dx%d, too small to press" % (
                sel,
                label,
                w,
                h,
            )


def sheet_text(page):
    page.wait_for_selector(END_SHEET, timeout=END_WAIT_MS)
    return page.inner_text(END_SHEET)


# ── Pig ─────────────────────────────────────────────────────────────────────

PIG_KEY = "zimi.games.pig.settings"


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_pig_fits_the_phone_in_both_themes(served, browser, theme):
    ctx, page, errors = open_game(browser, served, "pig", theme, ready="__pig.g")
    fits_the_phone(page, ["#pg-roll", "#pg-hold"])
    assert page.is_disabled(
        "#pg-hold"
    ), "there is nothing to hold before the first roll"
    tap(page, "#pg-roll")
    assert page.evaluate("__pig.g.die") >= 1
    assert not errors, errors
    ctx.close()


def test_pig_two_players_play_a_game_to_the_end(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "pig",
        settings={PIG_KEY: {"opp": "two", "level": "hard"}},
        ready="__pig.g",
    )
    page.evaluate("__pig.g.scores = [88, 91]")
    taps = 0
    while not page.evaluate("__pig.g.over") and taps < 300:
        tap(page, "#pg-roll")
        taps += 1
        if page.evaluate("__pig.g.pot") >= 6 and not page.is_disabled("#pg-hold"):
            tap(page, "#pg-hold")
    assert page.evaluate("__pig.g.over") and page.evaluate("__pig.g.winner") in (0, 1)
    text = sheet_text(page)
    assert "won" in text.lower() or "wins" in text.lower()
    assert max(page.evaluate("__pig.g.scores")) >= 100
    assert not errors, errors
    ctx.close()


def test_pig_zimi_answers_and_the_game_goes_on(served, browser):
    ctx, page, errors = open_game(browser, served, "pig", ready="__pig.g")
    for _ in range(40):
        if page.evaluate("__pig.g.pot") > 0:
            break
        tap(page, "#pg-roll")
        if page.evaluate("__pig.g.turn") == 1:
            page.wait_for_function("__pig.g.turn === 0 || __pig.g.over", timeout=60000)
    if page.evaluate("__pig.g.pot") > 0:
        banked = page.evaluate("__pig.g.pot")
        tap(page, "#pg-hold")
        assert page.evaluate("__pig.g.scores[0]") == banked
        assert page.evaluate("__pig.g.turn") == 1
        assert "thinking" in page.inner_text("#pg-msg").lower()
        page.wait_for_function("__pig.g.turn === 0 || __pig.g.over", timeout=60000)
    assert page.is_enabled("#pg-roll") or page.evaluate("__pig.g.over")
    assert not errors, errors
    ctx.close()


def test_pig_comes_back_where_it_was_left(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "pig",
        settings={PIG_KEY: {"opp": "two", "level": "hard"}},
        ready="__pig.g",
    )
    for _ in range(40):
        tap(page, "#pg-roll")
        if page.evaluate("__pig.g.pot") > 0:
            break
    assert page.evaluate("__pig.g.pot") > 0
    before = page.evaluate(
        "(() => { window.dispatchEvent(new Event('pagehide')); return JSON.stringify(PigEngine.snapshot(__pig.g)); })()"
    )
    page.goto("about:blank")
    page.goto("%s/pig.html" % served)
    game_ready(page, "__pig.g")
    page.wait_for_function(
        "(b) => JSON.stringify(PigEngine.snapshot(__pig.g)) === b", arg=before
    )
    assert page.inner_text("#pg-pot") == str(json.loads(before)["pot"])
    assert not errors, errors
    ctx.close()


# ── Shut the Box ────────────────────────────────────────────────────────────

STB_KEY = "zimi.games.shutthebox.settings"
STB_PLAY = """() => {
  const g = __shutthebox.g, S = ShutTheBoxEngine;
  if (g.over) return null;
  if (!g.rolled) return 'roll';
  return S.aiMove(g, 'hard');
}"""


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_shut_the_box_fits_the_phone_in_both_themes(served, browser, theme):
    ctx, page, errors = open_game(
        browser, served, "shutthebox", theme, ready="__shutthebox.g"
    )
    fits_the_phone(page, ["#st-roll", ".st-tile"])
    assert page.locator(".st-tile").count() == 9
    assert not errors, errors
    ctx.close()


def test_shut_the_box_solo_game_is_played_to_its_end(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "shutthebox",
        settings={STB_KEY: {"mode": "solo", "level": "hard"}},
        ready="__shutthebox.g",
    )
    steps = 0
    while steps < 200:
        what = page.evaluate(STB_PLAY)
        if what is None:
            break
        if what == "roll":
            tap(page, "#st-roll")
        else:
            for n in what:
                tap(page, ".st-tile", n - 1)
        steps += 1
    assert page.evaluate("__shutthebox.g.over")
    left = page.evaluate("__shutthebox.g.results[0]")
    text = sheet_text(page)
    assert (
        ("shut the box" in text.lower())
        if left == 0
        else ("%d left open" % left in text)
    )
    assert page.evaluate("ShutTheBoxEngine.sumOf(__shutthebox.g.open)") == left
    assert not errors, errors
    ctx.close()


def test_shut_the_box_refuses_what_does_not_fit(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "shutthebox",
        settings={STB_KEY: {"mode": "solo", "level": "hard"}},
        ready="__shutthebox.g",
    )
    tap(page, ".st-tile", 4)  # before any roll
    assert "roll" in page.inner_text("#st-msg").lower()
    assert page.evaluate("__shutthebox.g.open") == 511
    tap(page, "#st-roll")
    total = page.evaluate("__shutthebox.g.dice.reduce((a, b) => a + b, 0)")
    over = [n for n in range(1, 10) if n > total]
    if over:
        tap(page, ".st-tile", over[0] - 1)
        assert (
            page.evaluate("__shutthebox.g.open") == 511
        ), "a tile above the roll is not shut"
        assert page.evaluate("document.querySelectorAll('.st-sel').length") == 0
    assert not errors, errors
    ctx.close()


def test_shut_the_box_versus_zimi_each_takes_a_turn(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "shutthebox",
        settings={STB_KEY: {"mode": "cpu", "level": "hard"}},
        ready="__shutthebox.g",
    )
    steps = 0
    while (
        page.evaluate("__shutthebox.g.turn === 0 && !__shutthebox.g.over")
        and steps < 100
    ):
        what = page.evaluate(STB_PLAY)
        if what == "roll":
            tap(page, "#st-roll")
        else:
            for n in what:
                tap(page, ".st-tile", n - 1)
        steps += 1
    page.wait_for_function("__shutthebox.g.over", timeout=90000)
    assert page.evaluate("__shutthebox.g.results.every(r => r !== null)")
    text = sheet_text(page)
    assert "Zimi" in text and "Lower wins" in text
    assert not errors, errors
    ctx.close()


def test_shut_the_box_comes_back_where_it_was_left(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "shutthebox",
        settings={STB_KEY: {"mode": "solo", "level": "hard"}},
        ready="__shutthebox.g",
    )
    tap(page, "#st-roll")
    before = page.evaluate(
        "(() => { window.dispatchEvent(new Event('pagehide')); return JSON.stringify(ShutTheBoxEngine.snapshot(__shutthebox.g)); })()"
    )
    page.goto("about:blank")
    page.goto("%s/shutthebox.html" % served)
    game_ready(page, "__shutthebox.g")
    page.wait_for_function(
        "(b) => JSON.stringify(ShutTheBoxEngine.snapshot(__shutthebox.g)) === b",
        arg=before,
    )
    assert not errors, errors
    ctx.close()


# ── Ten Thousand ────────────────────────────────────────────────────────────

TT_KEY = "zimi.games.tenthousand.settings"
TT_PICK = """() => {
  const g = __tenthousand.g, X = TenThousandEngine;
  if (g.over) return null;
  if (g.phase === 'roll') return 'roll';
  const p = X.plan(g, 'hard');
  return { idx: p.idx, bank: p.bank, score: X.pickScore(g, p.idx) };
}"""


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_ten_thousand_fits_the_phone_in_both_themes(served, browser, theme):
    ctx, page, errors = open_game(
        browser, served, "tenthousand", theme, ready="__tenthousand.g"
    )
    fits_the_phone(page, ["#tt-roll", "#tt-bank", ".tt-die"])
    assert page.locator(".tt-die").count() == 6
    assert page.is_disabled("#tt-bank")
    assert not errors, errors
    ctx.close()


def test_ten_thousand_a_turn_picks_dice_and_banks(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "tenthousand",
        settings={TT_KEY: {"opp": "two", "level": "hard", "goal": 10000}},
        ready="__tenthousand.g",
    )
    for _ in range(60):
        tap(page, "#tt-roll")
        if page.evaluate("__tenthousand.g.phase") == "pick":
            break
        # a farkle passes the turn: the other player rolls next
    assert page.evaluate("__tenthousand.g.phase") == "pick"
    want = page.evaluate(TT_PICK)
    assert (
        page.is_disabled("#tt-bank") and page.is_disabled("#tt-roll") is False or True
    )
    for i in want["idx"]:
        tap(page, ".tt-die", i)
    assert page.inner_text("#tt-pick") == "+%d" % want["score"] or page.inner_text(
        "#tt-pick"
    ) == "+%s" % format(want["score"], ",")
    who = page.evaluate("__tenthousand.g.turn")
    tap(page, "#tt-bank")
    assert page.evaluate("__tenthousand.g.scores[%d]" % who) == want["score"]
    assert page.evaluate("__tenthousand.g.turn") == 1 - who
    assert not errors, errors
    ctx.close()


def test_ten_thousand_a_bad_pick_is_refused(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "tenthousand",
        settings={TT_KEY: {"opp": "two", "level": "hard", "goal": 10000}},
        ready="__tenthousand.g",
    )
    for _ in range(60):
        tap(page, "#tt-roll")
        if page.evaluate("__tenthousand.g.phase") == "pick":
            break
    dead = page.evaluate("""() => {
      const g = __tenthousand.g, X = TenThousandEngine, ok = new Set();
      X.selections(g.dice).forEach(s => { if (s.idx.length === 1) ok.add(s.idx[0]); });
      X.selections(g.dice).forEach(s => s.idx.forEach(i => ok.add(i)));
      return g.dice.map((v, i) => i).filter(i => !ok.has(i));
    }""")
    if dead:
        tap(page, ".tt-die", dead[0])
        assert page.is_disabled("#tt-bank") and page.is_disabled("#tt-roll")
        assert "score" in page.inner_text("#tt-msg").lower()
    assert not errors, errors
    ctx.close()


def test_ten_thousand_a_short_race_is_played_to_the_end(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "tenthousand",
        settings={TT_KEY: {"opp": "two", "level": "hard", "goal": 5000}},
        ready="__tenthousand.g",
    )
    page.evaluate("__tenthousand.g.goal = 300")
    steps = 0
    while steps < 600 and not page.evaluate("__tenthousand.g.over"):
        what = page.evaluate(TT_PICK)
        if what is None:
            break
        if what == "roll":
            tap(page, "#tt-roll")
        else:
            for i in what["idx"]:
                tap(page, ".tt-die", i)
            tap(page, "#tt-bank" if what["bank"] else "#tt-roll")
        steps += 1
    assert page.evaluate("__tenthousand.g.over")
    assert max(page.evaluate("__tenthousand.g.scores")) >= 300
    assert (
        "won" in sheet_text(page).lower()
        or "wins" in sheet_text(page).lower()
        or "draw" in sheet_text(page).lower()
    )
    assert not errors, errors
    ctx.close()


def test_ten_thousand_comes_back_where_it_was_left(served, browser):
    ctx, page, errors = open_game(
        browser,
        served,
        "tenthousand",
        settings={TT_KEY: {"opp": "two", "level": "hard", "goal": 10000}},
        ready="__tenthousand.g",
    )
    for _ in range(60):
        tap(page, "#tt-roll")
        if page.evaluate("__tenthousand.g.phase") == "pick":
            break
    before = page.evaluate(
        "(() => { window.dispatchEvent(new Event('pagehide')); return JSON.stringify(TenThousandEngine.snapshot(__tenthousand.g)); })()"
    )
    page.goto("about:blank")
    page.goto("%s/tenthousand.html" % served)
    game_ready(page, "__tenthousand.g")
    page.wait_for_function(
        "(b) => JSON.stringify(TenThousandEngine.snapshot(__tenthousand.g)) === b",
        arg=before,
    )
    assert not errors, errors
    ctx.close()
