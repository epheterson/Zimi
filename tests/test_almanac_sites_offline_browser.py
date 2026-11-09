"""The landing sites with no network: their code, models, table and routes are kept with the Almanac (sw.js keepAlmanac,
the list http._offline_urls reads from the pages), so a visit works with the network cut.

A real server, a real Chromium with the service worker in charge, the network cut by the browser's offline mode. The
first test asks the worker to keep the Almanac and then reads every file a site needs back with the network cut. The
second opens the 3D view offline and stands at Apollo 11 (software GL, so it takes a while).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_almanac_sites_offline_browser.py -v
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
SCRIPTS = (
    "almanac-sites.js",
    "almanac-sites-ground.js",
    "almanac-sites-drive.js",
    "almanac-sites-launch.js",
    "almanac-sites-trail.js",
)


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    tmp = tmp_path_factory.mktemp("sitesoffline")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    port = _free_port()
    env = dict(
        os.environ,
        ZIM_DIR=str(tmp / "zims"),
        ZIMI_DATA_DIR=str(tmp / "data"),
        ZIMI_OFFLINE="1",
        ZIMI_TORRENT="0",
        ZIMI_AUTO_UPDATE="0",
        ZIMI_PEER_DISCOVERY="0",
        ZIMI_BUILTIN_ZIMS="1",
        PYTHONUNBUFFERED="1",
    )
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "zimi",
            "serve",
            "--port",
            str(port),
            "--host",
            "127.0.0.1",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
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
    sync_playwright = pytest.importorskip("playwright.sync_api").sync_playwright

    with sync_playwright() as p:
        yield p


def _kept(page, suffix):
    return page.evaluate(
        "async (s) => { for (const k of await caches.keys()) { for (const r of await (await caches.open(k)).keys()) if (r.url.includes(s)) return true; } return false; }",
        suffix,
    )


def _keep_the_almanac(page, base):
    page.goto(base + "/", wait_until="load")
    page.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=60_000)
    page.evaluate(
        "() => navigator.serviceWorker.ready.then(r => r.active.postMessage({ type: 'keep-almanac' }))"
    )
    needed = [
        "/static/earth/sites-v1.json",
        "/static/earth/traverses-v1.json",
        "/static/earth/landmarks-v1.json",
    ] + ["/static/" + s for s in SCRIPTS]
    needed += [
        "/static/earth/" + n
        for n in sorted(os.listdir(EARTH))
        if n.startswith("craft-site-")
    ]
    deadline = time.time() + 120
    while time.time() < deadline:
        if all(_kept(page, n) for n in needed):
            return needed
        time.sleep(1)
    missing = [n for n in needed if not _kept(page, n)]
    pytest.fail("the worker did not keep: %s" % missing[:5])


def test_the_sites_files_are_kept_and_come_back_with_the_network_cut(pw, server):
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    needed = _keep_the_almanac(page, server)
    ctx.set_offline(True)
    results = page.evaluate(
        "async (urls) => Promise.all(urls.map(async u => { try { const r = await fetch(u); return [u, r.ok, (await r.arrayBuffer()).byteLength]; } catch (e) { return [u, false, 0]; } }))",
        needed,
    )
    bad = [r for r in results if not r[1] or r[2] == 0]
    ctx.close()
    br.close()
    assert not bad, "offline: %s" % bad[:5]
    table = json.load(open(os.path.join(EARTH, "sites-v1.json"), encoding="utf-8"))
    for name in table["models"]:
        assert "/static/earth/craft-site-%s-v1.bin" % name in needed, (
            "%s is in the kept list" % name
        )


def test_a_visit_to_apollo_11_works_with_the_network_cut(pw, server):
    br = pw.chromium.launch(args=GL_ARGS)
    ctx = br.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=1,
        has_touch=True,
        is_mobile=True,
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (PLACE, PLACE)
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # The earth's own files are kept the same way: open the view once while online so the worker has seen the pack asked for.
    _keep_the_almanac(page, server)
    page.goto(server + "/#almanac", wait_until="load")
    page.wait_for_function(
        "() => typeof openAlmanacEarth === 'function'", timeout=120_000
    )
    ctx.set_offline(True)
    page.reload(wait_until="load")
    page.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    page.evaluate("() => openAlmanacEarth({ target: 'moon' })")
    page.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=300_000,
        polling=250,
    )
    page.evaluate("() => _aeLmLoad()")
    page.wait_for_function("() => !!_aeLm", timeout=60_000)
    page.evaluate(
        "() => _aeLmOpen('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 11')[0])"
    )
    page.wait_for_function(
        "() => !!document.getElementById('as-visit')", timeout=120_000, polling=250
    )
    page.evaluate("() => document.getElementById('as-visit').click()")
    page.wait_for_function(
        "() => { var s = _aeSiteState(); return s && s.phase === 'stand' && s.ready; }",
        timeout=240_000,
        polling=500,
    )
    assert page.evaluate("() => _aeSiteState().parts.map(p => p.model).sort()") == [
        "flag",
        "lm",
    ]
    ctx.close()
    br.close()
    assert errors == []
