"""Inside Zimi, a Daily tile opens the daily: the reader keeps a game link's address (?daily=).

Zimi routes a click inside its reader through its own history, and it dropped a link's query on the way, so a Daily tile
on the shelf opened the ordinary game (an Easy Sudoku where the day's Medium one was asked for). Links into Zimi's own
apps now keep their query; links into other ZIMs are routed as before.

Run: pytest tests/test_games_daily_reader_live.py -v
"""

import json
import os
import socket
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_offline_truth_live import Server  # noqa: E402

PHONE = {"width": 390, "height": 844}
DAY = "2026-11-04"


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("daily-reader")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    srv = Server(str(tmp / "zims"), str(tmp / "data"), _free_port())
    was = os.environ.get("ZIMI_BUILTIN_ZIMS")
    os.environ["ZIMI_BUILTIN_ZIMS"] = "1"   # the suite turns Zimi's own ZIMs off; this server needs ZimiGames
    try:
        srv.start()
    finally:
        if was is None:
            os.environ.pop("ZIMI_BUILTIN_ZIMS")
        else:
            os.environ["ZIMI_BUILTIN_ZIMS"] = was
    # A fresh install asks who may manage it: this one is open, as a test machine's is.
    req = urllib.request.Request(
        srv.base + "/manage/access",
        data=json.dumps(
            {"require_password": False, "remember": True, "open_confirm": True}
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req).read()
    yield srv
    srv.stop()


def _game_frame(page, part):
    for _ in range(80):
        fr = next(
            (f for f in page.frames if f != page.main_frame and part in f.url), None
        )
        if fr:
            return fr
        page.wait_for_timeout(250)
    raise AssertionError(
        "no frame at " + part + ": " + str([f.url for f in page.frames])
    )


def test_a_daily_link_on_the_shelf_opens_the_daily_inside_zimi(zimi):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport=PHONE).new_page()
        page.goto(zimi.base + "/?a=zimi_games%2Findex.html")
        shelf = _game_frame(page, "/w/zimi_games/index.html")
        shelf.wait_for_selector("a.ar-game", state="attached", timeout=20000)
        # The shelf's Daily tile, as the shelf writes it (built here, so the test holds whatever the committed ZIM's shelf has).
        shelf.evaluate(
            "d => { const a = document.createElement('a'); a.id = 'daily-link'; a.href = 'sudoku.html?daily=' + d; a.textContent = 'Daily'; document.body.prepend(a); }",
            DAY,
        )
        shelf.click("#daily-link")
        game = _game_frame(page, "/w/zimi_games/sudoku.html")
        assert game.url.endswith("sudoku.html?daily=" + DAY)
        b.close()
