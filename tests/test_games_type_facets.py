"""A puzzle whose types are a product (grid shape, size, difficulty) asks them as short choices, and every type stays reachable.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_type_facets.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

CHECKED = "() => { const c = document.querySelector('#gametype input[name=preset]:checked'); return c && c.closest('label').textContent.trim(); }"


def open_new_game(page, name, served):
    page.goto("%s/puzzles/%s.html" % (served, name))
    page.wait_for_selector(".ar-bar .ar-btn")
    page.wait_for_function("() => document.querySelectorAll('#gametype input[name=preset]').length > 0")
    page.locator(".ar-bar .ar-btn", has_text="Menu").click()
    page.locator(".gs-sheet .gs-item", has_text="New game").first.click()
    page.wait_for_selector(".pz-facet")


def start(page):
    page.locator(".gs-sheet .gs-primary").click()
    page.wait_for_timeout(300)


@pytest.fixture
def page(browser):
    ctx = browser.new_context(viewport=VIEW)
    yield ctx.new_page()
    ctx.close()


def test_loopy_is_shape_then_size_then_difficulty(page, served):
    open_new_game(page, "loopy", served)
    assert page.locator(".pz-types .pz-opt[data-type]").count() == 1   # Custom is the only plain row left
    page.select_option(".pz-select", "Cairo")
    page.wait_for_function("() => document.querySelectorAll('.pz-facet:not([hidden])').length === 1")   # one size and one difficulty: no choice to ask
    start(page)
    assert page.evaluate(CHECKED) == "9x9 Cairo - Hard"
    open_new_game(page, "loopy", served)
    page.select_option(".pz-select", "Squares")
    page.locator(".pz-chips .pz-opt", has_text="7x7").click()
    page.locator(".pz-chips .pz-opt", has_text="Hard").click()
    start(page)
    assert page.evaluate(CHECKED) == "7x7 Squares - Hard"


def test_every_type_is_reachable_and_custom_stays(page, served):
    open_new_game(page, "mines", served)
    shapes = page.locator(".pz-select option").count() - 1   # the first option is the blank shown for Custom
    assert shapes >= 15
    page.select_option(".pz-select", "Octagonal")
    page.locator(".pz-chips .pz-opt", has_text="30x16").first.click()
    page.locator(".pz-chips .pz-opt", has_text="30% mines").click()
    start(page)
    assert page.evaluate(CHECKED) == "30x16, 30% mines, Octagonal"
    open_new_game(page, "mines", served)
    page.locator(".pz-types .pz-opt[data-type]", has_text="Custom").click()
    assert page.locator(".pz-opt[aria-pressed=true]").count() == 1


def test_a_size_and_difficulty_puzzle_is_two_short_rows(page, served):
    open_new_game(page, "bridges", served)
    assert page.locator(".pz-facet").count() == 2
    page.locator(".pz-chips .pz-opt", has_text="15x15").click()
    page.locator(".pz-chips .pz-opt", has_text="hard").click()
    start(page)
    assert page.evaluate(CHECKED) == "15x15 hard"
