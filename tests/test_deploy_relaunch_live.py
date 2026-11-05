"""A relaunch after a deploy runs the new code, even when the new worker has a lot to keep.

Eric, on his installed app: a fix was live on the server, and the home-screen app kept
running the old code through several force-quits while Safari's tab had it at once. The
device had opened the Almanac, so the new worker held its install (Chromium) or its
activation (WebKit, which holds every fetch until a worker has activated) until the whole
Almanac pack was fetched. The page's build check waited a short while for the worker,
reloaded, and was answered by the old kept shell. The page also never heard a worker that
claimed it before the build was asked for, and an address inside /w/ never fetched the
kept shell again at all.

The deploy is faked in the running server (a new bundle hash, a new app.js) and the
Almanac's files are slow to arrive, as they are over a phone's connection.

Run: pytest tests/test_deploy_relaunch_live.py -v
"""

import os
import re
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SLOW_PACK_S = 22  # longer than the page's wait for a new worker (15 s)
GEN_MARK = ";window.__gen=%d;"


def _forget_served_files(handler):
    """A process starts with nothing read: sw.js carries the build it was served under."""
    with handler._static_cache_lock:
        handler._static_cache.clear()


class _Server:
    """The running server, and a way to deploy a new build of it."""

    def __init__(self, http, base):
        self.http, self.base, self.gen = http, base, 0
        self.slow_pack = 0

    def deploy(self):
        h = self.http
        old_build = "zimi-v%s-%s" % (h._srv.ZIMI_VERSION, h._ASSET_BUNDLE_HASH)
        self.gen += 1
        new_hash = "gen%d" % self.gen
        h._ASSET_BUNDLE_HASH = new_hash
        new_build = h._asset_version()
        src = re.sub(r";window\.__gen=\d+;$", "", h.APP_JS_REWRITTEN) + GEN_MARK % self.gen
        h.APP_JS_REWRITTEN = src
        app_hash = "g%d" % self.gen
        h.SEARCH_UI_HTML = re.sub(r"(/static/app\.js\?v=)\w+", r"\g<1>" + app_hash, h.SEARCH_UI_HTML.replace(old_build, new_build))
        h.ZimHandler._index_etag = '"z-gen%d"' % self.gen
        _forget_served_files(h.ZimHandler)  # a deploy restarts the process


@pytest.fixture(params=["chromium", "webkit"])
def served(request, tmp_path, monkeypatch):
    pytest.importorskip("playwright")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    import zimi.http as http
    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "water.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    monkeypatch.setattr(http, "APP_JS_REWRITTEN", http.APP_JS_REWRITTEN + GEN_MARK % 0)
    monkeypatch.setattr(http, "SEARCH_UI_HTML", http.SEARCH_UI_HTML)
    monkeypatch.setattr(http, "_ASSET_BUNDLE_HASH", http._ASSET_BUNDLE_HASH)
    monkeypatch.setattr(ZimHandler, "_index_etag", ZimHandler._index_etag)
    _forget_served_files(ZimHandler)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    server = _Server(http, base)

    real_get = ZimHandler.do_GET

    def slow_get(self):
        if server.slow_pack and re.match(r"/static/almanac", self.path.split("?")[0].replace("/static/", "/static/")) is not None:
            time.sleep(server.slow_pack)
        return real_get(self)

    monkeypatch.setattr(ZimHandler, "do_GET", slow_get)
    yield server, request.param
    httpd.shutdown()
    _forget_served_files(ZimHandler)


def _gen(page):
    return page.evaluate("() => window.__gen")


def test_relaunch_after_a_deploy_runs_the_new_code(served):
    from playwright.sync_api import sync_playwright

    server, engine = served
    with sync_playwright() as p:
        br = getattr(p, engine).launch()
        ctx = br.new_context(service_workers="allow", **p.devices["iPhone 13"])
        pg = ctx.new_page()
        pg.goto(server.base + "/#almanac")
        pg.wait_for_function("() => typeof _almanacOpen !== 'undefined' && _almanacOpen", timeout=30000)
        # The worker in charge, and the Almanac kept whole
        pg.wait_for_function("() => navigator.serviceWorker.controller", timeout=30000)
        pg.wait_for_function(
            "() => caches.keys().then(ks => Promise.all(ks.map(k => caches.open(k).then(c => c.keys())))).then(r => r.flat().some(q => /almanac-earth\\.js/.test(q.url)))",
            timeout=60000,
        )
        assert _gen(pg) == 0
        pg.close()

        server.deploy()
        server.slow_pack = SLOW_PACK_S

        log = []
        pg = ctx.new_page()
        pg.on("request", lambda r: log.append(r.url) if r.resource_type == "document" and r.frame.parent_frame is None else None)
        pg.goto(server.base + "/", wait_until="commit")
        t0 = time.time()
        gens = []
        while time.time() - t0 < 40:  # the page waits up to 15 s for a worker; this one must not need it
            time.sleep(2)
            try:
                gens.append(_gen(pg))
            except Exception:
                gens.append(None)
            if gens[-1] == 1:
                break
        print(engine, "first launch after the deploy:", gens, "documents:", len(log), "after %.0fs" % (time.time() - t0))
        first = gens[-1]
        diag = None
        if first != 1:
            diag = pg.evaluate("async () => { const r = await navigator.serviceWorker.getRegistration(); const st = w => w && w.state; return [st(r.installing), st(r.waiting), st(r.active), !!navigator.serviceWorker.controller, _BUILD, [...document.scripts].map(x=>x.src).filter(x=>/app\\.js/.test(x)).join(), (await caches.keys()).join(',')]; }")
        br.close()
    assert first == 1 and time.time() - t0 < 14, (engine, gens, diag)


def _kept_almanac_on_device(ctx, server):
    pg = ctx.new_page()
    pg.goto(server.base + "/#almanac")
    pg.wait_for_function("() => typeof _almanacOpen !== 'undefined' && _almanacOpen", timeout=30000)
    pg.wait_for_function("() => navigator.serviceWorker.controller", timeout=30000)
    pg.wait_for_function(
        "() => caches.keys().then(ks => Promise.all(ks.map(k => caches.open(k).then(c => c.keys())))).then(r => r.flat().some(q => /almanac-earth\\.js/.test(q.url)))",
        timeout=60000,
    )
    pg.close()


def test_a_relaunch_inside_a_zim_address_has_the_new_build_by_the_second_start(served):
    """The app opened at /w/... is answered by the kept shell; every start must still fetch the latest for the next."""
    from playwright.sync_api import sync_playwright

    server, engine = served
    with sync_playwright() as p:
        br = getattr(p, engine).launch()
        ctx = br.new_context(service_workers="allow", **p.devices["iPhone 13"])
        _kept_almanac_on_device(ctx, server)
        server.deploy()
        server.slow_pack = SLOW_PACK_S
        seen = []
        for _ in range(3):
            pg = ctx.new_page()
            pg.goto(server.base + "/w/water/", wait_until="commit")  # the slow Almanac files hold the load event
            pg.wait_for_timeout(5000)
            seen.append(_gen(pg))
            pg.close()
        br.close()
    print(engine, "starts at /w/ after the deploy:", seen)
    assert seen[1] == 1 and seen[2] == 1, (engine, seen)
