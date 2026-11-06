"""Read aloud getting ready shows a turning ring, from the first moment.

The 1.15.2 proof caught the bar showing three still, dimmed bars (they read as
pulsing dots) while the voice got ready: the ring was held back 700 ms for
every wait, including the first, which is a real wait. Before the first
sound the ring now turns at once (a pulse under Reduce Motion); between
sentences the bars still hold still, as Eric asked ("seamless").
Chromium and WebKit, on the real page.
"""

import os
import sys

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_phone_polish_live import PHONE, zimi  # noqa: E402,F401  (the server fixture)

STATE = """(heard) => {
  _ttsSpeaking = true;
  _ttsNow = { at: 0, engine: 'device', playing: false, spin: false, heard: heard, lang: 'en', ahead: 0 };
  _ttsHold();
  const el = document.querySelector('#tts-bar .tts-bar-state');
  return [el.className, getComputedStyle(el).animationName];
}"""


@pytest.mark.parametrize("engine", ["chromium", "webkit"])
@pytest.mark.parametrize("motion", ["no-preference", "reduce"])
def test_the_first_wait_turns_the_ring_at_once(zimi, engine, motion):
    with sync_playwright() as p:
        try:
            b = getattr(p, engine).launch()
        except Exception as e:  # the browser is not installed here
            pytest.skip("%s unavailable: %s" % (engine, str(e).splitlines()[0]))
        try:
            opts = dict(PHONE, reduced_motion=motion)
            if engine == "webkit":
                opts.pop("is_mobile", None)
            pg = b.new_context(**opts).new_page()
            pg.goto(zimi + "/?a=survival_en_test%2FA%2FFire", wait_until="load")
            pg.wait_for_function("() => typeof readerOpen !== 'undefined' && readerOpen", timeout=30000)
            assert pg.evaluate("() => _ttsLoad()"), "readaloud.js did not load"
            cls, anim = pg.evaluate(STATE, False)
            assert "hold" not in cls.split(), cls
            assert anim == ("tts-pulse" if motion == "reduce" else "spin"), (cls, anim)
            # After the first sound, a pause between sentences holds still.
            cls, anim = pg.evaluate(STATE, True)
            assert "hold" in cls.split(), cls
            pg.evaluate("() => { _ttsSpeaking = false; clearTimeout(_ttsSpinTimer); }")
        finally:
            b.close()
