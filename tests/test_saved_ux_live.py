"""The Saved panel, the list picker and the highlight bar as a person meets
them (1.12's UX pass), in a real browser:

- First use: the panel says how to save something, with no empty Liked
  under it; an empty list's menu offers no export that could not run.
- A phone: every control in the panel is a thumb's size, and Tab leaves the
  tree in one stop (the rows' menus are reached by the menu key).
- New list: the name is typed where the list will be.
- Right to left: what a list holds is indented from the right, the menus
  line up, a highlight's note follows the chrome's alignment.
- The Lists picker: each list says whether it is ticked (to a screen
  reader too), and opened by a tap none looks chosen before it is.
- One Save on a question, the page's own; B keeps what it keeps.
- The highlight bar: every button a thumb's size, and Russian on a 360px
  phone fits without a word running out of its button.

Run: pytest tests/test_saved_ux_live.py -v
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
PHONE = {
    "viewport": {"width": 390, "height": 844},
    "has_touch": True,
    "is_mobile": True,
}
QUESTION = "questions/567/how-can-i-chop-onions-without-crying"
SEED = """() => {
  var S = Saved;
  var a = S.save({kind: 'article', zim: 'hlwiki', path: 'A/Lighthouse', title: 'Lighthouse'});
  S.save({kind: 'article', zim: 'hlwiki', path: 'A/Plain', title: 'Plain'});
  var trip = S.createList('Portugal trip');
  S.addToList(a, trip);
  S.addToList(a, S.LIKED);
  S.highlight({zim: 'hlwiki', path: 'A/Lighthouse', kind: 'article', title: 'Lighthouse', exact: 'trusted the old lighthouse',
    prefix: 'inthefog', suffix: 'totakethem', pos: 0.08, color: 'green', note: 'A note'});
}"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from app_saved_fixture import build_library
    from test_highlights_live import _wiki

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("saved_ux")
    build_library(tmp / "zims")
    _wiki(str(tmp / "zims" / "hlwiki_en_all_2026-01.zim"))
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


@pytest.fixture
def browser():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        yield br
        br.close()


def _page(br, base, lang=None, seed=True, **ctx):
    pg = br.new_context(**(ctx or PHONE)).new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base + "/")
    pg.wait_for_function(READY, timeout=30000)
    pg.evaluate(
        "(l) => { localStorage.clear(); if (l) localStorage.setItem('zimi_ui_lang', l); }",
        lang,
    )
    pg.reload()
    pg.wait_for_function(READY, timeout=30000)
    if seed:
        pg.evaluate(SEED)
    pg.errors = errors
    return pg


def _panel(pg):
    pg.evaluate("() => toggleLibraryPanel('bookmarks')")
    pg.wait_for_selector("#bm-tree")


def _rect(pg, sel):
    return pg.evaluate(
        "(s) => { var r = document.querySelector(s).getBoundingClientRect(); return {l: r.left, r: r.right, t: r.top, h: r.height, w: r.width}; }",
        sel,
    )


def test_first_use_then_a_phone_sized_panel(served, browser):
    pg = _page(browser, served, seed=False)
    _panel(pg)
    assert "Nothing saved yet" in pg.inner_text("#history-panel .hp-empty")
    assert not pg.query_selector(
        '.bm-folder[data-fid="liked"]'
    ), "an empty Liked under the note"
    pg.evaluate(SEED)
    pg.evaluate("() => { Saved.createList('Empty'); _bmRerender(); }")
    # Every control a thumb's size on a touch screen.
    small = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#history-panel .hp-clear, #history-panel .hp-action-btn, #bm-tree .bm-row, #bm-tree button.bm-gear'))"
        ".map(e => [e.className, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]).filter(x => x[1] < 44 || x[2] < 44)"
    )
    assert not small, small
    # Tab leaves the tree in one stop: its rows' menus are out of the order.
    assert pg.evaluate(
        "() => Array.from(document.querySelectorAll('#bm-tree .bm-gear')).every(g => g.tabIndex < 0)"
    )
    # An empty list: rename and delete, no export that would open with Export off.
    lid = pg.evaluate("() => Saved.lists().filter(l => l.name === 'Empty')[0].id")
    pg.locator('.bm-folder[data-fid="%s"] .bm-gear' % lid).tap()
    pg.wait_for_selector("#zim-ctx-menu.visible")
    acts = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#zim-ctx-menu .ctx-item')).map(i => i.dataset.action)"
    )
    assert acts == ["rename", "delete"], acts
    assert not pg.errors, pg.errors


def test_new_list_is_typed_where_it_lands(served, browser):
    pg = _page(browser, served)
    _panel(pg)
    pg.get_by_role("button", name="New list").tap()
    after = pg.evaluate(
        "() => { var n = document.querySelector('.bm-newfolder').nextElementSibling; return n && n.dataset.fid; }"
    )
    assert after == "", "the box is not just above Bookmarks: %r" % after
    pg.locator(".bm-newfolder-input").fill("Groceries")
    pg.locator(".bm-newfolder-input").press("Enter")
    pg.wait_for_timeout(200)
    order = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#bm-tree .bm-folder .bm-name')).map(n => n.textContent)"
    )
    assert order[order.index("Groceries") + 1] == "Bookmarks", order


def test_a_removal_says_so_and_can_be_undone(served, browser):
    """Remove from Saved (and a highlight) says so, with Undo; Undo puts the
    item back in its lists, where it stood."""
    pg = _page(browser, served)
    _panel(pg)
    key = "hlwiki\nA/Lighthouse"
    row = '#bm-tree .bm-bk[data-key="%s"]' % key.replace("\n", "\\a ")
    pg.evaluate("(k) => _savedRemoveUndoable(k)", key)
    pg.wait_for_selector(".toast-undo")
    assert "Removed from Saved" in pg.inner_text(".toast-undo")
    assert not pg.evaluate("(k) => Saved.has(k)", key)
    pg.locator(".toast-undo button").tap()
    pg.wait_for_timeout(200)
    assert pg.evaluate(
        "(k) => Saved.has(k) && Saved.inList(k, Saved.LIKED) && Saved.lists().some(l => l.name === 'Portugal trip' && Saved.inList(k, l.id))",
        key,
    ), "back in Liked and in its list"
    assert pg.locator(row).count() >= 1, "and back in the panel"
    hid = pg.evaluate("() => Saved.highlights({})[0].id")
    pg.evaluate("(h) => _savedRemoveHighlight(h)", hid)
    pg.wait_for_selector(".toast-undo")
    assert "Highlight removed" in pg.inner_text(".toast-undo")
    pg.locator(".toast-undo button").tap()
    pg.wait_for_timeout(200)
    h = pg.evaluate("(h) => Saved.getHighlight(h)", hid)
    assert h and h["note"] == "A note" and h["color"] == "green", h
    assert not pg.errors, pg.errors


def test_right_to_left_tree(served, browser):
    pg = _page(browser, served, lang="he")
    _panel(pg)
    folder = _rect(pg, '.bm-folder[data-fid="liked"] .bm-ficon')
    item = _rect(pg, '.bm-bk[data-fid="liked"] .bm-bicon')
    assert (
        item["r"] < folder["r"] - 8
    ), "an item in a list is indented from the right (%r, %r)" % (folder, item)
    gears = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#bm-tree .bm-gear')).map(g => Math.round(g.getBoundingClientRect().left))"
    )
    assert max(gears) - min(gears) <= 1, "the menus line up: %r" % gears
    assert (
        pg.evaluate(
            "() => getComputedStyle(document.querySelector('.bm-hl .bm-sub')).textAlign"
        )
        == "right"
    )


def test_list_picker_says_what_is_ticked(served, browser):
    pg = _page(browser, served)
    _panel(pg)
    pg.locator('.bm-bk[data-fid="liked"] .bm-gear').tap()
    pg.wait_for_selector("#zim-ctx-menu.visible")
    pg.wait_for_timeout(100)
    # Opened by a tap: the first item has focus for the keyboard's sake, and
    # is not painted as if it were chosen.
    bg = pg.evaluate(
        "() => { var f = document.querySelector('#zim-ctx-menu .ctx-item'); return [document.activeElement === f, getComputedStyle(f).backgroundColor]; }"
    )
    assert bg == [True, "rgba(0, 0, 0, 0)"], bg
    pg.locator("#zim-ctx-menu .ctx-item:has(.ctx-sub)").tap()
    rows = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#zim-ctx-menu .ctx-sub .ctx-item[data-action=toggle-list]')).map(i => i.getAttribute('role') + ' ' + i.getAttribute('aria-checked') + ' ' + i.textContent.replace(/^\\u2713/, ''))"
    )
    assert rows == [
        "menuitemcheckbox true Liked",
        "menuitemcheckbox true Portugal trip",
    ], rows


def test_one_save_on_a_question_and_b_keeps_what_it_keeps(served, browser):
    pg = _page(browser, served, seed=False)
    pg.evaluate("() => openExchange()")
    fr = pg.frame_locator("#reader-frame")
    fr.locator(".row .t >> visible=true").first.click()
    fr.locator(".svbar .svb").first.wait_for()
    # Its Lists, tapped in the page: no list looks chosen before one is
    # (focus coming out of the frame painted the first as the keyboard's).
    fr.locator(".svb[data-sv=lists]").tap()
    pg.wait_for_selector("#zim-ctx-menu.visible")
    pg.wait_for_timeout(150)
    painted = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#zim-ctx-menu .ctx-item')).filter(i => getComputedStyle(i).backgroundColor !== 'rgba(0, 0, 0, 0)').map(i => i.textContent)"
    )
    assert painted == [], painted
    pg.evaluate("() => _closeMenu()")
    # One Save: the page's own. The header offers no second bookmark for
    # the same question; B (the header's key) makes the same row, votes and all.
    assert not pg.locator("#library-btn").is_visible()
    pg.evaluate("() => document.activeElement && document.activeElement.blur()")
    pg.keyboard.press("b")
    pg.wait_for_function("() => Saved.itemsFor({app: 'exchange'}).length === 1")
    it = pg.evaluate("() => Saved.itemsFor({app: 'exchange'})[0]")
    assert it["kind"] == "question" and it["path"] == QUESTION
    assert (it.get("meta") or {}).get("votes") == 265, it
    pg.wait_for_function(
        "() => document.getElementById('reader-frame').contentDocument.querySelector('.svb[data-sv=save]').classList.contains('on')"
    )


@pytest.mark.parametrize("lang,width", [("ru", 360), ("en", 390)])
def test_highlight_bar_fits_a_phone(served, browser, lang, width):
    ctx = dict(PHONE, viewport={"width": width, "height": 780})
    pg = _page(browser, served, lang=lang, **ctx)
    pg.evaluate("() => openArticle('hlwiki', 'A/Lighthouse')")
    pg.wait_for_function(
        "() => { var f = document.getElementById('reader-frame'), w = f && f.contentWindow; var n = 0; w && w.CSS && w.CSS.highlights && w.CSS.highlights.forEach(function () { n++; }); return n > 0; }",
        timeout=20000,
    )
    at = pg.evaluate(
        """() => { var f = document.getElementById('reader-frame'), w = f.contentWindow, rr = null;
        w.CSS.highlights.forEach(function (h) { h.forEach(function (x) { rr = rr || x; }); });
        var b = rr.getClientRects()[0], o = f.getBoundingClientRect(); return {x: o.left + b.left + 5, y: o.top + b.top + b.height / 2}; }"""
    )
    pg.touchscreen.tap(at["x"], at["y"])
    pg.wait_for_selector("#hl-bar.open")
    m = pg.evaluate(
        """() => { var b = document.getElementById('hl-bar'), r = b.getBoundingClientRect();
        var bs = Array.from(b.querySelectorAll('button'));
        return {inside: r.left >= 0 && r.right <= innerWidth, spill: bs.filter(x => x.scrollWidth > x.clientWidth + 1).length,
          small: bs.filter(x => x.getBoundingClientRect().height < 44 || x.getBoundingClientRect().width < 44).length,
          word: getComputedStyle(b.querySelector('.hl-note-btn > span')).display !== 'none',
          label: b.querySelector('.hl-note-btn').getAttribute('aria-label')}; }"""
    )
    assert m["inside"] and not m["spill"] and not m["small"], m
    # English keeps Note's word at 390px; the label says the note is there.
    if lang == "en":
        assert m["word"] and m["label"] == "Edit note", m
    assert not pg.errors, pg.errors
