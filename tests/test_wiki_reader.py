"""Zimipedia's article reader, in a real browser: a phone and a desk.

Eric, 2026-09-25: "It not useful it doesn't own the pages or help dive in
and learn better ... Have a refined article reader."

An article opened from Zimipedia reads in Zimipedia's reader: Reader View
laid out as an encyclopedia. On a phone: the lead image over the title, the
facts folded, a bar at the foot (contents, reading settings) that steps
aside with Zimi's header as you read, and a citation as a card in place. On
a desk: the contents in a rail that follows you, the facts beside the text.
The reading settings are the book reader's own sheet; where you were goes to
Saved, as Zimipedia's Continue reading. A mini says what it is. The fixture
is mwoffliner's Parsoid HTML (tests/wiki_fixture.py).

Run: pytest tests/test_wiki_reader.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import wiki  # noqa: E402

FRAME = "() => document.getElementById('reader-frame').contentDocument"
READY = "() => { var d = document.getElementById('reader-frame').contentDocument; return !!(d && d.querySelector('.zw-bar')); }"


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import wiki_fixture

    from zimi.http import ZimHandler

    zdir = str(tmp_path / "zims")
    wiki_fixture.build_library(zdir)
    monkeypatch.setattr(srv, "ZIM_DIR", zdir)
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    wiki._reset_for_tests()
    srv.load_cache(force=True)
    wiki_fixture.index_wikipedias()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _boot(pg, base):
    pg.goto(base + "/")
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=30000,
    )
    pg.evaluate("() => document.activeElement && document.activeElement.blur()")


def _from_zimipedia(pg, zim, path):
    """Open an article as Zimipedia's page does: a word to the shell."""
    pg.evaluate("() => openWiki()")
    pg.wait_for_function(
        "() => { var w = document.getElementById('reader-frame').contentWindow; return w && typeof w.tell === 'function' && /wiki\\.html/.test(w.location.pathname); }",
        timeout=30000,
    )
    pg.evaluate(
        "([z, p]) => document.getElementById('reader-frame').contentWindow.tell({ zimi: 'open', zim: z, path: p })",
        [zim, path],
    )
    pg.wait_for_function(READY, timeout=30000)
    pg.wait_for_timeout(500)


def _q(pg, js):
    return pg.evaluate(
        "() => { var f = document.getElementById('reader-frame'), d = f.contentDocument, w = f.contentWindow; return ("
        + js
        + "); }"
    )


def test_an_article_from_zimipedia_reads_in_its_reader_on_a_phone(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        pg = ctx.new_page()
        fr = pg.frame_locator("#reader-frame")
        try:
            _boot(pg, served)
            _from_zimipedia(pg, "wikipedia", "Albert_Einstein")
            s = _q(
                pg,
                """{ reader: !!d.querySelector('.zimi-reader'), bar: d.querySelector('.zw-bar').getBoundingClientRect().bottom,
              h: w.innerHeight, facts: !!d.querySelector('details.zw-facts table.infobox'), open: d.querySelector('details.zw-facts').open,
              hero: (d.querySelector('.zw-hero img') || {}).getAttribute ? d.querySelector('.zw-hero img').getAttribute('src') : '',
              heroShown: !!(d.querySelector('.zw-hero') && d.querySelector('.zw-hero').getBoundingClientRect().height > 0),
              sub: (d.querySelector('.zw-sub') || {}).textContent, sister: !!d.querySelector('.sistersitebox'),
              zoom: d.body.style.zoom, top: !!d.getElementById('zimi-top') }""",
            )
            assert s["reader"], "Reader View is on for an article from Zimipedia"
            assert abs(s["bar"] - s["h"]) < 2, "the bar sits at the foot on a phone"
            assert s["facts"] and not s["open"], "the infobox is kept, folded"
            assert (
                s["hero"].endswith("I/Einstein_1921.png") and s["heroShown"]
            ), "the lead image over the title"
            assert s["sub"] == "German-born physicist (1879 to 1955)"
            assert not s["top"], "no jump-to-top button: the reader has its own bar"
            # A citation opens in place, with its note.
            mark = fr.locator("p sup.reference a").nth(1)
            mark.scroll_into_view_if_needed()
            y0 = _q(pg, "w.scrollY")
            mark.click()
            pg.wait_for_timeout(300)
            card = _q(
                pg,
                "{ shown: !d.querySelector('.zw-card').hidden, text: d.querySelector('.zw-card').textContent, y: w.scrollY }",
            )
            assert (
                card["shown"] and "Source number 2" in card["text"] and card["y"] == y0
            ), "the note, where you are: the page does not jump to the references"
            fr.locator("h1").first.click()
            pg.wait_for_timeout(200)
            assert _q(pg, "d.querySelector('.zw-card').hidden")
            # Contents: a sheet from the bar; a section opens at its heading.
            _q(pg, "w.scrollTo(0, 0)")
            pg.wait_for_timeout(300)
            fr.locator(".zw-cbtn").click()
            pg.wait_for_timeout(300)
            items = _q(
                pg,
                "Array.prototype.map.call(d.querySelectorAll('.zw-toc-sheet .zb-toc-list li'), function(li) { return li.className + ':' + li.textContent; })",
            )
            assert items[1:] == [
                ":Life",
                "zb-sub:Early life",
                ":Relativity",
                ":Legacy",
                ":Other websites",
                ":References",
            ], items
            fr.locator('.zw-toc-sheet button[data-k="2"]').click()
            pg.wait_for_timeout(400)
            top = _q(pg, "d.getElementById('Relativity').getBoundingClientRect().top")
            assert 0 <= top < 80, top
            assert (
                _q(pg, "d.querySelector('.zw-cbtn span').textContent") == "Relativity"
            ), "the bar says where you are"
            # Reading on: the bar and Zimi's header step aside; back up, they return.
            _q(pg, "w.scrollBy(0, 300)")
            pg.wait_for_timeout(400)
            assert _q(pg, "d.documentElement.classList.contains('zb-away')")
            assert pg.evaluate("() => document.body.classList.contains('chrome-away')")
            _q(pg, "w.scrollBy(0, -120)")
            pg.wait_for_timeout(400)
            assert not _q(pg, "d.documentElement.classList.contains('zb-away')")
            # The reading settings are the book reader's sheet; bigger type keeps the passage.
            fr.locator(".zw-bar .zb-aa").click()
            pg.wait_for_timeout(300)
            rows = _q(pg, "d.querySelectorAll('.zw-set-sheet .zb-set').length")
            assert (
                rows == 5
            ), "theme, font, size, spacing, margins (no layout: that is a book's)"
            fr.locator('.zw-set-sheet [data-size="1"]').click()
            pg.wait_for_timeout(300)
            assert (
                _q(pg, "d.documentElement.style.getPropertyValue('--zw-size')")
                == "21px"
            )
            assert (
                pg.evaluate(
                    "() => JSON.parse(localStorage.getItem('zimi_wiki_prefs')).size"
                )
                == 21
            )
            assert (
                pg.evaluate("() => localStorage.getItem('zimi_book_prefs')") is None
            ), "a book's settings are its own"
            fr.locator(".zw-set-sheet .zb-x").click()
            # Where you were: a place in Saved, for Zimipedia's Continue reading.
            _q(pg, "w.dispatchEvent(new Event('pagehide'))")
            place = pg.evaluate(
                "() => Saved.position({ zim: 'wikipedia', path: 'Albert_Einstein' })"
            )
            assert (
                place
                and place["app"] == "wiki"
                and place["kind"] == "article"
                and place["where"]["s"]
            ), place
            assert place["title"] == "Albert Einstein"
        finally:
            br.close()


def test_on_a_desk_the_contents_follow_and_the_facts_sit_beside_the_text(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 1440, "height": 900})
        try:
            _boot(pg, served)
            _from_zimipedia(pg, "wikipedia", "Albert_Einstein")
            s = _q(
                pg,
                """{ rail: getComputedStyle(d.querySelector('.zw-rail')).display, open: d.querySelector('details.zw-facts').open,
              facts: d.querySelector('details.zw-facts').getBoundingClientRect().left, text: d.querySelector('.zimi-reader-body').getBoundingClientRect().right,
              hero: d.querySelector('.zw-hero').getBoundingClientRect().height, bar: d.querySelector('.zw-bar').getBoundingClientRect().top,
              wide: d.documentElement.scrollWidth <= w.innerWidth }""",
            )
            assert s["rail"] == "block" and s["open"], s
            assert s["facts"] > s["text"], "the facts sit beside the text, not in it"
            assert s["hero"] == 0, "the lead image is in the facts on a desk"
            assert s["bar"] == 0 and s["wide"], s
            _q(pg, "d.getElementById('Relativity').scrollIntoView()")
            pg.wait_for_timeout(400)
            assert (
                _q(
                    pg,
                    "d.querySelector('.zw-rail [aria-current=\"true\"]').textContent",
                )
                == "Relativity"
            )
        finally:
            br.close()


def test_a_right_to_left_article_and_a_mini(served):
    from playwright.sync_api import sync_playwright

    import wiki_fixture

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 1440, "height": 900})
        try:
            _boot(pg, served)
            _from_zimipedia(pg, "wikipedia_he", wiki_fixture.HE_TITLE)
            s = _q(
                pg,
                """{ dir: d.querySelector('.zimi-reader').getAttribute('dir'), lang: d.querySelector('.zimi-reader').getAttribute('lang'),
              rail: d.querySelector('.zw-rail').getBoundingClientRect().left, text: d.querySelector('.zimi-reader-body').getBoundingClientRect().right }""",
            )
            assert s["dir"] == "rtl" and s["lang"] == "he"
            assert s["rail"] > s["text"], "the contents stand on the article's own side"
            # A mini says what it is, and a citation whose note it lacks says why.
            _from_zimipedia(pg, "wikipedia_en", "Albert_Einstein")
            note = _q(pg, "(d.querySelector('.zw-note') || {}).textContent || ''")
            assert "mini build" in note
            pg.frame_locator("#reader-frame").locator("p sup.reference a").first.click()
            pg.wait_for_timeout(300)
            assert "introduction only" in _q(
                pg, "d.querySelector('.zw-card').textContent"
            )
        finally:
            br.close()
