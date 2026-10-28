"""A page of Zimi's own ZIMs and the scripts it loads are one version, even when the server is slow.

After a deploy a busy NAS answers slowly. The service worker used to give a slow request a deadline and then answer
from its kept copy, so the games' new sokoban.js ran beside an old text.js and every label showed as a raw key
("sokoban.moves"). Own ZIMs now wait for the server, and a rebuilt own ZIM is a different worker
(http._own_zims_version), so the kept copies are dropped and open windows reload.

Run: pytest tests/test_own_zim_freshness_browser.py -v
"""

import os
import shutil
import subprocess
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SLOW_S = 3.5   # longer than the worker's deadline for a kept copy (2.5 s)
PAGE = (
    '<!doctype html><html><head><meta charset="utf-8"><title>t</title><script src="text.js"></script></head>'
    '<body><p id="o">x</p><script>document.getElementById("o").textContent = window.TEXT;</script></body></html>'
)


def _zim(tmp, version, out):
    from zimi import creator

    src = tmp / ("src_" + version)
    src.mkdir()
    (src / "index.html").write_text(PAGE, encoding="utf-8")
    (src / "text.js").write_text('window.TEXT = "%s";' % version, encoding="utf-8")
    (src / "zimi.txt").write_text("title: Freshness\n", encoding="utf-8")
    creator.create_folder_zim(str(src), out_path=str(out), register=False)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("fresh")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    _zim(tmp, "v1", tmp / "v1.zim")
    _zim(tmp, "v2", tmp / "v2.zim")
    target = tmp / "zims" / "zimi_games_2026-10.zim"
    shutil.copy(tmp / "v1.zim", target)
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    slow = {"on": False}

    class Slow(ZimHandler):
        def do_GET(self):
            if slow["on"] and self.path.split("?")[0].endswith("/text.js"):
                time.sleep(SLOW_S)
            return super().do_GET()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield {
        "base": "http://127.0.0.1:%d" % httpd.server_address[1],
        "slow": slow,
        "swap": lambda: (shutil.copy(tmp / "v2.zim", target), srv.load_cache(force=True)),
    }
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def test_a_slow_server_never_mixes_an_old_script_with_a_new_page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 390, "height": 844})
        pg = ctx.new_page()

        def shown():
            pg.goto(served["base"] + "/?a=zimi_games%2Findex.html", wait_until="load")
            pg.wait_for_function(
                "() => { const f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.getElementById('o'); }",
                timeout=60000,
            )
            return pg.evaluate("() => document.getElementById('reader-frame').contentDocument.getElementById('o').textContent")

        try:
            pg.goto(served["base"] + "/", wait_until="load")
            pg.wait_for_function("() => navigator.serviceWorker && navigator.serviceWorker.controller", timeout=30000)
            assert shown() == "v1"
            assert shown() == "v1"           # the worker now keeps text.js
            served["swap"]()
            served["slow"]["on"] = True       # a NAS right after a deploy
            assert shown() == "v2", "a kept text.js answered for a slow server"
        finally:
            served["slow"]["on"] = False
            br.close()


def test_a_rebuilt_own_zim_is_a_different_worker(tmp_path):
    from zimi import http, ownzims

    def version(stamp):
        d = tmp_path / stamp
        d.mkdir(exist_ok=True)
        (d / "zimi_games_2026-10.zim.source").write_text(stamp + "\n", encoding="utf-8")
        ownzims.OUT_DIR = str(d)
        return http.own_zims_version()

    saved = ownzims.OUT_DIR

    try:
        assert version("a") == version("a")
        assert version("a") != version("b")
    finally:
        ownzims.OUT_DIR = saved


# ── the real games ZIM: Kart, an old build then the current one ─────────────────────────────────────────────────
# Eric: "ZimiKart still doesn't load". The current kart-page.js beside a kept old shell.js (no ZimiShell.persist)
# throws at start and the page stays blank. The same mix gave Sokoban its raw "sokoban.moves" labels.
OLD_BUILD = "8e820d79~1"     # the games folder before ZimiShell.persist existed
GAMES = "zimi/builtin/games"


def _repo():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _games_zim(folder, out):
    from zimi import creator

    creator.create_folder_zim(str(folder), out_path=str(out), register=False)


@pytest.fixture(scope="module")
def kart_served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    old_src = tmp_path_factory.mktemp("old_games")
    try:
        archive = subprocess.run(["git", "archive", OLD_BUILD, GAMES], cwd=_repo(), capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("the git history that holds the old games build is not here")
    subprocess.run(["tar", "-x", "-C", str(old_src)], input=archive, check=True)
    tmp = tmp_path_factory.mktemp("kart")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    _games_zim(old_src / GAMES, tmp / "old.zim")
    _games_zim(os.path.join(_repo(), GAMES), tmp / "new.zim")

    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    target = tmp / "zims" / "zimi_games_2026-10.zim"
    shutil.copy(tmp / "old.zim", target)
    saved = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    slow = {"on": False}

    class Slow(ZimHandler):
        def do_GET(self):
            if slow["on"] and self.path.split("?")[0].endswith("/shell.js"):
                time.sleep(SLOW_S)
            return super().do_GET()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield {
        "base": "http://127.0.0.1:%d" % httpd.server_address[1],
        "slow": slow,
        "swap": lambda: (shutil.copy(tmp / "new.zim", target), srv.load_cache(force=True)),
    }
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = saved


KART = "/?a=zimi_games%2Fkart.html"
IN_FRAME = "() => { const f = document.getElementById('reader-frame'); return f && f.contentWindow && f.contentWindow.__kart; }"


def test_kart_starts_after_an_update_on_a_slow_server(kart_served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(viewport={"width": 390, "height": 844}).new_page()
        try:
            pg.goto(kart_served["base"] + "/", wait_until="load")
            pg.wait_for_function("() => navigator.serviceWorker && navigator.serviceWorker.controller", timeout=30000)
            for _ in range(2):   # the old build: the worker keeps its files
                pg.goto(kart_served["base"] + KART, wait_until="load")
                pg.wait_for_function(IN_FRAME, timeout=60000)
            kart_served["swap"]()
            kart_served["slow"]["on"] = True
            pg.goto(kart_served["base"] + KART, wait_until="load")
            pg.wait_for_function(IN_FRAME, timeout=60000)   # an old shell.js beside the new kart-page.js never gets here
            assert pg.evaluate("() => !document.getElementById('reader-frame').contentDocument.querySelector('[role=alert]')")
        finally:
            kart_served["slow"]["on"] = False
            br.close()


def test_a_game_that_fails_to_start_says_so(kart_served):
    """A script that throws while the page starts leaves a message with a Reload, not a blank page."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
        pg = ctx.new_page()
        pg.route("**/w/zimi_games/kart-page.js*", lambda r: r.fulfill(status=200, content_type="text/javascript", body="throw new Error('boom');"))
        try:
            kart_served["swap"]()
            pg.goto(kart_served["base"] + KART, wait_until="load")
            frame = pg.frame_locator("#reader-frame")
            alert = frame.locator("[role=alert]")
            alert.wait_for(timeout=60000)
            assert "failed to start" in alert.inner_text()
            assert frame.locator("[role=alert] button").inner_text() == "Reload"
        finally:
            br.close()
