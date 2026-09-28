"""Where you were (1.12), written only when you move: Zimipedia keeps a
place per article read, and wrote it every two seconds while an article
was on screen, a nudge of the page enough. Now it writes when you reach
another section or move a step on within one, so an article read does
not rewrite the store (nor push another app's places out) all the while.

The fixture and helpers are Zimipedia's own (tests/test_wiki_reader.py).

Run: pytest tests/test_saved_places_live.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_wiki_reader import _boot, _from_zimipedia, _q, served  # noqa: E402,F401

COUNT = "() => { window.__places = 0; var f = Saved.setPosition; Saved.setPosition = function () { __places++; return f.apply(Saved, arguments); }; }"
PLACE_MS = 2300  # a little over Zimipedia's two seconds between writes


def test_zimipedia_writes_a_place_only_when_you_move(served):  # noqa: F811
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        pg = ctx.new_page()
        fr = pg.frame_locator("#reader-frame")
        try:
            _boot(pg, served)
            _from_zimipedia(pg, "wikipedia", "Albert_Einstein")
            pg.evaluate(COUNT)
            fr.locator(".zw-cbtn").click()
            pg.wait_for_timeout(300)
            fr.locator('.zw-toc-sheet button[data-k="2"]').click()
            pg.wait_for_timeout(PLACE_MS)
            _q(pg, "w.scrollBy(0, 1)")
            pg.wait_for_timeout(PLACE_MS)
            first = pg.evaluate("() => __places")
            where = pg.evaluate(
                "() => Saved.position({ zim: 'wikipedia', path: 'Albert_Einstein' }).where"
            )
            assert first >= 1 and where["s"] == "Relativity", (first, where)
            # Reading on in the same few lines: nothing written.
            for _ in range(3):
                _q(pg, "w.scrollBy(0, 3)")
                pg.wait_for_timeout(PLACE_MS)
            assert pg.evaluate("() => __places") == first, "a nudge wrote the place"
            # Another section: written.
            _q(
                pg,
                "w.scrollTo(0, w.scrollY + d.getElementById('Legacy').getBoundingClientRect().top)",
            )
            pg.wait_for_timeout(PLACE_MS)
            _q(pg, "w.scrollBy(0, 1)")
            pg.wait_for_timeout(PLACE_MS)
            assert pg.evaluate("() => __places") == first + 1
            assert (
                pg.evaluate(
                    "() => Saved.position({ zim: 'wikipedia', path: 'Albert_Einstein' }).where.s"
                )
                == "Legacy"
            )
        finally:
            br.close()
