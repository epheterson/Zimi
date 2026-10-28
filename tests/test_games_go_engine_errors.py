"""Go's computer goes through EngineKit.client: a Worker that answers an error does not make the computer pass.

The old copy in go.js passed an `{error}` answer on as a move, so the computer passed; a silent worker left
"Thinking" up for ever. EngineKit falls back to this thread on either.

Run: pytest tests/test_games_go_engine_errors.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import game_ready  # noqa: E402

GAMES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")
FAKE_WORKER = """
window.Worker = function () {
  var self = this;
  this.postMessage = function (d) { setTimeout(function () { self.onmessage({ data: { id: d.id, result: { error: 'boom' } } }); }, 5); };
  this.terminate = function () {};
};
"""
CENTRE = 40   # the middle point of the 9 by 9 board


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1]
    srv.shutdown()


def test_a_worker_that_errors_does_not_make_the_computer_pass(site):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        b = p.webkit.launch()
        page = b.new_page(viewport={"width": 390, "height": 844})
        page.add_init_script(FAKE_WORKER)
        page.goto(site + "go.html")
        game_ready(page)
        page.locator(".go-pt").nth(CENTRE).click()
        # the human's stone, then the computer's answer from the main thread: two stones, not one and a pass
        page.wait_for_function("() => document.querySelectorAll('#go-stones > *').length >= 2", timeout=30000)
        b.close()
