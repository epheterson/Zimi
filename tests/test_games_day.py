"""GET /games-day: the server's day for ZimiGames' dailies, and the one hash every daily's seed comes from.

Eric: "Daily must be same for all users of the Zimi server right". The server answers its own date in its own time zone
(and its UTC offset, so a page can work the day out itself until it asks again), never kept by a cache; the games' one
FNV-1a (shell.js, ZimiShell.hash) gives the same numbers as zimi/gamelinks.py's, so Discover's game of the day and the
shelf's agree.

Run: pytest tests/test_games_day.py -v
"""

import datetime
import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as srv  # noqa: E402
from zimi import gamelinks  # noqa: E402
from zimi.http import ZimHandler, games_day  # noqa: E402

SHELL = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
    "shell.js",
)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("gday")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def test_the_server_answers_its_own_day_never_kept(served):
    with urllib.request.urlopen(served + "/games-day") as r:
        body = json.loads(r.read())
        cache = r.headers.get("Cache-Control", "")
    now = datetime.datetime.now().astimezone()
    assert body["day"] in (
        now.date().isoformat(),
        (now - datetime.timedelta(seconds=5)).date().isoformat(),
    )
    assert body["utcOffsetMin"] == int(now.utcoffset().total_seconds() // 60)
    assert "no-store" in cache


def test_the_day_is_the_servers_time_zone_not_utc():
    # 23:30 in Los Angeles is already the next day in UTC: the server's own calendar day is what everyone on it plays.
    la = datetime.timezone(datetime.timedelta(hours=-8))
    late = datetime.datetime(2026, 11, 4, 23, 30, tzinfo=la)
    assert games_day(late) == {"day": "2026-11-04", "utcOffsetMin": -480}
    auckland = datetime.timezone(datetime.timedelta(hours=13))
    assert games_day(datetime.datetime(2026, 11, 5, 0, 15, tzinfo=auckland)) == {
        "day": "2026-11-05",
        "utcOffsetMin": 780,
    }


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_the_games_one_hash_is_gamelinks():
    words = [
        "",
        "a",
        "foobar",
        "2026-11-04",
        "zimi-daily|2026-11-04|sudoku.html",
        "Été 🌞",
        "日本",
    ]
    script = (
        "const S = require(process.argv[1]); console.log(JSON.stringify(%s.map(S.hash)))"
        % json.dumps(words)
    )
    got = json.loads(subprocess.check_output(["node", "-e", script, SHELL], text=True))
    assert got == [gamelinks._fnv1a(w) for w in words]
