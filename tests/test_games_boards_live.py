"""This server's leaderboards inside Zimi, on a phone: a game's board names the people here by the name they go by, the
player's own row marked; a daily's board puts the fastest solve first; an arcade game's best scores begin as a house table
(cabinet initials, labelled as the house's) that real scores push down; the Stats page shows today's dailies across the
server. Boards are for people signed in.

Run: pytest tests/test_games_boards_live.py -v
"""

import json, os, sys, threading
import pytest
import zimi.renderer as renderer  # noqa: E402
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import zimi.server as srv, zimi.users as users
PW = "correct horse 1"

@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer
    from conftest_zim import build_wiki_fixture_zim
    from zimi.http import ZimHandler
    zdir = tmp_path / "zims"; zdir.mkdir(); build_wiki_fixture_zim(str(zdir / "wiki.zim"))
    data = tmp_path / "data"; data.mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir)); monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(data))
    monkeypatch.setenv("ZIMI_BUILTIN_ZIMS", "1"); monkeypatch.setattr(srv, "ZIMI_BUILTIN_ZIMS", True, raising=False)
    srv.load_cache(force=True)
    for n in ("kid", "mum", "dad"): users.create_user(n, PW, role="user")
    users.set_display_name("mum", "Mum")
    import time
    day = time.strftime("%Y-%m-%d")
    users.GAMES.change("mum", {"zimi.games.best.rocks.html": {"v": json.dumps({"score": 14200, "better": "high", "at": 1})},
        "zimi.games.day." + day: {"v": json.dumps({"sudoku.html": {"r": "win", "ms": 412000}, "fiveletters.html": {"r": "win", "ms": 95000}})}})
    users.GAMES.change("dad", {"zimi.games.best.rocks.html": {"v": json.dumps({"score": 3100, "better": "high", "at": 2})},
        "zimi.games.day." + day: {"v": json.dumps({"sudoku.html": {"r": "lose", "ms": 900000}})}})
    users.GAMES.change("kid", {"zimi.games.best.rocks.html": {"v": json.dumps({"score": 6150, "better": "high", "at": 3})},
        "zimi.games.day." + day: {"v": json.dumps({"sudoku.html": {"r": "win", "ms": 301000}})}})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()

def _frame(pg, part):
    for _ in range(80):
        f = next((f for f in pg.frames if f != pg.main_frame and part in f.url), None)
        if f: return f
        pg.wait_for_timeout(250)
    raise AssertionError(part)

def test_boards_inside_zimi(served):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 390, "height": 844})
        pg = ctx.new_page(); pg.goto(served + "/")
        pg.wait_for_function("() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0", timeout=30000)
        assert pg.evaluate("(p) => doLogin('kid', p, true).then(r => r.status)", PW) == 200
        pg.goto(served + "/?a=zimi_games%2Frocks.html")
        g = _frame(pg, "/w/zimi_games/rocks.html")
        g.wait_for_function("() => window.ZimiShell && ZimiShell.boardSheet", timeout=20000)
        pg.wait_for_function("() => localStorage.getItem('zimi_games_signed') === '1'", timeout=10000)
        g.evaluate("() => ZimiShell.boardSheet()")
        g.wait_for_selector(".gs-board-row", timeout=10000)
        rows = g.evaluate("() => [...document.querySelectorAll('.gs-board')].pop().querySelectorAll('.gs-board-row').length")
        names = g.evaluate("() => [...[...document.querySelectorAll('.gs-board')].pop().querySelectorAll('.gs-board-row')].map(r => [r.querySelector('.gs-board-name').textContent, r.className])")
        assert rows == 10
        assert ["Mum", "gs-board-row"] in names and ["kid", "gs-board-row gs-you"] in names and ["dad", "gs-board-row"] in names
        house = [n for n, c in names if "gs-house" in c]
        assert house and all(len(n) == 3 and n.isupper() for n in house), "the house's rows are cabinet initials, marked"
        assert g.evaluate("() => !!document.querySelector('.gs-board-note')"), "and said to be the house's"
        g.evaluate("(d) => { location.href = 'sudoku.html?daily=' + d; }", __import__("time").strftime("%Y-%m-%d"))
        pg.wait_for_timeout(1500)
        g = _frame(pg, "/w/zimi_games/sudoku.html")
        g.wait_for_function("() => window.ZimiShell && ZimiShell.boardSheet", timeout=20000)
        g.evaluate("() => ZimiShell.boardSheet()")
        g.wait_for_selector(".gs-board-row", timeout=10000)
        day = g.evaluate("() => [...document.querySelectorAll('.gs-board-row .gs-board-name')].map(n => n.textContent.trim())")
        assert [n.split(" ")[-1] for n in day] == ["kid", "Mum", "dad"], day
        g.evaluate("() => { document.querySelectorAll('.ar-sheet').forEach(e => e.remove()); ZimiShell.statsSheet(); }")
        g.wait_for_selector(".gs-boards .gs-board-day", timeout=10000)
        assert g.evaluate("() => document.querySelector('.gs-person').textContent").startswith("Playing as kid")
        assert g.evaluate("() => document.querySelectorAll('.gs-boards .gs-board-day').length") == 2
        # Signed out, there is no board to see: it names the people here.
        ctx2 = br.new_context(viewport={"width": 390, "height": 844})
        pg2 = ctx2.new_page(); pg2.goto(served + "/?a=zimi_games%2Frocks.html")
        g2 = _frame(pg2, "/w/zimi_games/rocks.html")
        g2.wait_for_function("() => window.ZimiShell && ZimiShell.boardSheet", timeout=20000)
        g2.evaluate("() => ZimiShell.boardSheet()")
        g2.wait_for_selector(".ar-sheet .gs-text", timeout=10000)
        assert not g2.evaluate("() => document.querySelector('.gs-board-row')")
        br.close()
