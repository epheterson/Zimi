"""Bridge's bidding box leaves the auction above it in view, so the earlier calls can be read while a call is chosen.

At the width of a phone, on the heights a game has inside Zimi's reader (the header and the bar take about 90 px off the
screen) and on a full one: the auction and the box never overlap, the buttons keep a usable height, and a long auction shows
its latest calls.

Run: pytest tests/test_games_bridge_box.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready  # noqa: E402
from test_games_persist_browser import browser, served  # noqa: E402,F401

MY_CALL = "() => ZimiBridge.session.state.phase === 'auction' && ZimiBridge.session.state.turn === 0 && document.querySelector('.br-box:not([hidden])')"
# Bids that rise one step at a time, round the table, until it is our turn again after at least `n` calls.
LONG_AUCTION = """(n) => {
  const B = window.ZimiBridge, s = B.session || ZimiBridge.session;
  let st = JSON.parse(JSON.stringify(s.state));
  while (st.auction.length < n || st.turn !== 0) {
    const next = B.applyCall(st, st.turn, B.legalCalls(st, st.turn)[1]);   // the lowest bid there is: the auction rises a step at a time
    if (next === st || next.phase !== 'auction') break;
    st = next;
  }
  s.follow(st);
}"""
RECTS = """() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
  const bid = document.querySelector('.br-bid');
  const au = document.querySelector('.br-auction');
  const latest = document.querySelector('.br-latest');
  const ab = au.getBoundingClientRect(), lb = latest ? latest.getBoundingClientRect() : null;
  return { auction: r('.br-auction'), box: r('.br-box'), bidH: bid ? bid.getBoundingClientRect().height : 0,
    latestShown: lb ? lb.top >= ab.top && lb.bottom <= ab.bottom + 1 : false };
}"""


@pytest.mark.parametrize("height", [700, 760, 844])
@pytest.mark.parametrize("calls", [0, 14])
def test_the_auction_stays_visible_above_the_bidding_box(served, browser, height, calls):  # noqa: F811
    ctx = browser.new_context(viewport={"width": 390, "height": height})
    page = ctx.new_page()
    page.goto(served + "/bridge.html")
    game_ready(page)
    page.wait_for_function(MY_CALL, timeout=90000)
    if calls:
        page.evaluate(LONG_AUCTION, calls)
        page.wait_for_function("(n) => ZimiBridge.session.state.auction.length >= n && document.querySelector('.br-box:not([hidden])')", arg=calls)
    frames(page, 4)
    got = page.evaluate(RECTS)
    assert got["auction"] and got["box"], got
    assert got["auction"]["bottom"] <= got["box"]["top"] + 0.5, "the box covers the auction: %s" % json.dumps(got)
    assert got["bidH"] >= 32, "the bid buttons are too small to tap: %s" % got["bidH"]
    assert got["latestShown"] or not calls, "the latest call is out of sight: %s" % json.dumps(got)
    ctx.close()
