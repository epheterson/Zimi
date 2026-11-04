"""Carry a ZIM on the phone, lose the server, read and search it.

An iPhone 15 (390 px) opens the app online, keeps a ZIM from its About panel
(the real /keep route into the browser's private storage, through the real
worker), then the server is stopped and the phone starts the app cold:

  - the home says what is on the phone and dims what is not;
  - a kept ZIM opens at its front page, read from the phone, and an article
    shows its picture;
  - title search answers at once; full-text search follows and is labelled;
  - a reload offline still works.

Timings are printed (run with -s). Chromium is the full proof (the service
worker's Cache Storage and OPFS both work in it). Playwright's WebKit keeps no
Cache Storage in a persistent context and no OPFS in an ephemeral one, so the
WebKit run (persistent: OPFS) proves the part Safari is new at (writing OPFS
from a worker, reading it from the service worker, libzim in a worker) with the
page already loaded, not a cold start.

Run: pytest tests/test_keep_phone_live.py -v -s
Screenshots: ZIMI_SHOTS=/some/dir pytest tests/test_keep_phone_live.py -s
"""

import os
import sys
import tempfile
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import wiki_fixture as wf  # noqa: E402
from test_offline_truth_live import Server, _free_port, poll  # noqa: E402

SHOTS = os.environ.get("ZIMI_SHOTS", "")
ZIM = "wikipedia"
ARTICLE = "Albert_Einstein"


def shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


@pytest.fixture(scope="module")
def pw():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        yield p


@pytest.fixture
def world(tmp_path):
    zims, data = tmp_path / "zims", tmp_path / "data"
    zims.mkdir()
    data.mkdir()
    wf.build_library(str(zims))
    srv = Server(str(zims), str(data), _free_port())
    srv.start()
    yield srv
    srv.stop()


def _device(pw):
    return {
        k: v for k, v in pw.devices["iPhone 15"].items() if k != "default_browser_type"
    }


def keep_from_about(pg, zim=ZIM, timeout=90000):
    """One tap on Keep offline in the ZIM's About panel, and let it finish."""
    pg.evaluate("(z) => _openZimAbout(z)", zim)
    pg.wait_for_selector("#zi-keep .keep-btn", timeout=30000)
    shot(pg, "1-about-keep")
    size_label = pg.inner_text("#zi-keep .keep-size")
    pg.click("#zi-keep .keep-btn")
    t0 = time.time()
    pg.wait_for_function(
        "() => /On this phone/.test(document.querySelector('#zi-keep .keep-line')?.innerText || '')",
        timeout=timeout,
    )
    shot(pg, "3-about-kept")
    return size_label, time.time() - t0


def wait_shell_kept(pg):
    """The worker is in charge and has kept the shell and, once the page has
    asked for them through it, the answers the next start cannot do without."""
    pg.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=30000)
    poll(
        pg,
        """async () => {
          for (const k of await caches.keys()) {
            const u = (await (await caches.open(k)).keys()).map(r => r.url);
            if (u.some(x => x.includes('/static/app.js')) && u.some(x => x.endsWith('/'))
                && u.some(x => x.includes('/list?layout=1')) && u.some(x => x.includes('/whoami')) && ['/fzstd.js', '/zimreader.js', '/keepstore.js', '/keepworker.js'].every(f => u.some(x => x.includes(f)))) return true;
          }
          return false;
        }""",
    )


PICTURE_LOADED = """() => {
  const f = document.querySelector('iframe');
  const i = f && f.contentDocument && f.contentDocument.querySelector('img');
  return !!(i && i.naturalWidth > 0);
}"""


def article_text(pg):
    return pg.evaluate(
        "() => { const f = document.querySelector('iframe'); try { return f.contentDocument.body.innerText; } catch (e) { return ''; } }"
    )


def wait_article(pg, needle, timeout=30000):
    pg.wait_for_function(
        "(n) => { const f = document.querySelector('iframe'); try { return f && f.contentDocument.body.innerText.includes(n); } catch (e) { return false; } }",
        arg=needle,
        timeout=timeout,
    )


def test_chromium_full_cold_start_offline(pw, world):
    br = pw.chromium.launch()
    ctx = br.new_context(**_device(pw))
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(world.base + "/", wait_until="load")
    pg.wait_for_selector(".stat-card", timeout=30000)
    wait_shell_kept(pg)

    room, pull_s = keep_from_about(pg)
    assert room.endswith("KB"), room   # the ZIM's own size beside the button, no sentence
    print("\nkeep: pulled in %.1f s; size label %s" % (pull_s, room))
    kept = pg.evaluate(
        "async () => (await (await fetch('/keep-local/list')).json()).zims.map(z => [z.name, z.complete, z.main])"
    )
    assert kept == [[ZIM, True, "Main_Page"]], kept

    print(
        "kept before offline:",
        pg.evaluate(
            "async () => { const o=[]; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (/list|whoami|has-pass/.test(r.url)) o.push(new URL(r.url).pathname); return o; }"
        ),
    )
    world.stop()
    ctx.set_offline(True)
    pg.close()

    # A cold start: a new page, no server.
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    t0 = time.time()
    pg.goto(world.base + "/", wait_until="commit")
    pg.wait_for_selector(".stat-card.kept", timeout=20000)
    home_ms = (time.time() - t0) * 1000
    shot(pg, "4-offline-home")
    cards = pg.evaluate(
        "() => [...document.querySelectorAll('.stat-card')].map(c => [c.dataset.zim, c.classList.contains('kept')])"
    )
    assert {z for z, k in cards if k} == {ZIM}, cards
    assert len(cards) > 1 and pg.query_selector(".stat-card.kept .keep-ico.kept")
    # The library is drawn from the phone's copy of the list, and says so.
    assert pg.inner_text("#conn-pill").strip() in ("Offline", "No server")
    assert not pg.query_selector(".conn-retry")
    opacity = pg.evaluate(
        "() => getComputedStyle([...document.querySelectorAll('.stat-card:not(.kept):not(.keep-tile-app)')][0]).opacity"
    )
    assert float(opacity) < 1, "what is not on the phone is dimmed offline"

    # Open the kept ZIM: its front page, then an article with its picture.
    t1 = time.time()
    pg.evaluate("([z]) => openArticle(z, 'Main_Page', 'Main Page')", [ZIM])
    wait_article(pg, "Welcome to Wikipedia")
    first_page_ms = (time.time() - t1) * 1000
    t2 = time.time()
    pg.evaluate("([z, p]) => openArticle(z, p, 'Albert Einstein')", [ZIM, ARTICLE])
    wait_article(pg, "theory of relativity")
    article_ms = (time.time() - t2) * 1000
    poll(pg, PICTURE_LOADED, 10)
    pg.wait_for_timeout(600)
    shot(pg, "5-article-offline")  # the article's picture is read from the phone too
    assert "Albert Einstein" in article_text(pg)

    # Title search: instant. Full text: follows, and says so.
    pg.evaluate("() => closeReader()")
    pg.fill("#search-input, input[type=search], .topbar input", "albert")
    pg.keyboard.press("Enter")
    t3 = time.time()
    pg.wait_for_selector(".results .result .title", timeout=20000)
    title_ms = (time.time() - t3) * 1000
    shot(pg, "6-title-search-offline")
    titles = pg.evaluate(
        "() => [...document.querySelectorAll('.results .result .title')].map(e => e.innerText)"
    )
    assert "Albert Einstein" in titles, titles
    assert "Full-text search is starting" in pg.inner_text(
        ".keep-search-note"
    ) or "full text" in pg.inner_text(".keep-search-note")

    pg.fill("#search-input, input[type=search], .topbar input", "relativity")
    pg.keyboard.press("Enter")
    t4 = time.time()
    pg.wait_for_function(
        "() => /full text/i.test(document.querySelector('.keep-search-note')?.innerText || '')",
        timeout=120000,
    )
    full_ms = (time.time() - t4) * 1000
    shot(pg, "7-full-text-offline")
    hits = pg.evaluate(
        "() => [...document.querySelectorAll('.results .result .title')].map(e => e.innerText)"
    )
    assert hits, "full-text search found the article whose body says it"

    # A reload offline: the same app, still working.
    pg.reload(wait_until="commit")
    pg.wait_for_selector(".stat-card.kept", timeout=20000)
    shot(pg, "8-reloaded-offline")

    print("cold start offline -> kept home: %.0f ms" % home_ms)
    print(
        "front page of a kept ZIM: %.0f ms; an article with its picture: %.0f ms"
        % (first_page_ms, article_ms)
    )
    print(
        "title search: %.0f ms; full-text search (cold worker): %.0f ms"
        % (title_ms, full_ms)
    )
    assert not [e for e in errors if "keep" in e.lower()], errors
    ctx.close()
    br.close()


@pytest.mark.fieldguide_on
def test_the_shell_features_need_no_server_and_no_file_is_missing(pw, world):
    """From the home the phone draws from its kept list, offline: Help now opens
    and answers, the Almanac opens, and not one /static/ file the shell asks for
    comes back as the worker's "offline" answer (a versioned script missing from
    the precache shows up here as a 503)."""
    br = pw.chromium.launch()
    ctx = br.new_context(**_device(pw))
    pg = ctx.new_page()
    pg.goto(world.base + "/", wait_until="load")
    pg.wait_for_selector(".stat-card", timeout=30000)
    wait_shell_kept(pg)
    # The Almanac comes once asked for: a ZIM kept here, or the Almanac opened.
    pg.evaluate("() => _keepAlmanac()")
    poll(pg, """async () => { for (const k of await caches.keys()) {
        const u = (await (await caches.open(k)).keys()).map(r => r.url);
        if (u.some(x => x.includes('/static/almanac.js')) && u.some(x => x.includes('/almanac-satellites'))) return true; }
        return false; }""")
    world.stop()
    ctx.set_offline(True)
    pg.close()

    pg = ctx.new_page()
    missing = []
    pg.on(
        "response",
        lambda r: (
            missing.append(r.url)
            if r.status == 503
            and "/static/" in r.url
            and r.headers.get("x-zimi-offline")
            else None
        ),
    )
    pg.goto(world.base + "/", wait_until="commit")
    pg.wait_for_selector(".stat-card", timeout=20000)

    # Help now, from the pill on the kept home.
    pg.click("a.help-now")
    fg = None
    deadline = time.time() + 30
    while time.time() < deadline and fg is None:
        fg = next((f for f in pg.frames if "fieldguide.html" in f.url), None)
        pg.wait_for_timeout(200)
    assert fg, "the Field Guide page opened"
    fg.wait_for_selector("#t-q", timeout=30000)
    fg.fill("#t-q", "my baby is choking")
    fg.wait_for_selector(".fg-hit.lead", timeout=15000)
    shot(pg, "9-help-now-offline")
    pg.evaluate("() => closeReader()")

    # The Almanac, all of it worked out on the device.
    pg.evaluate("() => openAlmanac()")
    pg.wait_for_selector("#almanac-head-date", timeout=30000)
    pg.wait_for_function(
        "() => document.querySelector('#almanac-view').innerText.length > 200",
        timeout=30000,
    )
    pg.wait_for_timeout(1500)
    shot(pg, "10-almanac-offline")
    # Kept on first use rather than at install, on purpose (their size): the 3D
    # Earth's textures, three.js and the probes' paths (space-tracks, 286 KB, read
    # once the view is among the planets), and one rosetta entry's text. Anything else is a hole.
    lazy = (
        "/static/earth/earth-",
        "/static/earth/three-",
        "/static/earth/satellite-",
        "/static/earth/space-tracks-",
        "/static/rosetta/",
    )
    holes = [
        u
        for u in missing
        if not any(m in u for m in lazy) or u.endswith("rosetta/manifest.json")
    ]
    assert not holes, (
        "files the shell asked for that the phone did not have: %s" % holes
    )
    ctx.close()
    br.close()


def test_webkit_opfs_worker_service_worker_and_libzim(pw, world):
    """What Safari is new at, in WebKit: a worker writes OPFS (sync access
    handle), the service worker reads it with async Blob.slice, libzim searches
    it in a worker. The page stays loaded (Playwright's WebKit has no Cache
    Storage in a context that has OPFS), so this is not a cold start."""
    try:
        br_ctx = pw.webkit.launch_persistent_context(tempfile.mkdtemp(), **_device(pw))
    except Exception as e:  # pragma: no cover
        pytest.skip("webkit not available: %s" % e)
    pg = br_ctx.new_page()
    pg.goto(world.base + "/", wait_until="load")
    pg.wait_for_selector(".stat-card", timeout=30000)
    pg.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=30000)
    room, pull_s = keep_from_about(pg)
    print("\nwebkit: pulled in %.1f s; size label %s" % (pull_s, room))
    world.stop()

    t0 = time.time()
    pg.evaluate("([z, p]) => openArticle(z, p, 'Albert Einstein')", [ZIM, ARTICLE])
    wait_article(pg, "theory of relativity")
    article_ms = (time.time() - t0) * 1000
    poll(pg, PICTURE_LOADED, 10)
    shot(pg, "w1-webkit-article")

    t1 = time.time()
    titles = pg.evaluate(
        "async () => (await (await fetch('/keep-local/search?q=albert')).json()).results.map(r => r.title)"
    )
    title_ms = (time.time() - t1) * 1000
    assert "Albert Einstein" in titles, titles

    t2 = time.time()
    hits = pg.evaluate(
        "async () => { await KeepStore.ftsWarm('wikipedia'); return await KeepStore.ftsSearch('wikipedia', 'relativity', 10); }"
    )
    full_ms = (time.time() - t2) * 1000
    assert hits, "libzim finds the article whose body says it"
    print(
        "webkit: article with picture %.0f ms; title search %.0f ms; full-text (cold worker) %.0f ms; first hit %s"
        % (article_ms, title_ms, full_ms, hits[0]["title"])
    )
    br_ctx.close()
