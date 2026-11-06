"""Almanac HD in the 3D view: tiles by view, nothing without it, and the offer.

A small Almanac HD is built here (three levels of solid tiles), served by Zimi, and the Earth view is driven in
headless Chromium at a phone's size. Without it the view asks for no tile and draws its one map; with it, far away
it draws level 0, close in the deepest level over what is in sight only, and the body's one map steps aside.

Run: pytest tests/test_almanac_hd_browser.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
INSERT = {"site": "apollo11", "lat": 0.67408, "lon": 23.47297, "z": 2, "x0": 4, "x1": 5, "y0": 0, "y1": 1}
LEVELS = {"earth/day": 2, "earth/night": 1, "moon/albedo": 1, "moon/relief": 1}
OFFER = {
    "installed": False,
    "mode": "ask",
    "locked": None,
    "offer": {"file": "zimi_almanac_hd_2026-11.zim", "size": 312_000_000},
    "downloading": None,
    "can_change": True,
}


def _build_hd(folder, out):
    from PIL import Image

    from zimi import creator

    for layer, top in LEVELS.items():
        for z in range(top + 1):
            for x in range(2 ** (z + 1)):
                for y in range(2**z):
                    p = os.path.join(folder, layer, str(z), str(x))
                    os.makedirs(p, exist_ok=True)
                    Image.new("RGB", (64, 64), (60 + 60 * z, 120, 200)).save(
                        os.path.join(p, "%d.webp" % y), "WEBP"
                    )
    # An insert past the Moon's max, round the Apollo 11 site: level 2, the four tiles under level 1's (2, 0).
    for x in (4, 5):
        for y in (0, 1):
            p = os.path.join(folder, "moon/albedo", "2", str(x))
            os.makedirs(p, exist_ok=True)
            Image.new("RGB", (64, 64), (250, 250, 250)).save(os.path.join(p, "%d.webp" % y), "WEBP")
    layers = {k: {"max": v} for k, v in LEVELS.items()}
    layers["moon/albedo"]["inserts"] = [INSERT]
    with open(os.path.join(folder, "hd.json"), "w") as f:
        json.dump(
            {
                "version": 1,
                "tile": 512,
                "ext": "webp",
                "layers": layers,
            },
            f,
        )
    with open(os.path.join(folder, "index.html"), "w") as f:
        f.write("<!doctype html><title>Almanac HD</title><p>tiles</p>")
    with open(os.path.join(folder, "zimi.txt"), "w") as f:
        f.write(
            "Title: Almanac HD\nDescription: test tiles\nLanguage: eng\nCreator: test\nPublisher: test\n"
        )
    creator.create_folder_zim(folder, out_path=out, register=False)


#: What the library holds: nothing; the HD flavour of the Almanac (tiles under hd/); or 1.15.3's tiles-only ZIM.
KINDS = {"without": None, "flavour": "/w/zimi_almanac_maxi/hd/", "tiles-only": "/w/zimi_almanac_hd/"}
SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")


def _serve(tmp, kind, fresh=True):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    (tmp / "zims").mkdir(exist_ok=not fresh)
    (tmp / "data").mkdir()
    if kind == "tiles-only":
        _build_hd(str(tmp / "stage"), str(tmp / "zims" / "zimi_almanac_hd_2026-11.zim"))
    elif kind == "flavour":
        _build_hd(str(tmp / "stage"), str(tmp / "tiles.zim"))
        sys.path.insert(0, SCRIPTS)
        import build_almanac_maxi

        build_almanac_maxi.build(str(tmp / "tiles.zim"), str(tmp / "zims"), month="2026-11")
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


@pytest.fixture(scope="module")
def browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


@pytest.fixture(params=list(KINDS), ids=list(KINDS))
def served(request, tmp_path):
    import zimi.server as srv

    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    httpd = _serve(tmp_path, request.param)
    yield request.param != "without", "http://127.0.0.1:%d" % httpd.server_address[1], KINDS[request.param]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _open_earth(browser, url, route_hd=None, base="/w/zimi_almanac_"):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r);"
        " localStorage.removeItem('zimi_alm_hd_later'); } catch (e) {}" % (PLACE, PLACE)
    )
    pg = ctx.new_page()
    tiles = []
    pg.on(
        "request",
        lambda r: (
            tiles.append(r.url)
            if base in r.url and r.url.endswith(".webp")
            else None
        ),
    )
    if route_hd is not None:
        # The offer rides on the satellites answer the view asks for as it opens.
        def with_offer(route):
            body = route.fetch().json()
            body["hd"] = {k: v for k, v in route_hd.items() if k != "can_change"}
            body["can_change"] = route_hd["can_change"]
            route.fulfill(
                status=200, content_type="application/json", body=json.dumps(body)
            )

        pg.route("**/almanac-satellites*", with_offer)
    pg.goto(url + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=READY_MS,
        polling=200,
    )
    return ctx, pg, tiles


DRAWN = "() => _ae.gl.hd ? _ae.gl.hd.bodies[0].drawn.map(n => n.z) : null"


def _settle(pg, js_true, ms=60_000):
    pg.wait_for_function(
        "() => { _ae.dirty = true; _aeKick(); return (" + js_true + ")(); }",
        timeout=ms,
        polling=250,
    )


def test_tiles_by_view(browser, served):
    with_hd, url, base = served
    ctx, pg, tiles = _open_earth(browser, url, base=base or "/w/zimi_almanac_")
    try:
        if not with_hd:
            pg.wait_for_timeout(2500)
            assert pg.evaluate("_ae.gl.hd") is None
            assert tiles == []
            assert pg.evaluate("_ae.gl.earth.material.visible") is True
            assert pg.evaluate("AE_TARGETS.earth.min") == pytest.approx(1.12)
            return
        # A data pack: served to the view, listed nowhere (Home, the library's grid).
        listed = pg.evaluate("() => fetch('/list').then(r => r.json()).then(l => (Array.isArray(l) ? l : l.zims).map(z => z.name))")
        assert not [n for n in listed if n.startswith("zimi_almanac_")], listed
        # Every tile came from where this library keeps them: inside the flavour's hd/, or the tiles-only ZIM's root.
        assert tiles and all(base in u for u in tiles), (base, tiles[:3])
        # Far: level 0 covers the Earth, and its one map steps aside. Far enough that a level-0 tile covers no more
        # device pixels than it has (nearer, at 8 Earth radii and 2x, level 2 is the right choice, and the old check
        # passed only while level 2's tiles were still on their way), not so far the Earth is under 40 px and asks for
        # none. Worked out from the view's own numbers, the flight in done.
        pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=200)
        far = pg.evaluate("""() => { var d = Math.PI * _aeFocalPx() * _ae.gl.dpr / (AE_HD_TILE_PX * AE_HD_SPLIT) + 2.5;
            _ae.dist = d; _ae.dirty = true; _aeKick(); return { dist: d, radiusPx: _aeFocalPx() / d }; }""")
        assert far["radiusPx"] > 40, far
        _settle(
            pg,
            "() => { var d = ("
            + DRAWN
            + ")(); return d && d.length && d.every(z => z === 0); }",
        )
        assert pg.evaluate("_ae.gl.earth.material.visible") is False
        # The camera may come nearer with tiles to show it.
        assert pg.evaluate("AE_TARGETS.earth.min") < 1.1
        # Close in over one place: the deepest level, and only what is in sight.
        pg.evaluate(
            "_ae.fly = null; _ae.dist = AE_TARGETS.earth.min; _ae.dirty = true; _aeKick()"
        )
        _settle(
            pg,
            "() => { var d = ("
            + DRAWN
            + ")(); return d && d.length && d.every(z => z === 2); }",
        )
        deep = [u for u in tiles if "/earth/day/2/" in u]
        assert 0 < len(deep) < 32, deep
        assert not any(
            "/earth/night/2/" in u for u in tiles
        ), "night stops at its deepest level"
        # The Moon's relief: lit through its own shader, read in colour (east and north tilt), not as one channel.
        # Its tiles are asked for once the Moon is big enough to need them.
        pg.evaluate("_aePreset('moon')")
        _settle(pg, "() => { var b = _ae.gl.hd.bodies.filter(b => b.key === 'moon')[0]; var n = b.nodes['0/0/0'];"
                    " return !_ae.fly && n && n.tex['moon/relief'] && n.tex['moon/relief'].isTexture; }")
        moon = pg.evaluate("""() => { var b = _ae.gl.hd.bodies.filter(b => b.key === 'moon')[0];
            var n = b.nodes['0/0/0'], t = n && n.tex['moon/relief'], a = n && n.tex['moon/albedo'];
            return { relief: b.frag.indexOf('reliefMap') >= 0, maps: b.maps.map(m => m.uni),
                     reliefRed: t && t.isTexture ? t.format === AE_THREE_RED_FORMAT : null,
                     albedoRed: a && a.isTexture ? a.format === AE_THREE_RED_FORMAT : null }; }""")
        assert moon["relief"] and moon["maps"] == ["moonMap", "reliefMap"], moon
        assert moon["reliefRed"] is False and moon["albedoRed"] is True, moon
        # Over the Apollo 11 site the Moon goes past its max, into the insert; outside it, never.
        pg.evaluate("""() => { var row = _aeLm && _aeLm.moon ? _aeLm.moon.filter(r => r[0] === 'Apollo 11')[0] : ['Apollo 11', 0.67408, 23.47297, 'landing', '', 0];
            _ae.fly = null; _aeLmFly('moon', row); _ae.fly = null; _ae.dist = AE_TARGETS.moon.min; }""")
        _settle(pg, "() => { var b = _ae.gl.hd.bodies.filter(b => b.key === 'moon')[0]; return b.drawn.some(n => n.z === 2); }")
        deep = pg.evaluate("_ae.gl.hd.bodies.filter(b => b.key === 'moon')[0].drawn.filter(n => n.z === 2).map(n => [n.x, n.y])")
        assert all(4 <= x <= 5 and 0 <= y <= 1 for x, y in deep), deep
        assert not any("/moon/albedo/2/" in u and not any("/moon/albedo/2/%d/%d.webp" % (x, y) in u for x in (4, 5) for y in (0, 1)) for u in tiles)
    finally:
        ctx.close()


def test_the_offer_line(browser, served):
    with_hd, url, base = served
    if with_hd:
        pytest.skip("offered only while it is not installed")
    ctx, pg, _tiles = _open_earth(browser, url, route_hd=OFFER)
    try:
        pg.wait_for_function(
            "() => !document.getElementById('ae-hd').hidden", timeout=20_000
        )
        text = pg.inner_text("#ae-hd")
        assert "312" in text and "MB" in text, text
        assert pg.is_visible("#ae-hd-get") and pg.is_visible("#ae-hd-later")
        pg.click("#ae-hd-later")
        assert pg.evaluate("document.getElementById('ae-hd').hidden")
        assert pg.evaluate("localStorage.getItem('zimi_alm_hd_later')") == "1"
    finally:
        ctx.close()


@pytest.mark.parametrize("who", ["admin", "viewer", "never"])
def test_the_gear_keeps_hd_after_not_now(browser, served, who):
    """Not now hides the line under the controls, never the way to it: the gear keeps a row for Almanac HD with its
    size and Download for someone who may; for anyone else it says who can add it; under Never there is none."""
    with_hd, url, base = served
    if with_hd:
        pytest.skip("offered only while it is not installed")
    st = dict(OFFER, can_change=who == "admin", mode="never" if who == "never" else "ask")
    ctx, pg, _tiles = _open_earth(browser, url, route_hd=st)
    try:
        pg.wait_for_function("() => !!_ae.hdSt", timeout=20_000)
        if who == "admin":
            pg.click("#ae-hd-later")
        pg.click("#ae-gear")
        row = pg.evaluate("() => { var r = document.querySelector('#ae-set-body .ae-set-hd'); return r ? r.innerText : null; }")
        if who == "never":
            assert row is None, row
        else:
            assert row and "Sharper Earth, Moon and planets" in row and "312" in row, row
            assert pg.evaluate("!!document.getElementById('ae-set-hd-get')") == (who == "admin"), row
            if who == "viewer":
                assert "runs this Zimi" in row, row
    finally:
        ctx.close()


@pytest.mark.parametrize("flavour", ["standard", "maxi"])
def test_a_flavour_opened_alone_is_the_almanac_and_the_hd_one_draws_its_own_tiles(browser, tmp_path, flavour):
    """What Kiwix does: the ZIM's page with nothing of Zimi's app around it (?raw=1), reading only its own files. The
    standard flavour starts with no page error and no tile; the HD flavour draws the sharp tiles from hd/ inside itself."""
    import zimi.server as srv

    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    if flavour == "maxi":
        httpd = _serve(tmp_path, "flavour")
        page = "/w/zimi_almanac_maxi/index.html?raw=1"
    else:
        from zimi import ownzims

        (tmp_path / "zims").mkdir()
        ownzims.write_zim(next(o for o in ownzims.OWN if o.name == "zimi_almanac"), str(tmp_path / "zims" / "zimi_almanac_2026-11.zim"))
        httpd = _serve(tmp_path, "without", fresh=False)
        page = "/w/zimi_almanac/index.html?raw=1"
    ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block")
    ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); } catch (e) {}" % PLACE)
    pg = ctx.new_page()
    reqs, errors = [], []
    pg.on("request", lambda r: reqs.append(r.url))
    pg.on("pageerror", lambda e: errors.append(str(e)))
    try:
        pg.goto("http://127.0.0.1:%d%s" % (httpd.server_address[1], page), wait_until="load")
        pg.wait_for_function("() => typeof openAlmanacEarth === 'function'", timeout=120_000)
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
        if flavour == "standard":
            pg.wait_for_timeout(2500)
            assert pg.evaluate("_ae.gl.hd") is None and not [u for u in reqs if "/hd/" in u and u.endswith(".webp")]
        else:
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !!_ae.gl.hd; }", timeout=60_000, polling=250)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return !_ae.fly; }", timeout=60_000, polling=200)
            pg.evaluate("_ae.dist = AE_TARGETS.earth.min; _ae.dirty = true; _aeKick()")
            _settle(pg, "() => { var d = (" + DRAWN + ")(); return d && d.length && d.every(z => z === 2); }")
            tiles = [u for u in reqs if u.endswith(".webp") and "/earth/day/" in u and "/hd/" in u]
            assert tiles and all("/w/zimi_almanac_maxi/hd/earth/day/" in u for u in tiles), tiles[:3]
            assert not [u for u in reqs if "zimi_almanac_hd" in u]
        assert errors == []
    finally:
        ctx.close()
        httpd.shutdown()
        srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old
