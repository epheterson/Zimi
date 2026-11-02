"""Five Letters: tapping the solved word's row opens its definition when one is on offer (the Dictionary link),
and does nothing when none is.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_five_tap.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

DAILY = "() => { const E = FiveLettersEngine; return E.dailyAnswer(E.makeWords(FIVE_ALLOWED, FIVE_ANSWERS), new Date()); }"
# Stands in for the Dictionary link a Zimi with the app on would show: a link that counts its clicks.
OFFER = """() => { const a = document.getElementById('fl-learn'); window.__learned = 0; a.href = '#learn'; a.hidden = false; a.addEventListener('click', e => { e.preventDefault(); window.__learned++; }); }"""
WON_ROW = "() => document.querySelectorAll('.fl-row')[0].querySelectorAll('.fl-tile')[2]"


def solve(page):
    page.keyboard.type(page.evaluate(DAILY))
    page.keyboard.press("Enter")
    page.wait_for_function("document.getElementById('fl-actions') && !document.getElementById('fl-actions').hidden", timeout=10000)


def test_tapping_the_solved_row_follows_the_definition_link(served, browser):
    ctx = browser.new_context(viewport=VIEW, has_touch=True)
    page = ctx.new_page()
    page.goto("%s/fiveletters.html" % served)
    page.wait_for_selector(".fl-tile")
    page.wait_for_timeout(300)
    solve(page)
    page.evaluate(OFFER)
    page.locator(".fl-row").nth(1).locator(".fl-tile").nth(2).click(force=True)
    assert page.evaluate("window.__learned") == 0, "an empty row is not the solved word"
    page.locator(".fl-row").nth(0).locator(".fl-tile").nth(2).click()
    assert page.evaluate("window.__learned") == 1, "the solved row opens the definition"
    ctx.close()


def test_tapping_the_solved_row_does_nothing_without_a_definition(served, browser):
    ctx = browser.new_context(viewport=VIEW, has_touch=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("%s/fiveletters.html" % served)
    page.wait_for_selector(".fl-tile")
    page.wait_for_timeout(300)
    solve(page)
    page.locator(".fl-row").nth(0).locator(".fl-tile").nth(2).click()
    assert not errors
    ctx.close()
