"""What a person searching costs the server, counted in a real browser.

Eric (2026-10-01): "Can we have searches hammer the server less and not get
to the point where we have to limit so much even remotely?" A public client
has RATE_LIMIT API requests a minute (60). Measured before on six sources:
one typed search was 22 requests (two /search passes and twenty /snippet),
and the same search again 2 more. Now: one /search per search, its snippets
inside it, and a search asked again (Back, Forward, the same words) none.

The budget test is a fast typist's minute: three searches typed at 60 ms a
key with a typo taken back, the results scrolled and paged, a result opened,
Back, Forward, Back, a search inside one source as you type, and the first
search asked again. Everything it sends on the API budget stays under half
of what a public client may.
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SOURCES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
DESKTOP = {"width": 1280, "height": 900}


def _build(path, name):
    from libzim.writer import Creator

    from conftest_zim import _Article

    with Creator(path).config_indexing(True, "eng") as c:
        c.set_mainpath("A/Water_0")
        for i in range(30):
            html = (
                "<html><head><meta name='description' content='Water and rivers %d.'>"
                "</head><body><h1>Water topic %d</h1><p>Rivers and lakes of %s.</p>"
                "</body></html>" % (i, i, name)
            )
            c.add_item(
                _Article(
                    "A/Water_%d" % i, "Water topic %d %s" % (i, name), html.encode()
                )
            )
        c.add_metadata("Title", "Source " + name.capitalize())
        c.add_metadata("Language", "eng")
        c.add_metadata("Description", "fixture " + name)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("requests")
    zdir = tmp / "zims"
    zdir.mkdir()
    for name in SOURCES:
        _build(str(zdir / ("%s_en_test.zim" % name)), name)
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR, os.environ.get("ZIMI_OFFLINE"))
    os.environ["ZIMI_OFFLINE"] = "1"
    srv.ZIM_DIR = str(zdir)
    srv.ZIMI_DATA_DIR = str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    srv.load_cache(force=True)
    srv._search_cache_clear()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old[0], old[1]
    if old[2] is None:
        os.environ.pop("ZIMI_OFFLINE", None)
    else:
        os.environ["ZIMI_OFFLINE"] = old[2]


def _api_paths(urls, base):
    """The requests that spend the API budget, by path (http._rate_class)."""
    from zimi.http import _rate_class

    out = []
    for u in urls:
        path = u[len(base) :].split("?")[0] if u.startswith(base) else ""
        limited, content = _rate_class(path) if path else (False, False)
        if limited and not content:
            out.append(path)
    return out


def _done(pg, query):
    pg.wait_for_function(
        "q => allResults && allResults._query === q && !allResults.partial && _snippetsStreamSeq === 0",
        arg=query,
        timeout=30000,
    )


def _enter_search(pg, text):
    box = pg.locator("#q")
    box.fill("")
    box.click()
    box.press_sequentially(text, delay=60)
    box.press("Enter")
    _done(pg, text)


def test_one_search_is_one_request_and_again_is_none(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport=DESKTOP, service_workers="block")
        urls = []
        pg.on("request", lambda r: urls.append(r.url))
        pg.goto(served + "/")
        pg.wait_for_function("() => zimsCache && zimsCache.length === 6", timeout=30000)
        urls.clear()
        _enter_search(pg, "water topic")
        sent = [u for u in urls if "/search?" in u or "/snippet?" in u]
        assert len([u for u in sent if "/search?" in u]) == 1, sent
        assert not [
            u for u in sent if "/snippet?" in u
        ], "the snippets came with the search"
        # Every card on the first screen has its snippet and none waits for one.
        assert (
            pg.evaluate("document.querySelectorAll('[data-needs-snippet]').length") == 0
        )
        assert (
            pg.evaluate("document.querySelectorAll('a.result .snippet').length") >= 18
        )

        urls.clear()
        pg.evaluate(
            "() => { document.getElementById('q').value = 'water topic'; doSearch('water topic', 'new'); }"
        )
        _done(pg, "water topic")
        assert not [
            u for u in urls if "/search?" in u
        ], "the same search again is answered from what came"
        br.close()


def test_a_fast_typists_minute_stays_well_under_the_public_budget(served):
    from playwright.sync_api import sync_playwright

    from zimi.http import RATE_LIMIT

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport=DESKTOP, service_workers="block")
        urls = []
        pg.on("request", lambda r: urls.append(r.url))
        pg.goto(served + "/")
        pg.wait_for_function("() => zimsCache && zimsCache.length === 6", timeout=30000)
        urls.clear()

        for text in ("water topic", "rivers lakes", "topic alpha"):
            box = pg.locator("#q")
            box.fill("")
            box.click()
            box.press_sequentially(text[:4] + "x", delay=60)  # a typo...
            box.press("Backspace")  # ...taken back
            box.press_sequentially(text[4:], delay=60)
            box.press("Enter")
            _done(pg, text)
            pg.mouse.wheel(0, 2500)
            more = pg.locator(".load-more button, .result-more")
            if more.count():
                more.first.click()
                pg.wait_for_function(
                    "() => allResults && !allResults.partial && _snippetsStreamSeq === 0",
                    timeout=30000,
                )
            pg.locator("a.result").first.click()
            pg.wait_for_function("() => readerOpen", timeout=15000)
            pg.go_back()
            pg.wait_for_function(
                "() => !readerOpen && document.querySelector('a.result')", timeout=15000
            )
            pg.go_forward()
            pg.wait_for_function("() => readerOpen", timeout=15000)
            pg.go_back()
            pg.wait_for_function(
                "() => !readerOpen && document.querySelector('a.result')", timeout=15000
            )

        # Inside one source the box searches as you type.
        pg.evaluate("async () => { await enterSource('alpha_en_test', true); }")
        pg.wait_for_function(
            "() => mode === 'source' && currentSource === 'alpha_en_test'",
            timeout=15000,
        )
        box = pg.locator("#q")
        box.click()
        box.press_sequentially("water", delay=60)
        _done(pg, "water")
        box.press_sequentially(" topic", delay=60)
        _done(pg, "water topic")

        # And the first search, asked again.
        pg.evaluate("() => goHome(null)")
        _enter_search(pg, "water topic")

        api = _api_paths(urls, served)
        searches = api.count("/search")
        print("API requests in the minute: %d (%s searches)" % (len(api), searches))
        # Three typed, a "More from" each time there was one, two in the
        # source, and none for the search asked again.
        assert searches <= 8, api
        assert len(api) <= RATE_LIMIT // 2, api
        assert not [p for p in api if p == "/snippet"]
        br.close()
