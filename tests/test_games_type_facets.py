"""A puzzle whose types are a product (grid shape, size, difficulty) asks them as short choices in the shared option rows, every type stays reachable,
and the custom size is one more choice of the size row whose fields show only while it is chosen.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_type_facets.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

CHECKED = "() => { const c = document.querySelector('#gametype input[name=preset]:checked'); return c && c.closest('label').textContent.trim(); }"


ROWS = ".gs-options .gs-row:not([hidden])"
PARAMS = """() => {
  const radios = [...document.querySelectorAll('#gametype input[name=preset]')];
  const custom = radios.find(r => r.closest('label').textContent.trim() === 'Custom...');
  const was = radios.find(r => r.checked);
  custom.click();
  const form = document.getElementById('dlgform');
  const out = [...form.querySelectorAll('label')].map(l => { const s = l.querySelector('select'), i = l.querySelector('input[type=text]'); return s ? s.options[s.selectedIndex].text : i ? i.value : ''; });
  form.querySelector('input[value=Cancel]').click();
  return out.join(',');
}"""


def open_new_game(page, name, served):
    page.goto("%s/puzzles/%s.html" % (served, name))
    page.wait_for_selector(".ar-bar .ar-btn")
    page.wait_for_function("() => document.querySelectorAll('#gametype input[name=preset]').length > 0")
    page.locator(".ar-bar .ar-btn", has_text="Menu").click()
    page.locator(".gs-sheet .gs-item", has_text="New game").first.click()
    page.wait_for_selector(".gs-options .gs-row")


def start(page):
    page.locator(".gs-sheet .gs-primary").click()
    page.wait_for_timeout(300)


def choice(page, text):
    page.locator(".gs-options .gs-seg button", has_text=text).first.click()


@pytest.fixture
def page(browser):
    ctx = browser.new_context(viewport=VIEW)
    yield ctx.new_page()
    ctx.close()


def test_loopy_is_shape_then_size_then_difficulty(page, served):
    open_new_game(page, "loopy", served)
    assert page.locator(".pz-types .pz-opt").count() == 0   # no plain list of types left: the rows are the shared option rows
    page.select_option(".gs-options select", "Cairo")
    page.wait_for_function("() => document.querySelectorAll('.gs-options .gs-row:not([hidden]):not(.gs-field)').length === 1")   # one size (and Custom) and one difficulty: only the size row asks
    start(page)
    assert page.evaluate(CHECKED) == "9x9 Cairo - Hard"
    open_new_game(page, "loopy", served)
    page.select_option(".gs-options select", "Squares")
    choice(page, "7x7")
    choice(page, "Hard")
    start(page)
    assert page.evaluate(CHECKED) == "7x7 Squares - Hard"


def test_every_type_is_reachable(page, served):
    open_new_game(page, "mines", served)
    assert page.locator(".gs-options select option").count() >= 15
    page.select_option(".gs-options select", "Octagonal")
    choice(page, "30x16")
    choice(page, "30% mines")
    start(page)
    assert page.evaluate(CHECKED) == "30x16, 30% mines, Octagonal"


def test_a_size_and_difficulty_puzzle_is_two_short_rows(page, served):
    open_new_game(page, "bridges", served)
    assert page.locator(ROWS).count() == 2
    choice(page, "15x15")
    choice(page, "hard")
    start(page)
    assert page.evaluate(CHECKED) == "15x15 hard"


def test_custom_fields_show_only_while_custom_is_chosen(page, served):
    open_new_game(page, "loopy", served)
    assert page.locator(".pz-custom").is_hidden()
    choice(page, "Custom")
    assert page.locator(".pz-custom input").count() == 2   # width and height; the shape and the difficulty are the rows above, not asked twice
    assert page.locator(".gs-options select").count() == 1
    page.select_option(".gs-options select", "Triangular")
    assert page.locator(".pz-custom").is_visible()   # changing the shape does not leave the custom size
    page.select_option(".gs-options select", "Squares")
    choice(page, "7x7")
    assert page.locator(".pz-custom").is_hidden()


def test_custom_size_starts_with_the_panes_own_values(page, served):
    open_new_game(page, "loopy", served)
    choice(page, "Custom")
    fields = page.locator(".pz-custom input")
    fields.nth(0).fill("6")
    fields.nth(1).fill("4")
    page.select_option(".gs-options select", "Triangular")   # the presets give Triangular one difficulty; a custom size has the dialog's four
    choice(page, "Hard")
    start(page)
    assert page.evaluate("() => !document.getElementById('dlgform')")   # no second dialog
    assert page.evaluate(PARAMS) == "6,4,Triangular,Hard"
    open_new_game(page, "loopy", served)   # a custom game in play: the pane opens on it
    assert page.locator(".gs-options .gs-row:not([hidden]) [aria-pressed=true]").all_text_contents() == ["Custom", "Hard"]
    assert page.locator(".pz-custom input").nth(0).input_value() == "6"


def test_a_puzzle_with_a_plain_list_of_types_keeps_custom_in_it(page, served):
    open_new_game(page, "net", served)
    choice(page, "Custom")
    assert page.locator(".pz-custom input").count() >= 2
    assert page.locator(".pz-types > .gs-row .gs-seg [aria-pressed=true]").all_text_contents() == ["Custom"]
    choice(page, "5x5")
    assert page.locator(".pz-custom").is_hidden()


def test_a_custom_size_offers_what_only_its_dialog_has(page, served):
    """Unequal's Recursive difficulty is in no preset, only in the custom size's dialog: Custom offers it, and it is what the game is made with."""
    open_new_game(page, "unequal", served)
    assert page.locator(".gs-options .gs-seg button", has_text="Recursive").count() == 0
    choice(page, "Custom")
    choice(page, "Recursive")
    start(page)
    assert page.evaluate(PARAMS).endswith("Recursive")
    open_new_game(page, "unequal", served)   # the pane opens on the game in play, Recursive included
    assert "Recursive" in page.locator(".gs-options .gs-row:not([hidden]) [aria-pressed=true]").all_text_contents()
    choice(page, "4x4")   # a preset size again: its difficulty is a preset's
    assert page.locator(".gs-options .gs-seg button", has_text="Recursive").count() == 0
    start(page)
    assert "4x4" in page.evaluate(CHECKED)
