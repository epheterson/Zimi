"""The games ZIM is a library file a copy can stand in for; Zimi's window never runs its scripts, and only the games page may drive the game header.

* game, game-sky and game-app messages are heard only while the games ZIM is what the reader shows.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_home_isolation.py -v
"""

import os
import socket
import subprocess
import sys

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from games_wait import wait_for_server  # noqa: E402


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    base = tmp_path_factory.mktemp("home")
    (base / "zims").mkdir()
    (base / "data").mkdir()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1", ZIMI_RATE_LIMIT="1000000", ZIM_DIR=str(base / "zims"), ZIMI_DATA_DIR=str(base / "data"))
    env.pop("ZIMI_BUILTIN_ZIMS", None)
    proc = subprocess.Popen([sys.executable, "-m", "zimi", "serve", "--port", str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_for_server(port):
            pytest.skip("zimi did not start")
        yield "http://127.0.0.1:%d/" % port
    finally:
        proc.terminate()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


MESSAGES = [
    {"zimi": "game", "title": "Hostile", "act": {"kind": "undo", "label": "x"}},
    {"zimi": "game-sky", "place": "x"},
    {"zimi": "game-app", "app": "dictionary", "w": "word"},
]


def _send_from_reader_frame(page, msg):
    page.evaluate("""m => { let f = document.getElementById('reader-frame'); f.src = 'about:blank'; }""")
    page.wait_for_function("() => document.getElementById('reader-frame').contentWindow.location.href === 'about:blank'")
    # run inside the frame, so the message's source is the reader frame
    page.evaluate("m => document.getElementById('reader-frame').contentWindow.eval('parent.postMessage(' + JSON.stringify(m) + ', \"*\")')", msg)
    page.evaluate("() => new Promise(r => setTimeout(r, 150))")


@pytest.mark.parametrize("zim,heard", [("wikipedia_en", False), ("zimi_games", True)], ids=["another ZIM", "the games ZIM"])
def test_game_messages_are_heard_only_from_the_games_zim(zimi, browser, zim, heard):
    page = browser.new_page()
    page.goto(zimi)
    page.wait_for_function("() => typeof _gameFrameIs === 'function'")
    page.evaluate("""z => {
      window.__asked = [];
      _gameSkyOpen = () => window.__asked.push('sky');
      openDictionary = () => window.__asked.push('dictionary');
      readerOpen = true;
      currentArticle = { zim: z, path: 'index.html', title: 'x' };
      _gameFrameZim = () => z;   // the frame's own address (here it is about:blank, so the test says whose page it is)
    }""", zim)
    for m in MESSAGES:
        _send_from_reader_frame(page, m)
    asked = page.evaluate("window.__asked")
    head = page.evaluate("_gameHead")
    if heard:
        assert asked == ["sky", "dictionary"] and head, (asked, head)
    else:
        assert asked == [] and head is None, (asked, head)
    page.close()


def test_the_game_header_gap_and_undo_arrow_follow_the_reading_direction(zimi, browser):
    page = browser.new_page()
    page.goto(zimi)
    page.wait_for_function("() => typeof _GAME_ACT_SVG === 'object'")
    got = page.evaluate("""() => {
      document.documentElement.dir = 'rtl';
      const head = document.getElementById('game-head'), act = document.getElementById('game-act-btn');
      head.hidden = false; act.hidden = false; act.dataset.kind = 'undo'; act.innerHTML = _GAME_ACT_SVG.undo;
      const h = getComputedStyle(head);
      return { left: h.marginLeft, right: h.marginRight, flip: getComputedStyle(act.querySelector('svg')).transform };
    }""")
    assert got["right"] == "4px" and got["left"] == "0px", got
    assert got["flip"] == "matrix(-1, 0, 0, 1, 0, 0)", got
    page.close()
