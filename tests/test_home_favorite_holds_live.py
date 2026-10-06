"""A star on home leaves the tapped card where it was.

Eric, on his iPhone: "When I favorite or unfavorite on home everything
bounces." Starring a card adds it to Favorites, above every other section,
and the re-render pushed the tapped card down by a whole Favorites row
(unstarring pulled it up again). The card stays under the finger now.

Run: pytest tests/test_home_favorite_holds_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HOME = "() => typeof mode !== 'undefined' && mode === 'home' && !!document.querySelector('.stats-grid')"
# The tapped card's own section is never Favorites here: the last copy on the
# page is the one in its category.
CARD_TOP = """(z) => { var c = document.querySelectorAll('.stat-card[data-zim="' + z + '"]');
  return c[c.length - 1].getBoundingClientRect().top; }"""
FAV_COUNT = "() => ((collectionsCache && collectionsCache.favorites) || []).length"
# How far the card may move: none, give or take a pixel of rounding.
TOLERANCE_PX = 3


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim, build_wiki_fixture_zim

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_wiki_fixture_zim(str(zdir / "wiki.zim"))
    build_fixture_zim(str(zdir / "water.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def test_star_and_unstar_hold_the_card(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(**p.devices["iPhone 13"])
        pg = ctx.new_page()
        pg.goto(served + "/")
        pg.wait_for_function(HOME, timeout=15000)
        # Home draws again as Discover and the counts arrive; star a settled page.
        pg.wait_for_load_state("networkidle")
        pg.wait_for_timeout(500)
        # Room to scroll either way, so a held position is always reachable.
        pg.evaluate("document.body.style.minHeight = '4000px'")
        for want in (1, 0):
            # Mid-screen, and tapped where it is: a locator click scrolls on
            # its own whenever the hit test is unsure, which is not a finger.
            pg.evaluate("(z) => window.scrollBy(0, (" + CARD_TOP + ")(z) - 300)", "water")
            before = pg.evaluate(CARD_TOP, "water")
            star = pg.locator('.stat-card[data-zim="water"]').last.locator(".star-btn")
            box = star.bounding_box()
            pg.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            pg.wait_for_function(FAV_COUNT + " === %d" % want, timeout=5000)
            pg.wait_for_timeout(200)
            after = pg.evaluate(CARD_TOP, "water")
            assert abs(after - before) <= TOLERANCE_PX, (want, before, after)
        br.close()
