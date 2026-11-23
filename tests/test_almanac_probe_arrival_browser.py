"""Arriving at a far craft is steady: its name keeps its side and its ring and dot fade rather than pop ("On Kepler there's some odd flashes getting there and the label flaps left and right of the dot").

On arrival the camera is centred on the craft, so its dot sits on the screen's middle and "hang toward the middle" picked a
side by which pixel it was on. The ring of the flight also popped on and off as the camera swung past the screen's edge, and
the dot and name popped in the frame the ring let go.

In headless Chromium at a phone's size.

Run: pytest tests/test_almanac_probe_arrival_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

SLOW_FRAME_MS = 150
FRAMES ="""(k) => new Promise(res => { var out = [], n = 0;
  function f() { var el = document.getElementById('ae-bm-' + k);
    out.push({ t: performance.now(), fly: !!_ae.fly, shown: !!el && !el.hidden, op: el ? parseFloat(el.style.opacity || '0') : 0,
      ringed: !!el && el.classList.contains('ae-bm-ringed'), left: !!el && el.classList.contains('ae-bm-l') });
    if (++n < 1500 && (_ae.fly || n < 120)) requestAnimationFrame(f); else res(out); }
  requestAnimationFrame(f); })"""


def test_the_name_keeps_its_side_while_the_mark_sits_on_the_middle(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            seq = pg.evaluate(
                """() => { var el = document.createElement('div'), h = _ae.w / 2, out = [];
                  [h + 3, h - 3, h + 2, h - 30, h - 3, h + 3, h - 50, h - 3, h + 3, h + 50].forEach(x => out.push(_aeNameOutLeft(el, x)));
                  return out; }"""
            )
            # starts right of the middle, holds through the wobble, flips only once well left, and the same back
            assert seq == [True, True, True, True, True, True, False, False, False, True], seq
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


@pytest.mark.parametrize("target", ["gaia", "juice", "spitzer"])   # far craft that stay dots (Kepler now arrives on its model)
def test_a_flight_to_a_far_craft_does_not_flash_or_flap(served, target):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            pg.wait_for_function(
                "() => { _aeTracksLoad(); return !!_aeTracks && !!_aeProbePos.%s; }" % target,
                timeout=60_000,
                polling=200,
            )
            pg.evaluate("() => _aePreset('%s')" % target)
            rows = pg.evaluate(FRAMES, target)
            # the name's side changes at most once after the flight (it used to toggle every few frames on the middle)
            tail = [r["left"] for r in rows if r["shown"] and not r["ringed"]]
            flips = sum(1 for a, b in zip(tail, tail[1:]) if a != b)
            assert flips <= 1, (target, flips)
            # a ring never pops: a frame that hides it follows one it was already nearly gone in
            # (the fade runs on the clock, so two frames seconds apart on a software renderer are one step of it, not a pop)
            for a, b in zip(rows, rows[1:]):
                if b["t"] - a["t"] > SLOW_FRAME_MS:
                    continue
                if a["shown"] and not b["shown"] and a["ringed"]:
                    assert a["op"] < 0.5, (target, a)
                if a["shown"] and b["shown"] and a["ringed"] and b["ringed"]:
                    assert abs(a["op"] - b["op"]) < 0.5, (target, a, b)
            # the name and dot take over from the ring without a jump
            first = [r for r in rows if r["shown"] and not r["ringed"] and not r["fly"]]
            assert first and first[0]["op"] < 0.6, (target, first[:2])
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
