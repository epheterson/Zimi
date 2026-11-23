"""The globe is never see-through, whatever its Almanac HD tiles are doing.

A synthetic HD set is answered by route interception (no ZIM is built): /almanac-hd says installed, hd.json lists the
Earth's layers, every tile is a small flat picture, and a test chooses which tiles fail. The Earth is then drawn alone
over a colour nothing else has, the frame is read back, and every pixel inside the Earth's disc must be the Earth's:
with the device's level stepped down mid-view (the tiles turned off, and back once it steps up), with the shallow tiles missing, and with the
server away as the view opens (and the tiles must come once it is back).

Run: pytest tests/test_almanac_hd_holes_browser.py -v
"""

import json
import os
import struct
import sys
import threading
import zlib

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":40.71,"lon":-74.0,"name":"New York"}'
READY_MS = 240_000
WAIT_MS = 90_000
HD_BASE = "/w/fakehd/"
MANIFEST = {"layers": {"earth/day": {"max": 5, "px": 512}, "earth/night": {"max": 2, "px": 512}}}
NEAR, FAR = 1.5, 3.2   # Earth radii from the centre: deep tiles in sight, then the whole globe
TURN = 0.9             # radians the globe is turned by after the tiles went, as anyone turns it
SLOW_FRAME_MS = 40     # a frame the governor counts as slow at every level but the lowest
LOW_FRAME_MS = 33      # the low level draws 30 frames a second: a frame on that cadence
GOVERNOR_HELD_MS = 3_600_000
SHALLOW = 1            # levels 0 and 1: the stand-ins for every other tile


def _png(rgb, n=64):
    raw = b"".join(b"\x00" + bytes(rgb) * n for _ in range(n))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


TILE = _png((60, 160, 90))

# The Earth alone (its one map and its tiles) over magenta, read back: how many pixels well inside its disc are the
# Earth's, how many are open to what is behind it, and how many of a tile's pixels the one map was drawn over. The state of
# the tiles is told with it.
EARTH_PIXELS = r"""
() => {
  const S = _ae.gl, T = S.THREE, r = S.renderer, gl = r.getContext(), cam = S.camera;
  const b = S.hd ? S.hd.bodies.find((x) => x.key === 'earth') : null;
  const keep = new Set([S.earth]);
  if (b) for (const k in b.nodes) if (b.nodes[k].mesh) keep.add(b.nodes[k].mesh);
  const hidden = [];
  S.scene.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && !keep.has(o) && o.visible) { o.visible = false; hidden.push(o); } });
  r.setClearColor(0xff00ff, 1);
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const read = () => { r.render(S.scene, cam); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  const px = read(), base = S.earth.material.visible;
  S.earth.material.visible = false;
  const alone = read();   // the tiles without the one map: where a tile is, the picture must be the same with it
  S.earth.material.visible = base;
  r.setClearColor(0x000000, 0);   // the view's own (_aeBuildGl)
  hidden.forEach((o) => { o.visible = true; });
  const to = new T.Vector3().setFromMatrixPosition(S.earth.matrixWorld).sub(cam.position), at = new T.Vector3();
  const DISC = 0.985;   // of the Earth's radius: clear of the flattened poles and the limb's soft edge
  const magenta = (p, i) => p[i] > 200 && p[i + 1] < 60 && p[i + 2] > 200;
  let inside = 0, open = 0, over = 0;
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    at.set((x + 0.5) / w * 2 - 1, (y + 0.5) / h * 2 - 1, 0.5).unproject(cam);
    at.sub(cam.position).normalize();
    const along = at.dot(to);
    if (along <= 0 || to.lengthSq() - along * along >= DISC * DISC) continue;
    inside++;
    const i = (y * w + x) * 4;
    if (magenta(px, i)) open++;
    if (!magenta(alone, i) && (alone[i] !== px[i] || alone[i + 1] !== px[i + 1] || alone[i + 2] !== px[i + 2])) over++;
  }
  _ae.dirty = true; _aeKick();
  const failed = [];
  if (b) for (const k in b.nodes) for (const l in b.nodes[k].tex) if (b.nodes[k].tex[l] === 'failed') failed.push(l + '/' + k);
  return { inside, open, over, failed: failed.length, tiles: b ? b.drawn.filter((n) => n.mesh && n.mesh.visible).length : 0,
    deepest: b ? Math.max(-1, ...b.drawn.map((n) => n.z)) : -1, holes: b ? b.holes : null,
    busy: S.hd ? S.hd.queue.length + S.hd.loading : 0, level: ZimiCap.level(), hdOn: ZimiCap.get('hdTiles') };
}
"""


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    from http.server import ThreadingHTTPServer

    import zimi.renderer as renderer
    import zimi.server as srv
    from zimi.http import ZimHandler

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    tmp = tmp_path_factory.mktemp("hdholes")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br, "http://127.0.0.1:%d" % httpd.server_address[1]
        br.close()
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _open_earth(site, fails):
    """The Earth view open with the synthetic HD set read. fails(level) says whether a tile of that level fails now."""
    browser, url = site
    ctx = browser.new_context(
        viewport=VIEW, device_scale_factor=2, has_touch=True, is_mobile=True, service_workers="block", reduced_motion="reduce"
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (PLACE, PLACE)
    )
    pg = ctx.new_page()
    state = {"installed": True, "base": HD_BASE, "parts": {}, "mode": "never", "can_change": False}

    def hd_file(route):
        path = route.request.url.split(HD_BASE, 1)[1].split("?")[0]
        if path == "hd.json":
            route.fulfill(status=200, content_type="application/json", body=json.dumps(MANIFEST))
        elif fails(int(path.split("/")[2])):
            route.fulfill(status=503, body="")
        else:
            route.fulfill(status=200, content_type="image/png", body=TILE)

    pg.route("**/almanac-hd", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(state)))
    pg.route("**" + HD_BASE + "**", hd_file)
    pg.goto(url + "/#almanac", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=120_000)
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=READY_MS, polling=200)
    # Software GL is slow enough to step the device down by itself: the governor counts no frame until a test lets it.
    pg.evaluate("ZimiCap.hold(%d)" % GOVERNOR_HELD_MS)
    pg.evaluate("_aeHdPollNow()")
    pg.wait_for_function("() => !!(_ae.gl && _ae.gl.hd)", timeout=WAIT_MS, polling=200)
    return ctx, pg


def _look(pg, dist, turn=0.0):
    pg.evaluate("([d, a]) => { _ae.dist = d; _ae.az += a; _ae.dirty = true; _aeKick(); }", [dist, turn])


def _frames(pg, n=4):
    for _ in range(n):
        pg.evaluate("() => new Promise((done) => { _ae.dirty = true; _aeKick(); requestAnimationFrame(() => requestAnimationFrame(done)); })")


def _watch(pg, until, ms=WAIT_MS):
    """Reads the Earth back every half second until `until(reading)`; every reading on the way must be closed."""
    seen = []
    for _ in range(ms // 500):
        _frames(pg, 1)
        got = pg.evaluate(EARTH_PIXELS)
        seen.append(got)
        assert got["inside"] > 5000 and got["open"] == 0 and got["over"] == 0, got
        if until(got):
            return seen
        pg.wait_for_timeout(500)
    raise AssertionError("never settled: %r" % seen[-1])


def test_the_tiles_turned_off_mid_view_leave_the_whole_earth_drawn_and_come_back(site):
    ctx, pg = _open_earth(site, lambda level: False)
    try:
        _look(pg, NEAR)
        before = _watch(pg, lambda g: g["tiles"] > 0 and g["deepest"] > SHALLOW and not g["busy"])[-1]
        assert before["hdOn"] is True, before
        pg.evaluate("ZimiCap.hold(1, 0)")   # the governor counts frames again
        # A busy phone: slow frame after slow frame, until the governor has stepped the device down to no tiles.
        fed = pg.evaluate(
            "(ms) => { let t = performance.now() + 5000, n = 0; while (ZimiCap.get('hdTiles') && n < 5000) { t += ms; ZimiCap.frame('earth', t); n++; } return n; }",
            SLOW_FRAME_MS,
        )
        assert fed < 5000 and pg.evaluate("ZimiCap.get('hdTiles')") is False, fed
        _frames(pg, 1)   # the very next picture: no tile left in it, the one map whole
        after = pg.evaluate(EARTH_PIXELS)
        _look(pg, FAR, TURN)
        _frames(pg)
        turned = pg.evaluate(EARTH_PIXELS)
        assert turned["open"] == 0 and turned["inside"] > 5000, turned
        assert after["open"] == 0 and after["inside"] > 5000, after
        assert after["tiles"] == 0 and turned["tiles"] == 0, (after, turned)
        # The phone is fine again: frames on the low level's own cadence give the level back, and the tiles with it.
        fed = pg.evaluate(
            "(ms) => { let t = performance.now() + 60000, n = 0; while (!ZimiCap.get('hdTiles') && n < 5000) { t += ms; ZimiCap.frame('earth', t); n++; } return n; }",
            LOW_FRAME_MS,
        )
        assert fed < 5000, fed
        back = _watch(pg, lambda g: g["tiles"] > 0 and not g["busy"])[-1]
        assert back["hdOn"] is True and back["holes"] == 0, back
    finally:
        ctx.close()


def test_missing_shallow_tiles_show_the_one_map_not_a_hole(site):
    ctx, pg = _open_earth(site, lambda level: level <= SHALLOW)
    try:
        _look(pg, NEAR)
        seen = _watch(pg, lambda g: g["tiles"] > 0 and not g["busy"])
        assert seen[-1]["deepest"] > SHALLOW, seen[-1]
        _look(pg, FAR, TURN)   # the far side's deep tiles were never asked for: only the one map can be there
        seen += _watch(pg, lambda g: not g["busy"])
        assert any(g["holes"] > 0 for g in seen), seen[-1]
    finally:
        ctx.close()


def test_tiles_that_failed_while_the_server_was_away_come_once_it_is_back(site):
    away = [True]
    ctx, pg = _open_earth(site, lambda level: away[0])
    try:
        _look(pg, NEAR)
        down = _watch(pg, lambda g: g["failed"] > 0 and not g["busy"])[-1]
        assert down["tiles"] == 0, down
        away[0] = False
        _watch(pg, lambda g: g["deepest"] > SHALLOW and g["holes"] == 0 and not g["failed"] and not g["busy"])
    finally:
        ctx.close()
