"""A game from the catalog's Games ZIM (Name zimi_mul_games) opens inside Zimi with the same header as the built-in one: its name, Menu
and Undo. Without that, the page's own bar is hidden for the reader and Zimi drew none, so the game had no header at all.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_catalog_header_browser.py -v
"""

import os
import socket
import subprocess
import sys
import urllib.parse

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import wait_for_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAIT = 60000


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    import games_library_fixture as fx

    base = tmp_path_factory.mktemp("catalog")
    lib, data = base / "lib", base / "data"
    for d in (lib, data):
        d.mkdir()
    fx.catalog_games_zim(lib)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1", ZIMI_BUILTIN_ZIMS="0", ZIMI_APPS="1", ZIMI_MANAGE_OPEN="1", ZIM_DIR=str(lib), ZIMI_DATA_DIR=str(data))
    proc = subprocess.Popen([sys.executable, "-m", "zimi", "serve", "--port", str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_for_server(port):
            pytest.skip("the catalog games library did not start")
        yield "http://127.0.0.1:%d" % port
    finally:
        proc.terminate()


@pytest.mark.parametrize("viewport", [{"width": 1280, "height": 800}, {"width": 390, "height": 844}], ids=["desktop", "phone"])
def test_catalog_game_has_the_zimi_header(zimi, viewport):
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        page = b.new_context(viewport=viewport).new_page()
        page.goto(zimi + "/?a=" + urllib.parse.quote("zimi_mul_games/chess.html", safe=""))
        page.locator("#reader.open").wait_for(timeout=WAIT)
        page.wait_for_function("() => document.body.classList.contains('game-page')", timeout=WAIT)
        assert page.locator("#game-menu-btn").is_visible()
        assert page.locator("#game-title").text_content().strip() == "Chess"
        b.close()
