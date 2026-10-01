"""Settings and the reading surfaces as Eric met them on his iPhone (1.12's
polish pass), in a real browser at 390x844 touch:

- Settings > Preferences: every app is the same row with the same switch,
  "Open articles in apps" sits with them, and every on/off in the pane is
  that one switch row (no loose checkboxes). A tap on a row flips it.
- Settings > Library: the catalog/local split sits under the ZIM count,
  quieter, not under Auto-update.
- Nothing zooms by accident: a double tap is a tap, and every field and
  menu on a touch screen is 16px (iOS zooms into any smaller one it focuses).
  A pinch zooms; nothing zooms on its own.
- The book's reading settings leave the page undimmed, and Auto's swatch is
  the sepia and dark Auto actually paints, not a white page it never gives.
- History and Saved are two panels: the clock opens History (Continue at
  its head), a bookmarks mark opens Saved (its loose items are Bookmarks).

Run: pytest tests/test_settings_polish_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

READY = "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0"
SMALL_FIELDS = """() => Array.from(document.querySelectorAll(
  'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=file]), select, textarea'))
  .filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id || e.className || e.tagName)"""


# A synthetic iOS pinch: is its gesturestart cancelled?
PINCH_CANCELLED = """(doc) => { var e = new (doc.defaultView.Event)('gesturestart', {cancelable: true, bubbles: true});
  doc.body.dispatchEvent(e); return e.defaultPrevented; }"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from app_saved_fixture import build_library
    from conftest_zim import _MediaItem
    from libzim.writer import Creator
    from test_book_reader import FILES, G2Z
    from test_highlights_live import _wiki

    from zimi import books
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("settings_polish")
    zdir = tmp / "zims"
    build_library(zdir)
    _wiki(str(zdir / "hlwiki_en_all_2026-01.zim"))
    with Creator(str(zdir / "gutenberg_mul_all_2026-01.zim")).config_indexing(
        False, "eng"
    ) as cr:
        cr.set_mainpath("Liber.1")
        for fpath, blob in FILES.items():
            mime = "application/javascript" if fpath.endswith(".js") else "text/html"
            cr.add_item(_MediaItem(fpath, mime, blob))
        for key, value in {
            "Scraper": G2Z,
            "Name": "gutenberg_mul_all",
            "Title": "Library",
            "Language": "eng",
            "Description": "books",
            "Date": "2026-01-04",
        }.items():
            cr.add_metadata(key, value)
    old_details = books.request_details
    books.request_details = lambda name: None
    books._reset_for_tests()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(zdir), str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    books.request_details = old_details


@pytest.fixture
def phone():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"])
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        yield pg
        br.close()


def test_preferences_are_one_row_shape(served, phone):
    pg = phone
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_selector("#ms-apps .app-pick", timeout=15000)
    pane = pg.evaluate("""() => {
      var p = document.getElementById('ms-pane');
      var labels = Array.from(p.querySelectorAll('.ms-section-label')).map(l => l.firstChild.textContent.trim());
      var openRow = document.getElementById('ms-open-in-apps').closest('.set-row');
      var display = Array.from(p.querySelectorAll('.ms-section-label')).find(l => /Display/i.test(l.textContent));
      return {
        labels: labels,
        apps: p.querySelectorAll('#ms-apps .set-row.app-pick').length,
        appsWithSwitch: p.querySelectorAll('#ms-apps .set-row.app-pick .switch input[role=switch]').length,
        rowHeights: Array.from(p.querySelectorAll('#ms-apps .set-row')).map(r => Math.round(r.getBoundingClientRect().height)),
        looseChecks: p.querySelectorAll('.ms-check').length,
        openBeforeDisplay: !!(openRow.compareDocumentPosition(display) & Node.DOCUMENT_POSITION_FOLLOWING),
        readingSwitches: ['ms-reader-auto', 'ms-darken-articles'].every(id => document.getElementById(id).closest('.set-row')),
      };
    }""")
    assert pane["apps"] >= 5 and pane["appsWithSwitch"] == pane["apps"], pane
    assert max(pane["rowHeights"]) - min(pane["rowHeights"]) <= 1, (
        "the apps are all sorts of shapes: %s" % pane["rowHeights"]
    )
    assert pane["looseChecks"] == 0, "a checkbox outside the switch rows"
    assert pane["openBeforeDisplay"], "Open articles in apps is not with the apps"
    assert pane["readingSwitches"]
    assert (
        "Reader" not in pane["labels"] and "Accessibility" not in pane["labels"]
    ), pane["labels"]
    # A tap on the row flips its switch, and the setting follows.
    was = pg.evaluate("() => _openInApps()")
    pg.locator("#ms-open-in-apps").locator("xpath=ancestor::label").tap()
    assert pg.evaluate("() => _openInApps()") is (not was)
    assert pg.evaluate(SMALL_FIELDS) == []
    assert not pg.errors, pg.errors


def test_apps_paint_in_their_final_shape_with_discover(served, phone):
    """The apps list is drawn with the pane, not after /manage/apps answers:
    nothing below it moves while it loads. Discover is one of its rows."""
    pg = phone
    # /manage/apps answers late, as it does on a slow link.
    pg.add_init_script(
        """(() => { var f = window.fetch; window.fetch = function(u) { var a = arguments, self = this;
      if (String(u).indexOf('/manage/apps') >= 0) return new Promise(r => setTimeout(r, 800)).then(() => f.apply(self, a));
      return f.apply(self, a); }; })()"""
    )
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_selector("#ms-open-in-apps", state="attached", timeout=15000)
    where = """() => ({ apps: document.querySelectorAll('#ms-apps .app-pick').length,
      hidden: document.getElementById('ms-apps-wrap').hidden,
      all: document.querySelectorAll('#ms-apps-all button').length,
      open: Math.round(document.getElementById('ms-open-in-apps').closest('.set-row').getBoundingClientRect().top) })"""
    first = pg.evaluate(where)
    pg.wait_for_timeout(1600)
    last = pg.evaluate(where)
    assert first["apps"] >= 5 and not first["hidden"] and first["all"] == 2, first
    assert first == last, (first, last)
    discover = pg.evaluate(
        """() => { var r = document.getElementById('ms-show-discover').closest('.set-rows');
      return r === document.getElementById('ms-open-in-apps').closest('.set-rows'); }"""
    )
    assert discover, "Show Discover is not with the apps"


def test_every_settings_on_off_is_a_switch(served, phone):
    pg = phone
    for section in ("library", "preferences", "creator", "server", "users"):
        pg.goto(served + "/?manage=" + section)
        pg.wait_for_timeout(1800)
        if section == "users":
            pg.evaluate("() => { var b = document.getElementById('add-user-toggle'); if (b) b.click(); }")
            pg.wait_for_timeout(300)
        loose = pg.evaluate(
            """() => Array.from(document.querySelectorAll('#ms-pane input[type=checkbox]'))
          .filter(i => !i.closest('.switch') && !i.closest('.ms-allowlist-picker, #ms-hot-zims'))
          .map(i => i.id || i.className || i.outerHTML.slice(0, 60))"""
        )
        assert loose == [], (section, loose)
    # The Almanac's satellite setting is the Earth view's, not Settings'.
    pg.goto(served + "/?manage=server")
    pg.wait_for_selector("#ms-net", state="attached", timeout=15000)
    pg.wait_for_timeout(1000)
    assert pg.locator("#ms-sat-mode").count() == 0
    assert not pg.errors, pg.errors


def test_library_split_sits_under_the_count(served, phone):
    pg = phone
    pg.goto(served + "/?manage=library")
    pg.wait_for_selector("#ms-lib-split .mc-sub", timeout=15000)
    split = pg.evaluate("""() => {
      var c = document.getElementById('ms-zim-count').closest('.mc-row');
      var s = document.getElementById('ms-lib-split');
      var rows = Array.from(s.querySelectorAll('.mc-sub'));
      return { right_after: c.nextElementSibling === s,
        labels: rows.map(r => r.querySelector('.mc-label').textContent),
        values: rows.map(r => +r.querySelector('.mc-value').textContent),
        total: +document.getElementById('ms-zim-count').textContent,
        quieter: parseFloat(getComputedStyle(rows[0]).fontSize) < parseFloat(getComputedStyle(c).fontSize),
        in_auto_update: document.querySelectorAll('#ms-auto-update .mc-sub').length };
    }""")
    assert split["right_after"] and split["quieter"], split
    assert split["labels"] == ["Catalog", "Local"], split
    assert sum(split["values"]) == split["total"], split
    assert split["in_auto_update"] == 0
    assert pg.evaluate(SMALL_FIELDS) == []


def test_nothing_zooms_by_accident(served, phone):
    """A pinch zooms (Eric, 2026-10-01: "Maybe I still did want pinch to zoom
    just not text or any auto"); nothing zooms on its own: no double-tap
    zoom, and no zoom into a focused field."""
    pg = phone
    pg.goto(served + "/")
    pg.wait_for_function(READY, timeout=30000)
    got = pg.evaluate(
        """() => ({ ta: getComputedStyle(document.documentElement).touchAction,
      vp: document.querySelector('meta[name=viewport]').content })"""
    )
    assert got["ta"] == "manipulation", got
    assert "user-scalable=no" not in got["vp"] and "maximum-scale" not in got["vp"], got
    assert pg.evaluate("(" + PINCH_CANCELLED + ")(document)") is False
    assert pg.evaluate(SMALL_FIELDS) == []
    pg.goto(served + "/static/tube.html")
    vp = pg.evaluate("() => document.querySelector('meta[name=viewport]').content")
    assert "user-scalable=no" not in vp, vp
    assert pg.evaluate("(" + PINCH_CANCELLED + ")(document)") is False
    pg.goto(served + "/?manage=server")
    pg.wait_for_timeout(1500)
    assert pg.evaluate(SMALL_FIELDS) == []


def test_book_settings_leave_the_page_and_auto_is_what_it_paints(served, phone):
    pg = phone
    pg.goto(served + "/")
    pg.wait_for_function(READY, timeout=30000)
    pg.evaluate(
        "() => { _setReaderTheme('auto'); openArticle('gutenberg_mul', 'Liber.1'); }"
    )
    pg.wait_for_function(
        "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.querySelector('.zb-aa'); }",
        timeout=30000,
    )
    pg.wait_for_timeout(500)
    fr = pg.frame_locator("#reader-frame")
    fr.locator(".zb-aa").click()
    pg.wait_for_timeout(500)
    got = pg.evaluate(
        """() => { var d = document.getElementById('reader-frame').contentDocument;
      var w = d.defaultView;
      return { scrim: w.getComputedStyle(d.querySelector('.zb-scrim')).backgroundColor,
        open: d.documentElement.classList.contains('zb-set-open'),
        auto: w.getComputedStyle(d.querySelector('.zb-dot-auto')).backgroundImage }; }"""
    )
    assert got["open"], got
    assert got["scrim"] in ("rgba(0, 0, 0, 0)", "transparent"), got
    # Sepia (244, 236, 216) and dark (10, 10, 11); no light page (251, 251, 249).
    assert "244, 236, 216" in got["auto"] and "10, 10, 11" in got["auto"], got
    assert "251, 251, 249" not in got["auto"], got
    # The contents sheet still dims: there the page is behind, not the subject.
    fr.locator(".zb-scrim").click(position={"x": 20, "y": 20})
    assert pg.evaluate(
        "() => !document.getElementById('reader-frame').contentDocument.documentElement.classList.contains('zb-set-open')"
    )


def test_history_and_saved_are_two_panels(served, phone):
    """Eric: "continue should be under history ... while saved is everything
    the user intentionally tapped without reusing that word and both under
    the clock is weird". The clock opens History, Continue at its head; the
    bookmarks mark opens Saved, whose loose items are Bookmarks, not Saved.
    Each header is one short band."""
    pg = phone
    pg.goto(served + "/")
    pg.wait_for_function(READY, timeout=30000)
    pg.evaluate(
        """() => { var a = Saved.save({kind: 'article', zim: 'hlwiki', path: 'A/Lighthouse', title: 'Lighthouse'});
      Saved.save({kind: 'article', zim: 'hlwiki', path: 'A/Plain', title: 'Plain'});
      Saved.addToList(a, Saved.createList('Trip'));
      Saved.setPosition({kind: 'book', app: 'books', zim: 'hlwiki', path: 'A/Lighthouse', title: 'A book'}, {f: 0.4}); }"""
    )
    # Home: the clock (library-btn) and the bookmarks mark (bm-panel-btn).
    assert pg.locator("#library-btn").is_visible() and pg.locator("#bm-panel-btn").is_visible()
    pg.locator("#library-btn").tap()
    pg.wait_for_selector("#history-panel.open")
    got = pg.evaluate(
        """() => ({ title: document.querySelector('.library-panel-title').textContent,
      tabs: document.querySelectorAll('.library-tab').length,
      first: document.querySelector('#history-panel .library-panel-header').nextElementSibling.id,
      rows: Array.from(document.querySelectorAll('#bm-tree .bm-row .bm-name')).map(n => n.textContent),
      head: Math.round(document.querySelector('#history-panel .library-panel-header').getBoundingClientRect().height),
      lit: document.getElementById('library-btn').classList.contains('panel-open') })"""
    )
    assert got["title"] == "History" and got["tabs"] == 0, got
    assert got["first"] == "bm-tree" and got["rows"] == ["Continue", "A book"], got
    assert got["head"] <= 50 and got["lit"], got
    # The bookmarks mark: Saved, no Continue, the loose items are Bookmarks.
    pg.locator("#bm-panel-btn").tap()
    pg.wait_for_selector("#bm-tree .bm-folder")
    got = pg.evaluate(
        """() => ({ title: document.querySelector('.library-panel-title').textContent,
      names: Array.from(document.querySelectorAll('#bm-tree .bm-folder .bm-name')).map(n => n.textContent),
      head: Math.round(document.querySelector('#history-panel .library-panel-header').getBoundingClientRect().height),
      top: document.querySelector('#bm-tree .bm-row').getBoundingClientRect().top - document.getElementById('history-panel').getBoundingClientRect().top,
      lit: [document.getElementById('bm-panel-btn').classList.contains('panel-open'), document.getElementById('library-btn').classList.contains('panel-open')] })"""
    )
    assert got["title"] == "Saved" and got["head"] <= 50, got
    assert "Bookmarks" in got["names"] and "Saved" not in got["names"], got
    assert "Continue" not in got["names"], got
    assert got["top"] <= 112 and got["lit"] == [True, False], got
    # The keyboard: H and B, Escape closes; Continue's tree takes arrows.
    pg.keyboard.press("Escape")
    pg.keyboard.press("h")
    pg.wait_for_selector("#history-panel.open .hp-continue")
    pg.focus("#bm-tree .bm-row")
    pg.keyboard.press("ArrowDown")
    assert pg.evaluate("() => document.activeElement.classList.contains('bm-bk')")
    pg.keyboard.press("Escape")
    pg.keyboard.press("b")
    pg.wait_for_selector("#history-panel.open #bm-tree .bm-folder")
    assert pg.evaluate("() => document.querySelector('.library-panel-title').textContent") == "Saved"
    # In the reader: the clock is history-btn, library-btn saves the page.
    pg.keyboard.press("Escape")
    pg.evaluate("() => openArticle('hlwiki', 'A/Lighthouse')")
    pg.wait_for_timeout(1200)
    shown = pg.evaluate(
        "() => ['history-btn', 'library-btn', 'bm-panel-btn'].map(id => getComputedStyle(document.getElementById(id)).display !== 'none')"
    )
    assert shown == [True, True, True], shown
    assert pg.evaluate("() => document.getElementById('library-btn').dataset.state") == "saved"
    pg.locator("#history-btn").tap()
    pg.wait_for_selector("#history-panel.open .hp-continue")
    assert pg.evaluate("() => document.getElementById('history-btn').classList.contains('panel-open')")
    # Nothing in the header crowds the search off a phone.
    assert pg.evaluate("() => document.getElementById('q').getBoundingClientRect().width") >= 100
    assert not pg.errors, pg.errors
