"""Flying down to a ground: the picture stays the place.

The UFO comes down over a body; the globe's picture gives way to the ground's through a band of heights (almanac-standhost.js). Here the two pictures
are read back where they meet: the ground comes in at the globe's own brightness and colour of the place (measured, almanac-standhost.js _aeRigMatch),
keeps the map's picture of the country below it while more than a texel of it is in sight, and settles on its own look by the time it is low.

Run: pytest tests/test_almanac_descent_browser.py -v
"""

import json
import math
import os
import struct
import sys
import zlib

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_almanac_rig_browser import PLACE, READY_MS, SUNLIT_OVER, _at, _fly, page, served  # noqa: E402, F401  (the fixtures and the craft's helpers)

GROUND_MS = 300_000
# The two pictures as the match measured them, and the ground drawn again from the same place at the matched exposure and colour: what it shows there.
MATCHED = """() => { const sh = _ae.ship, g = sh.gnd, st = g.st, M = g.match, r = _ae.gl.renderer, gu = st.ground, top = g.top * 1000;
  const was = { cam: gu.uCam.value, hue: gu.uMatch.value, k: gu.uKg.value, craft: g.craft && g.craft.root.visible };
  if (g.craft) g.craft.root.visible = false;
  gu.uCam.value = [0, 0, top]; gu.uMatch.value = M.hue; gu.uKg.value = was.k / (st.kMatch || 1) * M.k;
  r.setRenderTarget(M.groundRt.rt); r.clear(); r.render(st.scene, M.cam);
  r.setRenderTarget(null);
  gu.uCam.value = was.cam; gu.uMatch.value = was.hue; gu.uKg.value = was.k;
  if (g.craft) g.craft.root.visible = was.craft;
  return _aeRigMean(M.groundRt.rt, M.groundRt.buf).then((shown) => ({ globe: M.globe, ground: M.ground, shown: shown, k: M.k, hue: M.hue })); }"""
LUMA = (0.2126, 0.7152, 0.0722)
APART = 0.08   # the two pictures' own brightness differs by at least this where the test looks (else it proves nothing). Was 0.12: the globe's eye vector moved to the world's axes (5f7169c27, the ring fix), which dimmed Mars's lit globe toward the ground's (0.098 to 0.112 now, by the run)
SAME = 0.06    # and the matched ground is within this of the globe, each channel (of 1)


def _luma(c):
    return sum(x * w for x, w in zip(c, LUMA))


def _into_the_band(page, body, share):
    """The craft over sunlit ground, its ground built, hung at a share of the band's top height."""
    _at(page, body)
    _fly(page)
    page.evaluate("() => _aeStandReady()")
    page.wait_for_function("() => typeof _aeRigTopKm === 'function'", timeout=120_000)
    page.evaluate(SUNLIT_OVER, [body, 1.02])
    page.evaluate(
        "(k) => { const s = _ae.ship, ll = _aeRigLatLon(k, s.pos), fr = _aeRigFrame(k, ll.lat, ll.lon); s.pos = _aeRigWorld(fr, [0, 0, _aeRigTopKm(k) * 2000]); _afAdvance(0.1); }",
        body,
    )
    page.wait_for_function("() => { _afAdvance(0.1); const g = _ae.ship && _ae.ship.gnd; return !!g && g.live; }", timeout=GROUND_MS, polling=500)
    page.evaluate(
        "(share) => { const s = _ae.ship, g = s.gnd, fr = _aeRigFrame(g.key, g.lat, g.lon); s.pos = _aeRigWorld(fr, [0, 0, g.top * 1000 * share]); g.liveAt = 0; _afAdvance(0.2); _ae.dirty = true; _aeKick(); }",
        share,
    )
    page.wait_for_function("() => { _ae.dirty = true; _aeKick(); const g = _ae.ship && _ae.ship.gnd; return !!(g && g.match && g.match.ground && !g.match.busy); }", timeout=60_000, polling=200)


@pytest.mark.local_gate
@pytest.mark.parametrize("body", ["mars", "earth"])
def test_the_ground_comes_in_at_the_globes_own_brightness_and_colour(page, body):
    _into_the_band(page, body, 0.5)
    try:
        got = page.evaluate(MATCHED)
        assert abs(_luma(got["ground"]) - _luma(got["globe"])) > APART, got   # left alone the ground is another picture: far brighter or darker
        assert all(abs(a - b) < SAME for a, b in zip(got["shown"], got["globe"])), got
        # Down the band the match gives way: nothing of it is left two tenfolds of height under the top.
        settled = page.evaluate("() => { const g = _ae.ship.gnd; return [_aeRigSettled(g.top, g.top), _aeRigSettled(g.top, g.top / 10), _aeRigSettled(g.top, g.top / 100), _aeRigSettled(g.top, 0.002)]; }")
        assert settled[0] == 0 and 0 < settled[1] < 1 and settled[2] == 1 and settled[3] == 1, settled
    finally:
        page.evaluate("() => _afStop(true)")


# What the ground's first pictures would stop a frame for, as it stands the moment the ground goes live (nothing of it shown yet).
PAID_FOR = """() => { const g = _ae.ship.gnd, st = g.st, S = _ae.gl, r = S.renderer;
  const prog = (m) => { const p = m && r.properties.get(m), c = p && p.currentProgram; return c ? { ready: c.isReady ? c.isReady() : true, used: c.usedTimes } : null; };
  const mats = []; st.scene.traverse((o) => { if (o.material && mats.indexOf(o.material) < 0) mats.push(o.material); });
  const want = Math.min(S.dpr, _aeStandRatioCap());
  return { alpha: st.alpha || 0, warmStep: st.warmStep, uncompiled: mats.filter((m) => { const p = prog(m); return !p || !p.ready; }).length, materials: mats.length,
    target: st.msaa ? [st.msaa.w, st.msaa.h] : null, size: [Math.round(_ae.w * want), Math.round(_ae.h * want)], ownRatio: st.ownRatio || null, want: want,
    canvasRatio: r.getPixelRatio(), craft: !!g.craft && !!prog(g.craft.body.material),
    air: typeof _aeStandAir !== 'undefined' && !!_aeStandAir && { tables: !!_aeStandAir.uniforms, sky: prog(st.skyMatAir) }, rings: !!S.standRings }; }"""


def test_what_the_grounds_first_pictures_need_is_made_before_any_of_it_shows(page):
    """A flight down had a frame of 50 to 85 ms where the ground first showed and another 3 km up, where the Earth's own air comes in: programs compiled and first
    used, the full-size target made, the air's tables built, the canvas given a new size, all in the picture's own frame. They are done ahead, a step a frame."""
    _at(page, "earth")
    ratio0 = page.evaluate("_ae.gl.renderer.getPixelRatio()")
    _fly(page)
    page.evaluate("() => _aeStandReady()")
    page.wait_for_function("() => typeof _aeRigTopKm === 'function' && typeof _aeStandAir !== 'undefined' && !!_aeStandAir", timeout=120_000)
    page.evaluate(SUNLIT_OVER, ["earth", 1.02])
    page.evaluate("() => { const s = _ae.ship, ll = _aeRigLatLon('earth', s.pos), fr = _aeRigFrame('earth', ll.lat, ll.lon); s.pos = _aeRigWorld(fr, [0, 0, _aeRigTopKm('earth') * 2000]); _afAdvance(0.1); }")
    try:
        # (Every step done: a software renderer's slow frames can run the steps past the wait the ground gives them, AE_STAND_WARM_MS, and they go on after it.)
        page.wait_for_function("() => { _afAdvance(0.1); const g = _ae.ship && _ae.ship.gnd; return !!g && g.live && g.st.warmStep === -1; }", timeout=GROUND_MS, polling=100)
        got = page.evaluate(PAID_FOR)
        assert got["alpha"] == 0, got                                     # nothing of it on the screen yet
        assert got["materials"] > 4 and got["uncompiled"] == 0, got       # every material of the scene has its program
        assert got["craft"], got                                          # the craft's own, for the ground's target
        assert got["rings"], got
        if not page.evaluate("!!_ae.gl.renderer.extensions.get('KHR_parallel_shader_compile')"):
            return   # a renderer that compiles where it stands (software GL) keeps the old one-step warm: the steps below are not taken there
        assert got["target"] == got["size"], got                          # the full-size target is there, at the size it will be drawn at
        assert got["ownRatio"] == got["want"] and got["canvasRatio"] == ratio0, got   # the canvas kept its size: the ground has its own
        assert got["air"] and got["air"]["tables"] and got["air"]["sky"] and got["air"]["sky"]["ready"] and got["air"]["sky"]["used"] >= 1, got   # the Earth's air: tables built, its sky compiled and used once
        assert page.evaluate("!!_ae.gl.standWarmed && _ae.gl.standKeep.plain.children.length") > 4   # and a copy of each material kept: the next ground compiles nothing
    finally:
        page.evaluate("() => _afStop(true)")


WOODED = (50.0, 10.0)   # central Germany: broadleaf country on the land-cover grid
TREES_MS = 180_000


def test_the_earths_trees_are_there_on_the_way_down_and_are_the_same_trees(page):
    """Built in one go the trees held the picture for a third of a second and more, so a craft's ground had none until it had landed. In slices they are
    built beside the flight; and whatever the slices, they are the trees one go gives: the same places, the same shapes."""
    _at(page, "earth")
    _fly(page)
    page.evaluate("() => _aeStandReady()")
    page.wait_for_function("() => typeof _aeRigTopKm === 'function'", timeout=120_000)
    top = page.evaluate("_aeRigTopKm('earth')")
    page.evaluate(OVER_PLACE, ["earth", WOODED[0], WOODED[1], top * 2])
    try:
        page.wait_for_function("() => { _afAdvance(0.1); const g = _ae.ship && _ae.ship.gnd; return !!g && g.live; }", timeout=GROUND_MS, polling=200)
        # Hanging above the band, nothing of the ground on screen, never set down: the trees come.
        page.wait_for_function("() => { _afAdvance(0.05); _ae.dirty = true; _aeKick(); const st = _ae.ship && _ae.ship.gnd && _ae.ship.gnd.st; return !!(st && st.trees); }", timeout=TREES_MS, polling=300)
        got = page.evaluate(
            "() => { const g = _ae.ship.gnd, st = g.st, t = st.trees; return { alpha: st.alpha || 0, alt: _ae.ship.near.alt * AE_EARTH_RADIUS_KM, top: g.top, count: t.count, meshes: t.meshes.length,"
            " inScene: t.meshes.every((m) => m.parent === st.scene && m.visible), chunk: AE_STAND_TREE_CHUNK, grass: !!st.grass && st.grass.mesh.parent === st.scene,"
            " corners: t.meshes.reduce((n, m) => n + m.geometry.attributes.position.count, 0) }; }"
        )
        assert got["alpha"] == 0 and got["alt"] > got["top"], got           # still above the band
        assert got["count"] > 200 and got["inScene"] and got["grass"], got
        assert got["meshes"] == math.ceil(got["count"] / got["chunk"]) and got["corners"] > got["count"] * 12, got   # a few hundred trees to a mesh
        # One go against slices of a hundredth of a millisecond: the same corners in the same order.
        same = page.evaluate(
            """() => { const st = _ae.ship.gnd.st, flat = (job) => { const out = []; job.meshes.forEach((m) => { const a = m.geometry.attributes.position.array; for (let i = 0; i < a.length; i += 97) out.push(a[i]); }); return out; };
              const whole = _aeStandTreesJob(st); while (!whole.step(0)) {}
              const sliced = _aeStandTreesJob(st); let slices = 1; while (!sliced.step(0.01)) slices++;
              const a = flat(whole), b = flat(sliced);
              whole.meshes.concat(sliced.meshes).forEach((m) => { m.geometry.dispose(); }); if (whole.meshes[0]) whole.meshes[0].material.dispose(); if (sliced.meshes[0]) sliced.meshes[0].material.dispose();
              return { slices, counts: [whole.count, sliced.count, st.trees.count], n: [a.length, b.length], same: a.length === b.length && a.every((v, i) => v === b[i]) }; }"""
        )
        assert same["slices"] > 50 and same["same"] and same["counts"][0] == same["counts"][1] == same["counts"][2], same
    finally:
        page.evaluate("() => _afStop(true)")


def test_the_map_is_the_grounds_picture_while_more_than_a_texel_of_it_is_in_sight(page):
    """Standing, the horizon is a quarter of an Earth texel away: one colour, the map's mean. From a few hundred metres the map itself."""
    page.evaluate("() => _aeStandReady()")   # the ground's code loads when first stood on
    share = page.evaluate(
        "() => [0.0017, 0.03, 0.4, 3, 40].map((km) => _aeStandMapShare({ key: 'earth', b: { km: AE_EARTH_RADIUS_KM }, altKm: km }))"
    )
    assert share[0] == 0 and share[2] == 1 and share[3] == 1 and share[4] == 1 and 0 < share[1] < 1, share
    texel, radius = page.evaluate("() => [2 * Math.PI * AE_EARTH_RADIUS_KM / _aeStandMapWidth('earth'), AE_EARTH_RADIUS_KM]")
    horizon = lambda km: math.sqrt(2 * radius * km)  # noqa: E731
    assert horizon(0.0017) < 0.5 * texel and horizon(0.4) > 2 * texel, (texel, horizon(0.0017), horizon(0.4))


def test_the_snow_line_is_the_alps_own(page):
    page.evaluate("() => _aeStandReady()")   # the ground's code loads when first stood on
    line = page.evaluate("() => AE_ST_SNOW_LINE_M * Math.pow(Math.cos(46 * Math.PI / 180), AE_ST_SNOW_LINE_POW)")
    assert 2700 <= line <= 3100, line   # the Alps' climatic snow line


# ── With Almanac HD installed ──
# A synthetic set (route interception, no ZIM): every tile carries its part of one world-wide checker whose squares are a level-8 tile across (78 km at the
# equator), so any tile of any level shows the same squares in the same places.
HD_BASE = "/w/fakehd/"
CELL_LEVEL = 8
CELL_DEG = 180 / 2**CELL_LEVEL
HD_MANIFEST = {"layers": {"earth/day": {"max": CELL_LEVEL}, "earth/night": {"max": 2}}}
INLAND = (48.0, 68.0)   # the Kazakh steppe: no sea within the picture (the ground draws water where its heights say sea)
NOON_THERE_MS = 1781006400000 - int(INLAND[1] / 15 * 3600_000)   # 2026-06-09, the Sun high over that longitude
LOOK_KM, LOOK_PX = 300, 48   # the height the ground is looked at from, straight down, and the picture's side
AGREE = 0.9                  # the share of the picture's pixels that are the checker's own colour there (the rest: the squares' soft edges, the ground's grain)
OVER_PLACE = """([key, lat, lon, km]) => { const fr = _aeRigFrame(key, lat, lon), p = _aeAdd(fr.origin, _aeScale(fr.u, km / AE_EARTH_RADIUS_KM));
  _afLinkPlace([p[0], p[1], p[2], -fr.u[0], -fr.u[1], -fr.u[2], 0]); _afAdvance(0.1); }"""
# The ground alone, drawn straight down from LOOK_KM: each pixel's green, and the latitude and longitude the globe gives the point of the ground it shows.
GROUND_AND_PLACES = """([km, N]) => { const sh = _ae.ship, g = sh.gnd, st = g.st, S = _ae.gl, T = S.THREE, r = S.renderer, fr = g.fr, gu = st.ground, top = km * 1000, fov = 35;
  const rt = new T.WebGLRenderTarget(N, N), cam = new T.PerspectiveCamera(), buf = new Uint8Array(N * N * 4);
  cam.fov = fov; cam.aspect = 1; cam.near = top * 0.05; cam.far = top * 3; cam.position.set(0, 0, top); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  const was = { cam: gu.uCam.value, pix: gu.uPixAng.value, craft: g.craft && g.craft.root.visible };
  if (g.craft) g.craft.root.visible = false;
  gu.uCam.value = [0, 0, top]; gu.uPixAng.value = 2 * Math.tan(fov * Math.PI / 360) / N;
  r.setRenderTarget(rt); r.clear(); r.render(st.scene, cam); r.readRenderTargetPixels(rt, 0, 0, N, N, buf); r.setRenderTarget(null); rt.dispose();
  gu.uCam.value = was.cam; gu.uPixAng.value = was.pix; if (g.craft) g.craft.root.visible = was.craft;
  const half = top * Math.tan(fov * Math.PI / 360), out = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const ll = _aeRigLatLon(g.key, _aeRigWorld(fr, [((i + 0.5) / N * 2 - 1) * half, ((j + 0.5) / N * 2 - 1) * half, 0]));
    out.push([buf[(j * N + i) * 4 + 1], ll.lat, ll.lon]);
  }
  return { px: out, tiles: g.hd ? g.hd.tiles : 0, on: gu.uHd.value }; }"""


def _checker_png(z, x, y):
    cells = 2 ** (CELL_LEVEL - z)   # squares along the tile's side (a fraction of one past CELL_LEVEL)
    px = max(64, int(2 * cells))
    rows = []
    for j in range(px):
        row = bytearray([0])
        for i in range(px):
            v = 230 if (int((x + i / px) * cells) + int((y + j / px) * cells)) % 2 == 0 else 90
            row += bytes((v, v, v))
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", px, px, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(b"".join(rows), 1)) + chunk(b"IEND", b"")


@pytest.fixture(scope="module")
def hd_page(page, served):
    """A second window of the same browser, with the synthetic Almanac HD answered to it."""
    ctx = page.context.browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1, has_touch=True, is_mobile=True, service_workers="block")
    ctx.add_init_script("try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE))
    pg = ctx.new_page()
    state = {"installed": True, "base": HD_BASE, "parts": {}, "mode": "never", "can_change": False}

    def hd_file(route):
        path = route.request.url.split(HD_BASE, 1)[1].split("?")[0]
        if path == "hd.json":
            route.fulfill(status=200, content_type="application/json", body=json.dumps(HD_MANIFEST))
            return
        layer, z, x, y = path.rsplit(".", 1)[0].rsplit("/", 3)
        route.fulfill(status=200, content_type="image/png", body=_checker_png(int(z), int(x), int(y)))

    pg.route("**/almanac-hd", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(state)))
    pg.route("**" + HD_BASE + "**", hd_file)
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=READY_MS)
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly", timeout=READY_MS, polling=200)
    pg.evaluate("_aeHdPollNow()")
    pg.wait_for_function("() => !!(_ae.gl && _ae.gl.hd)", timeout=60_000, polling=200)
    yield pg
    ctx.close()


def test_with_almanac_hd_the_craft_comes_down_to_a_ground_that_shows_the_tiles_where_the_globe_does(hd_page):
    pg = hd_page
    pg.evaluate("(ms) => _aeGoTo(ms)", NOON_THERE_MS)
    _fly(pg)
    pg.evaluate("() => _aeStandReady()")
    pg.wait_for_function("() => typeof _aeRigTopKm === 'function'", timeout=120_000)
    top = pg.evaluate("_aeRigTopKm('earth')")
    stop_km = pg.evaluate("(AE_TARGETS.earth.min - AE_TARGETS.earth.surface) * AE_EARTH_RADIUS_KM")
    assert stop_km > top * 3, (stop_km, top)   # the view's own closest stop with these tiles is far above where a ground starts to be built
    # Asked down to well inside the band: the craft is let below the HD stop (it was held there, and no ground was ever built), and its ground comes.
    pg.evaluate(OVER_PLACE, ["earth", INLAND[0], INLAND[1], top * 0.5])
    pg.wait_for_function("() => { _afAdvance(0.1); const g = _ae.ship && _ae.ship.gnd; return !!g && g.live; }", timeout=GROUND_MS, polling=500)
    try:
        assert pg.evaluate("_ae.ship.near.alt * AE_EARTH_RADIUS_KM") < top, "the craft is inside the band"
        # The tiles the globe holds there are in the ground's own picture once they are in.
        pg.wait_for_function(
            "() => { _afAdvance(0.05); _ae.dirty = true; _aeKick(); const h = _ae.gl.hd, g = _ae.ship.gnd; return h.queue.length + h.loading === 0 && !!g.hd && g.hd.tiles > 10 && g.st.ground.uHd.value === 1; }",
            timeout=120_000,
            polling=500,
        )
        pg.wait_for_timeout(1500)   # (one more look at the tiles, AE_RIG_HD_EVERY_MS)
        pg.evaluate("() => { _afAdvance(0.05); _ae.dirty = true; _aeKick(); }")
        got = pg.evaluate(GROUND_AND_PLACES, [LOOK_KM, LOOK_PX])
        greens = sorted(p[0] for p in got["px"])
        cut = (greens[len(greens) // 10] + greens[-len(greens) // 10]) / 2   # between the dark squares and the light
        assert greens[-len(greens) // 10] - greens[len(greens) // 10] > 30, ("the checker is not in the ground's picture", greens[:: len(greens) // 12])
        right = sum(1 for g, lat, lon in got["px"] if (g > cut) == ((int((lon + 180) / CELL_DEG) + int((90 - lat) / CELL_DEG)) % 2 == 0))
        assert right / len(got["px"]) >= AGREE, (right / len(got["px"]), got["tiles"])
    finally:
        pg.evaluate("() => _afStop(true)")
