"""The game bar on a phone: a stat that would cut the title ("2048" as "2." beside "148 · Bestwert 148" at 390 px in
German) goes on a second line under the title; where it fits beside the title (English) the bar is as it was.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_bar_stack_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import browser, served  # noqa: E402,F401

BAR = """() => { const bar = document.querySelector('.ar-bar'), h1 = bar.querySelector('h1');
  return { stack: bar.classList.contains('gs-bar-stack'), cut: h1.scrollWidth > h1.clientWidth + 0.5,
    h: Math.round(bar.getBoundingClientRect().height), right: Math.round(bar.lastElementChild.getBoundingClientRect().right) }; }"""


@pytest.mark.parametrize(
    "lang,stat,stacked",
    [("de", "148 · Bestwert 148", True), ("en", "148 · Best 148", False)],
)
def test_2048_keeps_its_name_whole(browser, served, lang, stat, stacked):
    ctx = browser.new_context(viewport={"width": 390, "height": 700})
    page = ctx.new_page()
    page.goto("%s/2048.html#lang=%s&dir=ltr" % (served, lang))
    page.wait_for_selector(".gs-ready .ar-bar")
    page.evaluate("s => { document.getElementById('tf-stat').textContent = s; }", stat)
    page.wait_for_timeout(300)
    got = page.evaluate(BAR)
    assert not got["cut"], got
    assert got["stack"] is stacked, got
    assert got["h"] == 56, got  # the bar keeps its height
    assert got["right"] <= 390 - 16 + 1, got  # Menu stays inside the gutter
    ctx.close()
