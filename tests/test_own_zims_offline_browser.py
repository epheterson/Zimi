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
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        yield p


def _game_frame(page, name, timeout=60000):
    page.wait_for_function(
        "(n) => { const f = document.getElementById('reader-frame'); return !!f && f.contentWindow.location.pathname === '/w/zimi_games/' + n + '.html'"
        " && !!f.contentDocument && !!f.contentDocument.documentElement && f.contentDocument.documentElement.classList.contains('gs-ready'); }", arg=name, timeout=timeout)
    return next(f for f in page.frames if f.url.endswith("/w/zimi_games/%s.html" % name))


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
    assert not [p for p in got if "/puzzles/" in p or "/thumbs/" in p]
    assert json.load(urllib.request.urlopen(server + "/own-offline?zim=nope"))["paths"] == []
    assert json.load(urllib.request.urlopen(server + "/own-offline?zim=../etc"))["paths"] == []


def test_a_removed_zim_takes_its_kept_pages_with_it(phone, server):
    ctx, page = phone
    worker = ctx.service_workers[0]
    assert worker.evaluate("async () => { await keepOwnZim('zimi_games'); return !!(await (await caches.open(CACHE_VERSION)).match('/w/zimi_games/golf.html')); }")
    worker.evaluate("async () => { await forgetOwnZim('zimi_games'); }")
    assert not worker.evaluate("async () => { const c = await caches.open(CACHE_VERSION); return (await c.keys()).some(r => r.url.includes('/w/zimi_games/') || r.url.includes('/_kept/own/')); }")
