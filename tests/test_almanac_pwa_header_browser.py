"""The Almanac's own header (the big date) paints below Zimi's top bar when the
app is installed and the Almanac opens from a page that had slid the top bar
away.

Reading an article on a phone slides Zimi's header up (app.js _chromeScroll,
body.chrome-away). Since "The header steps aside only while reading"
(ab32dc35) nothing in the Almanac scrolls it back, so opening the Almanac from
there kept the Almanac pinned to the top of the screen, its date under the
bar. Opening the Almanac now puts the header back (_chromeReset).

Emulated: an iPhone-sized touch viewport, display-mode: standalone and
navigator.standalone (an installed home-screen app).

Run: pytest tests/test_almanac_pwa_header_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_live_sky_browser import GL_ARGS, browser, served  # noqa: F401

STANDALONE = """
(() => {
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => /display-mode\\s*:\\s*standalone/.test(q)
    ? Object.assign(mm('all'), { matches: true, media: q }) : mm(q);
  Object.defineProperty(navigator, 'standalone', { value: true });
})();
"""
GEOMETRY = """() => {
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  return { bar: r('.topbar').bottom, view: r('#almanac-view').top, date: r('#almanac-head-date').top,
           away: document.body.classList.contains('chrome-away') };
}"""


def _open_almanac_after(browser, served, prelude):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(STANDALONE)
    pg = ctx.new_page()
    pg.goto(served + "/", wait_until="load")
    pg.wait_for_function("() => typeof openAlmanac === 'function'", timeout=30000)
    pg.evaluate(prelude)
    pg.evaluate("() => openAlmanac()")
    pg.wait_for_selector("#almanac-head-date", timeout=30000)
    pg.wait_for_timeout(1500)
    return ctx, pg


@pytest.mark.parametrize(
    "prelude",
    [
        "() => {}",
        "() => _setChromeAway(true)",  # an article was scrolled, the header slid away
        "() => _chromeImmersive(true)",  # a video or a book held it away
    ],
    ids=["fresh", "after a scrolled article", "after a held header"],
)
def test_the_almanac_header_clears_the_top_bar(browser, served, prelude):
    ctx, pg = _open_almanac_after(browser, served, prelude)
    try:
        g = pg.evaluate(GEOMETRY)
        for _ in range(40):   # the view slides down as the header comes back (a 0.2 s transition)
            if g["view"] >= g["bar"] - 0.5 or g["away"]:
                break
            pg.wait_for_timeout(250)
            g = pg.evaluate(GEOMETRY)
        assert not g["away"], g
        assert g["view"] >= g["bar"] - 0.5, g  # the Almanac starts under the bar
        assert g["date"] >= g["bar"] - 0.5, g  # and its date is not behind it
    finally:
        ctx.close()
