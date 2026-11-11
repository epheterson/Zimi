"""A finished trick game left over (its end sheet never kept) comes back through the game's own end: the sheet says who won and by how much.

The states are what the bot (scripts/games_bot/bot3.py) left at the end of a real game, with the hands and the played cards dropped. The
saved game has no `ending`, the shape an older save had; the sheet must be rebuilt from the state, and its first line is the verdict
with both scores (it used to be the last hand's line only).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_finished_resume_browser.py -v
"""

import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

FINISHED = json.loads('{"spades":{"hands":[[],[],[],[]],"bids":[4,3,2,2],"dealer":2,"turn":1,"leader":1,"trick":[],"tricks":[2,5,1,5],"broken":true,"played":[],"scores":[-213,358],"bags":[7,8],"handNo":6,"phase":"over","result":[{"points":-60,"bags":7,"made":false,"contract":6,"tricks":3,"nil":[],"bagsGained":0,"penalty":0},{"points":55,"bags":8,"made":true,"contract":5,"tricks":10,"nil":[],"bagsGained":5,"penalty":0}],"moves":56},"euchre":{"hands":[[],[],[],[]],"upcard":8,"dealer":0,"phase":"over","turn":3,"passes":2,"trump":0,"maker":3,"alone":false,"sitting":-1,"turnedDown":null,"trick":[],"leader":3,"tricks":[0,0,0,5],"played":[],"scores":[5,11],"handNo":9,"result":{"team":1,"points":2,"euchred":false,"makerTeam":1,"got":5},"moves":24},"belote":{"hands":[[],[],[],[]],"upcard":26,"deck":[],"dealer":2,"phase":"over","turn":1,"passes":1,"trump":2,"taker":0,"trick":[],"leader":1,"won":[[11,12,32,37],[19,21,33,24,20,25,35,13,26,34,38,50,45,23,22,36],[51,48,46,49,0,47,39,9],[7,8,10,6]],"tricksWon":[3,5],"belote":{"seat":-1,"shown":0},"scores":[450,582],"target":501,"handNo":5,"result":{"takerTeam":0,"pts":[58,104],"totals":[58,104],"belote":-1,"capot":-1,"made":false,"add":[0,162]},"played":[],"moves":34,"lastWinner":1}}')
# game, the numbers its verdict line must show
WANT = {"spades": ["358", "-213"], "euchre": ["11", "5"], "belote": ["582", "450"]}


@pytest.mark.parametrize("game", sorted(FINISHED))
def test_a_finished_game_without_its_end_shows_the_result(browser, served, game):
    state = FINISHED[game]
    save = json.dumps({"v": 1, "at": int(time.time() * 1000), "data": {"id": game, "state": state, "history": [], "ms": 90000, "ending": None}})
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("try { localStorage.setItem('zimi.games.save.%s', %s); } catch (e) {}" % (game, json.dumps(save)))
    page.goto("%s/%s.html" % (served, game))
    page.wait_for_selector(".ar-sheet:not([hidden]) .ar-sheet-card", timeout=30000)
    text = page.inner_text(".ar-sheet:not([hidden]) .ar-sheet-card")
    first = [l for l in text.splitlines() if l.strip()][1]
    for n in WANT[game]:
        assert n in first, (game, first, text)
    assert not errors, errors
    ctx.close()
