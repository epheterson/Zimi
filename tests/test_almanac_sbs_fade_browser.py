"""Side by side opens and closes as a 300 ms cross-fade, not a cut: a copy of the last picture of the one layout fades away over the first of the other.

Sampled in the page on every frame: the copy's own opacity (the picture under it changes at once, so what is blended is the copy). On the old code there is no
copy at all and the layout changes between two frames. Reduced motion keeps the cut; open and shut inside 100 ms ends clean (no copy left, the right layout).

Run: ZIMI_TEST_BROWSERS=4 pytest tests/test_almanac_sbs_fade_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_planets_browser import served  # noqa: E402,F401  (a fixture)
from test_almanac_worlds_browser import _settled, _to, page  # noqa: E402,F401  (a fixture)

FADE_MS = 300
STEP_CAP_MS = 50   # AE_XFADE_MAX_STEP_MS: the longest a single frame counts toward the fade

# Start `change` and record, on each frame for `span` ms, the opacity of the copies laid over the canvas.
SAMPLE_JS = """([change, span]) => new Promise(done => {
  const t0 = performance.now(), rows = [];
  // The span and the wait are counted in frames (a frame is at most STEP_CAP_MS), like the fade itself: on a slow renderer one frame can be seconds.
  let clock = 0, prev = null;
  window._sbsStill = null;
  eval(change);
  const tick = () => {
    const t = performance.now() - t0;
    clock += Math.min(t - (prev === null ? 0 : prev), STEP_CAP);
    prev = t;
    const els = Array.from(document.querySelectorAll('.ae-stand-still'));
    if (els[0] && !window._sbsStill) {
      const c = els[0], px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0; for (let i = 0; i < px.length; i += 4 * 97) if (px[i] + px[i + 1] + px[i + 2] > 30) lit++;
      window._sbsStill = { lit };
    }
    rows.push([t, els.length ? Math.max(...els.map(e => +getComputedStyle(e).opacity)) : null]);
    if (clock < span || (els.length && clock < span + 4000)) requestAnimationFrame(tick); else done({ rows, spin: !!_ae.spin, preset: _ae.preset, still: window._sbsStill, left: els.length });
  };
  requestAnimationFrame(tick);
})""".replace("STEP_CAP", str(STEP_CAP_MS))


def _fade(rows):
    """(first opacity, the steps seen strictly between, when it went) from the frames' rows."""
    seen = [(t, o) for t, o in rows if o is not None]
    mid = [o for _, o in seen if 0.05 < o < 0.95]
    # The fade counts a long frame (a scene built, on a slow renderer) as at most STEP_CAP_MS, so time it the same way.
    gone, clock, last = None, 0, 0
    for t, o in rows:
        clock += min(t - last, STEP_CAP_MS)
        last = t
        if o is None and t > 50:
            gone = clock
            break
    return seen[0][1] if seen else None, mid, gone


def _wait_clean(pg):
    pg.wait_for_function("() => !document.querySelector('.ae-stand-still')", timeout=5000)


@pytest.mark.local_gate
@pytest.mark.parametrize("opening", [True, False])
def test_the_grid_crossfades_both_ways(page, opening):
    _to(page, "earth")
    _wait_clean(page)
    if not opening:
        _to(page, "spin")
        page.wait_for_function("() => !!_ae.spin && !!_ae.gl.spin", timeout=120_000)
        _wait_clean(page)
    got = page.evaluate(SAMPLE_JS, ["_aePreset(%r)" % ("spin" if opening else "earth"), 700])
    first, mid, gone = _fade(got["rows"])
    assert got["spin"] == opening, got
    assert first is not None and first > 0.8, "no copy of the last picture over the new layout: %r" % got["rows"][:8]
    assert len(mid) >= 3, "the blend has no in-between frames: %r" % got["rows"]
    assert gone is not None and FADE_MS - 80 <= gone <= FADE_MS + 250, "the copy went at %r ms" % gone
    assert got["still"] and got["still"]["lit"] > 0, "the copy is a blank picture"
    assert got["left"] == 0, got
    assert not page.errors, page.errors


@pytest.mark.local_gate
def test_a_task_longer_than_the_backstop_still_blends(page):
    """A scene built in one long task (software GL on a runner: seconds) leaves the frames queued behind the copy's backstop timer;
    the blend must still be seen, not cut when the timer runs first."""
    _to(page, "earth")
    _wait_clean(page)
    block = "(() => { _aePreset('spin'); const e = performance.now() + 1700; while (performance.now() < e); })()"
    got = page.evaluate(SAMPLE_JS, [block, 700])
    first, mid, gone = _fade(got["rows"])
    assert got["spin"] is True, got
    assert first is not None and first > 0.8, got["rows"][:8]
    assert len(mid) >= 3, "the blend has no in-between frames: %r" % got["rows"]
    assert got["left"] == 0, got


def test_open_and_shut_inside_100ms_ends_clean(page):
    _to(page, "earth")
    _wait_clean(page)
    got = page.evaluate(
        SAMPLE_JS.replace("eval(change);", "eval(change); setTimeout(() => _aePreset('earth'), 60);"),
        ["_aePreset('spin')", 800],
    )
    assert got["spin"] is False and got["preset"] == "earth", got
    assert got["left"] == 0, got
    assert page.evaluate("() => getComputedStyle(document.getElementById('ae-canvas')).opacity") == "1"
    assert not page.errors, page.errors


def test_reduced_motion_keeps_the_cut(page):
    _to(page, "earth")
    _wait_clean(page)
    page.emulate_media(reduced_motion="reduce")
    try:
        got = page.evaluate(SAMPLE_JS, ["_aePreset('spin')", 500])
        assert got["spin"] is True and all(o is None for _, o in got["rows"]), got["rows"]
        got = page.evaluate(SAMPLE_JS, ["_aePreset('earth')", 500])
        assert got["spin"] is False and all(o is None for _, o in got["rows"]), got["rows"]
    finally:
        page.emulate_media(reduced_motion="no-preference")
