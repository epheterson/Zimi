"""Opening Zimi's home does not flash ("Loading the main Zimi view has this weird flash during loading").

On a slow link the bar painted in one shape and, a moment later, the boot re-laid it out under the eye: the search box
shrank, the Saved button and the search tips popped in, the logo moved six pixels, the placeholder changed twice
("Search everything..." to "Search" to "Search everything…" to "Search"), and a "Loading library..." message blinked in
for a fraction of a second before the page replaced it. This samples every frame of a cold and a warm load of / on an
emulated iPhone and on a desktop, over a slow network, and fails on any of those.

Run: pytest tests/test_home_boot_flash_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from test_home_apps_live import HOME  # noqa: E402

# One entry per frame in which anything the eye could catch changed.
RECORD = r"""
(() => { const T = window.__tl = []; const t0 = performance.now(); let last = '', loadAt = 0, loadSeen = 0;
 function snap() { const d = document, tb = d.querySelector('.topbar'); if (!tb) return;
  const box = id => { const e = d.getElementById(id), r = e && e.getBoundingClientRect(); return e && r.width > 0 ? [Math.round(r.left), Math.round(r.width)] : null; };
  const q = d.getElementById('q'), ld = d.querySelector('#output .loading');
  const now = performance.now() - t0;
  if (ld && !loadAt) loadAt = now;
  if (ld && !loadSeen && parseFloat(getComputedStyle(ld).opacity) > 0.05) loadSeen = now;
  const o = { ph: q && q.placeholder, logo: box('logo'), q: box('q'), help: box('search-help'), saved: box('bm-panel-btn'),
    outTop: Math.round(d.getElementById('output').getBoundingClientRect().top),
    bg: getComputedStyle(d.body).backgroundColor, loadAt: Math.round(loadAt), loadSeen: Math.round(loadSeen) };
  const k = JSON.stringify(o); if (k !== last) { last = k; T.push(o); } }
 function loop() { snap(); requestAnimationFrame(loop); }
 document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(loop));
})();
"""

CONTEXTS = {
    "phone": dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2),
    "desktop": dict(viewport={"width": 1280, "height": 800}),
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("bootflash")
    zdir, data = tmp / "zims", tmp / "data"
    zdir.mkdir()
    data.mkdir()
    for n in ("wikipedia_en_all_maxi", "devdocs_en_python", "lowtech"):
        build_fixture_zim(str(zdir / (n + "_2026-01.zim")), {"Name": n, "Title": n.title(), "Language": "eng"})
    mp = pytest.MonkeyPatch()
    mp.setenv("ZIMI_APPS", ",".join(srv.APP_NAMES))
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(data))
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


def _timeline(url, kind, warm):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(color_scheme="dark", **CONTEXTS[kind])
            if warm:
                p = ctx.new_page()
                p.goto(url)
                p.wait_for_function(HOME, timeout=30000)
                p.wait_for_timeout(1500)
                p.close()
            ctx.add_init_script(RECORD)
            pg = ctx.new_page()
            cdp = ctx.new_cdp_session(pg)
            cdp.send("Network.enable")
            cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 150, "downloadThroughput": 400000, "uploadThroughput": 200000})
            cdp.send("Emulation.setCPUThrottlingRate", {"rate": 3})
            pg.goto(url, wait_until="commit")
            pg.wait_for_function(HOME, timeout=60000)
            pg.wait_for_timeout(1500)
            return pg.evaluate("window.__tl")
        finally:
            br.close()


@pytest.mark.parametrize("warm", [False, True], ids=["cold", "warm"])
@pytest.mark.parametrize("kind", ["phone", "desktop"])
def test_home_boot_does_not_flash(served, kind, warm):
    tl = _timeline(served, kind, warm)
    assert tl, "no frames recorded"
    # The bar is the one Home settles on from its first paint: nothing in it moves, pops in or changes its words.
    # (The desktop's ⋯, an admin's Create, arrives when the server says who may; it is not part of this.)
    if kind == "desktop":  # the ⋯ moves the buttons sideways, so there it is whether they are there
        tl = [dict(f, help=bool(f["help"]), saved=bool(f["saved"]), q=None) for f in tl]
    keys = ("ph", "logo", "q", "help", "saved")
    shapes = {tuple(repr(f[k]) for k in keys) for f in tl}
    assert len(shapes) == 1, ("the bar changed after its first paint", [dict((k, f[k]) for k in keys) for f in tl])
    # Where the page starts does not move when the library arrives (an empty counts bar once held 24px, then left).
    assert len({f["outTop"] for f in tl}) == 1, ("the page jumped when the library arrived", sorted({f["outTop"] for f in tl}))
    # Dark before and after: no light frame while the scheme is dark.
    assert {f["bg"] for f in tl} == {"rgb(10, 10, 11)"}, {f["bg"] for f in tl}
    # A "Loading library" message is for a slow start: never on screen within half a second of appearing.
    last = tl[-1]
    if last["loadSeen"]:
        assert last["loadSeen"] - last["loadAt"] >= 450, ("the loading message blinked in", last)
