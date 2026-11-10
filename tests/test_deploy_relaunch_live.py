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

#: The page gives a new worker 15 s to take charge before it reloads anyway. A slow runner can take that long
#: for reasons that are not the bug, so the test makes the page wait far longer (the served app.js is
#: rewritten) and holds the Almanac's files until the end: the new code must run on the first launch
#: while they are still held, and a wait is for that state, never a number of seconds.
PAGE_WAITS_MS = 600_000
FIRST_LAUNCH_DEADLINE_S = 120
GEN_MARK = ";window.__gen=%d;"


def _forget_served_files(handler):
    """A process starts with nothing read: sw.js carries the build it was served under."""
    with handler._static_cache_lock:
        handler._static_cache.clear()


class _Server:
    """The running server, and a way to deploy a new build of it."""

    def __init__(self, http, base):
        self.http, self.base, self.gen = http, base, 0
        self.hold_pack = False
        self.pack_gate = threading.Event()  # set: the held Almanac files go through

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
    waits = re.compile(r"(var _BUILD_SW_WAIT_MS = )\d+")
    assert waits.search(http.APP_JS_REWRITTEN), "the page's wait for a worker moved: the test must follow it"
    monkeypatch.setattr(http, "APP_JS_REWRITTEN", waits.sub(r"\g<1>%d" % PAGE_WAITS_MS, http.APP_JS_REWRITTEN) + GEN_MARK % 0)
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
        if server.hold_pack and self.path.split("?")[0].startswith("/static/almanac"):
            server.pack_gate.wait(FIRST_LAUNCH_DEADLINE_S + 30)
        return real_get(self)

    monkeypatch.setattr(ZimHandler, "do_GET", slow_get)
    yield server, request.param
    server.pack_gate.set()
    httpd.shutdown()
    _forget_served_files(ZimHandler)


def _gen(page):
    return page.evaluate("() => window.__gen")


def test_relaunch_after_a_deploy_runs_the_new_code(served):
    from playwright.sync_api import sync_playwright

    server, engine = served
    with sync_playwright() as p:
        try:
            br = getattr(p, engine).launch()
        except Exception as e:  # CI installs only chromium
            pytest.skip("%s not available: %s" % (engine, e))
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
        server.hold_pack = True

        log = []
        pg = ctx.new_page()
        pg.on("request", lambda r: log.append(r.url) if r.resource_type == "document" and r.frame.parent_frame is None else None)
        pg.goto(server.base + "/", wait_until="commit")
        t0 = time.time()
        gens = []
        while time.time() - t0 < FIRST_LAUNCH_DEADLINE_S:  # a deadline for a broken run; a good one leaves at the first 1
            time.sleep(1)
            try:
                gens.append(_gen(pg))
            except Exception:
                gens.append(None)
            if gens[-1] == 1:
                break
        print(engine, "first launch after the deploy:", gens, "documents:", len(log), "after %.0fs" % (time.time() - t0))
        first = gens[-1]
        diag = None
        by = None
        try:
            by = pg.evaluate("() => sessionStorage.getItem('zimi_update_by')")
        except Exception:
            pass
        if first != 1:
            diag = pg.evaluate("async () => { const r = await navigator.serviceWorker.getRegistration(); const st = w => w && w.state; return [st(r.installing), st(r.waiting), st(r.active), !!navigator.serviceWorker.controller, _BUILD, [...document.scripts].map(x=>x.src).filter(x=>/app\\.js/.test(x)).join(), (await caches.keys()).join(',')]; }")
        br.close()
    # The new code runs on the first launch, with the Almanac's files still held, and its reload followed the new
    # worker taking charge, never the page's wait for one that does not come.
    assert first == 1 and by != "timeout", (engine, gens, by, diag)


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
        try:
            br = getattr(p, engine).launch()
        except Exception as e:  # CI installs only chromium
            pytest.skip("%s not available: %s" % (engine, e))
        ctx = br.new_context(service_workers="allow", **p.devices["iPhone 13"])
        _kept_almanac_on_device(ctx, server)
        server.deploy()
        server.hold_pack = True
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
