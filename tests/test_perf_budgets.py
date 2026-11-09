"""Budgets for what a phone pays: bytes and requests on the first load, what stays lazy, the size of what ships.

Three tiers, cheapest first:
  - sizes of files in the tree and of their gzip (no browser, no GPU): always run;
  - bytes and requests of a cold Home, of opening the Almanac and of opening the 3D view, counted by the browser
    (any Chromium): run wherever the browser tests run;
  - the 3D view's frame cost and the time to its first frame under a 4x CPU throttle: only on a machine with a real
    GPU (ZIMI_PERF_GPU=1, as on the Mac mini), because a software renderer measures the renderer, not the page.

A budget is a ceiling set a little above what the page costs today, so a change that adds a request or a megabyte to
the first load fails here and is argued for in its PR. Raise a number only with the reason beside it.
Run: pytest tests/test_perf_budgets.py -v        (ZIMI_PERF_GPU=1 for the frame budgets)
"""

import gzip
import os
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "zimi", "static")
KB = 1024
MB = 1024 * KB

# ── Sizes in the tree ───────────────────────────────────────────────────────────────────────────────────────────
# gzip -6 of each file the Home page fetches before it can be used, in KB (the server sends gzip level 4: a few
# percent more). Today: app.js 413, app.css 76, en.json 57.
HOME_GZIP_KB = {"app.js": 450, "app.css": 85, "i18n/en.json": 65}
# Any one picture in static/earth (the Moon's 4k map is the largest, 730 KB; the HD tiles live in the release ZIM).
EARTH_FILE_MAX_BYTES = 800 * KB
# The two ZIMs the wheel and the image carry (29.8 MB together today).
OWN_ZIM_MAX_BYTES = {"zimi_games_": 20 * MB, "zimi_almanac_": 14 * MB}
# One ZIM of each kind: a second copy under builtin/ would ship twice (the NAS image carried four old ones).
OWN_ZIM_COPIES = 1


def _gz_kb(rel):
    with open(os.path.join(STATIC, rel), "rb") as fh:
        return len(gzip.compress(fh.read(), 6)) / KB


@pytest.mark.parametrize("rel,budget", sorted(HOME_GZIP_KB.items()))
def test_the_homes_own_files_stay_under_their_gzip_budget(rel, budget):
    assert _gz_kb(rel) <= budget, "%s is %.0f KB gzipped, budget %d KB" % (
        rel,
        _gz_kb(rel),
        budget,
    )


def test_no_picture_in_the_3d_views_folder_is_bigger_than_a_phone_can_use():
    big = []
    for name in os.listdir(os.path.join(STATIC, "earth")):
        p = os.path.join(STATIC, "earth", name)
        if (
            os.path.isfile(p)
            and name.endswith((".webp", ".png", ".jpg"))
            and os.path.getsize(p) > EARTH_FILE_MAX_BYTES
        ):
            big.append((name, os.path.getsize(p)))
    assert not big, big


def test_each_own_zim_is_under_its_size_and_there_is_one_of_each():
    folder = os.path.join(ROOT, "zimi", "builtin")
    zims = [n for n in os.listdir(folder) if n.endswith(".zim")]
    for prefix, limit in OWN_ZIM_MAX_BYTES.items():
        mine = [n for n in zims if n.startswith(prefix)]
        assert len(mine) == OWN_ZIM_COPIES, mine
        assert os.path.getsize(os.path.join(folder, mine[0])) <= limit, mine[0]


def test_the_images_dockerignore_leaves_out_the_zims_source_folders():
    with open(os.path.join(ROOT, ".dockerignore"), encoding="utf-8") as fh:
        lines = fh.read().split()
    assert "zimi/builtin/games/*" in lines and "zimi/builtin/almanac" in lines


def test_deploy_sends_dockerignore_to_the_nas():
    with open(os.path.join(ROOT, "deploy.sh"), encoding="utf-8") as fh:
        text = fh.read()
    assert ".dockerignore" in text.split("SRC=", 1)[1].split("\n", 1)[0]


# ── Bytes and requests, counted by the browser ─────────────────────────────────────────────────────────────────
# Cold Home on an empty library, as an iPhone loads it: requests and encoded KB until the page has settled
# (27 requests, 770 KB today, manage.js's 123 KB included: it is fetched once Home is quiet).
HOME_MAX_REQUESTS = 36
HOME_MAX_KB = 900
# Opening the Almanac from Home: its modules, stylesheet and first picture (11 requests, 405 KB today).
ALMANAC_MAX_REQUESTS = 20
ALMANAC_MAX_KB = 520
# Then the 3D view, opened as a tap on the Moon opens it (10 requests, 602 KB today).
EARTH_MAX_REQUESTS = 16
EARTH_MAX_KB = 700
# Files that must NOT come with Home or with the Almanac: the 3D view loads on its first use.
LAZY_PREFIXES = (
    "/static/earth/three",
    "/static/almanac-earth.js",
    "/static/earth/satellite",
    "/static/almanac-stand",
    "/static/almanac-sites",
    "/static/almanac-sats",
)

PHONE = {
    "viewport": {"width": 390, "height": 844},
    "device_scale_factor": 3,
    "has_touch": True,
    "is_mobile": True,
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("perf")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


class Counter:
    """Requests and encoded bytes since the last reset, by path."""

    def __init__(self, ctx, page, base):
        self.base, self.urls, self.by = base, {}, {}
        self.cdp = ctx.new_cdp_session(page)
        self.cdp.on(
            "Network.requestWillBeSent",
            lambda e: self.urls.__setitem__(e["requestId"], e["request"]["url"]),
        )
        self.cdp.on("Network.loadingFinished", self._done)
        self.cdp.send("Network.enable")

    def _done(self, e):
        url = self.urls.get(e["requestId"], "?")
        if url.startswith("data:"):
            return
        self.by[url.replace(self.base, "")] = e["encodedDataLength"]

    def reset(self):
        self.by = {}

    @property
    def requests(self):
        return len(self.by)

    @property
    def kb(self):
        return sum(self.by.values()) / KB

    def top(self, n=8):
        return sorted(((u, round(b / KB)) for u, b in self.by.items()), key=lambda r: -r[1])[:n]

    def lazy_seen(self):
        return sorted(u for u in self.by if u.startswith(LAZY_PREFIXES))


@pytest.fixture(scope="module")
def phone(served):
    from playwright.sync_api import sync_playwright

    gpu = os.environ.get("ZIMI_PERF_GPU") == "1"
    args = (
        ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
        if gpu
        else [
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ]
    )
    with sync_playwright() as pw:
        br = pw.chromium.launch(
            args=args
            + (["--disable-gpu-vsync", "--disable-frame-rate-limit"] if gpu else [])
        )
        ctx = br.new_context(service_workers="block", **PHONE)
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_almanac_hd_ask', 'never'); } catch (e) {}"
        )
        pg = ctx.new_page()
        counter = Counter(ctx, pg, served)
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_timeout(
            2500
        )  # manage.js comes once Home is quiet: it is part of the cost
        pg.counter = counter
        pg.home = (counter.requests, counter.kb, counter.lazy_seen(), counter.top())
        yield pg
        br.close()


def test_a_cold_home_stays_under_its_request_and_byte_budget(phone):
    requests, kb, lazy, top = phone.home
    assert requests <= HOME_MAX_REQUESTS, "%d requests, budget %d: %s" % (requests, HOME_MAX_REQUESTS, top)
    assert kb <= HOME_MAX_KB, "%.0f KB, budget %d: %s" % (kb, HOME_MAX_KB, top)
    assert lazy == [], "fetched on Home though they belong to the 3D view: %s" % lazy


def test_opening_the_almanac_stays_under_budget_and_leaves_the_3d_view_unfetched(phone):
    c = phone.counter
    c.reset()
    phone.evaluate("() => openAlmanac()")
    phone.wait_for_function(
        "() => typeof _almanacLoaded !== 'undefined' && _almanacLoaded && document.querySelectorAll('.alm-card, .alm-sky, .alm-hero').length > 0",
        timeout=120_000,
    )
    phone.wait_for_timeout(1500)
    assert c.requests <= ALMANAC_MAX_REQUESTS, "%d requests, budget %d: %s" % (
        c.requests,
        ALMANAC_MAX_REQUESTS,
        sorted(c.by),
    )
    assert c.kb <= ALMANAC_MAX_KB, "%.0f KB, budget %d" % (c.kb, ALMANAC_MAX_KB)
    assert not [
        u
        for u in c.lazy_seen()
        if "three" in u
        or "satellite" in u
        or "stand" in u
        or "sites" in u
        or "sats" in u
    ], c.lazy_seen()


def test_opening_the_3d_view_stays_under_budget(phone):
    c = phone.counter
    c.reset()
    phone.evaluate("() => _almLoadEarth()")
    phone.wait_for_function(
        "() => typeof openAlmanacEarth === 'function'", timeout=120_000
    )
    phone.evaluate("() => openAlmanacEarth({ target: 'earth' })")
    phone.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=240_000,
        polling=100,
    )
    phone.wait_for_timeout(1500)
    assert c.requests <= EARTH_MAX_REQUESTS, "%d requests, budget %d: %s" % (
        c.requests,
        EARTH_MAX_REQUESTS,
        sorted(c.by),
    )
    assert c.kb <= EARTH_MAX_KB, "%.0f KB, budget %d" % (c.kb, EARTH_MAX_KB)
    # Stand here, landing sites, satellites and Almanac HD come on their own first use, not with the view.
    heavy = [
        u
        for u in c.by
        if u.startswith(
            (
                "/static/almanac-stand",
                "/static/almanac-terrain",
                "/static/almanac-sites-",
                "/static/almanac-maps",
            )
        )
    ]
    assert heavy == [], heavy


# ── Frame cost, on a real GPU ───────────────────────────────────────────────────────────────────────────────────
# Medians over 90 frames at DPR 3, 390x844 with a finger turning the Earth, vsync off so the interval is what a frame
# costs, on an Apple GPU (Mac mini): 1.1 ms a frame, 0.5 ms of it JS; with the CPU throttled 4x (a phone's main thread)
# 3.8 ms, 1.7 ms of it JS. The budgets are a 60 Hz frame (16.7 ms) at 4x and a few times the JS cost, for a loaded machine.
GPU_ONLY = pytest.mark.skipif(
    os.environ.get("ZIMI_PERF_GPU") != "1",
    reason="frame budgets need a real GPU: ZIMI_PERF_GPU=1",
)
FRAME_JS_MS_MAX = 4.0  # time inside _aeDraw per frame, unthrottled
FRAME_MS_MAX_THROTTLED = 16.7  # a whole frame at 4x CPU
FIRST_FRAME_MS_MAX_THROTTLED = (
    2500  # tap on the Moon to the view's first frame, 4x CPU (600 ms on the mini)
)

FRAME_JS = """(n) => { window.__fr = null; var js = [], k = 0, t = [], l = performance.now(), orig = window._aeDraw;
  window._aeDraw = function () { var s = performance.now(); var r = orig.apply(this, arguments); js.push(performance.now() - s); return r; };
  function q(a) { a = a.slice(10).sort((x, y) => x - y); return a[a.length >> 1]; }
  function f(now) { t.push(now - l); l = now; _ae.dirty = true; if (++k < n) requestAnimationFrame(f); else { window._aeDraw = orig; window.__fr = { js: q(js), frame: q(t) }; } }
  requestAnimationFrame(f); }"""


def _frames_while_turning(pg, n=90):
    """Median JS ms in _aeDraw and median frame interval over n frames while a finger drags the view."""
    pg.evaluate("(n) => (" + FRAME_JS + ")(n)", n)
    pg.mouse.move(195, 420)
    pg.mouse.down()
    for i in range(600):
        pg.mouse.move(
            195 + 60 * ((i % 40) / 40.0 - 0.5),
            420 + 30 * (((i + 10) % 40) / 40.0 - 0.5),
        )
        if pg.evaluate("() => !!window.__fr"):
            break
        pg.wait_for_timeout(8)
    pg.mouse.up()
    return pg.evaluate("() => window.__fr")


@pytest.fixture(scope="module")
def earth(phone):
    phone.evaluate("() => _almLoadEarth()")
    phone.wait_for_function(
        "() => typeof openAlmanacEarth === 'function'", timeout=120_000
    )
    phone.evaluate("() => openAlmanacEarth({ target: 'earth' })")
    phone.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
        timeout=240_000,
        polling=100,
    )
    phone.wait_for_timeout(800)
    return phone


@GPU_ONLY
def test_turning_the_earth_costs_a_frame_little_main_thread_time(earth):
    r = _frames_while_turning(earth)
    assert r["js"] <= FRAME_JS_MS_MAX, r


@GPU_ONLY
def test_turning_the_earth_holds_60_fps_with_the_cpu_throttled_4x(earth):
    cdp = earth.context.new_cdp_session(earth)
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    try:
        r = _frames_while_turning(earth)
    finally:
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    assert r["frame"] <= FRAME_MS_MAX_THROTTLED, r


@GPU_ONLY
def test_the_3d_view_makes_its_first_frame_in_time_under_a_4x_throttle(phone, served):
    ctx = phone.context.browser.new_context(service_workers="block", **PHONE)
    try:
        pg = ctx.new_page()
        pg.goto(served + "/", wait_until="load")
        pg.wait_for_timeout(2500)
        ctx.new_cdp_session(pg).send("Emulation.setCPUThrottlingRate", {"rate": 4})
        t0 = pg.evaluate("() => performance.now()")
        pg.evaluate("() => openAlmanac()")
        pg.wait_for_function(
            "() => typeof _almanacLoaded !== 'undefined' && _almanacLoaded",
            timeout=120_000,
            polling=50,
        )
        pg.evaluate("() => _almLoadEarth()")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function'", timeout=120_000, polling=50
        )
        pg.evaluate("() => openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=240_000,
            polling=50,
        )
        pg.evaluate(
            "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
        )
        took = pg.evaluate("(t) => performance.now() - t", t0)
    finally:
        ctx.close()
    assert took <= FIRST_FRAME_MS_MAX_THROTTLED, "%.0f ms" % took
