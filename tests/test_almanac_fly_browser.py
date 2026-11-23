"""Fly in the Almanac's 3D view: the ship's file is fetched on the first press and not before; the keys move and turn it; a body chosen is flown to
and ends in orbit; nothing passes through a body; the camera swaps; the controls are touch-sized.

Run: pytest tests/test_almanac_fly_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_slots import WEBGL_ARGS
GL_ARGS = WEBGL_ARGS + ['--disable-accelerated-2d-canvas']
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 600_000
GROUND_MS = 300_000
SHOTS = os.environ.get("ZIMI_FLY_SHOTS")


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("fly")
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


def test_fly(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx = br.new_context(viewport=VIEW, device_scale_factor=1, has_touch=True, is_mobile=True, service_workers="block")
            ctx.add_init_script(
                "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}"
                % (PLACE, PLACE)
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            requested = []
            pg.on("request", lambda r: requested.append(r.url))
            pg.goto(served + "/#almanac", wait_until="load")
            pg.wait_for_function(
                "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=READY_MS
            )
            pg.evaluate("openAlmanacEarth({ target: 'earth' })")
            pg.wait_for_function(
                "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200
            )

            # Lazy: the view is open and nothing of Fly has come.
            assert not any("almanac-fly.js" in u for u in requested), "almanac-fly.js was fetched with the view"
            assert pg.evaluate("() => typeof _afStart === 'undefined'")

            # The way in is the rim button over empty space (the view's mode language); the ship comes with it on the first press only.
            assert pg.evaluate("() => _aeRimModes.some(m => m.enter && m.enter({ body: null }))")
            assert pg.evaluate("() => _aeFlyAble()")
            # From a view centred on a body the rim says Stand here, so Fly has its own button in the column (a 44 px target).
            box = pg.evaluate("() => { const b = document.getElementById('ae-fly-btn'), r = b.getBoundingClientRect(), t = document.elementFromPoint(r.x + r.width / 2 + 21, r.y + r.height / 2); return [b.hidden, t === b || b.contains(t)]; }")
            assert box == [False, True], box
            # Getting in moves nothing. The camera is sampled every frame from the click; the reference is the first frame with the ship (the view may still be settling
            # when the file is fetched, which is the view's own business), and after it nothing may move for a second and a half.
            pg.evaluate(
                """() => { window.__dev = []; window.__ref = null; window.__devStop = false;
                  function s() { const c = _ae.gl.camera, t = _aeBodyPos(_ae.target) || [0, 0, 0], here = { p: c.position.toArray().map((v, i) => v - t[i]), q: c.quaternion.toArray(), fov: c.fov };
                    if (_ae.ship) { if (!window.__ref) window.__ref = here; const r = window.__ref, d = here.p.map((v, i) => v - r.p[i]);
                      window.__dev.push([Math.hypot(...d) / Math.hypot(...r.p), 1 - Math.abs(here.q.reduce((a, v, i) => a + v * r.q[i], 0)), Math.abs(here.fov - r.fov), performance.now()]); }
                    if (!window.__devStop) requestAnimationFrame(s); }
                  requestAnimationFrame(s); document.getElementById('ae-fly-btn').click(); }"""
            )
            pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS)
            pg.wait_for_timeout(1500)   # a second with no hand on anything
            pg.evaluate("() => { window.__devStop = true; }")
            dev = pg.evaluate("() => window.__dev")
            assert len(dev) >= 2, dev
            assert max(d[0] for d in dev) < 1e-5 and max(d[1] for d in dev) < 1e-9 and max(d[2] for d in dev) < 1e-6, dev   # the camera's place, its way of looking and its field stay
            assert any("almanac-fly.js" in u for u in requested)
            # While it flies: the rim button moves the craft (down, or up from the surface; the UFO button leaves), Home is its own; each gives a finger 44 px.
            pg.wait_for_function("() => { const r = document.getElementById('ae-rim'); return !r.hidden && r.dataset.kind === 'enter'; }", timeout=READY_MS)
            assert pg.evaluate("() => document.getElementById('ae-cam').hidden"), "flying is one view: no camera button"
            assert pg.evaluate("() => !document.querySelector('#ae-rim .ae-rim-glyph').classList.contains('ae-rim-ground')"), "flying is in space: the lit dot is the space one"
            hint = pg.evaluate("() => { const h = document.getElementById('af-hint'); return [!h.hidden || !!_aeHintOut[AF_HINT_KEY], h.textContent]; }")   # (shown, then timed out on a slow box: it has had its say)
            assert hint[0] and len(hint[1]) > 10, hint   # the first flight says how to fly, once
            assert pg.evaluate("() => getComputedStyle(document.querySelector('.ae-pin')).display") != "none", "the one strip stays while flying"
            ufo = pg.evaluate("() => { const b = document.getElementById('ae-fly-btn'), r = b.getBoundingClientRect(); return [b.hidden, b.getAttribute('aria-pressed'), r.width >= 40, getComputedStyle(b).borderTopColor]; }")
            assert ufo[0] is False and ufo[1] == 'true' and ufo[2], ufo   # the UFO button stays and is lit while it flies: the way out
            pg.evaluate("document.getElementById('ae-fly-btn').click()")   # and it is the way out
            pg.wait_for_function("() => !_ae.ship", timeout=60_000, polling=100)
            assert pg.evaluate("() => document.getElementById('ae-fly-btn').getAttribute('aria-pressed')") == 'false'
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            pg.wait_for_function("() => !!_ae.ship && !!_ae.ship.craft", timeout=60_000, polling=100)
            boxes = pg.evaluate("() => ['ae-fly-btn', 'ae-locate', 'ae-rim', 'af-lever'].map(i => { const r = document.getElementById(i).getBoundingClientRect(); return [i, r.left, r.top, r.right, r.bottom]; })")
            for i, a in enumerate(boxes):
                for b in boxes[i + 1:]:
                    assert not (a[1] < b[3] and b[1] < a[3] and a[2] < b[4] and b[2] < a[4]), ("two controls overlap while flying", a, b)
            assert pg.evaluate("() => !document.getElementById('af-level') && !document.getElementById('af-tilt')"), "no Level or Tilt buttons"
            pg.evaluate("() => { _ae.ship.tipped = true; _ae.ship.free = true; }")   # a craft the hand has rolled
            pg.wait_for_function("() => !_ae.ship.tipped && _ae.ship.free === false", timeout=20_000, polling=100)   # puts its horizon back by itself
            for ident in ("ae-fly-btn", "ae-rim", "af-lever"):
                ok = pg.evaluate(
                    "(i) => { const e = document.getElementById(i), r = e.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;"
                    " return [[-21, 0], [21, 0], [0, -21], [0, 21]].every(d => { const t = document.elementFromPoint(cx + d[0], cy + d[1]); return t && (t === e || e.contains(t)); }); }",
                    ident,
                )
                assert ok, (ident, pg.evaluate("(i) => { const e = document.getElementById(i), r = e.getBoundingClientRect(), t = document.elementFromPoint(r.x + r.width / 2 + 21, r.y + r.height / 2); return [JSON.stringify(r), t && (t.id + '.' + t.className)]; }", ident))

            # Moves at once and stops dead: W moves the craft, letting go is a hover (no inertia, no drift).
            pg.evaluate("() => _afAdvance(1)")
            assert pg.evaluate("() => Math.hypot(..._ae.ship.vel)") == 0, "it hovers with no hand on it"
            pg.evaluate("() => { window.__b0 = _ae.ship.craft.root.position.toArray().join(); }")
            pg.wait_for_function("() => _ae.ship.craft.root.position.toArray().join() !== window.__b0", timeout=60_000, polling=100)   # the lens bobs while it hovers
            p0 = pg.evaluate("() => _ae.ship.pos.slice()")
            pg.keyboard.down("w")
            pg.evaluate("() => _afAdvance(0.1)")
            assert pg.evaluate("() => Math.hypot(..._ae.ship.vel)") > 0, "it moves at once"
            pg.evaluate("() => _afAdvance(2)")
            p1 = pg.evaluate("() => _ae.ship.pos.slice()")
            pg.keyboard.up("w")
            moved = sum((a - b) ** 2 for a, b in zip(p1, p0)) ** 0.5
            assert moved > 1e-3, moved
            pg.evaluate("() => _afAdvance(0.05)")
            assert pg.evaluate("() => Math.hypot(..._ae.ship.vel)") == 0, "it stops dead on release"
            # The craft's shader compiles and links (a failed one draws nothing at all: only the halo shows).
            linked = pg.evaluate(
                """() => { const S = _ae.gl, gl = S.renderer.getContext(), pr = S.renderer.properties.get(_ae.ship.craft.body.material), cp = pr && pr.currentProgram;
                  return !!cp && gl.getProgramParameter(cp.program, gl.LINK_STATUS); }"""
            )
            assert linked, "the UFO's shader did not link"

            # The craft is built (a pearl lens with running lights, lit by the Sun and the world below) and it leans a little into a slide, no more.
            pg.keyboard.down("d")
            pg.evaluate("() => _afAdvance(0.5)")
            pg.wait_for_function("() => Math.max(..._ae.ship.craft.lean.map(Math.abs)) > 0.01", timeout=60_000, polling=100)
            lean = pg.evaluate("() => _ae.ship.craft.lean.map(Math.abs)")
            pg.keyboard.up("d")
            assert 0.01 < max(lean) <= 0.1, lean

            # The craft never touches the clock: its speed is its own whatever rate the time bar runs at (the bar is almanac.js's; stood in for here).
            pg.keyboard.down("w")
            v1, v10, alt = pg.evaluate(
                """() => { const s = _ae.ship, p = s.pos.slice(), view = s.view.slice(), up = s.up.slice(), r0 = window._almStripRate;
                  _afAdvance(0.05); const a = Math.hypot(...s.vel);
                  s.pos = p; s.view = view; s.up = up; window._almStripRate = () => -10;
                  _afAdvance(0.05); const b = Math.hypot(...s.vel);
                  if (r0) window._almStripRate = r0; else delete window._almStripRate;
                  return [a, b, _afNearest(_afBodies(_ae.scene), s.pos).alt / AF_TAU_S]; }"""   # (read in the same step: the page's own frames run between two calls, and the key may be up by then)
            )
            pg.keyboard.up("w")
            assert 0.99 < v10 / v1 < 1.01, (v1, v10)
            # And that speed is the one law: its height over the nearest surface covered in AF_TAU_S.
            pg.evaluate("() => _afAdvance(0.05)")
            assert pg.evaluate("() => Math.hypot(..._ae.ship.vel)") == 0, "the key let go, it stops dead"
            assert abs(v10 / alt - 1) < 0.1, (v10, alt)

            # Turning is D and A (the left thumb sideways): the nose follows, the craft stays level (up unchanged) and does not slide.
            v0 = pg.evaluate("() => ({ view: _ae.ship.view.slice(), up: _ae.ship.up.slice(), pos: _ae.ship.pos.slice() })")
            pg.keyboard.down("a")
            pg.evaluate("() => _afAdvance(0.3)")
            pg.keyboard.up("a")
            v1 = pg.evaluate("() => ({ view: _ae.ship.view.slice(), up: _ae.ship.up.slice(), pos: _ae.ship.pos.slice() })")
            dot = sum(a * b for a, b in zip(v0["view"], v1["view"]))
            cr = [v0["view"][1] * v1["view"][2] - v0["view"][2] * v1["view"][1], v0["view"][2] * v1["view"][0] - v0["view"][0] * v1["view"][2], v0["view"][0] * v1["view"][1] - v0["view"][1] * v1["view"][0]]
            assert dot < 0.999 and sum(c * u for c, u in zip(cr, v0["up"])) > 0, dot   # A turns it left (about its up)
            assert sum(a * b for a, b in zip(v0["up"], v1["up"])) > 0.999, "turning does not tilt it"
            assert sum((a - b) ** 2 for a, b in zip(v0["pos"], v1["pos"])) ** 0.5 < 1e-9, "turning in place does not slide it"

            # A flight game's keys. The arrows mirror W S A D: Up and Down fly forward and back, Left and Right turn; no key looks (the mouse does).
            v0 = pg.evaluate("() => ({ view: _ae.ship.view.slice(), pos: _ae.ship.pos.slice() })")
            pg.keyboard.down("ArrowLeft")
            pg.evaluate("() => _afAdvance(0.3)")
            pg.keyboard.up("ArrowLeft")
            assert sum(a * b for a, b in zip(v0["view"], pg.evaluate("() => _ae.ship.view.slice()"))) < 0.999, "the left arrow turns like A"
            p0 = pg.evaluate("() => _ae.ship.pos.slice()")
            pg.keyboard.down("ArrowUp")
            pg.evaluate("() => _afAdvance(0.5)")
            pg.keyboard.up("ArrowUp")
            assert sum((a - b) ** 2 for a, b in zip(p0, pg.evaluate("() => _ae.ship.pos.slice()"))) ** 0.5 > 1e-6, "the up arrow flies forward like W"
            pg.keyboard.down("ArrowDown")
            pg.evaluate("() => _afAdvance(0.5)")
            pg.keyboard.up("ArrowDown")
            # The mouse drags to point the nose, and it stays where it is left: no spring back.
            v0 = pg.evaluate("() => _ae.ship.view.slice()")
            pg.mouse.move(200, 300)
            pg.mouse.down()
            pg.mouse.move(150, 300, steps=4)
            pg.evaluate("() => _afAdvance(0.1)")
            pg.mouse.up()
            v1 = pg.evaluate("() => _ae.ship.view.slice()")
            assert sum(a * b for a, b in zip(v0, v1)) < 0.99, "a drag points the nose"
            pg.evaluate("() => _afAdvance(3)")
            assert sum(a * b for a, b in zip(v1, pg.evaluate("() => _ae.ship.view.slice()"))) > 0.99999, "and it stays where the hand left it"
            # Space is the craft's now (it rises); the view's controls toggle is H.
            lift0 = pg.evaluate("() => _ae.ship.pos.slice()")
            pg.keyboard.down(" ")
            pg.evaluate("() => _afAdvance(0.3)")
            assert pg.evaluate("() => _ae.ship.ask.u") == 1, "Space rises"   # (the view's own show/hide of the controls is H, ui2's)
            pg.keyboard.up(" ")
            pg.keyboard.down("Control")
            pg.evaluate("() => _afAdvance(0.3)")
            assert pg.evaluate("() => _ae.ship.ask.u") == -1, "Ctrl sinks"
            pg.keyboard.up("Control")
            pg.keyboard.down("c")
            pg.evaluate("() => _afAdvance(0.3)")
            assert pg.evaluate("() => _ae.ship.ask.u") == -1, "C sinks too"
            pg.keyboard.up("c")

            # H is the view's, not the ship's (Space is the ship's: jump, hop, rise).
            pg.keyboard.down("h")
            assert pg.evaluate("() => Object.keys(_afKeys).length") == 0
            pg.keyboard.up("h")
            assert pg.evaluate("() => _ae.el.classList.contains('ae-bare')"), "H did not toggle the view's controls"
            pg.keyboard.press("h")

            # The thumbs: a lever each. The left is the throttle: held off its middle the craft goes, lit; let go, it springs back to stop (no lever left standing).
            cdp = ctx.new_cdp_session(pg)

            def touch(kind, pts):
                cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})

            assert pg.evaluate("() => !document.getElementById('af-stick')"), "there is no steering ball"
            thr = pg.evaluate("() => { const r = document.getElementById('af-throttle').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width, r.height]; }")
            assert thr[2] >= 44 and thr[3] >= 150, thr
            touch("touchStart", [(thr[0], thr[1])])
            for d in (10, 30, 50, 60, 60):
                touch("touchMove", [(thr[0], thr[1] - d)])
                pg.wait_for_timeout(60)
            pg.wait_for_function("() => _ae.ship.throttle > 0.5", timeout=5000)
            pg.evaluate("() => _afAdvance(0.2)")
            held = pg.evaluate("() => [Math.hypot(..._ae.ship.vel) > 0, document.getElementById('af-throttle').classList.contains('af-lever-on')]")
            assert held == [True, True], ("held forward, the craft goes and the lever is lit", held)
            assert pg.evaluate("() => [document.getElementById('af-hint').hidden, localStorage.getItem(AF_HINT_KEY)]") == [True, "1"], "the first touch takes the hint away for good"
            touch("touchEnd", [])
            pg.wait_for_function("() => _ae.ship.throttle === 0", timeout=5000)
            pg.evaluate("() => _afAdvance(0.1)")
            # (it stops: nothing moves the craft without a lever, not even close to a world)
            assert pg.evaluate("() => [Math.hypot(..._ae.ship.vel) === 0, document.getElementById('af-throttle').classList.contains('af-lever-on')]") == [True, False], "let go, it springs back and the craft stops"
            # Near its middle it is at stop: a resting thumb does not creep. Down is backwards, and it springs back from there too.
            thr = pg.evaluate("() => { const r = document.getElementById('af-throttle').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width, r.height]; }")   # (where it is now: the hint that stood by it has gone)
            touch("touchStart", [(thr[0], thr[1] + 6)])
            pg.wait_for_timeout(100)
            assert pg.evaluate("() => _ae.ship.throttle") == 0
            touch("touchMove", [(thr[0], thr[1] + 50)])
            pg.wait_for_function("() => _ae.ship.throttle < -0.5", timeout=5000)
            touch("touchEnd", [])
            pg.wait_for_function("() => _ae.ship.throttle === 0", timeout=5000)
            # A world chosen while it cruises: the autopilot takes it, and hands it back with the throttle at stop.
            pg.evaluate("() => { _afThrottleSet(_ae.ship, 0.8); _aeFlyGoTo('moon'); }")
            assert pg.evaluate("() => [_ae.ship.throttle, _ae.ship.auto]") == [0, "moon"]
            pg.evaluate("() => { _ae.ship.auto = null; _afAdvance(0.05); }")
            # The right thumb points the nose and it stays.
            f0 = pg.evaluate("() => _ae.ship.view.slice()")
            touch("touchStart", [(300, 400)])
            for xx in (280, 260, 250, 250):
                touch("touchMove", [(xx, 400)])
                pg.wait_for_timeout(60)
            pg.evaluate("() => _afAdvance(0.1)")
            f1 = pg.evaluate("() => _ae.ship.view.slice()")
            f1_tilt = pg.evaluate("() => { const s = _ae.ship, n = _afOverShip(s, _afBodies(_ae.scene)), a = s.pos.map((v, i) => v - n.body.pos[i]), l = Math.hypot(...a); return s.view.reduce((t, v, i) => t + v * a[i] / l, 0); }")
            assert sum(a * b for a, b in zip(f0, f1)) < 0.99, "a drag points the nose"
            touch("touchEnd", [])
            pg.evaluate("() => _afAdvance(0.1)")   # (the finger is up: the turn it asked for is done)
            TILT = "() => { const s = _ae.ship, n = _afOverShip(s, _afBodies(_ae.scene)), a = s.pos.map((v, i) => v - n.body.pos[i]), l = Math.hypot(...a); return s.view.reduce((t, v, i) => t + v * a[i] / l, 0); }"
            f1_tilt = pg.evaluate(TILT)   # (taken once let go: frames ran between the last move and the lift, and the turn went on till then)
            pg.evaluate("() => _afAdvance(3)")
            # (the nose stays where it was left: over the world it is held to, which a craft very close to one circling it turns with, so the height of the nose over the horizon is what stays)
            tilt = "() => { const s = _ae.ship, n = _afOverShip(s, _afBodies(_ae.scene)), a = s.pos.map((v, i) => v - n.body.pos[i]), l = Math.hypot(...a); return s.view.reduce((t, v, i) => t + v * a[i] / l, 0); }"
            assert abs(pg.evaluate(tilt) - f1_tilt) < 1e-4, "let go, the nose stays"

            # The lift lever (right edge): analog, springs to the middle.
            box = pg.evaluate("() => { const r = document.getElementById('af-lever').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.height]; }")
            touch("touchStart", [(box[0], box[1] - box[2] * 0.3)])
            touch("touchMove", [(box[0], box[1] - box[2] * 0.3)])
            pg.evaluate("() => _afAdvance(0.1)")
            lift = pg.evaluate("() => [_ae.ship.lever, _ae.ship.ask.u, Math.hypot(..._ae.ship.vel)]")
            touch("touchEnd", [])
            assert lift[0] > 0.4 and lift[1] > 0.4 and lift[2] > 0, lift
            pg.evaluate("() => _afAdvance(0.05)")
            assert pg.evaluate("() => _ae.ship.lever") == 0 and pg.evaluate("() => Math.hypot(..._ae.ship.vel)") == 0, "let go, the lever springs to the middle and the craft stops"

            # Roll: keys Q and E roll; with no Level button the craft levels itself when the hand is off it (L still levels at once).
            up0 = pg.evaluate("() => _ae.ship.up.slice()")
            pg.keyboard.down("e")
            pg.evaluate("() => _afAdvance(1)")
            pg.keyboard.up("e")
            rolled = pg.evaluate("() => ({ free: _ae.ship.free, up: _ae.ship.up.slice(), view: _ae.ship.view.slice() })")
            assert rolled["free"] and sum(a * b for a, b in zip(up0, rolled["up"])) < 0.9, "E rolls it"
            pg.evaluate("() => _afAdvance(5)")   # no Level button: a rolled craft puts its horizon back by itself once the hand is off it
            lvl0 = pg.evaluate("() => { const s = _ae.ship, d = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0), c = d(s.ref, s.view), t = s.ref.map((v, i) => v - s.view[i] * c), n = Math.hypot(...t); return { free: s.free, tipped: s.tipped, upTarget: d(s.up, t) / n }; }")
            assert not lvl0["free"] and not lvl0["tipped"] and lvl0["upTarget"] > 0.999, lvl0   # (rolled about the nose: the nose stays on what it pointed at)
            pg.keyboard.press("t")
            assert pg.evaluate("() => _ae.ship.tilt") is False, "there is no Tilt mode"
            # Two fingers twisting on the picture roll it.
            up1 = pg.evaluate("() => _ae.ship.up.slice()")
            touch("touchStart", [(150, 250), (230, 250)])
            for ang in (0.3, 0.6, 0.9):
                import math as _m
                touch("touchMove", [(190 - 40 * _m.cos(ang), 250 - 40 * _m.sin(ang)), (190 + 40 * _m.cos(ang), 250 + 40 * _m.sin(ang))])
                pg.wait_for_timeout(60)
            pg.evaluate("() => _afAdvance(0.1)")
            touch("touchEnd", [])
            assert sum(a * b for a, b in zip(up1, pg.evaluate("() => _ae.ship.up.slice()"))) < 0.95, "a two-finger twist rolls"
            # One tap on Level puts the horizon back: the craft is level to the reference up, its nose flat to it.
            pg.evaluate("_afLevel()")
            pg.evaluate("() => _afAdvance(4)")
            lvl = pg.evaluate("() => { const s = _ae.ship, d = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0); return { free: s.free, upRef: d(s.up, s.ref), nose: d(s.view, s.ref) }; }")
            assert not lvl["free"] and lvl["upRef"] > 0.995 and abs(lvl["nose"]) < 0.1, lvl
            pg.evaluate("() => _ae.el.classList.remove('ae-bare')")   # (until the view's show/hide is H, a Space toggles the chrome too)
            over = pg.evaluate(
                "() => ['#ae-chips button', '#ae-find'].map(q => { const r = document.querySelector(q).getBoundingClientRect();"
                " return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).id !== 'af-layer'; })"
            )
            assert all(over), over

            # Flying is one view: V and the camera button are gone, the model is always drawn from behind.
            pg.keyboard.press("v")
            assert pg.evaluate("() => _ae.ship.cam === undefined && _ae.gl.ufo.root.visible && document.getElementById('ae-cam').hidden")

            # Flown straight at the Moon the craft goes there, to the lowest height over it and no lower (the nose is the hand's: nothing skims it away).
            pg.evaluate(
                "() => { const m = _ae.scene.moon, n = Math.hypot(...m), s = _ae.ship;"
                " s.pos = m.map(x => x * (1 - 4 * AE_MOON_RADIUS_RE / n)); s.view = m.map(x => x / n); s.up = _aeNorm(_aeCross(s.view, [0, 0, 1])); s.free = true; s.vel = [0, 0, 0]; s.auto = null; }"
            )
            pg.evaluate("() => { _ae.infoShift = 150; }")   # the time bar under the picture shifts the view's centre up: the glide does not depend on it
            pg.keyboard.down("Shift")
            pg.keyboard.down("w")
            least = pg.evaluate(
                "() => { let least = 1e9; for (let i = 0; i < 400; i++) { _afAdvance(0.05);"
                " const s = _ae.ship; least = Math.min(least, Math.hypot(...s.pos.map((x, k) => x - _ae.scene.moon[k]))); } return (least - AE_MOON_RADIUS_RE) / AE_MOON_RADIUS_RE; }"
            )
            pg.keyboard.up("w")
            pg.keyboard.up("Shift")
            pg.evaluate("() => { _ae.infoShift = 0; }")
            kept = pg.evaluate("() => _ae.ship.near.alt / _ae.ship.near.body.r")
            assert kept < 1.2, kept   # twenty seconds of boost along the ground and it is still low over it: the view turns with the ground, it does not climb out
            shown = pg.evaluate("() => _ae.ship.shown")
            assert shown["inPicture"] and shown["cover"] >= 0.25, shown   # low over a world, it fills the picture below the craft
            pg.wait_for_timeout(300)
            pg.evaluate("() => _afAdvance(0.1)")
            assert pg.evaluate("() => _ae.target") == "moon", "the row of worlds marks the one it is nearest, not the one it left"
            assert 0 <= least < 0.01, least   # flown at a world it goes where the nose points, down to the lowest height over it (it is stood back on that height, never below it)

            # With Almanac HD loaded for a body that has no ground to come down to, the lowest height is the view's own sharp closest stop there, not a few km; a
            # body with a ground keeps the few km (held at the HD stop, hundreds of km up, the craft never reached where its ground is built).
            floor = pg.evaluate(
                "() => { const m = { key: 'moon', r: AE_MOON_RADIUS_RE }, none = _afFloor(m), g = _ae.gl.hd, was = AE_TARGETS.moon.min, keys = AE_STAND_KEYS.slice();"
                " _ae.gl.hd = { bodies: [{ key: 'moon' }] }; AE_TARGETS.moon.min = AE_MOON_RADIUS_RE + 0.01; const ground = _afFloor(m);"
                " AE_STAND_KEYS.length = 0; const hd = _afFloor(m); keys.forEach(k => AE_STAND_KEYS.push(k));"
                " _ae.gl.hd = g; AE_TARGETS.moon.min = was; return [none, hd, ground]; }"
            )
            assert floor[2] == floor[0], floor
            assert floor[0] < 0.001 and abs(floor[1] - 0.01) < 1e-9, floor

            # Down and up: Ctrl sinks it toward the nearest ground, Space lifts it away, at once.
            pg.evaluate(
                "() => { const m = _ae.scene.moon, n = Math.hypot(...m), s = _ae.ship;"
                " s.pos = m.map(x => x * (1 + 0.5 * AE_MOON_RADIUS_RE / n)); s.up = _aeNorm(_aeSub(s.pos, m)); s.view = _aeNorm(_aeCross(s.up, [0, 0, 1])); s.free = false; s.vel = [0, 0, 0]; s.auto = null; _afAdvance(0.1); }"
            )
            alt0 = pg.evaluate("() => _ae.ship.near.alt")
            pg.keyboard.down(" ")
            pg.evaluate("() => _afAdvance(2)")
            pg.keyboard.up(" ")
            assert pg.evaluate("() => _ae.ship.near.alt") > alt0 * 2

            # A body chosen is where the ship goes, and it stops there and holds still, its card open.
            go = pg.evaluate("() => _aeFlyGoTo('mars')")
            assert go["ok"] and 5 <= go["seconds"] <= 90 and go["distM"] > 1e10, go   # a planet is tens of seconds away, and far in fact
            assert pg.evaluate("() => _aeFlyGoTo('nowhere')")["ok"] is False
            lost = pg.evaluate(
                "() => { const out = []; for (let i = 0; i < 160; i++) { _afAdvance(0.5); const s = _ae.ship; if (!s.auto) break;"
                " if (i >= 6 && !s.shown.inPicture) out.push(['out', i, s.shown.key]);"
                " if (s.near.body.key === s.shown.key && s.near.alt <= s.near.body.r && s.shown.cover < 0.25) out.push(['small', i, s.shown.key, s.shown.cover]); } return out; }"   # (near the world it goes to: leaving another, it may first go round it)
            )
            assert not lost, lost   # a world is in the picture every moment of the flight, and a near one fills a quarter of it
            pg.evaluate("() => _afAdvance(120)")
            state = pg.evaluate("() => ({ arrived: _ae.ship.arrived, auto: _ae.ship.auto, card: _ae.arrived, v: Math.hypot(..._ae.ship.vel) })")
            assert state["arrived"] == "mars" and state["auto"] is None and state["card"] == "mars" and state["v"] == 0, state
            d = pg.evaluate(
                "() => { const b = _ae.gl.planets.mars; return Math.hypot(..._ae.ship.pos.map((x, k) => x - b.pos[k])) / b.b.r; }"
            )
            want = pg.evaluate("() => _afStopAt({ r: 1 })")
            assert abs(d - want) < 0.1 and 5 < want < 15, (d, want)   # where the world spans two thirds of the picture's shorter side (a phone on end: about ten radii out)

            # Turned to face empty space far from everything the nose stays: an arrow points to a world, the craft is not turned to it.
            pg.evaluate(
                "() => { const s = _ae.ship; s.auto = null; s.arrived = null; s.pos = [3000, 3000, 3000]; s.vel = [0, 0, 0];"
                " s.view = [0.57735, 0.57735, 0.57735]; s.up = _aeNorm(_aeCross(_aeCross(s.view, [0, 0, 1]), s.view)); s.blind = 0; s.lookAt = 0; }"
            )
            pg.evaluate("() => _afAdvance(8)")
            assert pg.evaluate("() => { const s = _ae.ship, v = [0.57735, 0.57735, 0.57735]; return s.view[0] * v[0] + s.view[1] * v[1] + s.view[2] * v[2]; }") > 0.9999, "the nose stayed"

            # The Go sheet: a row picked is where the ship goes; past the speed of light the readout says plainly it is only for fun.
            pg.evaluate("() => _aeGoPick('jupiter')")
            assert pg.evaluate("() => _ae.ship.auto") == "jupiter"
            fast = pg.evaluate(
                "() => { for (let i = 0; i < 80; i++) { _afAdvance(1); _ae.ship.hudAt = 0; _aeShipStep(_ae.scene, 0.01);"
                " if (_ae.ship.kmS > SPEED_OF_LIGHT_KM_S) return [document.getElementById('af-note').textContent, _ae.ship.speedText]; } return null; }"
            )
            assert fast and fast[0] and "c" in fast[1], fast   # past light the readout is in c, with a plain line that it is only for fun

            # Any hand on the controls takes the craft back from the autopilot; a world chosen sends it there; the exit gives the camera back.
            pg.keyboard.down("w")
            pg.evaluate("() => _afAdvance(0.2)")
            pg.keyboard.up("w")
            assert pg.evaluate("() => _ae.ship.auto") is None
            assert pg.evaluate("() => !document.getElementById('af-home')"), "no Home button: the chips are the way to a world"
            pg.evaluate("() => _aeFlyGoTo('earth')")
            assert pg.evaluate("() => _ae.ship.auto") == "earth"
            # No boost, and nothing pretends: the picture's field is the view's own at any speed.
            pg.keyboard.down("w")
            pg.evaluate("() => _afAdvance(3)")
            assert pg.evaluate("() => _ae.ship.pose.fov") == pg.evaluate("() => AE_FOV_DEG")
            pg.keyboard.up("w")
            pg.emulate_media(reduced_motion="reduce")
            # A body's high-resolution tiles whose program the GPU will not link stand aside for the body's own map (instead of a body drawn as only its grid).
            bad = pg.evaluate(
                """async () => { const S = _ae.gl, T = S.THREE, g = new T.BufferGeometry();
                  g.setAttribute('position', new T.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
                  const m = new T.Mesh(g, new T.ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }', fragmentShader: 'void main() { gl_FragColor = nonsense; }' }));
                  m.frustumCulled = false; S.scene.add(m); _ae.dirty = true; _aeKick();
                  for (let i = 0; i < 300 && !(S.renderer.properties.get(m.material).currentProgram && S.renderer.properties.get(_ae.ship.craft.body.material).currentProgram); i++) await new Promise(r => setTimeout(r, 100));
                  const out = [_aeHdProgramBad(S, m), _aeHdProgramBad(S, _ae.ship.craft.body)]; S.scene.remove(m); return out; }"""
            )
            assert bad == [True, False], bad

            pg.emulate_media(reduced_motion="no-preference")
            pg.evaluate("document.getElementById('ae-fly-btn').click()")
            assert pg.evaluate("() => _ae.ship") is None
            assert pg.evaluate("() => !!_ae.shipExit && _ae.shipExit.hold"), "leaving holds the picture where it was, not a cut"
            pg.evaluate("() => _aeLetGo()")   # a hand on the view: it eases to the orbit view
            pg.wait_for_function("() => !_ae.shipExit", timeout=60_000, polling=250)
            assert not errors, errors
        finally:
            br.close()


def _fly_open(served, pw):
    br = pw.chromium.launch(args=GL_ARGS)
    ctx = br.new_context(viewport=VIEW, device_scale_factor=1, has_touch=True, is_mobile=True, service_workers="block")
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); sessionStorage.setItem('zimi_almanac_location', %r); } catch (e) {}" % (PLACE, PLACE)
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'", timeout=READY_MS)
    pg.evaluate("openAlmanacEarth({ target: 'earth' })")
    pg.wait_for_function("() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=READY_MS, polling=200)
    pg.evaluate("() => enterFly()")
    pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS)
    return br, pg


def test_fly_keys_are_let_go_under_a_modifier_and_on_focus_loss_and_esc_leaves_sheets_first(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.evaluate("() => { document.activeElement && document.activeElement.blur(); }")
            # W held, Ctrl pressed (the way down), W let go while Ctrl is down: the forward key is not left on.
            pg.keyboard.down("w")
            pg.wait_for_function("() => _afKeys.f === true", timeout=60_000, polling=50)
            pg.keyboard.down("Control")
            pg.keyboard.up("w")
            assert pg.evaluate("() => !_afKeys.f"), "a key let go under Ctrl is let go"
            pg.keyboard.up("Control")
            # A key held as the window loses the focus is let go too.
            pg.keyboard.down("a")
            pg.wait_for_function("() => _afKeys.l === true", timeout=60_000, polling=50)
            pg.evaluate("() => window.dispatchEvent(new Event('blur'))")
            assert pg.evaluate("() => !_afKeys.l")
            pg.keyboard.up("a")
            # A slider that kept the focus (the clock's speed, dragged a moment ago) is not typing: W still flies.
            pg.evaluate("() => { var r = document.createElement('input'); r.type = 'range'; r.id = 'ae-test-range';"
                        " document.body.appendChild(r); r.focus(); }")
            pg.keyboard.down("w")
            pg.wait_for_function("() => _afKeys.f === true", timeout=10_000, polling=50)
            pg.keyboard.up("w")
            pg.evaluate("() => document.getElementById('ae-test-range').remove()")
            # A key event without a key (autofill) is not an error.
            pg.evaluate("() => document.dispatchEvent(new KeyboardEvent('keydown', {}))")
            # An open sheet is put away by Esc first: the flight goes on.
            pg.evaluate("() => _aeWorldShow(true)")
            pg.wait_for_function("() => !document.getElementById('ae-go').hidden", timeout=60_000, polling=100)
            pg.keyboard.press("Escape")
            st = pg.evaluate("() => [!!_ae.ship, document.getElementById('ae-go').hidden]")
            assert st == [True, True], st
            pg.keyboard.press("Escape")
            pg.wait_for_function("() => !_ae.ship", timeout=60_000, polling=100)
            assert not pg.errors, pg.errors
        finally:
            br.close()


def test_the_ship_does_not_start_in_a_view_that_was_left(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.evaluate("() => { _afStop(true); _aeClose(); }")
            pg.wait_for_function("() => !_aeIsOpen", timeout=60_000, polling=100)
            pg.evaluate("() => _afStart()")
            assert pg.evaluate("() => !_ae.ship && !_afOnKey"), "no ship, no key handler swallowing keys, in a closed view"
        finally:
            br.close()


def test_a_worlds_tag_is_its_name_and_how_far_is_the_moves_to_say(served):
    """A world's tag in the picture names it and nothing more (at the picture's edge it points, with the name); how far it is, is told once, by the move's own
    state, in metres (never a time: it was light-time once, read as the time left)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_function("() => !!_ae.ship && !!_ae.ship.craft", timeout=READY_MS)
            pg.wait_for_function("() => Array.from(document.querySelectorAll('#af-refs .af-ref')).some(e => !e.hidden && e.textContent)", timeout=60_000, polling=100)
            texts = pg.evaluate("() => Array.from(document.querySelectorAll('#af-refs .af-ref')).filter(e => !e.hidden).map(e => e.textContent)")
            assert not any(u in t for t in texts for u in (" ms", " sec", " min", " km", " mi", " AU", "\u00b7")), texts
            assert all(len(t) < 14 for t in texts), texts
            pg.wait_for_function("() => !!_ae.move && _ae.move.nearM > 0", timeout=60_000, polling=100)
            assert pg.evaluate("() => !document.querySelector('.af-line') && !document.getElementById('af-speed')"), "the craft draws no readout of its own"
        finally:
            br.close()


def test_flying_down_at_a_world_lands_and_the_lit_button_lifts_off_again(served):
    """The UFO flown at a world with its nose toward the ground comes down to the surface and holds over it; the right lever sets it down (Stand here, no other step); the
    UFO button is lit on the ground and, like Space, lifts off again."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.evaluate("() => _aeStandReady()")
            pg.wait_for_function("() => typeof _aeStBodyNow === 'function' && typeof _aeTerrainLoad === 'function'", timeout=READY_MS, polling=200)
            pg.evaluate(
                "() => { const m = _ae.scene.moon, n = Math.hypot(...m), s = _ae.ship;"
                " s.pos = m.map(x => x * (1 - 1.05 * AE_MOON_RADIUS_RE / n)); s.view = _aeNorm(m); s.up = _aeNorm(_aeCross(s.view, [0, 0, 1])); s.free = true; s.vel = [0, 0, 0]; s.auto = null; }"
            )
            pg.evaluate("() => _aeTerrainLoad('moon')")
            # Flown at the ground on the throttle it comes down to its lowest height and holds there: the throttle never sets the craft down.
            pg.keyboard.down("w")
            pg.evaluate("() => _afAdvance(20)")
            pg.wait_for_timeout(1500)
            pg.evaluate("() => _afAdvance(2)")
            held = pg.evaluate("() => [!!_ae.ship, _ae.shipLanded || null, !!(_ae.stand || _ae.standPending), _ae.ship.near.alt / _ae.ship.near.body.r]")
            assert held[:3] == [True, None, False] and held[3] < 0.01, held
            pg.keyboard.up("w")
            # Setting down is the right lever (its key), held there.
            pg.keyboard.down("c")
            pg.wait_for_function("() => { if (_ae.ship) _afAdvance(0.2); return _ae.shipLanded === 'moon'; }", timeout=GROUND_MS, polling=200)
            pg.keyboard.up("c")
            pg.wait_for_function("() => document.getElementById('ae-fly-btn').getAttribute('aria-label') === _aeT('alm_fly_liftoff')", timeout=20_000, polling=100)   # landed, the lit button offers Lift off, not Leave the UFO
            pg.wait_for_function("() => !_ae.ship && _ae.stand && _ae.stand.live && _ae.stand.mode === 'ground'", timeout=240_000, polling=250)
            btn = pg.evaluate("() => { const b = document.getElementById('ae-fly-btn'); return [b.hidden, b.getAttribute('aria-pressed')]; }")
            assert btn == [False, "true"], btn   # the UFO button is there and lit
            assert pg.evaluate("() => document.getElementById('ae-fly-btn').getBoundingClientRect().width >= 40"), "and shown on the ground"
            pg.keyboard.press(" ")
            pg.wait_for_function("() => !!_ae.ship && !_ae.stand && !_ae.shipLanded", timeout=240_000, polling=250)
            assert not pg.errors, pg.errors
        finally:
            br.close()


CAM_SAMPLER = """() => { window.__dev = []; window.__ref = null; window.__devStop = false;
  function s() { const c = _ae.gl.camera, p = _aeProject([0, 0, 0]);
    const here = { p: c.position.toArray(), q: c.quaternion.toArray(), fov: c.fov, e: p ? [p.x, p.y] : [0, 0] };
    if (window.__ref) { const r = window.__ref; window.__dev.push([Math.hypot(...here.p.map((v, i) => v - r.p[i])) / Math.hypot(...r.p), 1 - Math.abs(here.q.reduce((a, v, i) => a + v * r.q[i], 0)), Math.abs(here.fov - r.fov), Math.hypot(here.e[0] - r.e[0], here.e[1] - r.e[1])]); }
    if (!window.__devStop) requestAnimationFrame(s); }
  const c = _ae.gl.camera, p = _aeProject([0, 0, 0]);
  window.__ref = { p: c.position.toArray(), q: c.quaternion.toArray(), fov: c.fov, e: p ? [p.x, p.y] : [0, 0] };
  requestAnimationFrame(s); }"""


def test_leaving_the_ship_moves_nothing_until_a_hand_touches_the_view(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_timeout(1500)
            pg.evaluate(CAM_SAMPLER)
            pg.evaluate("() => _afStop()")
            pg.wait_for_timeout(2500)   # (the old way out eased for 1.4 s)
            pg.evaluate("() => { window.__devStop = true; }")
            dev = pg.evaluate("() => window.__dev")
            assert len(dev) > 5, dev
            assert max(d[0] for d in dev) < 1e-5 and max(d[1] for d in dev) < 1e-9 and max(d[2] for d in dev) < 1e-6 and max(d[3] for d in dev) < 0.5, ("the picture moved on leaving", [max(d[i] for d in dev) for i in range(4)])
            # A hand on the view lets it go: it ends on the orbit view.
            pg.evaluate("() => _aeZoomBy(1.0001)")
            pg.wait_for_function("() => !_ae.shipExit", timeout=60_000, polling=100)
            assert not pg.errors, pg.errors
        finally:
            br.close()


def test_up_and_down_are_away_from_and_toward_the_world_whatever_the_crafts_tilt(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_timeout(1000)
            out = pg.evaluate(
                """() => { var sh = _ae.ship, b = _afNearest(_afBodies(_ae.scene), sh.pos).body, res = {};
                  var right = _aeNorm(_aeCross(sh.view, sh.up)); _afTurnAtt(sh, right, 0.9); sh.free = true;   // nose well down (or up): the craft's own up is 50 degrees off the radial
                  [['up', 1], ['dn', -1]].forEach(function (k) {
                    var p0 = sh.pos.slice(); _afKeys[k[0]] = true; _afAdvance(0.6); delete _afKeys[k[0]];
                    var d = _aeSub(sh.pos, p0), away = _aeNorm(_aeSub(p0, b.pos)), rad = _aeDot(d, away), tan = _aeLen(_aeSub(d, _aeScale(away, rad)));
                    res[k[0]] = { rad: rad, tan: tan, tilt: _aeDot(sh.up, away) };
                  });
                  return res; }"""
            )
            assert out["up"]["rad"] > 0 and out["up"]["tan"] < 0.02 * out["up"]["rad"], out
            assert out["dn"]["rad"] < 0 and out["dn"]["tan"] < 0.02 * abs(out["dn"]["rad"]), out
            assert out["up"]["tilt"] < 0.9, "the craft really was tilted"
            assert not pg.errors, pg.errors
        finally:
            br.close()


def test_flying_keeps_a_world_in_view_an_arrow_says_where_and_the_nose_stays(served):
    """with nothing in the picture an arrow points the way to the biggest world; the craft is never turned to it (the nose stays where the hand left it)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_timeout(1000)
            pg.evaluate(
                """() => { var s = _ae.ship, u = _aeNorm([0.3, 0.2, 0.93]);
                  s.pos = _aeScale(u, 6); s.view = u; s.up = _aeNorm(_aeCross(_aeCross(u, [0, 0, 1]), u)); s.vel = [0, 0, 0]; s.auto = null; s.arrived = null; s.blind = 0; s.lookAt = 0; s.hold = null; s.release = null; window.__v0 = s.view.slice(); _ae.dirty = true; _aeKick(); }"""
            )   # six Earth radii out, facing straight away from the Earth
            pg.wait_for_function("() => !document.getElementById('af-find').hidden", timeout=30_000, polling=100)
            pg.wait_for_timeout(3500)   # (the old craft turned itself round to the world in about two seconds)
            assert pg.evaluate("() => { var s = _ae.ship, v = window.__v0; return s.view[0] * v[0] + s.view[1] * v[1] + s.view[2] * v[2]; }") > 0.9999, "the nose stayed"
            assert not pg.evaluate("() => document.getElementById('af-find').hidden"), "and the arrow still says where the world is"
            assert not pg.errors, pg.errors
        finally:
            br.close()


def test_the_nose_points_where_the_hand_leaves_it_and_forward_goes_that_way(served):
    """the right thumb (or the mouse) points the nose and it stays: no spring back, no levelling, no skimming along the ground; forward goes where the nose points,
    over a world as in space."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_timeout(1000)
            out = pg.evaluate(
                """() => { var sh = _ae.ship, res = {};
                  // low over the Earth (a quarter of its radius up), nose level; a drag of the right thumb tips it up 45 degrees
                  var u = _aeNorm([0.3, 0.2, 0.93]); sh.pos = _aeScale(u, 1.25); sh.view = _aeNorm(_aeCross(u, [0, 0, 1])); sh.up = u; sh.vel = [0, 0, 0]; sh.hold = null; sh.release = null; sh.auto = null; sh.free = false; sh.leveling = false;
                  var rate = AF_LOOK_DRAG_DEG_PX; sh.look.y = -45 / rate; _afAdvance(0.05);
                  var v1 = sh.view.slice(), tip = Math.asin(Math.max(-1, Math.min(1, v1[0] * u[0] + v1[1] * u[1] + v1[2] * u[2]))) * 180 / Math.PI;
                  _afAdvance(3);   // hands off for three seconds
                  var v2 = sh.view, same = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
                  _afKeys.f = true; var p0 = sh.pos.slice(); _afAdvance(0.4); delete _afKeys.f;
                  var d = _aeNorm(_aeSub(sh.pos, p0)), along = d[0] * sh.view[0] + d[1] * sh.view[1] + d[2] * sh.view[2];
                  return { tip: tip, same: same, along: along, free: sh.free }; }"""
            )
            assert abs(abs(out["tip"]) - 45) < 3, out   # the nose tipped as dragged
            assert out["same"] > 0.99999, ("the nose stayed where it was left (no spring, no levelling)", out)
            assert out["along"] > 0.999, ("forward went where the nose points, low over a world", out)
            assert not pg.errors, pg.errors
        finally:
            br.close()


def test_the_rainbow_lights_travel_round_the_rim(served):
    """the lights' colours and the bright one are moved round the rim by the craft's clock, a lap in a few seconds, both the same way (the shader links: the
    craft is drawn; its colours are a function of the lamp's place minus the clock)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_timeout(1500)
            got = pg.evaluate(
                """() => { var m = _ae.ship.craft.body.material, f = m.fragmentShader, info = _ae.gl.renderer.properties.get(m);
                  return { hue: /hue\(idx \/ 12\.0 - time \* ([\d.]+)\)/.exec(f), chase: /cos\(idx \* 0\.5236 - time \* ([\d.]+)\)/.exec(f), lap: AF_LAP_S, linked: !!info.currentProgram }; }"""
            )
            assert got["linked"] and got["hue"] and got["chase"], got
            assert float(got["hue"][1]) == pytest.approx(1 / got["lap"], rel=0.01), "a lap of colours in the lap time"
            assert float(got["chase"][1]) == pytest.approx(6.2832 / got["lap"], rel=0.01), "the bright light goes round with them"
            assert 1 <= got["lap"] <= 6, "fast enough to be seen to run"
            assert not pg.errors, pg.errors
        finally:
            br.close()


def test_the_craft_is_always_in_the_picture_whatever_is_pressed(served):
    """the UFO vanished sometimes: after the held picture was let go (the first touch) the camera eased from the old look while the craft flew off. Random key
    sequences, tilts and boosts for 300 steps: the craft is finite, upright against its nose, and inside the picture at every step."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_timeout(1000)
            out = pg.evaluate(
                """() => { var sh = _ae.ship, keys = ['f', 'b', 'l', 'r', 'au', 'ad', 'up', 'dn', 'rl', 'rr', 'boost'], bad = [], seed = 12345,
                    rnd = function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
                  for (var it = 0; it < 300; it++) {
                    var n = 1 + Math.floor(rnd() * 3); window._afKeys = {}; for (var k = 0; k < n; k++) _afKeys[keys[Math.floor(rnd() * keys.length)]] = true;
                    
                    _afAdvance(0.2 + rnd() * 0.4); _aeUpdate(_aeDisplayMs()); _ae.gl.camera.updateMatrixWorld(true);
                    var pr = _aeProject(sh.pos), fin = function (v) { return v.every(isFinite); };
                    var ok = fin(sh.pos) && fin(sh.view) && fin(sh.up) && Math.abs(_aeDot(sh.view, sh.up)) < 1e-3 && !!pr && pr.x > -50 && pr.x < _ae.w + 50 && pr.y > -50 && pr.y < _ae.h + 50;
                    if (!ok) bad.push([it, pr && [Math.round(pr.x), Math.round(pr.y)], Object.keys(_afKeys).join('+')]);
                  }
                  window._afKeys = {}; return bad.slice(0, 5); }"""
            )
            assert out == [], out
            assert not pg.errors, pg.errors
        finally:
            br.close()


def test_down_after_the_autopilot_brings_it_to_jupiter_goes_to_jupiter_and_stops_at_its_cloud_tops(served):
    """From the autopilot's stop at Jupiter a moon (Europa) is nearer than Jupiter's cloud tops: the craft took that moon for the world it was over, and pushing down
    dived at the moon, out of the picture. The world it was sent to is the one it is over; down goes to Jupiter and holds at its deck, the craft in the picture."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_function("() => !!_ae.ship && !!_ae.ship.craft", timeout=READY_MS)
            assert pg.evaluate("() => _aeFlyGoTo('jupiter').ok")
            pg.wait_for_function("() => { _afAdvance(2); return !_ae.ship.auto; }", timeout=120_000, polling=100)
            assert pg.evaluate("() => _ae.ship.near.body.key") == "jupiter"
            pg.evaluate("() => { window._afKeys = { dn: true }; _afAdvance(8); window._afKeys = {}; _afAdvance(0.5); }")
            st = pg.evaluate(
                "() => { const sh = _ae.ship; _aeUpdate(_aeDisplayMs()); _ae.gl.camera.updateMatrixWorld(true); const p = _aeProject(sh.pos);"
                " return [sh.near.body.key, sh.near.alt / sh.near.body.r, AF_DECK_SHARE, !!p && p.x > 0 && p.x < _ae.w && p.y > 0 && p.y < _ae.h]; }"
            )
            assert st[0] == "jupiter" and abs(st[1] - st[2]) < 1e-6 and st[3], st
            assert pg.evaluate("() => document.getElementById('af-lever').classList.contains('af-lever-floor')"), "at the cloud tops the lever's way down is dimmed: no ground under them"
            assert not pg.errors, pg.errors
        finally:
            br.close()


def test_a_far_world_ahead_is_named_and_a_moon_only_beside_its_planet(served):
    """Heading for Jupiter on the throttle it was an unnamed point: the few worlds nearest the middle of the picture are named at any distance, besides the one
    it goes to and the Sun. A moon is named only beside its own planet (from the Earth, Jupiter is the name, not Ganymede)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_function("() => !!_ae.ship && !!_ae.ship.craft", timeout=READY_MS)
            pg.evaluate(
                "() => { const s = _ae.ship, j = _afBody(_afBodies(_ae.scene), 'jupiter'); _afRelease(s); s.free = true; s.view = _aeNorm(_aeSub(j.pos, s.pos));"
                " s.up = _aeNorm(_aeCross(_aeCross(s.view, [0, 0, 1]), s.view)); window._afKeys = { f: true }; _afAdvance(1); window._afKeys = {}; }"
            )
            pg.wait_for_timeout(600)
            tags = pg.evaluate("() => Array.from(document.querySelectorAll('#af-refs .af-ref')).filter(e => !e.hidden).map(e => e.textContent.replace(/^\\S+ /, '') || (e.getAttribute('aria-label') || '').split(': ').pop())")
            assert _name(pg, "jupiter") in tags, tags
            assert not any(_name(pg, m) in tags for m in ("io", "europa", "ganymede", "callisto")), tags
            assert not pg.errors, pg.errors
        finally:
            br.close()


def _name(pg, key):
    return pg.evaluate("k => _aeGoName(k)", key)


def test_a_tapped_worlds_name_flies_there_keys_move_the_levers_and_far_reads_in_words(served):
    """"If I click a direction pill (i.e. in UFO, sun backwards) that's me taking the hint, go." A world's tag is a button: a tap starts the
    autopilot to it. "If I'm using WASD for my UFO then show the throttle move with me": W takes the throttle's knob to full ahead, and it comes back on
    letting go. "No 1,547,315 mi": a far distance reads in words, a near one exactly. Low over Uranus its limb is drawn from the fine sphere (no corner)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _fly_open(served, pw)
        try:
            pg.wait_for_function("() => !!_ae.ship && !!_ae.ship.craft", timeout=READY_MS)
            pg.wait_for_function("() => Array.from(document.querySelectorAll('#af-refs .af-ref')).some(e => !e.hidden && e.dataset.key)", timeout=60_000, polling=100)
            key = pg.evaluate("() => Array.from(document.querySelectorAll('#af-refs .af-ref')).filter(e => !e.hidden && e.dataset.key)[0].dataset.key")
            at = pg.evaluate("(k) => { var q = document.querySelector(\"#af-refs .af-ref[data-key='\" + k + \"']\").getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; }", key)
            pg.mouse.click(at[0], at[1])   # (the tags take no pointer: the tap is the view's, which hands it to the tag under it)
            assert pg.evaluate("() => _ae.ship.auto") == key
            # The keys and the levers.
            knob = "() => getComputedStyle(document.querySelector('#af-throttle i')).transform"
            rest = pg.evaluate(knob)
            pg.keyboard.down("w")
            # (a frame can take a few hundred ms in software GL after a tap: wait for the lever, not a fixed time)
            pg.wait_for_function("() => document.getElementById('af-throttle').getAttribute('aria-valuenow') === '1.00'", timeout=10_000, polling=50)
            held = pg.evaluate("() => [document.getElementById('af-throttle').getAttribute('aria-valuenow'), document.getElementById('af-throttle').classList.contains('af-lever-on')]")
            pg.keyboard.up("w")
            pg.wait_for_function("(r) => getComputedStyle(document.querySelector('#af-throttle i')).transform === r", arg=rest, timeout=10_000, polling=50)
            assert held == ["1.00", True], held
            assert pg.evaluate(knob) == rest
            # Readable distances, in either unit.
            texts = pg.evaluate("() => [2.49e6, 152000, 9500].map(km => _aeLenRead(km))")
            assert "million" in texts[0] and "," not in texts[0].split(" ")[0], texts
            assert texts[1].replace(",", "").startswith("150000") or texts[1].replace(",", "").startswith("94000"), texts
            # Low over Uranus: the fine sphere.
            assert pg.evaluate("() => _aeFlyGoTo('uranus').ok")
            pg.wait_for_function("() => { _afAdvance(2); return !_ae.ship.auto; }", timeout=120_000, polling=100)
            pg.evaluate("() => { window._afKeys = { dn: true }; _afAdvance(8); window._afKeys = {}; _afAdvance(0.5); }")
            pg.wait_for_function("() => !!_ae.gl.planetFine && _ae.gl.planetFine.p.b.key === 'uranus'", timeout=30_000, polling=200)
            assert not pg.errors, pg.errors
        finally:
            br.close()
