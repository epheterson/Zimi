"""An app waiting for its first answer shows cards in its own place from the start, keeps them until the content
is there, says so plainly if it takes long, and offers Try again if it fails (Eric, 2026-11-04, ZimiTube on his
phone: only the header and an empty page; "no good loading view or it disappears before content appears")."""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

DELAY = {"s": 0.0, "fail": False}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi import dictionary, tube
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("wait")
    zdir = tmp / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "ted_en_all_2026-01.zim"), {"Scraper": "ted2zim 3.0.2", "Name": "ted_en_all", "Title": "All TED videos"})
    build_fixture_zim(str(zdir / "askubuntu.com_en_all_2026-01.zim"), {"Scraper": "sotoki 2.2", "Name": "askubuntu.com_en_all", "Title": "Ask Ubuntu"})
    mp = pytest.MonkeyPatch()
    mp.setenv("ZIMI_APPS", ",".join(srv.APP_NAMES))
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    srv.load_cache(force=True)

    def slow(real):
        def f(*a, **k):
            time.sleep(DELAY["s"])
            if DELAY["fail"]:
                raise RuntimeError("down")
            return real(*a, **k)
        return f

    mp.setattr(tube, "feed", slow(tube.feed))
    mp.setattr(dictionary, "home", slow(dictionary.home))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


FRAME = "() => document.getElementById('reader-frame').contentDocument"
STATE = """() => { const d = document.getElementById('reader-frame').contentDocument; if (!d || !d.body) return null;
  const w = d.querySelector('.app-wait'); return { wait: !!w, cards: w ? w.querySelectorAll('.app-wait-card').length : 0,
  note: w ? (w.querySelector('.app-wait-note') || {}).textContent || '' : '', retry: !!(w && w.querySelector('.app-wait-retry')),
  content: d.querySelectorAll('#shelves > *, #grid > *').length + (d.getElementById('empty').hidden ? 0 : 1) }; }"""


def _open_tube(pw, served):
    br = pw.chromium.launch()
    pg = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True).new_page()
    pg.goto(served + "/")
    pg.wait_for_function("() => typeof mode !== 'undefined' && mode === 'home'", timeout=30000)
    pg.evaluate("openTube()")
    return br, pg


def test_a_slow_first_answer_shows_cards_until_the_videos_are_there(served):
    from playwright.sync_api import sync_playwright

    DELAY.update(s=5.0, fail=False)
    with sync_playwright() as pw:
        br, pg = _open_tube(pw, served)
        try:
            pg.wait_for_function("() => { const d = document.getElementById('reader-frame').contentDocument; return d && d.querySelector('.app-wait'); }", timeout=3000)
            st = pg.evaluate(STATE)
            assert st["cards"] >= 3 and not st["content"], st
            pg.wait_for_function("() => { const w = document.getElementById('reader-frame').contentDocument.querySelector('.app-wait-note'); return w && !w.hidden; }", timeout=6000)
            assert pg.evaluate(STATE)["note"], "a plain word once it takes a while"
            if os.environ.get("ZIMI_SHOTS"):
                pg.screenshot(path=os.path.join(os.environ["ZIMI_SHOTS"], "app-wait.png"))
            pg.wait_for_function("() => !document.getElementById('reader-frame').contentDocument.querySelector('.app-wait')", timeout=10000)
            assert pg.evaluate(STATE)["content"], "the cards leave only with the content"
        finally:
            br.close()


def test_a_failed_first_answer_offers_try_again(served):
    from playwright.sync_api import sync_playwright

    DELAY.update(s=0.0, fail=True)
    with sync_playwright() as pw:
        br, pg = _open_tube(pw, served)
        try:
            pg.wait_for_function("() => { const d = document.getElementById('reader-frame').contentDocument; return d && d.querySelector('.app-wait-retry'); }", timeout=8000)
            DELAY.update(fail=False)
            pg.frame_locator("#reader-frame").locator(".app-wait-retry").click()
            pg.wait_for_function("() => { const d = document.getElementById('reader-frame').contentDocument; return !d.querySelector('.app-wait') && (d.querySelectorAll('#shelves > *, #grid > *').length || !d.getElementById('empty').hidden); }", timeout=8000)
        finally:
            br.close()


def test_the_dictionary_waits_in_the_same_way(served):
    """The Dictionary's own grey bars are gone: it waits with the apps' one waiting state, in lines."""
    from playwright.sync_api import sync_playwright

    DELAY.update(s=3.0, fail=False)
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True).new_page()
        try:
            pg.goto(served + "/")
            pg.wait_for_function("() => typeof mode !== 'undefined' && mode === 'home'", timeout=30000)
            pg.evaluate("openDictionary()")
            pg.wait_for_function("() => { const d = document.getElementById('reader-frame').contentDocument; return d && d.querySelector('.app-wait .app-wait-lines'); }", timeout=3000)
            assert not pg.evaluate("() => document.getElementById('reader-frame').contentDocument.querySelector('.sk')")
            pg.wait_for_function("() => !document.getElementById('reader-frame').contentDocument.querySelector('.app-wait')", timeout=8000)
        finally:
            br.close()
