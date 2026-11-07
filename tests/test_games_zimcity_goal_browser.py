"""A ZimCity scenario keeps its goal and the time left on screen, warns before the money is gone, and ends honestly.

A playtester found: Bern opened with the generic power-line line and its goal appeared only after a change; San Francisco's
goal was cut off ("Rebuild to a metropolis wi..."); Bern went bankrupt a year before judging with no warning, and the
Bankrupt sheet said the city ran out of money while the strip showed $1,410; the end sheets named neither the goal nor
what the city reached; the win sheet's year counted up from the wrong number.

Run: pytest tests/test_games_zimcity_goal_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_games_zimcity_browser import OURS, browser, site  # noqa: E402,F401

SCENARIO_IDS = [
    "dullsville",
    "sanfrancisco",
    "hamburg",
    "bern",
    "tokyo",
    "detroit",
    "boston",
    "rio",
]
LANGS = ["en", "ar", "de", "es", "fr", "he", "hi", "pt", "ru", "zh"]


def _page(browser, site, lang="en"):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        locale=lang,
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(site + "zimcity.html#lang=" + lang)
    pg.wait_for_function(
        "() => window.__zimcity && window.__zimcity.city && document.getElementById('cy-funds').textContent"
    )
    pg.evaluate("() => document.getElementById('cy-pause').click()")
    return pg


def _play(pg, i):
    pg.click(".gs-menu-btn")
    pg.click("#cy-scenarios")
    pg.click(OURS + " .cy-sc >> nth=%d >> .cy-sc-go" % i)
    pg.wait_for_function("(id) => window.__zimcity.city.scenario && window.__zimcity.city.scenario.id === id", arg=SCENARIO_IDS[i])   # the one asked for, not one already open


GOAL_BOX = """() => {
  const g = document.getElementById('cy-goal'), r = g.getBoundingClientRect(), kids = [...g.children].map(k => k.getBoundingClientRect());
  const lh = parseFloat(getComputedStyle(g).lineHeight) || 16;
  return { hidden: g.hidden, text: g.textContent, right: r.right, left: r.left, width: window.innerWidth,
           over: g.scrollWidth - g.clientWidth, lines: Math.round(r.height / lh),
           kidsOver: kids.some(k => k.right > r.right + 1 || k.left < r.left - 1), pageOver: document.documentElement.scrollWidth - window.innerWidth };
}"""


@pytest.mark.parametrize("lang", LANGS)
def test_every_scenario_shows_its_goal_and_years_left_whole_at_390_in_every_language(
    browser, site, lang
):
    pg = _page(browser, site, lang)
    for i, sid in enumerate(SCENARIO_IDS):
        _play(pg, i)
        got = pg.evaluate(GOAL_BOX)
        assert not got["hidden"] and got["text"].strip(), (sid, got)
        assert got["over"] <= 0 and not got["kidsOver"] and got["pageOver"] <= 0, (
            lang,
            sid,
            got,
        )
        assert got["right"] <= got["width"] and got["left"] >= 0, (lang, sid, got)
        assert got["lines"] <= 3, (lang, sid, got)
        assert pg.evaluate(
            "() => /\\d/.test(document.getElementById('cy-goal').textContent)"
        )  # the time left is a number
    assert not pg.errors, pg.errors


def test_the_goal_says_the_goal_where_the_city_stands_and_the_time_left(browser, site):
    pg = _page(browser, site)
    _play(pg, 3)  # Bern
    got = pg.evaluate(GOAL_BOX)
    assert (
        got["text"].startswith("Goal: traffic below 35")
        and "10 years left" in got["text"]
    ), got
    _play(pg, 1)  # San Francisco: five years, a size to reach
    got = pg.evaluate(GOAL_BOX)
    assert "reach Metropolis" in got["text"] and "5 years left" in got["text"], got
    pg.evaluate(
        "() => { window.__zimcity.city.scenario.judgeIn = 30; window.__zimcity.step(1); }"
    )
    assert (
        "8 months left" in pg.evaluate(GOAL_BOX)["text"]
    )  # under a year: months, in the plural form
    pg.evaluate("() => { window.__zimcity.city.scenario.judgeIn = 4; window.__zimcity.step(1); }")
    assert "1 month left" in pg.evaluate(GOAL_BOX)["text"]


def _settle_budgets(pg, years):
    """Step the city (16 steps are a tick, 48 ticks a year), closing each year's budget as a player does."""
    for _ in range(years * 4):
        pg.evaluate("() => window.__zimcity.step(16 * 12)")
        if pg.query_selector(OURS + " .ar-sheet-card"):
            pg.click(OURS + " >> text=Close")


def test_bern_warns_that_the_money_runs_out_long_before_it_does(browser, site):
    pg = _page(browser, site)
    _play(pg, 3)
    _settle_budgets(pg, 2)
    said = pg.evaluate("() => window.__zimcity.said()")
    funds = pg.evaluate("() => window.__zimcity.city.sim.budget.totalFunds")
    assert (
        funds > 10000
    )  # the bank is far from empty: this is the warning, not the bust
    assert any("Money is running out" in s for s in said), (said, funds)
    assert "cy-low" in pg.evaluate(
        "() => document.getElementById('cy-funds').className"
    )


def test_the_bankrupt_sheet_gives_the_figures_the_strip_shows_and_the_goal(
    browser, site
):
    pg = _page(browser, site)
    _play(pg, 3)
    _settle_budgets(pg, 1)
    pg.evaluate(
        "() => { window.__zimcity.city.sim.budget.totalFunds = 1410; window.__zimcity.step(1); }"
    )
    strip = pg.inner_text("#cy-funds")
    assert strip == "$1,410"
    pg.evaluate(
        "() => window.__zimcity.step(16 * 60)"
    )  # to the next year's budget, which it cannot pay
    sheet = pg.wait_for_selector(OURS + " .ar-sheet-card", timeout=15000)
    text = sheet.inner_text()
    assert "Bankrupt" in text and "$1,410" in text and "due this year" in text, text
    assert "The goal was traffic below 35" in text, text


def test_a_scenario_that_ends_names_the_goal_and_what_the_city_reached(browser, site):
    pg = _page(browser, site)
    _play(pg, 1)  # San Francisco
    pg.evaluate(
        "() => { window.__zimcity.city.scenario.judgeIn = 2; window.__zimcity.step(16 * 3); }"
    )
    sheet = pg.wait_for_selector(OURS + " .ar-sheet-card", timeout=15000)
    text = sheet.inner_text()
    assert (
        "The goal was reach Metropolis" in text or "goal met (reach Metropolis" in text
    ), text
    assert "the city reached" in text, text
    # the year is a name, not an amount: it never counts up from a wrong number
    chip = pg.evaluate(
        "() => { const c = [...document.querySelectorAll('.gs-chip')].find(c => /Year/.test(c.textContent)); return { t: c.querySelector('b').textContent, s: c.classList.contains('gs-chip-static'), y: window.__zimcity.city.sim.getDate().year }; }"
    )
    assert chip["s"] and chip["t"] == str(chip["y"]), chip
