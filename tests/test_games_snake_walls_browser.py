"""Snake's walls in Menu > Settings: Solid (the default, as before) or Wrap through, remembered, in every language.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_snake_walls_browser.py -v
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import GAMES, browser, served  # noqa: E402,F401

PRESSED = "() => Array.from(document.querySelectorAll('.gs-card .gs-row')).filter(r => r.querySelector('label').textContent === %s).map(r => Array.from(r.querySelectorAll('button')).map(b => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')))"


def open_settings(page):
    page.click(".gs-menu-btn")
    page.locator(".gs-card button", has_text="Settings").first.click()
    page.wait_for_selector(".gs-card .gs-row")


def test_walls_live_in_settings_and_are_remembered(browser, served):
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    page.goto("%s/snake.html#lang=en&dir=ltr" % served)
    page.wait_for_selector(".gs-ready .gs-menu-btn")
    open_settings(page)
    assert page.evaluate(PRESSED % json.dumps("Walls")) == [
        ["Solid*", "Wrap through"]
    ]  # the default is as it was
    page.locator(".gs-card .gs-row button", has_text="Wrap through").click()
    assert (
        page.evaluate(
            "JSON.parse(localStorage.getItem('zimi.games.snake.settings')).wrap"
        )
        is True
    )
    assert (
        page.evaluate("__snake.g.wrap") is True
    )  # a board not yet started takes it at once
    page.reload()
    page.wait_for_selector(".gs-ready .gs-menu-btn")
    open_settings(page)
    assert page.evaluate(PRESSED % json.dumps("Walls")) == [["Solid", "Wrap through*"]]
    assert page.evaluate("__snake.g.wrap") is True
    ctx.close()


def test_walls_say_so_in_every_language():
    for lang in ("en", "de", "es", "fr", "pt", "ru", "zh", "hi", "ar", "he"):
        with open(os.path.join(GAMES, "text", "%s.json" % lang), encoding="utf-8") as f:
            table = json.load(f)
        assert all(
            table.get(k)
            for k in ("snake.walls", "snake.walls.solid", "snake.walls.wrap")
        ), lang
