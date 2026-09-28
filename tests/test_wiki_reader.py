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
                card["shown"]
                and "Source number 2" in card["text"]
                and abs(card["y"] - y0) < 100
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


def test_languages_by_qid_land_on_the_same_section_and_sit_side_by_side(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 1440, "height": 900})
        fr = pg.frame_locator("#reader-frame")
        try:
            _boot(pg, served)
            # No Q-ID and no Simple twin: the switch is not there at all.
            _from_zimipedia(pg, "wikipedia", "Physics")
            pg.wait_for_timeout(800)
            assert _q(pg, "d.querySelector('.zw-lbtn').hidden")
            _from_zimipedia(pg, "wikipedia", "Albert_Einstein")
            pg.wait_for_function(
                "() => !document.getElementById('reader-frame').contentDocument.querySelector('.zw-lbtn').hidden",
                timeout=10000,
            )
            assert (
                _q(pg, "d.querySelector('.zw-lbtn span').textContent") == "2"
            ), "Hebrew, and Simple English as a level"
            # Side by side: Simple English beside the full article.
            fr.locator(".zw-lbtn").click()
            pg.wait_for_timeout(300)
            rows = _q(
                pg,
                "Array.prototype.map.call(d.querySelectorAll('.zw-lang-list .zw-go b'), function(b) { return b.textContent; })",
            )
            assert rows == ["Simple English", "עברית"], rows
            fr.locator(".zw-lang-list .zw-level .zw-side").click()
            pg.wait_for_function(
                "() => { var d = document.getElementById('reader-frame').contentDocument; return d.documentElement.classList.contains('zw-split') && d.querySelector('.zw-pane'); }",
                timeout=10000,
            )
            pane = _q(
                pg,
                "{ text: d.querySelector('.zw-pane').textContent, left: d.querySelector('.zw-pane').getBoundingClientRect().left, main: d.querySelector('.zimi-reader-body').getBoundingClientRect().right }",
            )
            assert (
                "He was born in Germany" in pane["text"]
                and pane["left"] >= pane["main"]
            ), pane
            fr.locator(".zw-pane-head button").click()
            assert not _q(pg, "d.documentElement.classList.contains('zw-split')")
            # In another language, from where you were: the section at the same place.
            _q(pg, "w.scrollTo(0, 0)")
            _q(
                pg,
                "w.scrollBy(0, d.getElementById('Relativity').getBoundingClientRect().top - 20)",
            )
            pg.wait_for_timeout(400)
            _q(pg, "w.scrollBy(0, -40)")
            pg.wait_for_timeout(400)
            fr.locator(".zw-lbtn").click()
            pg.wait_for_timeout(300)
            fr.locator(".zw-lang-list li:not(.zw-level) .zw-go").click()
            pg.wait_for_function(
                "() => { var d = document.getElementById('reader-frame').contentDocument; return d && d.documentElement.lang === 'he' && d.querySelector('.zw-bar'); }",
                timeout=15000,
            )
            pg.wait_for_timeout(500)
            here = _q(pg, "d.getElementById('מורשת').getBoundingClientRect().top")
            assert (
                0 <= here < 120
            ), "lands on the section at the same place, not the top"
            # A mini points to the full article once the lookup answers.
            _from_zimipedia(pg, "wikipedia_en", "Albert_Einstein")
            pg.wait_for_function(
                "() => !!document.getElementById('reader-frame').contentDocument.querySelector('.zw-note a')",
                timeout=10000,
            )
            assert (
                _q(pg, "d.querySelector('.zw-note a').getAttribute('href')")
                == "/w/wikipedia/Albert_Einstein"
            )
            assert not _q(
                pg, "d.querySelector('.zw-lbtn').hidden"
            ), "a borrowed Q-ID: the switch works on a mini"
        finally:
            br.close()


def test_one_topic_every_wiki_a_strip_after_the_lead(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 1440, "height": 900})
        fr = pg.frame_locator("#reader-frame")
        try:
            _boot(pg, served)
            _from_zimipedia(pg, "wikipedia", "Albert_Einstein")
            pg.wait_for_function(
                "() => !!document.getElementById('reader-frame').contentDocument.querySelector('.zw-strip')",
                timeout=10000,
            )
            s = _q(
                pg,
                """{ items: Array.prototype.map.call(d.querySelectorAll('.zw-strip a'), function(a) { return a.querySelector('i').textContent + ':' + a.getAttribute('data-path'); }),
              afterLead: d.querySelector('.zw-strip').previousElementSibling.getAttribute('data-mw-section-id') }""",
            )
            assert s["items"] == [
                "Wikiquote:Albert_Einstein",
                "Wikisource:Author:Albert_Einstein",
            ], s
            assert s["afterLead"] == "0", "after the lead, not over the text"
            fr.locator(".zw-strip a").first.click()
            pg.wait_for_function(
                "() => { var d = document.getElementById('reader-frame').contentDocument; return /\\/w\\/wikiquote\\/Albert_Einstein/.test(d.location.pathname) && d.querySelector('.zw-bar'); }",
                timeout=15000,
            )
            # A place, with a map of there installed: a way onto the map at it.
            pg.evaluate(
                "() => { zimsCache.push({ name: 'osm-test', title: 'Test map', kind: 'map', map_bounds: [-5, 40, 10, 55], main_path: 'index.html' }); }"
            )
            _from_zimipedia(pg, "wikipedia", "Paris")
            pg.wait_for_function(
                "() => !!document.getElementById('reader-frame').contentDocument.querySelector('.zw-strip .zw-map')",
                timeout=10000,
            )
            fr.locator(".zw-strip .zw-map").click()
            pg.wait_for_timeout(300)
            assert pg.evaluate("() => currentArticle.zim") == "osm-test"
            assert "map=12.00/48.85670/2.35080" in pg.evaluate("() => location.hash")
        finally:
            br.close()


def test_diving_in_a_card_for_a_link_a_trail_and_read_next(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        pg = ctx.new_page()
        fr = pg.frame_locator("#reader-frame")
        try:
            _boot(pg, served)
            _from_zimipedia(pg, "wikipedia", "Albert_Einstein")
            # A link asks first: its first sentence, and the way on.
            fr.locator('p a[href="./Physics"]').click()
            pg.wait_for_function(
                "() => { var c = document.getElementById('reader-frame').contentDocument.querySelector('.zw-card .zw-prev-s'); return c && c.textContent.trim(); }",
                timeout=10000,
            )
            s = _q(
                pg,
                "{ title: d.querySelector('.zw-prev-t').textContent, text: d.querySelector('.zw-prev-s').textContent, path: w.location.pathname }",
            )
            assert (
                s["title"] == "Physics"
                and s["text"]
                == "Physics is the science of matter, energy, space and time."
            ), s
            assert s["path"].endswith(
                "/Albert_Einstein"
            ), "the page stays until you choose"
            fr.locator(".zw-prev-go").click()
            pg.wait_for_function(
                "() => { var d = document.getElementById('reader-frame').contentDocument; return /\\/Physics$/.test(d.location.pathname) && d.querySelector('.zw-bar'); }",
                timeout=15000,
            )
            pg.wait_for_timeout(300)
            assert _q(
                pg,
                "Array.prototype.map.call(d.querySelectorAll('.zw-trail button, .zw-trail b'), function(x) { return x.textContent; })",
            ) == ["Albert Einstein", "Physics"]
            kept = pg.evaluate(
                "() => JSON.parse(localStorage.getItem('zimi_wiki_trails'))"
            )
            assert [s["path"] for s in kept[0]["items"]] == [
                "Albert_Einstein",
                "Physics",
            ]
            # A second tap on a link follows it; back along the trail cuts it there.
            link = fr.locator('p a[href="./Albert_Einstein"]')
            link.click()
            pg.wait_for_timeout(300)
            link.click()
            pg.wait_for_function(
                "() => { var d = document.getElementById('reader-frame').contentDocument; return /\\/Albert_Einstein$/.test(d.location.pathname) && d.querySelector('.zw-bar'); }",
                timeout=15000,
            )
            pg.wait_for_timeout(300)
            assert (
                _q(pg, "d.querySelector('.zw-trail')") is None
            ), "Einstein again: the trail is back to its start"
            # Read next: the lead's links, after the article, their lines when near.
            _q(pg, "d.querySelector('.zw-next').scrollIntoView()")
            pg.wait_for_function(
                "() => { var e = document.getElementById('reader-frame').contentDocument.querySelector('.zw-next em'); return e && e.textContent; }",
                timeout=10000,
            )
            nxt = _q(
                pg,
                "Array.prototype.map.call(d.querySelectorAll('.zw-next b'), function(b) { return b.textContent; })",
            )
            assert nxt == ["Physics", "Energy"], nxt
        finally:
            br.close()


def test_saving_to_reading_lists(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        pg = ctx.new_page()
        fr = pg.frame_locator("#reader-frame")
        try:
            _boot(pg, served)
            _from_zimipedia(pg, "wikipedia", "Albert_Einstein")
            assert (
                pg.evaluate("() => _savedRefOnScreen().app") == "wiki"
            ), "the header's button files it under Zimipedia too"
            fr.locator(".zw-sbtn").click()
            pg.wait_for_timeout(300)
            fr.locator(".zw-save-row").click()
            item = pg.evaluate(
                "() => Saved.get({ zim: 'wikipedia', path: 'Albert_Einstein' })"
            )
            assert (
                item
                and item["app"] == "wiki"
                and item["kind"] == "article"
                and item["title"] == "Albert Einstein"
            ), item
            assert _q(pg, "d.querySelector('.zw-sbtn').classList.contains('on')")
            # A new reading list, the article in it; and Liked.
            fr.locator(".zw-new input").fill("Physicists")
            fr.locator(".zw-new button").click()
            pg.wait_for_timeout(200)
            fr.locator('.zw-lists button[data-list="liked"]').click()
            lists = pg.evaluate(
                "() => Saved.get({ zim: 'wikipedia', path: 'Albert_Einstein' }).lists"
            )
            names = pg.evaluate(
                "(ids) => ids.map(function(id) { var l = Saved.lists().filter(function(x) { return x.id === id; })[0]; return l.builtin ? 'Liked' : l.name; })",
                lists,
            )
            assert sorted(names) == ["Liked", "Physicists"], names
            assert (
                pg.evaluate(
                    "() => Saved.lists({ app: 'wiki' }).filter(function(l) { return l.name === 'Physicists'; })[0].count"
                )
                == 1
            )
            # Taken back out.
            fr.locator(".zw-save-row").click()
            assert (
                pg.evaluate(
                    "() => Saved.has({ zim: 'wikipedia', path: 'Albert_Einstein' })"
                )
                is False
            )
        finally:
            br.close()


def test_today_is_a_front_door(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        pg = ctx.new_page()
        fr = pg.frame_locator("#reader-frame")
        page = lambda js: pg.evaluate(
            "() => { var d = document.getElementById('reader-frame').contentDocument; return ("
            + js
            + "); }"
        )  # noqa: E731
        try:
            _boot(pg, served)
            _from_zimipedia(pg, "wikipedia", "Albert_Einstein")
            # Part way through, then one link further.
            _q(
                pg,
                "w.scrollTo(0, (d.documentElement.scrollHeight - w.innerHeight) * 0.4)",
            )
            pg.wait_for_timeout(500)
            _q(pg, "w.dispatchEvent(new Event('pagehide'))")
            _q(pg, "w.scrollTo(0, 0)")
            fr.locator('p a[href="./Physics"]').click()
            pg.wait_for_timeout(300)
            fr.locator(".zw-prev-go").click()
            pg.wait_for_function(
                "() => /\\/Physics$/.test(document.getElementById('reader-frame').contentDocument.location.pathname)",
                timeout=15000,
            )
            pg.wait_for_timeout(300)
            # Zimipedia's front door: the day's article, where you were, the trail.
            pg.evaluate("() => openWiki()")
            pg.wait_for_function(
                "() => { var d = document.getElementById('reader-frame').contentDocument; return d && d.querySelector('#s-continue') && d.querySelector('#s-trails') && d.querySelector('.hero'); }",
                timeout=20000,
            )
            s = page(
                """{ cont: Array.prototype.map.call(d.querySelectorAll('#s-continue .t'), function(t) { return t.textContent; }),
              prog: d.querySelector('#s-continue .prog i').style.width, href: d.querySelector('#s-continue a').getAttribute('data-path'),
              trail: Array.prototype.map.call(d.querySelectorAll('#s-trails a'), function(a) { return a.textContent; }),
              old: !!d.querySelector('#s-otd,#s-dyk,#s-potd,#s-trail,#s-front,#s-wk') }"""
            )
            assert s["cont"] == ["Albert Einstein"] and s["prog"] not in ("", "0%"), s
            assert s["href"].startswith(
                "Albert_Einstein#"
            ), "back in at the section you were in"
            assert s["trail"] == ["Albert Einstein", "Physics"], s
            assert not s["old"], "1.11's front page is gone"
            # A trail's step goes back in, with the trail as it was.
            pg.frame_locator("#reader-frame").locator("#s-trails a").nth(1).click()
            pg.wait_for_function(READY, timeout=15000)
            pg.wait_for_timeout(300)
            assert _q(
                pg,
                "Array.prototype.map.call(d.querySelectorAll('.zw-trail button, .zw-trail b'), function(x) { return x.textContent; })",
            ) == ["Albert Einstein", "Physics"]
        finally:
            br.close()


def test_the_day_works_out_only_what_the_front_door_shows(library):
    import datetime

    day = datetime.date.today().strftime("%Y%m%d")
    names = [w["name"] for w in wiki.wikis()]
    wiki._warm(day, names)
    assert (
        wiki._pick_cache
        and not wiki._otd_cache
        and not wiki._extra_cache
        and not wiki._front_cache
    )
    got = wiki.today(day, ["wikipedia"], ["picks"])
    assert set(got) == {"picks", "failed"} and got["picks"]["wikipedia"]["path"]
    # The API still answers the rest when asked.
    assert set(wiki.today(day, ["wikipedia"])) == {
        "picks",
        "otd",
        "extras",
        "front",
        "failed",
    }


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


# ── the lookup beside an article: languages, level, a mini's full build, the topic ──


@pytest.fixture
def library(tmp_path, monkeypatch):
    import wiki_fixture

    zdir = str(tmp_path / "zims")
    wiki_fixture.build_library(zdir)
    monkeypatch.setattr(srv, "ZIM_DIR", zdir)
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    wiki._reset_for_tests()
    srv.load_cache(force=True)
    wiki_fixture.index_wikipedias()
    yield


def test_an_article_knows_its_languages_its_simple_twin_and_its_sister_pages(library):
    got = wiki.article("wikipedia", "Albert_Einstein")
    assert got["qid"] == "Q937" and got["flavour"] == "maxi"
    assert [(lg["lang"], lg["zim"]) for lg in got["languages"]] == [
        ("he", "wikipedia_he")
    ]
    assert got["level"] == {
        "zim": "wikipedia_en_simple",
        "path": "Albert_Einstein",
        "title": "Albert Einstein",
        "simple": True,
    }
    assert got["full"] is None
    # Its own sister links name the pages: Wikisource's author page included.
    assert {t["project"]: t["path"] for t in got["topic"]} == {
        "wikiquote": "Albert_Einstein",
        "wikisource": "Author:Albert_Einstein",
    }


def test_a_mini_borrows_its_qid_and_points_to_the_full_article(library):
    got = wiki.article("wikipedia_en", "Albert_Einstein")
    assert got["flavour"] == "mini"
    assert got["qid"] == "Q937", "the same page of a fuller build of the language"
    assert [lg["lang"] for lg in got["languages"]] == [
        "he"
    ], "so the language switch still works"
    assert got["full"] == {
        "zim": "wikipedia",
        "path": "Albert_Einstein",
        "title": "Albert Einstein",
    }


def test_simple_english_is_a_reading_level_not_a_language(library):
    import wiki_fixture

    got = wiki.article("wikipedia_en_simple", "Albert_Einstein")
    assert got["level"]["zim"] == "wikipedia" and got["level"]["simple"] is False
    # From Hebrew, English is the full English Wikipedia, never Simple.
    he = wiki.article("wikipedia_he", wiki_fixture.HE_TITLE)
    assert [(lg["lang"], lg["zim"]) for lg in he["languages"]] == [("en", "wikipedia")]


def test_a_word_is_found_in_the_dictionary_in_lower_case(library):
    got = wiki.article("wikipedia", "Physics")
    assert got["qid"] == "" and got["languages"] == [] and got["level"] is None
    assert [(t["project"], t["path"]) for t in got["topic"]] == [
        ("wiktionary", "physics")
    ]
    assert wiki.article("wikipedia", "No_such_page") is None
    assert wiki.article("not_a_wiki", "Albert_Einstein") is None
