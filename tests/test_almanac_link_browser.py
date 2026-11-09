"""The Almanac's address, in a real browser: the URL describes the moment, rate, scroll and 3D view, and a page opened at it
comes back to the same place; real time at now writes no moment; nonsense in the address changes nothing and breaks nothing.

Run one file at a time: pytest tests/test_almanac_link_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SF = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
READY_MS = 180_000
WRITE_WAIT_MS = 1200  # ALM_LINK_MS twice over, for a slow machine
WRITE_WAIT_TIMEOUT_MS = 20_000  # a shared CI runner under swiftshader can be ten times slower than that


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("almlink")
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


@pytest.fixture(scope="module")
def browser(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


def _open(browser, served, hash_="#almanac", errors=None):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=1,
        service_workers="block",
        color_scheme="dark",
        timezone_id="America/Los_Angeles",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_app_theme', 'dark'); localStorage.setItem('zimi_almanac_place', %r); }"
        " catch (e) {}" % SF
    )
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: (errors if errors is not None else []).append(str(e)))
    pg.goto(served + "/" + hash_, wait_until="domcontentloaded")
    pg.wait_for_selector("#almanac-head-date", state="attached", timeout=60_000)
    pg.wait_for_function(
        "() => typeof _almRevealing !== 'undefined' && !_almRevealing", timeout=60_000
    )
    return ctx, pg


def _hash_after_writes(pg, must_have):
    pg.wait_for_function(
        "(m) => m.every(function (k) { return location.hash.indexOf(k) >= 0; })",
        arg=must_have,
        timeout=WRITE_WAIT_TIMEOUT_MS,
    )
    pg.wait_for_timeout(WRITE_WAIT_MS)
    return pg.evaluate("() => location.hash")


def _view_ready(pg):
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
        timeout=READY_MS,
        polling=200,
    )


def test_a_reload_at_now_writes_no_moment(browser, served):
    errors = []
    ctx, pg = _open(browser, served, errors=errors)
    try:
        pg.wait_for_timeout(WRITE_WAIT_MS)
        h = pg.evaluate("() => location.hash")
        assert h.startswith("#almanac"), h
        assert "t=" not in h and "r=" not in h and "p=" not in h and "v=" not in h, h
        assert pg.evaluate("() => [_almFocus, _almRate]") == [None, 1]
        assert not errors, errors
    finally:
        ctx.close()


def test_the_moment_rate_scroll_and_3d_view_come_back_from_the_link(browser, served):
    errors = []
    ctx, pg = _open(browser, served, errors=errors)
    try:
        pg.evaluate(
            "() => { _almClockSetRate(0); _almClockGoTo(new Date('2031-03-05T12:34:00Z')); }"
        )
        pg.wait_for_function("() => !_almEd", timeout=5000)
        pg.evaluate(
            "() => { document.getElementById('almanac-content').scrollTop = 900; }"
        )
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function'", timeout=120_000
        )
        pg.evaluate("() => openAlmanacEarth({ from: 'sky' })")
        _view_ready(pg)
        pg.evaluate("() => _aePreset('mars')")
        pg.wait_for_function("() => _ae.target === 'mars' && !_ae.fly", timeout=60_000)
        pg.evaluate(
            """() => { _ae.dist = _ae.dist * 0.5; _ae.az = _aeRad(40); _ae.el_ = _aeRad(-20);
            _ae.pan = { t: 'mars', v: [0.05, -0.04, 0.02] }; _ae.preset = null; _ae.dirty = true; _aeKick(); }"""
        )
        want = pg.evaluate(
            "() => ({ dist: _ae.dist, pan: _ae.pan.v, scroll: document.getElementById('almanac-content').scrollTop })"
        )
        h = _hash_after_writes(pg, ["t=", "r=0", "v=mars", "c=", "n=", "s="])
        assert len(h) < 120, h
        assert "t=1930480440" in h, h
    finally:
        ctx.close()

    errors2 = []
    ctx2, pg2 = _open(browser, served, hash_=h, errors=errors2)
    try:
        _view_ready(pg2)
        got = pg2.evaluate(
            """() => ({ t: _almFocus && _almFocus.getTime(), rate: _almRate, target: _ae.target, dist: _ae.dist,
            az: _aeDeg(_ae.az), el: _aeDeg(_ae.el_), pan: _ae.pan && _ae.pan.v,
            scroll: document.getElementById('almanac-content').scrollTop, fly: !!_ae.fly })"""
        )
        assert (
            abs(got["t"] - 1930480440000) < 2000
        ), got  # 2031-03-05T12:34Z, to the second
        assert got["rate"] == 0, got
        assert got["target"] == "mars" and not got["fly"], got
        assert abs(got["dist"] - want["dist"]) / want["dist"] < 0.01, (got, want)
        assert abs(got["az"] - 40) < 0.2 and abs(got["el"] + 20) < 0.2, got
        assert got["pan"] and all(
            abs(a - b) < 0.001 for a, b in zip(got["pan"], [0.05, -0.04, 0.02])
        ), got
        # the page under the view is where it was left (it lands once the view closes and uncovers it)
        pg2.evaluate("() => _aeClose()")
        pg2.wait_for_function("() => !_aeIsOpen", timeout=30_000)
        assert (
            abs(
                pg2.evaluate(
                    "() => document.getElementById('almanac-content').scrollTop"
                )
                - want["scroll"]
            )
            <= 3
        )
        h2 = _hash_after_writes(pg2, ["s="])
        assert (
            "v=" not in h2 and "c=" not in h2
        ), h2  # the view is closed: the link no longer names it
        assert not errors2, errors2
    finally:
        ctx2.close()


def test_side_by_side_full_screen_comes_back(browser, served):
    errors = []
    ctx, pg = _open(browser, served, errors=errors)
    try:
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function'", timeout=120_000
        )
        pg.evaluate("() => openAlmanacEarth({ from: 'sky' })")
        _view_ready(pg)
        pg.evaluate("() => _aePreset(AE_SPIN_KEY)")
        pg.wait_for_function("() => !!_ae.spin", timeout=60_000)
        # The link is about Zimi's own full-screen state; the browser's Fullscreen API (which a
        # headless Linux Chromium may answer with an enter and an exit) is left out of it.
        pg.evaluate(
            "() => { Object.defineProperty(document, 'fullscreenEnabled', { get: () => false }); _aeFullEnter(); }"
        )
        h = _hash_after_writes(pg, ["v=spin", "f=1"])
    finally:
        ctx.close()
    ctx2, pg2 = _open(browser, served, hash_=h, errors=errors)
    try:
        _view_ready(pg2)
        pg2.wait_for_function("() => !!_ae.spin && _aeFullOn()", timeout=60_000)
        assert not errors, errors
    finally:
        ctx2.close()


def test_a_place_in_a_link_is_used_but_never_saved(browser, served):
    errors = []
    ctx, pg = _open(browser, served, hash_="#almanac?p=35.68,139.69", errors=errors)
    try:
        got = pg.evaluate(
            "() => [_getLocation().lat, _getLocation().lon, JSON.parse(localStorage.getItem('zimi_almanac_place')).lat]"
        )
        assert got == [35.68, 139.69, 37.77], got
        h = _hash_after_writes(pg, ["p=35.68,139.69"])
        assert "p=35.68,139.69" in h
        # choosing a place replaces it, and the link stops naming one
        pg.evaluate("() => _saveLocation(48.85, 2.35, 'Paris')")
        h = _hash_after_writes(pg, ["#almanac"])
        pg.wait_for_function(
            "() => location.hash.indexOf('p=') < 0", timeout=WRITE_WAIT_MS * 3
        )
        assert not errors, errors
    finally:
        ctx.close()


@pytest.mark.parametrize(
    "bad",
    [
        "#almanac?t=abc&r=zzz&p=999,5&s=-5&v=%3Cscript%3E&c=1,2&n=a,b,c&f=1",
        "#almanac?t=99999999999999999999&r=1e99&p=,&s=NaN&v=mars&c=-5,1000,9999",
        "#almanac?&&=&t=&r=&v=&c=,,",
        "#almanac?v=nosuchbody&c=3,4,5&n=1,2,3",
    ],
)
def test_nonsense_in_the_address_changes_nothing_and_breaks_nothing(
    browser, served, bad
):
    errors = []
    ctx, pg = _open(browser, served, hash_=bad, errors=errors)
    try:
        pg.wait_for_timeout(WRITE_WAIT_MS)
        assert pg.evaluate("() => _almanacOpen") is True
        r = pg.evaluate("() => _almRate")
        assert r == 1 or abs(r) <= 31557600, r
        assert not errors, errors
        if "v=mars" in bad:
            _view_ready(pg)
            d = pg.evaluate("() => [_ae.dist, _aeDeg(_ae.el_)]")
            assert d[0] > 0 and abs(d[1]) <= 85.01, d
    finally:
        ctx.close()


@pytest.mark.parametrize("view", ["iss", "voyager1"])
def test_a_link_to_the_station_or_a_probe_comes_back_there(browser, served, view):
    """The station and the probes are not known at the view's first frame (their data comes after): a link to one opened
    on the Earth with the link's camera, and was then written back as v=<it> with that Earth camera. It waits for them."""
    errors = []
    ctx, pg = _open(browser, served, hash_="#almanac?v=%s&c=0.0021,40,15" % view, errors=errors)
    try:
        pg.wait_for_function(
            "(v) => typeof _aeReady === 'function' && _aeIsOpen && _ae.target === v && !_ae.linkHeld",
            arg=view,
            timeout=READY_MS,
            polling=200,
        )
        got = pg.evaluate("() => ({ preset: _ae.preset, az: Math.round(_aeDeg(_ae.az)), fly: !!_ae.fly })")
        assert got["preset"] == view and got["az"] % 360 == 40 and not got["fly"], got
        assert not errors, errors
    finally:
        ctx.close()
