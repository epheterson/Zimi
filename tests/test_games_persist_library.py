"""The library games keep a round played on the player's own library: a move, the page is hidden, and coming back
puts the same position on the screen, with the library there and with it gone.

The six games (Five Letters on a French Wiktionary, Letter by Letter on the English one, Quizzical, Jigsaw, Wiki Race
and Where in the World on the Wikipedia) run from the games folder on a plain static server whose library calls
(/health, /list, /random, /w/, /dictionary/ ...) go to a real Zimi serving tests/games_library_fixture.py's small library.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_persist_library.py -v
"""

import functools
import http.server
import os
import re
import socket
import subprocess
import sys
import threading
import urllib.request

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)
from games_wait import wait_for_server, becomes, frames, game_ready  # noqa: E402
GAMES = os.path.join(ROOT, "zimi", "builtin", "games")
VIEW = {"width": 390, "height": 844}
API = re.compile(r"^/(health|list|random|w/|dictionary/|wiki/|search|snippet)")

# page, the condition that says the library is in use, the moves (selectors tapped in turn), the position as a string.
ROWS = [
    ("fiveletters.html?lang=fr", "__five.list && __five.game", ['.fl-key[data-k="a"]', '.fl-key[data-k="e"]'],
     "JSON.stringify(__five.game) + JSON.stringify(__five.list) + [...document.querySelectorAll('.fl-tile')].map(t => t.textContent).join()"),
    ("letterbyletter.html?lang=en", "__letters.source && __letters.game", ['.lb-key[data-k="e"]', '.lb-key[data-k="a"]'],
     "JSON.stringify(__letters.game) + JSON.stringify(__letters.source)"),
    ("quizzical.html", "__quiz.zim && __quiz.round.length", [".qz-choice", "#qz-next", ".qz-choice"],
     "JSON.stringify(__quiz.round) + document.getElementById('qz-n').textContent + document.getElementById('qz-score').textContent + [...document.querySelectorAll('.qz-choice')].map(b => b.className + b.disabled).join()"),
    ("jigsaw.html", "__jig.puzzle && !/ZimiGames/.test(__jig.puzzle.pic.credit)", ["#jg-peek"],
     "JSON.stringify(__jig.puzzle.pieces.map(p => [p.fx, p.fy, p.locked])) + JSON.stringify(__jig.puzzle.pic)"),
    ("wikirace.html", "__race.provider && !__race.provider.built && __race.race", [".rc-card .gm-play", ".rc-link"],
     "JSON.stringify(__race.race.steps) + __race.race.pair.start.path + __race.race.pair.end.path + document.getElementById('rc-clicks').textContent"),
    ("whereintheworld.html", "__world.round.length", ["#wm-svg", "#wm-guess"],
     "JSON.stringify(__world.round) + JSON.stringify(__world.pending) + document.getElementById('wm-score').textContent + document.getElementById('wm-n').textContent"),
]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    import games_library_fixture as fx

    base = tmp_path_factory.mktemp("lib")
    fx.build(str(base))
    (base / "data").mkdir()
    port = free_port()
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1", ZIMI_RATE_LIMIT="1000000", ZIM_DIR=str(base / "zims"), ZIMI_DATA_DIR=str(base / "data"))
    proc = subprocess.Popen([sys.executable, "-m", "zimi", "serve", "--port", str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_for_server(port):
            pytest.skip("the fixture library did not start")
        yield port
    finally:
        proc.terminate()


@pytest.fixture(scope="module")
def served(library):
    api = "http://127.0.0.1:%d" % library

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

        def do_GET(self):
            if API.match(self.path):
                try:
                    r = urllib.request.urlopen(api + self.path, timeout=90)
                    body = r.read()
                    self.send_response(200)
                    self.send_header("Content-Type", r.headers.get("Content-Type", "application/octet-stream"))
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception:
                    self.send_error(502)
                return
            super().do_GET()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=GAMES))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        for kind in (p.chromium, p.webkit):
            try:
                b = kind.launch()
            except Exception:
                continue
            yield b
            b.close()
            return
        pytest.skip("no browser installed")


def leave(page, position):
    """Hide the page and read the position in the same breath, so the save and the read see one table."""
    return page.evaluate("(() => { window.dispatchEvent(new Event('pagehide')); return " + position + "; })()")


def tap(page, locator):
    locator.wait_for(state="visible")
    box = locator.bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    frames(page)


@pytest.mark.parametrize("gone", [False, True], ids=["library there", "library gone"])
@pytest.mark.parametrize("name,ready,moves,position", ROWS, ids=[r[0].split(".")[0] for r in ROWS])
def test_a_library_round_comes_back_as_it_was(served, browser, name, ready, moves, position, gone):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    url = "%s/%s" % (served, name)
    page.goto(url)
    game_ready(page, ready)
    for sel in moves:
        tap(page, page.locator(sel).first)
    before = leave(page, position)
    page.goto("about:blank")
    if gone:
        ctx.route(re.compile(r".*/(health|list|random|w/|dictionary/|wiki/|search|snippet).*"), lambda route: route.abort())
    page.goto(url)
    game_ready(page)
    becomes(page, position, before)   # the round is put back once the game's own start has run
    after = page.evaluate(position)
    assert before and after
    assert after == before, "the round came back different after leaving and returning"
    ctx.close()


def test_a_save_survives_a_tap_and_a_hide_before_the_library_answers(served, browser):
    """Jigsaw restores only once the library answers. A tap, then pagehide, in that wait must not delete the save."""
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    url = served + "/jigsaw.html"
    page.goto(url)
    game_ready(page, "__jig.puzzle && !/ZimiGames/.test(__jig.puzzle.pic.credit)")
    tap(page, page.locator("#jg-peek").first)
    before = leave(page, "JSON.stringify(__jig.puzzle.pieces.map(p => [p.fx, p.fy, p.locked])) + JSON.stringify(__jig.puzzle.pic)")
    key = "zimi.games.save.jigsaw"
    assert page.evaluate("k => localStorage.getItem(k)", key)
    page.goto("about:blank")
    held, gate = [], {"open": False}
    ctx.route(re.compile(r".*/(health|list|random|w/|dictionary/|wiki/|search|snippet).*"),
              lambda route: route.continue_() if gate["open"] else held.append(route))
    page.goto(url, wait_until="commit")
    page.wait_for_function("() => !!window.ZimiShell")
    page.mouse.click(10, 300)
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    page.wait_for_timeout(700)   # past the debounced write too
    assert page.evaluate("k => localStorage.getItem(k)", key), "the save was deleted while the library had not answered"
    gate["open"] = True
    for r in held:
        r.continue_()
    game_ready(page)
    becomes(page, "JSON.stringify(__jig.puzzle.pieces.map(p => [p.fx, p.fy, p.locked])) + JSON.stringify(__jig.puzzle.pic)", before)
    ctx.close()
