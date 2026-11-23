"""Zimi's own apps, the games and the Almanac, on a phone: a reload brings the game back, and with the network cut they still open.

Eric, 2026-10-27: "I'm getting a lot of safari reloads on games when switching away and back" and "Games and almanac
should always be available offline if any app is offline unless user explicitly removes."

A real server (own ZIMs on, no outbound), a real Chromium with the service worker in charge, the network cut by
the browser's offline mode. Opening the games keeps them whole (sw.js keepOwnZim): a game never opened comes up offline,
a saved position is restored offline, and a game the person removed is not kept.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_own_zims_offline_browser.py -v
"""

import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

SOLITAIRE = "ZimiSolitaire.session.state"
STOCK = '[data-pile="stock"]'
VIEW = {"width": 390, "height": 844}


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    tmp = tmp_path_factory.mktemp("own")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    port = _free_port()
    env = dict(os.environ, ZIM_DIR=str(tmp / "zims"), ZIMI_DATA_DIR=str(tmp / "data"), ZIMI_OFFLINE="1", ZIMI_TORRENT="0",
               ZIMI_AUTO_UPDATE="0", ZIMI_PEER_DISCOVERY="0", ZIMI_BUILTIN_ZIMS="1", PYTHONUNBUFFERED="1")
    proc = subprocess.Popen([sys.executable, "-m", "zimi", "serve", "--port", str(port), "--host", "127.0.0.1"],
                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = "http://127.0.0.1:%d" % port
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            urllib.request.urlopen(base + "/health", timeout=2).read()
            break
        except Exception:
            time.sleep(0.3)
    else:
        proc.kill()
        raise RuntimeError("server did not start")
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="module")
def pw():
    sync_playwright = pytest.importorskip("playwright.sync_api").sync_playwright  # a runner without a browser skips

    with sync_playwright() as p:
        yield p


def _game_frame(page, name, timeout=60000):
    page.wait_for_function(
        "(n) => { const f = document.getElementById('reader-frame'); return !!f && f.contentWindow.location.pathname === '/w/zimi_games/' + n + '.html'"
        " && !!f.contentDocument && !!f.contentDocument.documentElement && f.contentDocument.documentElement.classList.contains('gs-ready'); }", arg=name, timeout=timeout)
    return next(f for f in page.frames if f.url.split("#")[0].split("?")[0].endswith("/w/zimi_games/%s.html" % name))


def _tap(page, frame, selector):
    box = frame.locator(selector).first.bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def _kept(page, suffix):
    return page.evaluate("async (s) => { for (const k of await caches.keys()) { for (const r of await (await caches.open(k)).keys()) if (r.url.includes(s)) return true; } return false; }", suffix)


@pytest.fixture
def phone(pw, server):
    br = pw.chromium.launch()
    ctx = br.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto(server + "/", wait_until="load")
    page.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=30000)
    yield ctx, page
    ctx.close()
    br.close()


def _play_one_move(page, server):
    page.goto(server + "/?a=zimi_games%2Fsolitaire.html")
    frame = _game_frame(page, "solitaire")
    frame.wait_for_function("() => !document.querySelector('.zc-dealing')")
    _tap(page, frame, STOCK)
    frame.wait_for_function("() => { ZimiShell.saveNow(); return ZimiShell.saved() !== null; }")
    frame.evaluate("window.dispatchEvent(new Event('pagehide'))")
    return frame.evaluate("JSON.stringify(%s)" % SOLITAIRE)


def _position(page):
    frame = _game_frame(page, "solitaire")
    frame.wait_for_function("() => !document.querySelector('.zc-dealing')")
    return frame.evaluate("JSON.stringify(%s)" % SOLITAIRE)


def test_a_reload_mid_game_puts_the_same_game_back(phone, server):
    _, page = phone
    position = _play_one_move(page, server)
    page.reload()
    assert _position(page) == position


def test_the_games_and_the_almanac_open_with_the_network_cut(phone, server):
    ctx, page = phone
    position = _play_one_move(page, server)
    # Kept whole a moment after the games opened: a game never opened is among them.
    deadline = time.time() + 90
    while not _kept(page, "/_kept/own/zimi_games") and time.time() < deadline:
        time.sleep(0.5)
    assert _kept(page, "/w/zimi_games/golf.html")
    assert _kept(page, "/static/almanac.js")
    ctx.set_offline(True)
    page.reload()
    assert _position(page) == position, "the saved game did not come back with no network"
    page.goto(server + "/?a=zimi_games%2Fgolf.html")
    golf = _game_frame(page, "golf")
    assert golf.evaluate("document.querySelectorAll('.zc-card, [data-pile]').length") > 0
    page.goto(server + "/", wait_until="load")
    page.wait_for_function("() => typeof openAlmanac === 'function'")
    page.evaluate("() => openAlmanac()")
    page.wait_for_function("() => typeof _almanacLoaded !== 'undefined' && _almanacLoaded && document.querySelector('#almanac-root, .almanac, [id^=almanac]')", timeout=30000)


def test_the_list_the_worker_keeps_is_empty_for_a_removed_zim(server):
    import json

    got = json.load(urllib.request.urlopen(server + "/own-offline?zim=zimi_games"))["paths"]
    assert "/w/zimi_games/golf.html" in got and "/w/zimi_games/index.html" in got
    assert [p for p in got if "/puzzles/" in p] and [p for p in got if "/thumbs/" in p], "puzzle files and thumbnails are kept with the rest"
    kept = json.load(urllib.request.urlopen(server + "/own-offline?zim=zimi_games"))
    assert kept["version"], "the file the list describes, so a phone can tell when its kept pages are of another file"
    assert json.load(urllib.request.urlopen(server + "/own-offline?zim=nope"))["version"] == ""
    assert json.load(urllib.request.urlopen(server + "/own-offline?zim=nope"))["paths"] == []
    assert json.load(urllib.request.urlopen(server + "/own-offline?zim=../etc"))["paths"] == []


def test_a_removed_zim_takes_its_kept_pages_with_it(phone, server):
    ctx, page = phone
    worker = ctx.service_workers[0]
    assert worker.evaluate("async () => { await keepOwnZim('zimi_games'); return !!(await (await caches.open(CACHE_VERSION)).match('/w/zimi_games/golf.html')); }")
    worker.evaluate("async () => { await forgetOwnZim('zimi_games'); }")
    assert not worker.evaluate("async () => { const c = await caches.open(CACHE_VERSION); return (await c.keys()).some(r => r.url.includes('/w/zimi_games/') || r.url.includes('/_kept/own/')); }")


# ── Kept ahead of time, on every device that loads Zimi and may (app.js _keepAheadAllowed, sw.js keepOwnAhead) ──
KEEP_WAIT_S = 150


def _wait_kept(page, suffix, seconds=KEEP_WAIT_S):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if _kept(page, suffix):
            return True
        time.sleep(1)
    return False


def _a_puzzle_file(server):
    import json

    return [p for p in json.load(urllib.request.urlopen(server + "/own-offline?zim=zimi_games"))["paths"] if "/puzzles/" in p][0]


def test_a_fresh_profile_keeps_the_games_and_the_almanac_without_either_being_opened(pw, server):
    br = pw.chromium.launch()
    try:
        ctx = br.new_context(viewport=VIEW)
        page = ctx.new_page()
        page.goto(server + "/", wait_until="load")
        assert not _kept(page, "/_kept/own/zimi_games"), "nothing is kept at install or first paint"
        assert _wait_kept(page, "/_kept/own/zimi_games") and _wait_kept(page, "/_kept/own/zimi_almanac")
        assert _kept(page, _a_puzzle_file(server)) and _kept(page, "/static/almanac.js")
    finally:
        br.close()


def test_an_almanac_file_that_failed_to_keep_is_fetched_again_next_time(pw, server):
    """Both ZIMs marked kept is not the Almanac kept: its own files go in apart, and one that failed was never retried."""
    br = pw.chromium.launch()
    try:
        ctx = br.new_context(viewport=VIEW)
        page = ctx.new_page()
        page.goto(server + "/", wait_until="load")
        assert _wait_kept(page, "/_kept/own/zimi_games") and _wait_kept(page, "/_kept/own/zimi_almanac")
        assert _wait_kept(page, "/static/almanac.js")
        page.evaluate("async () => { for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) if (r.url.includes('/static/almanac.js')) await c.delete(r); } }")
        assert not _kept(page, "/static/almanac.js")
        page.reload(wait_until="load")
        assert _wait_kept(page, "/static/almanac.js"), "the missing file was not fetched again"
    finally:
        br.close()


def test_data_saver_keeps_nothing_ahead_of_time(pw, server):
    br = pw.chromium.launch()
    try:
        ctx = br.new_context(viewport=VIEW)
        ctx.add_init_script("Object.defineProperty(navigator, 'connection', { value: { saveData: true, type: 'wifi' } });")
        page = ctx.new_page()
        asked = []
        page.on("request", lambda r: asked.append(r.url) if "/own-offline" in r.url or r.headers.get("x-zimi-keep") == "1" else None)  # Home's own tile art is not the keeper
        page.goto(server + "/", wait_until="load")
        time.sleep(20)  # well past the idle wait
        assert not _kept(page, "/_kept/own/zimi_games") and not asked, asked
    finally:
        br.close()


def test_a_second_load_fetches_nothing_again(pw, server):
    br = pw.chromium.launch()
    try:
        ctx = br.new_context(viewport=VIEW)
        page = ctx.new_page()
        page.goto(server + "/", wait_until="load")
        assert _wait_kept(page, "/_kept/own/zimi_games") and _wait_kept(page, "/_kept/own/zimi_almanac")
        time.sleep(5)  # the Almanac's own files follow the last mark
        again = []
        ctx.on("request", lambda r: again.append(r.url) if "/own-offline" in r.url or "/w/zimi_" in r.url or "almanac" in r.url else None)
        page.reload(wait_until="load")
        time.sleep(15)
        # A request the worker answered from its cache is not asked of the server; the page's own asks for its Home are not these.
        assert not [u for u in again if "/own-offline" in u or "/puzzles/" in u or "/thumbs/" in u], again
    finally:
        br.close()


KEEP_AHEAD_CASES = [
    # (connection, host, standalone, kept ahead, why)
    ({"saveData": True, "type": "wifi"}, "knowledge.example.org", True, False, "Data Saver on: no, even installed, even on Wi-Fi"),
    ({"saveData": True}, "192.168.1.20", False, False, "Data Saver on: no, even on the LAN"),
    ({}, "192.168.1.20", False, True, "a private address"),
    ({}, "10.0.0.14", False, True, "a private address"),
    ({}, "172.20.1.2", False, True, "a private address (172.16-31)"),
    ({}, "172.32.1.2", False, False, "172.32 is public"),
    ({}, "nas.lan", False, True, ".lan"),
    ({}, "zimi.local", False, True, ".local"),
    ({}, "localhost", False, True, "localhost"),
    ({"type": "wifi"}, "knowledge.example.org", False, True, "the browser says Wi-Fi"),
    ({"type": "ethernet"}, "knowledge.example.org", False, True, "the browser says Ethernet"),
    ({"type": "cellular"}, "knowledge.example.org", True, False, "the browser says cellular: no, even installed"),
    ({"type": "unknown"}, "knowledge.example.org", True, True, "type unknown and installed"),
    (None, "knowledge.example.org", True, True, "no network information (iOS Safari) and installed"),
    (None, "knowledge.example.org", False, False, "no network information in a browser tab: today's triggers only"),
    ({}, "knowledge.example.org", False, False, "a connection object without a type, in a tab"),
]


@pytest.mark.parametrize("conn,host,standalone,want,why", KEEP_AHEAD_CASES, ids=[c[4] for c in KEEP_AHEAD_CASES])
def test_the_rule_for_keeping_ahead_of_time(phone, conn, host, standalone, want, why):
    _, page = phone
    got = page.evaluate("([c, h, s]) => _keepAheadAllowed(c, h, s)", [conn, host, standalone])
    assert got is want, why
