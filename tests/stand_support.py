"""What the stand tests share: the served library, the one page, and the way down and up (split from the one module that
ran past a CI shard).
"""

import os
import sys
import threading
import pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hit_area import undersized  # noqa: E402
from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
GROUND_MS = 180_000
SPOTS = {
    "moon": (20.19, 30.77),  # Taurus-Littrow
    "mars": (-5.4, 137.8),  # Gale
    "titan": (-10.6, 192.3),  # Huygens
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    from http.server import ThreadingHTTPServer
    import zimi.server as srv
    from zimi.http import ZimHandler
    tmp = tmp_path_factory.mktemp("stand")
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
    env.undo()


@pytest.fixture(scope="module")
def page(served):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        ctx = browser.new_context(
            viewport=VIEW,
            device_scale_factor=2,
            has_touch=True,
            is_mobile=True,
            service_workers="block",
        )
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
            # Chromium now has iOS's permission ask, and a headless one answers no: answer yes, as a tap would.
            "DeviceOrientationEvent.requestPermission = function () { return Promise.resolve('granted'); };"
            % (PLACE, PLACE)
        )
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        # A shader that does not compile draws nothing and says so only here.
        pg.on(
            "console",
            lambda m: (
                pg.errors.append(m.text[:400])
                if m.type == "error" and "THREE" in m.text
                else None
            ),
        )
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=120_000,
        )
        pg.evaluate("openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly",
            timeout=READY_MS,
            polling=200,
        )
        yield pg
        browser.close()


@pytest.fixture(autouse=True)
def _clock_back_to_now(page):
    """Every test starts on the live clock: several set a moment (_aeGoTo), and a clock left off now opens the time bar's speed slider
    under the ground view, which the finger-size test then measures."""
    yield
    page.evaluate("() => { if (typeof _aeNow === 'function') _aeNow(); }")


def _stand(pg, body):
    lat, lon = SPOTS[body]
    pg.evaluate("([b, la, lo]) => _aeStandAt(b, la, lo)", [body, lat, lon])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'",
        timeout=GROUND_MS,
        polling=200,
    )


def _leave(pg):
    pg.evaluate("() => _aeStandLeave()")
    pg.wait_for_function(
        "() => !_ae.stand && !document.getElementById('ae-view').classList.contains('ae-standing')",
        timeout=60_000,
        polling=200,
    )


def _stand_anywhere(pg, body, lat, lon):
    pg.evaluate("([b, la, lo]) => _aeStandAt(b, la, lo)", [body, lat, lon])
    pg.wait_for_function(
        "() => _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground' && _ae.stand.fr",
        timeout=GROUND_MS,
        polling=200,
    )


def _ground_luma(page):
    """The mean linear luminance of the ground band of the picture (the lower quarter, above the clock)."""
    import io
    from PIL import Image
    im = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
    w, h = im.size
    band = im.crop((0, int(h * 0.62), w, int(h * 0.86))).resize((60, 24))
    px = list(band.getdata())
    return sum(0.2126 * (r / 255) ** 2.2 + 0.7152 * (g / 255) ** 2.2 + 0.0722 * (b / 255) ** 2.2 for r, g, b in px) / len(px)


NIGHT_OF_NOON = 0.15   # the readable night ground (starlight at this view's own widest exposure) comes to about 0.12 of the noon ground's luminance


def _face(page, expr):
    """Turn the head to the local direction `expr` (a unit vector in the ground's frame), draw, and give the pixel it is at."""
    return page.evaluate(
        """(expr) => { var st = _ae.stand, d = eval(expr); st.userYaw = Math.atan2(d[0], d[1]) - st.yaw; st.userPitch = Math.asin(d[2]) - AE_STAND_PITCH_DEG * Math.PI / 180; st.zoom = 1;
          st.dirty = true; _ae.dirty = true; _aeStandDraw(performance.now());
          var p = new (_ae.gl.THREE.Vector3)(d[0] * AE_STAND_SKY_AT_M, d[1] * AE_STAND_SKY_AT_M, d[2] * AE_STAND_SKY_AT_M).project(st.camera); return [(p.x + 1) / 2 * _ae.w, (1 - p.y) / 2 * _ae.h]; }""",
        expr,
    )


def _tag(page):
    return page.evaluate(
        "() => { var t = _ae.stand.skyTag && _ae.stand.skyTag.firstChild; return t && !t.hidden ? t.textContent : null; }"
    )


def _noon(page):
    page.evaluate(
        """() => { var st = _ae.stand; _aeGoTo(Date.UTC(2026, 5, 20, 18, 0, 0)); st.fr = null; st.dirty = true; _ae.dirty = true; _aeKick(); }"""
    )
    page.wait_for_function("() => _ae.stand.fr && _ae.stand.fr.sunAlt > 50", timeout=60_000, polling=250)


WALK_STEPS = """([n]) => { const st = _ae.stand, t0 = performance.now(); st.walk = _aeStandWalkOf(st); st.walk.at = t0; let peak = 0;
  for (let i = 1; i <= n; i++) { _aeStandWalkStep(st, t0 + i * 50); peak = Math.max(peak, st.walk.jump); }
  return { x: st.walk.x, y: st.walk.y, h: st.walk.h, jump: st.walk.jump, peak, yaw: st.yaw + st.userYaw }; }"""


def _walk_state(page):
    return page.evaluate("() => { const w = _ae.stand.walk || {}; return { x: w.x || 0, y: w.y || 0, h: w.h || 0, jump: w.jump || 0 }; }")


NEWLY_REACHED = ["vesta", "charon", "phobos", "enceladus", "mimas", "tethys", "dione", "rhea", "iapetus", "triton"]
