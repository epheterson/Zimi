"""An installed app opened offline has its CSS.

"Installed PWA offline showed only the header without CSS; the open Safari tab still worked."
Two ways the worker could keep a shell and not its stylesheet, both closed in sw.js:

1. A file the shell names fails to download while the worker installs (SHELL_URLS are kept one by one and a failure was
   skipped). The install now keeps what the shell names, trying again, and fails rather than keep a shell without it
   (tests/test_sw_offline.py, with a scripted network: the browser's own cache answers a real worker's downloads).
2. After a deploy, before the new worker has installed, the old worker fetched the shell again "for next time" and kept
   the new build's shell over its own, naming files its cache does not hold. A shell of another build is not kept by the
   worker that does not hold its files (below, in a real browser).

Run: pytest tests/test_pwa_offline_after_deploy_browser.py -v
"""

import os
import re
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

WAIT_MS = 30_000


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("pwaoffline")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def _first_visit(ctx, served):
    """A page that has finished the first-run question."""
    pg = ctx.new_page()
    pg.goto(served + "/", wait_until="commit", timeout=WAIT_MS)
    pg.wait_for_function("() => !!document.getElementById('setup-req') || !!document.getElementById('library-btn')", timeout=WAIT_MS)
    if pg.evaluate("!!document.getElementById('setup-req')"):
        pg.evaluate("document.getElementById('setup-req').click()")
        pg.wait_for_function("() => [...document.querySelectorAll('button')].some(b => b.innerText === 'Turn off password')", timeout=WAIT_MS)
        pg.evaluate("[...document.querySelectorAll('button')].filter(b => b.innerText === 'Turn off password')[0].click()")
        pg.wait_for_timeout(2500)
    return pg


def _stylesheet_rules(pg):
    return pg.evaluate(
        "() => [...document.styleSheets].filter(s => (s.href || '').indexOf('/static/app.css') > 0)"
        ".map(s => { try { return s.cssRules.length; } catch (e) { return -1; } })"
    )


def _offline_start_has_css(ctx, served):
    ctx.set_offline(True)
    off = ctx.new_page()
    off.goto(served + "/", wait_until="commit", timeout=WAIT_MS)
    off.wait_for_function("() => document.styleSheets.length > 0", timeout=WAIT_MS)
    off.wait_for_timeout(1500)
    return _stylesheet_rules(off)


def _kept_shell_build(pg):
    return pg.evaluate(
        "caches.keys().then(async ks => { for (const k of ks) { const r = await (await caches.open(k)).match('/');"
        " if (r) return ((await r.text()).match(/build:'[^']*'/) || [''])[0]; } return ''; })"
    )


def test_a_shell_of_a_newer_build_is_not_kept_over_the_one_that_has_its_files(served):
    from playwright.sync_api import sync_playwright

    import zimi.http as http

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context()
        pg = _first_visit(ctx, served)
        pg.goto(served + "/", wait_until="commit", timeout=WAIT_MS)
        pg.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=WAIT_MS)
        pg.wait_for_timeout(2500)
        build = _kept_shell_build(pg)
        assert build.startswith("build:'zimi-v"), build

        # A deploy: the server answers / with the next build's shell, naming its own hashed files, while this worker
        # (the old one) is still in charge: the new worker's install has not happened.
        real_html, real_etag = http.SEARCH_UI_HTML, http.ZimHandler._index_etag
        html = re.sub(r"build:'[^']*'", "build:'zimi-v9.9.9-next'", real_html)
        http.SEARCH_UI_HTML = re.sub(r"/static/app\.css\?v=[0-9a-f]+", "/static/app.css?v=ffffffff", html)
        http.ZimHandler._index_etag = '"z-next"'
        try:
            pg.reload(wait_until="commit", timeout=WAIT_MS)
            pg.wait_for_timeout(3000)  # the worker fetches the shell again behind that start
        finally:
            http.SEARCH_UI_HTML, http.ZimHandler._index_etag = real_html, real_etag
        assert _kept_shell_build(pg) == build, "the shell kept is still the one whose files are kept"
        rules = _offline_start_has_css(ctx, served)
        assert rules and all(n > 100 for n in rules), "offline, the page has its stylesheet: %r" % rules
        br.close()
