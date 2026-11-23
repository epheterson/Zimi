"""Zooming on in at the closest stop goes on down to the ground ("I should be able to keep scrolling and smoothly go down to the
surface same as if I was in the UFO heading toward"), and a crash with a place is marked where it happened.

Run: pytest tests/test_almanac_pushin_browser.py -v   (on the Mac mini: btm ... runhw6.py)
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_almanac_padview_browser import GL_ARGS, READY_MS, _page, served  # noqa: E402,F401


def test_zooming_on_at_the_moons_stop_lands_and_zooming_out_starts_the_count_again(served):  # noqa: F811
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            pg = _page(br, served, errors=errors)
            pg.evaluate("() => _aePreset('moon')")
            pg.wait_for_function("() => !_ae.fly && _ae.target === 'moon'", timeout=READY_MS, polling=200)
            stop = "() => { _ae.dist = AE_TARGETS.moon.min; _ae.dirty = true; _aeKick(); return _ae.atStop; }"
            pg.wait_for_function(stop, timeout=30_000, polling=200)
            # Out once between: the count starts again, nothing lands.
            pg.evaluate("() => { _aeZoomBy(0.85); _aeZoomBy(0.85); _aeZoomBy(1.2); }")
            assert pg.evaluate("() => !_ae.stand && !_ae.standPending && !_ae.pushIn")
            pg.wait_for_function(stop, timeout=30_000, polling=200)
            pg.evaluate("() => { for (var i = 0; i < 4; i++) _aeZoomBy(0.85); }")
            pg.wait_for_function("() => !!(_ae.stand || _ae.standPending)", timeout=60_000, polling=200)
            # A crash with a place: Sent's row is drawn as a site's dot where it came down.
            pg.evaluate("() => { if (_ae.stand && typeof _aeStandLeave === 'function') _aeStandLeave(); _aeSentStart(); }")
            pg.wait_for_function("() => !!_aeSent && _aeSent.objects.length > 0", timeout=60_000)
            pg.evaluate("() => _aeSentPick('sent:hakutor1')")
            pg.wait_for_function("() => !!_ae.sent && !!_ae.sent.spot && !_ae.fly", timeout=60_000, polling=200)
            pg.wait_for_function("() => { _ae.dirty = true; _aeKick(); return Array.from(document.querySelectorAll('#ae-lms .ae-lm')).some(e => !e.hidden && /Hakuto/.test(e.textContent)); }", timeout=30_000, polling=200)
            assert errors == [], errors
        finally:
            br.close()
