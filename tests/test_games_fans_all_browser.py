"""Every vertical fan follows one rule, in every card game that has one, and no card game runs off the side of a phone.

A covered face-up card shows its index row only (39.5 of 140 units of the card), whatever its rank: no strip of a court's picture, and
one step for the whole column. The deal's last card in each column is whole and inside the screen. Seen on the dealt table of every
solitaire with columns, at 390x844.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_fans_all_browser.py -v
(ZIMI_GAMES_DIR points the test at another copy of the games folder, to prove it fails on an older one.)
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import settled  # noqa: E402
from test_games_court_fill_browser import LAYOUT, NOT_DEALING, served  # noqa: E402,F401
from test_games_persist_browser import browser  # noqa: E402,F401

pytest.importorskip("playwright")

INDEX_ROW_SHARE = 39.5 / 140
FANS = [
    "solitaire",
    "spider",
    "freecell",
    "golf",
    "yukon",
    "scorpion",
    "canfield",
    "beleaguered",
    "eightoff",
    "fortythieves",
]
DEALS_NO_FAN = {"solitaire", "spider", "canfield"}   # one face-up card to a column when dealt; test_games_court_fill_browser builds their fans
EVERY_CARD_GAME = FANS + [
    "calculation",
    "acesup",
    "accordion",
    "montecarlo",
    "pyramid",
    "tripeaks",
    "ohhell",
    "cheat",
    "belote",
    "bigtwo",
        "bridge",
    "canasta",
    "crazyeights",
    "cribbage",
    "durak",
    "euchre",
    "gin",
    "gofish",
    "hearts",
        "koikoi",
    "oldmaid",
    "scopa",
    "skat",
    "snap",
    "spades",
    "teenpatti",
    "tienlen",
    "truco",
]

COLUMNS = """() => {
  const cols = {};
  document.querySelectorAll('.zc-card:not(.zc-off)').forEach(e => {
    const r = e.getBoundingClientRect(), k = Math.round(r.left);
    (cols[k] = cols[k] || []).push({ id: e.dataset.id, top: r.top, bottom: r.bottom, h: r.height, up: !e.classList.contains('zc-down'),
      frame: (() => { const f = e.querySelector('.zc-ct-row .zc-rule'); return f && f.getBoundingClientRect().width ? f.getBoundingClientRect().top - r.top : null; })() });
  });
  return Object.values(cols).map(c => c.sort((a, b) => a.top - b.top));
}"""


def open_game(browser, served, name, width=390, height=844):
    ctx = browser.new_context(
        viewport={"width": width, "height": height}, is_mobile=True, has_touch=True
    )
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, name))
    page.wait_for_selector(".zc-card:not(.zc-off)")
    page.wait_for_function(NOT_DEALING)
    settled(page, LAYOUT)
    return ctx, page


@pytest.mark.parametrize("name", FANS)
def test_a_covered_card_shows_its_index_row_only(browser, served, name):
    ctx, page = open_game(browser, served, name)
    cols = page.evaluate(COLUMNS)
    steps = 0
    for col in cols:
        for a, b in zip(col, col[1:]):
            if (
                not (a["up"] and b["up"])
                or b["top"] - a["top"] > a["h"] * 0.9
                or b["top"] - a["top"] < 1
            ):
                continue  # a face-down card, a pile on one spot, a gap between two piles: not a fan step
            steps += 1
            assert b["top"] - a["top"] <= a["h"] * INDEX_ROW_SHARE + 1, (
                name,
                a,
                b,
            )  # one rule: the index row at most
            if a["frame"] is not None:
                assert b["top"] - a["top"] <= a["frame"] + 0.5, (
                    name,
                    a,
                    b,
                )  # nothing of a court's frame or picture shows
    assert steps or name in DEALS_NO_FAN, name  # the dealt table has a fan to measure
    ctx.close()


@pytest.mark.parametrize("name", EVERY_CARD_GAME)
def test_no_card_runs_off_a_phone(browser, served, name):
    ctx, page = open_game(browser, served, name)
    r = page.evaluate(
        """() => { const cs = [...document.querySelectorAll('.zc-card:not(.zc-off)')].filter(e => getComputedStyle(e).visibility !== 'hidden').map(e => e.getBoundingClientRect());
      return { left: Math.min(...cs.map(r => r.left)), right: Math.max(...cs.map(r => r.right)), W: innerWidth, bottom: Math.max(...cs.map(r => r.bottom)), H: innerHeight, sw: document.documentElement.scrollWidth }; }"""
    )
    assert r["left"] >= -0.5 and r["right"] <= r["W"] + 0.5 and r["sw"] <= r["W"], (
        name,
        r,
    )
    ctx.close()
