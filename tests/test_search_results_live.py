"""Search results and find in page, in a real browser (search revamp, 2026-09-30).

The way a person uses them, on a desktop and a 390px phone, in English and
Hebrew: the words searched for marked in the results, results from many
sources grouped with "More from", the arrows walking the results, a chip's
× a step Back undoes, recent searches taken away one at a time or all at
once, and Find in page in the open article (count, next, a closed section
opened, Esc, right-to-left text, the browser's own Cmd+F left alone
everywhere else).
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PHONE = {"width": 390, "height": 844}
DESKTOP = {"width": 1280, "height": 900}
SOURCES = ["alpha", "bravo", "charlie", "delta"]

RIVER_PAGE = (
    "<html><body><h1>Water topic 0</h1>"
    "<p>The river runs. A second river joins it.</p>"
    "<p>Past the RIVER mouth, the sea.</p>"
    "<details><summary>More</summary><p>A hidden river, in a closed section.</p></details>"
    "<p>Rivers everywhere: river.</p>"
    "</body></html>"
)
HEBREW_PAGE = (
    '<html dir="rtl" lang="he"><body><h1>מים</h1>'
    "<p>שָׁלוֹם לכם. שלום שלום.</p><p>water in Latin letters</p></body></html>"
)


def _build(path, name):
    from libzim.writer import Creator

    from conftest_zim import _Article

    with Creator(path).config_indexing(True, "eng") as c:
        c.set_mainpath("A/Water_0")
        for i in range(12):
            html = (
                RIVER_PAGE
                if i == 0
                else (
                    "<html><body><h1>Water topic %d</h1><p>Water from %s, part %d.</p></body></html>"
                    % (i, name, i)
                )
            )
            # Titles differ between sources: the search keeps one of a title.
            title = "Water topic %d %s" % (i, name)
            c.add_item(_Article("A/Water_%d" % i, title, html.encode()))
        c.add_item(_Article("A/Hebrew", "Hebrew water", HEBREW_PAGE.encode()))
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

    tmp = tmp_path_factory.mktemp("results")
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
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old[0], old[1]
    if old[2] is None:
        os.environ.pop("ZIMI_OFFLINE", None)
    else:
        os.environ["ZIMI_OFFLINE"] = old[2]


def _page(pw, base, lang, phone):
    br = pw.chromium.launch()
    ctx = br.new_context(
        viewport=PHONE if phone else DESKTOP,
        locale="he-IL" if lang == "he" else "en-US",
        is_mobile=phone,
        has_touch=phone,
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base + "/")
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && zimsCache && zimsCache.length === 4",
        timeout=30000,
    )
    return br, pg, errors


def _search(pg, query):
    pg.locator("#q").fill(query)
    pg.locator("#q").press("Enter")
    pg.wait_for_function(
        "() => allResults && allResults._query === %r && !allResults.partial" % query,
        timeout=30000,
    )
    pg.wait_for_selector("#output .results")


@pytest.mark.parametrize("lang,phone", [("en", False), ("he", True)])
def test_results_marked_grouped_and_walked(served, lang, phone):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _page(pw, served, lang, phone)
        _search(pg, "water")

        # Four sources, 10 results each: grouped, each source's best three.
        groups = pg.locator("#output .result-group")
        assert groups.count() == 4
        for i in range(4):
            assert groups.nth(i).locator("a.result").count() == 3
            assert groups.nth(i).locator(".result-more").count() == 1
        # The word searched for, marked in every title; nothing else marked.
        marks = pg.eval_on_selector_all(
            "#output .result .title mark.hit", "ms => ms.map(m => m.textContent)"
        )
        assert marks and set(marks) == {"Water"}, marks
        assert pg.evaluate(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
        )

        # The arrows: down from the box into the results, down again, up
        # past the first back to the box.
        pg.locator("#q").focus()
        pg.evaluate("hideSuggest()")
        pg.keyboard.press("ArrowDown")
        first = pg.evaluate("document.activeElement.dataset.path")
        assert first, "ArrowDown from the box focuses the first result"
        pg.keyboard.press("ArrowDown")
        assert pg.evaluate("document.activeElement.dataset.path") not in (None, first)
        pg.keyboard.press("ArrowUp")
        pg.keyboard.press("ArrowUp")
        assert pg.evaluate("document.activeElement.id") == "q"

        # "More from": the same search in that source alone.
        src = groups.nth(1).locator(".result-more").get_attribute("data-zim")
        # The results on screen before the click already say 'water' and
        # finished: wait for the scoped search's own, not those.
        pg.evaluate("() => { window.__before = allResults; }")
        groups.nth(1).locator(".result-more").click()
        pg.wait_for_function(
            "(z) => currentSource === z && allResults && allResults !== window.__before && allResults._query === 'water' && !allResults.partial",
            arg=src,
            timeout=30000,
        )
        assert pg.locator("#output .result-group").count() == 0
        assert pg.evaluate("new Set(allResults.results.map(r => r.zim)).size") == 1
        # It had more than one screen asked for: "More results" asks again.
        assert pg.evaluate("allResults.results.length") >= 10
        more = pg.locator("#output .load-more button")
        assert more.count() == 1
        more.click()
        pg.wait_for_function(
            "() => allResults._limit === 50 && !allResults.partial", timeout=30000
        )
        pg.wait_for_function(
            "() => document.querySelectorAll('#output a.result').length >= 12"
        )
        assert errors == [], errors
        br.close()


def test_chip_back_and_recent_searches(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _page(pw, served, "en", False)
        _search(pg, "water -charlie")
        assert pg.evaluate("location.search") == "?q=water%20-charlie"
        pg.locator("#output .search-chip-x").first.click()
        pg.wait_for_function("() => allResults && allResults._query === 'water'")
        assert pg.evaluate("location.search") == "?q=water"
        # Back: the search with the chip, as it was.
        pg.go_back()
        pg.wait_for_function(
            "() => document.getElementById('q').value === 'water -charlie'"
        )
        pg.wait_for_selector("#output .search-chip")

        # Recent: the empty box lists the searches, each a × from gone.
        _search(pg, "topic bravo")
        pg.evaluate("clearSearchInput()")
        pg.evaluate("showHistoryDropdown()")
        rows = pg.locator("#suggest-dropdown .suggest-item.sg-recent")
        labels = [
            rows.nth(i).locator(".sg-title").inner_text() for i in range(rows.count())
        ]
        assert labels[0] == "topic bravo" and "water" in labels, labels
        rows.first.locator(".sg-forget").click()
        assert "topic bravo" not in pg.eval_on_selector_all(
            "#suggest-dropdown .sg-title", "els => els.map(e => e.textContent)"
        )
        assert "topic bravo" not in pg.evaluate("localStorage.getItem('zimi_history')")
        assert (
            pg.evaluate("document.activeElement.id") == "q"
        ), "the box keeps the focus"
        pg.locator("#suggest-dropdown .sg-recent-clear").click()
        kinds = pg.evaluate(
            "JSON.parse(localStorage.getItem('zimi_history') || '[]').map(e => e.type)"
        )
        assert "search" not in kinds
        assert errors == [], errors
        br.close()


def _open_article(pg, path):
    pg.evaluate("(p) => openArticle('alpha_en_test', p, '')", path)
    pg.wait_for_function(
        "() => { const d = document.getElementById('reader-frame').contentDocument;"
        " return readerOpen && d && d.readyState === 'complete' && d.body && d.body.textContent.length > 5; }",
        timeout=30000,
    )
    pg.wait_for_function(
        "() => !!document.getElementById('reader-frame').contentDocument.__zimiFindBound"
    )


def test_box_searches_the_zim_being_read(served):
    """An article opened from a search of everything: the box says it
    searches that article's ZIM, and does (it said the ZIM's name and
    searched everything)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _page(pw, served, "en", False)
        _search(pg, "water")
        pg.locator("#output .result-group").nth(2).locator("a.result").first.click()
        pg.wait_for_function("() => readerOpen && !!readerSource")
        zim = pg.evaluate("readerSource")
        title = pg.evaluate("(z) => _zimTitle(z)", zim)
        pg.wait_for_function(
            "(s) => document.getElementById('q').placeholder === s",
            arg=pg.evaluate("(s) => t('search_in', {source: s})", title),
        )
        _search(pg, "part")
        assert pg.evaluate("Object.keys(allResults.by_source)") == [zim]
        assert pg.evaluate("location.pathname") == "/w/" + zim
        assert errors == [], errors
        br.close()


@pytest.mark.parametrize("lang,phone", [("en", False), ("he", True)])
def test_find_in_page(served, lang, phone):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _page(pw, served, lang, phone)
        # Outside an article, Cmd/Ctrl+F is the browser's.
        taken = pg.evaluate(
            "() => { const e = new KeyboardEvent('keydown', {key: 'f', ctrlKey: true, bubbles: true, cancelable: true});"
            " document.dispatchEvent(e); return e.defaultPrevented; }"
        )
        assert taken is False
        assert pg.locator("#find-bar").count() == 0

        _open_article(pg, "A/Water_0")
        if phone:
            pg.locator(".topbar-more").tap()
            pg.locator("#tbm-find").tap()
        else:
            # From inside the article, where the keys are after a click.
            pg.frame_locator("#reader-frame").locator("h1").click()
            pg.keyboard.press("Control+f")
        bar = pg.locator("#find-bar.open")
        bar.wait_for()
        pg.keyboard.type("river")
        count = pg.locator("#find-bar .find-count")
        pg.wait_for_function(
            "() => /6/.test(document.querySelector('#find-bar .find-count').textContent)"
        )
        n_of = lambda n: pg.evaluate("(n) => t('n_of_total', {n: n, total: 6})", n)
        assert count.inner_text() == n_of(1)
        # Painted, every one, and the article's own DOM untouched.
        frame_js = "document.getElementById('reader-frame').contentWindow"
        assert pg.evaluate(frame_js + ".CSS.highlights.get('zimi-find').size") == 5
        assert pg.evaluate(frame_js + ".CSS.highlights.get('zimi-find-on').size") == 1
        assert pg.evaluate(frame_js + ".document.querySelectorAll('mark').length") == 0
        # Enter steps on; the fourth is in a closed section, which opens.
        pg.keyboard.press("Enter")
        assert count.inner_text() == n_of(2)
        pg.keyboard.press("Enter")
        pg.keyboard.press("Enter")
        assert count.inner_text() == n_of(4)
        assert pg.evaluate(frame_js + ".document.querySelector('details').open") is True
        pg.keyboard.press("Shift+Enter")
        assert count.inner_text() == n_of(3)
        # Nothing there: said, and the steps off.
        pg.locator("#find-bar .find-input").fill("zzqx")
        pg.wait_for_function(
            "() => document.querySelector('#find-bar').classList.contains('find-none')"
        )
        assert count.inner_text() == pg.evaluate("t('find_none')")
        assert pg.locator("#find-bar .find-next").is_disabled()
        # The bar fits the screen.
        box = bar.bounding_box()
        assert (
            box["x"] >= 0
            and box["x"] + box["width"] <= (PHONE if phone else DESKTOP)["width"]
        )
        # Esc closes the bar, not the article.
        pg.keyboard.press("Escape")
        assert pg.locator("#find-bar.open").count() == 0
        assert pg.evaluate("readerOpen") is True
        assert pg.evaluate(frame_js + ".CSS.highlights.has('zimi-find')") is False

        # Right to left: vowel marks do not count.
        _open_article(pg, "A/Hebrew")
        pg.evaluate("openFindInPage()")
        bar.wait_for()
        pg.locator("#find-bar .find-input").fill("שלום")
        pg.wait_for_function(
            "() => /3/.test(document.querySelector('#find-bar .find-count').textContent)"
        )
        assert pg.evaluate(frame_js + ".CSS.highlights.get('zimi-find').size") == 2
        assert errors == [], errors
        br.close()
