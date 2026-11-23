"""and, the UFO up: the surface/space button moves the craft (down to the nearest world from high up, back up from its surface), and a world's ring shows only
while the world is far off, never round one that fills the picture.

Run: pytest tests/test_almanac_ufo_rim_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_debug3d_browser import _open  # noqa: E402
from test_almanac_fly_browser import READY_MS, served  # noqa: E402,F401

PUT = """([key, radii]) => { const sh = _ae.ship, b = _afBody(_afBodies(_ae.scene), key), d = [0, 1, 2].map(i => sh.pos[i] - b.pos[i]), l = Math.hypot(...d);
  sh.hold = null; sh.auto = null; sh.dive = null; sh.rise = null; sh.pos = [0, 1, 2].map(i => b.pos[i] + d[i] / l * b.r * (1 + radii)); }"""
ALT = "(key) => { const b = _afBody(_afBodies(_ae.scene), key); return _afAt(b, _ae.ship.pos).alt / b.r; }"


def _fly_at(pg, key):
    pg.evaluate(f"_aePreset('{key}')")
    pg.wait_for_function(
        f"() => !_ae.fly && _ae.target === '{key}'", timeout=READY_MS, polling=500
    )
    pg.evaluate("document.getElementById('ae-fly-btn').click()")
    pg.wait_for_function("() => !!_ae.ship", timeout=READY_MS, polling=500)


def test_the_rim_button_takes_the_ufo_down_then_up(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            _fly_at(pg, "mars")
            pg.evaluate(PUT, ["mars", 3])
            st = pg.evaluate(
                "() => { const s = _aeRimState(); return s && { label: s.label, kind: s.kind }; }"
            )
            assert st and st["label"] == pg.evaluate("_aeT('alm_fly_down')"), (
                "high up the button goes down",
                st,
            )
            pg.evaluate("() => _aeRimState().run()")
            assert pg.evaluate(
                "() => _ae.ship.dive || _ae.ship.auto"
            ), "the button sets the craft going down"
            pg.evaluate(PUT, ["mars", 0.0001])
            st = pg.evaluate("() => { const s = _aeRimState(); return s && s.label; }")
            assert st == pg.evaluate("_aeT('alm_fly_up')"), (
                "at the surface the button goes up",
                st,
            )
            pg.evaluate("() => _aeRimState().run()")
            before = pg.evaluate(ALT, "mars")
            pg.evaluate("() => _afAdvance(4)")
            assert pg.evaluate(ALT, "mars") > before * 5, "the way up climbs"
        finally:
            br.close()


def test_a_ring_only_while_the_world_is_far(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            _fly_at(pg, "mars")
            pg.evaluate(
                """() => { const sh = _ae.ship; sh.hold = null; _ae.dirty = true; }"""
            )
            discs = pg.evaluate(
                "() => { const bs = _afBodies(_ae.scene); return ['mars', 'jupiter', 'saturn'].map(k => [k, _afDiscR(_afBody(bs, k))]); }"
            )
            assert all(d > 0 for _, d in discs), discs
            # up close the world is the whole picture: no ring may be drawn for it
            pg.evaluate(PUT, ["mars", 2])
            pg.evaluate(
                "() => { const sh = _ae.ship, b = _afBody(_afBodies(_ae.scene), 'mars'); sh.auto = 'mars'; sh.view = _aeNorm(_aeSub(b.pos, sh.pos)); }"
            )
            pg.wait_for_timeout(1200)
            rings = pg.evaluate(
                "() => [...document.querySelectorAll('#af-refs .af-ref')].filter(e => !e.hidden && e.classList.contains('af-ring')).map(e => e.dataset.key)"
            )
            disc = pg.evaluate("() => _afDiscR(_afBody(_afBodies(_ae.scene), 'mars'))")
            assert disc > 60 and "mars" not in rings, (
                "near, the world fills the picture and has no ring",
                disc,
                rings,
            )
        finally:
            br.close()


def test_shots_for_a_viewer(served):
    """Frames for a viewer subagent (UFO_SHOTS=<dir>): far toward a goal (ring), near it (no ring), and the craft hugging a world's floor under throttle."""
    import pytest

    out = os.environ.get("UFO_SHOTS")
    if not out:
        pytest.skip("UFO_SHOTS not set")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            _fly_at(pg, "mars")
            pg.evaluate(PUT, ["mars", 12])
            pg.evaluate(
                "() => { const sh = _ae.ship, j = _afBody(_afBodies(_ae.scene), 'jupiter'); sh.free = true; sh.view = _aeNorm(_aeSub(j.pos, sh.pos)); sh.auto = 'jupiter'; _ae.dirty = true; }"
            )
            pg.wait_for_timeout(2500)
            pg.screenshot(path=os.path.join(out, "far.png"))
            pg.evaluate(PUT, ["mars", 2])
            pg.evaluate(
                "() => { const sh = _ae.ship, b = _afBody(_afBodies(_ae.scene), 'mars'); sh.auto = 'mars'; sh.view = _aeNorm(_aeSub(b.pos, sh.pos)); }"
            )
            pg.wait_for_timeout(1500)
            pg.screenshot(path=os.path.join(out, "near.png"))
            pg.evaluate(PUT, ["mars", 0.0001])
            pg.evaluate("() => { const sh = _ae.ship; sh.hold = null; sh.ask = { f: 1, t: 0, u: 0 }; _ae.ship.throttle = 1; }")
            for i in range(4):
                pg.wait_for_timeout(700)
                pg.screenshot(path=os.path.join(out, "hug%d.png" % i))
            pg.evaluate("() => { _ae.ship.throttle = 0; }")
        finally:
            br.close()


def test_the_surface_button_turns_the_ufo_on_and_says_nothing(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, served, "")
        try:
            pg.evaluate("_aePreset('jupiter')")
            pg.wait_for_function(
                "() => !_ae.fly && _ae.target === 'jupiter'",
                timeout=READY_MS,
                polling=500,
            )
            assert not pg.evaluate("() => !!_ae.ship"), "no UFO yet"
            st = pg.evaluate(
                "() => { const s = _aeRimState(); return s && { label: s.label, kind: s.kind }; }"
            )
            assert st and st["label"] == pg.evaluate("_aeT('alm_fly_down')"), st
            pg.evaluate("() => _aeRimState().run()")
            pg.wait_for_function("() => !!_ae.ship && !!_ae.ship.dive", timeout=READY_MS, polling=500)
            pg.evaluate("() => _afAdvance(60)")
            said = pg.evaluate(
                "() => { const h = document.getElementById('ae-hint'); return h && !h.hidden ? h.textContent : ''; }"
            )
            assert "ground" not in said.lower() and "cloud tops" not in said.lower(), ("no line about ground", said)
        finally:
            br.close()
