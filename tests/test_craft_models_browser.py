"""The spacecraft in the 3D view, in a real browser: every stock craft builds and draws with its own shader, the Almanac
HD tier takes over when its ZIM has the craft and leaves the stock mesh when it does not.

Software GL (swiftshader), so nothing here times a frame. Run: pytest tests/test_craft_models_browser.py -v
"""

import io
import json
import os
import sys
import threading

import pytest

np = pytest.importorskip("numpy")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.append(os.path.join(ROOT, "scripts"))
import craftmesh as cm  # noqa: E402

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
STOCK = ["iss", "voyager", "pioneer", "juno", "parker", "webb", "galileo", "cassini"]
HD_PATH = "/w/zimi_almanac_hd/craft/"

# Build every craft, draw once, and report the GL error, every program's diagnostics, and what the craft is made of.
BUILD_ALL = """async (keys) => {
  var S = _ae.gl, gl = S.renderer.getContext(), out = {};
  for (var key of keys) {
    _aeCraftLoad(key);
    for (var i = 0; i < 400 && !_aeCraftData(key); i++) await new Promise(function (r) { setTimeout(r, 50); });
    var d = _aeCraftData(key);
    if (!d) { out[key] = { loaded: false }; continue; }
    var I = _aeCraftBuild(S, key);
    I.root.visible = true;
    S.renderer.render(S.scene, S.camera);
    out[key] = { loaded: true, normals: !!d.nrm, tris: d.idx.length / 3, parts: I.parts.length, palette: d.look.length };
    S.scene.remove(I.root);
  }
  out.glError = gl.getError();
  out.failed = S.renderer.info.programs.filter(function (p) { return p.diagnostics; }).length;
  return out;
}"""

# A craft asked to take its HD model: the index, the model and its texture fetched, then its meshes built.
HD_SWAP = """async (key) => {
  var S = _ae.gl, d = _aeCraftData(key);
  var I = _aeCraftBuild(S, key);
  I.root.visible = true;
  AE_CRAFT_HD_PX = 0;
  for (var i = 0; i < 200 && I.hd === undefined; i++) { _aeCraftHdRequest(I, [0, 0, 0]); await new Promise(function (r) { setTimeout(r, 50); }); }
  S.renderer.render(S.scene, S.camera);
  var gl = S.renderer.getContext();
  return { hd: I.hd, stockShown: I.stock.some(function (p) { return p.mesh.visible; }), parts: I.parts.length,
    mapped: I.parts.some(function (p) { return p.mesh.material.defines.CRAFT_MAP === 1; }), glError: gl.getError(),
    failed: S.renderer.info.programs.filter(function (p) { return p.diagnostics; }).length };
}"""


def _hd_assets():
    """A one-cube HD craft with a texture, as the builder writes it."""
    from PIL import Image

    v = np.array(
        [[x, y, z] for x in (0, 1) for y in (0, 1) for z in (0, 1)], dtype=np.float64
    )
    f = []
    for a, b, c, d in (
        (0, 1, 3, 2),
        (4, 6, 7, 5),
        (0, 4, 5, 1),
        (2, 3, 7, 6),
        (0, 2, 6, 4),
        (1, 5, 7, 3),
    ):
        f += [[a, b, c], [a, c, d]]
    v, f, n = cm.creased(v, np.array(f))
    uv = v[:, :2]
    entries = [((1, 1, 1), 0.5, 0.0, cm.MAT_DOUBLE_SIDED, 0, -1, -1)]
    data = cm.pack(
        1.0,
        v.min(0),
        v.max(0),
        (0, 0, 1),
        (1, 0, 0),
        entries,
        v,
        n,
        np.zeros(len(v), np.uint8),
        f,
        uv=uv,
        textures=["t.webp"],
    )
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 120, 40)).save(buf, "WEBP")
    index = {
        "models": {
            "voyager": {
                "file": "voyager.zcr2",
                "tris": len(f),
                "bytes": len(data),
                "credit": "test",
            }
        }
    }
    return {
        "index.json": (json.dumps(index).encode(), "application/json"),
        "voyager.zcr2": (data, "application/octet-stream"),
        "t.webp": (buf.getvalue(), "image/webp"),
    }


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("craftview")
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


def _open(br, served, hd=None):
    ctx = br.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=1,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
        % (PLACE, PLACE)
    )
    if hd is not None:

        def serve(route):
            name = route.request.url.split(HD_PATH)[1].split("?")[0]
            if name in hd:
                body, mime = hd[name]
                route.fulfill(body=body, content_type=mime)
            else:
                route.fulfill(status=404, body="")

        ctx.route("**" + HD_PATH + "**", serve)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on(
        "console",
        lambda m: (
            errors.append(m.text) if m.type == "error" and "404" not in m.text else None
        ),
    )
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=120_000,
    )
    pg.evaluate("() => openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
        timeout=READY_MS,
        polling=200,
    )
    return ctx, pg, errors


@pytest.fixture(scope="module")
def browser(served):  # after served: its availability probe runs its own Playwright
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


def test_every_stock_craft_builds_and_draws(browser, served):
    ctx, pg, errors = _open(browser, served)
    try:
        out = pg.evaluate(BUILD_ALL, STOCK)
        for key in STOCK:
            assert out[key]["loaded"], key
            assert out[key]["normals"], "%s is shaded flat: no normals" % key
            assert 1 <= out[key]["palette"] <= 12
        assert out["iss"]["parts"] == 2, "the station's arrays turn on their own mesh"
        assert out["glError"] == 0
        assert out["failed"] == 0, "a craft shader did not compile"
        assert errors == []
    finally:
        ctx.close()


def test_hd_craft_replaces_the_stock_mesh(browser, served):
    ctx, pg, errors = _open(browser, served, hd=_hd_assets())
    try:
        pg.evaluate("() => _aeCraftLoad('voyager')")
        pg.wait_for_function("() => !!_aeCraftData('voyager')", timeout=60_000)
        out = pg.evaluate(HD_SWAP, "voyager")
        assert out["hd"] is True
        assert out["stockShown"] is False and out["mapped"] is True
        assert out["glError"] == 0 and out["failed"] == 0
        assert errors == []
    finally:
        ctx.close()


def test_craft_without_hd_stays_stock(browser, served):
    for hd in (
        {},
        {"index.json": (json.dumps({"models": {}}).encode(), "application/json")},
    ):
        ctx, pg, errors = _open(browser, served, hd=hd)
        try:
            pg.evaluate("() => _aeCraftLoad('voyager')")
            pg.wait_for_function("() => !!_aeCraftData('voyager')", timeout=60_000)
            out = pg.evaluate(HD_SWAP, "voyager")
            assert out["hd"] is None and out["stockShown"] is True
            assert out["glError"] == 0
            assert errors == []
        finally:
            ctx.close()
