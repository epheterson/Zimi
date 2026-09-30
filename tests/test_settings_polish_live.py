"""Settings and the reading surfaces as Eric met them on his iPhone (1.12's
polish pass), in a real browser at 390x844 touch:

- Settings > Preferences: every app is the same row with the same switch,
  "Open articles in apps" sits with them, and every on/off in the pane is
  that one switch row (no loose checkboxes). A tap on a row flips it.
- Settings > Library: the catalog/local split sits under the ZIM count,
  quieter, not under Auto-update.
- Nothing zooms by accident: a double tap is a tap, and every field and
  menu on a touch screen is 16px (iOS zooms into any smaller one it focuses).
  No pinch-zoom either: the viewport caps the scale and iOS's pinch is
  cancelled in the shell, the reader's document and the app pages.
- The book's reading settings leave the page undimmed, and Auto's swatch is
  the sepia and dark Auto actually paints, not a white page it never gives.
- The Saved panel's group of things in no list is called Saved.

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
    assert split["labels"] == ["From the catalog", "Local"], split
    assert sum(split["values"]) == split["total"], split
    assert split["in_auto_update"] == 0
    assert pg.evaluate(SMALL_FIELDS) == []


def test_nothing_zooms_by_accident(served, phone):
    pg = phone
    pg.goto(served + "/")
    pg.wait_for_function(READY, timeout=30000)
    got = pg.evaluate(
        """() => ({ ta: getComputedStyle(document.documentElement).touchAction,
      vp: document.querySelector('meta[name=viewport]').content })"""
    )
    assert got["ta"] == "manipulation", got
    # No zoom at all: the viewport caps it, and iOS's pinch (which ignores
    # the cap) is cancelled in the shell and in the reader's document.
    assert "maximum-scale=1" in got["vp"] and "user-scalable=no" in got["vp"], got
    assert pg.evaluate("(" + PINCH_CANCELLED + ")(document)") is True
    assert pg.evaluate(SMALL_FIELDS) == []
    # An article in the reader, and an app page on its own.
    pg.evaluate("() => openArticle('hlwiki', 'A/Lighthouse')")
    pg.wait_for_function(
        "() => { var d = document.getElementById('reader-frame').contentDocument; return d && d.__zimiNoPinch; }",
        timeout=15000,
    )
    assert pg.evaluate(
        "(" + PINCH_CANCELLED + ")(document.getElementById('reader-frame').contentDocument)"
    )
    pg.goto(served + "/static/tube.html")
    vp = pg.evaluate("() => document.querySelector('meta[name=viewport]').content")
    assert "user-scalable=no" in vp, vp
    assert pg.evaluate("(" + PINCH_CANCELLED + ")(document)") is True
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


def test_the_things_in_no_list_are_called_saved(served, phone):
    pg = phone
    pg.goto(served + "/")
    pg.wait_for_function(READY, timeout=30000)
    pg.evaluate(
        """() => { var a = Saved.save({kind: 'article', zim: 'hlwiki', path: 'A/Lighthouse', title: 'Lighthouse'});
      Saved.save({kind: 'article', zim: 'hlwiki', path: 'A/Plain', title: 'Plain'});
      Saved.addToList(a, Saved.createList('Trip')); toggleLibraryPanel('bookmarks'); }"""
    )
    pg.wait_for_selector("#bm-tree")
    names = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#bm-tree .bm-folder .bm-name')).map(n => n.textContent)"
    )
    assert "Saved" in names and "Not in a list" not in names, names
    # The header and its actions are one short band on a phone.
    top = pg.evaluate(
        "() => document.querySelector('#bm-tree .bm-row').getBoundingClientRect().top - document.getElementById('history-panel').getBoundingClientRect().top"
    )
    assert top <= 112, top
