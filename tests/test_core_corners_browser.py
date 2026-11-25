"""Zimi's own corners on a phone (a design review of the 1.16 build, core list).

- a search that finds nothing runs its suggestion and says so, in one quiet line, with the typed words a tap away
- the search tips are a full-width sheet whose rows put their syntax into the box (explanations are plain text)
- a PDF that will not open gets the missing-page card, not a grey line
- Settings > Server > Add-ons says it is offline instead of "Could not load this list"

Run: pytest tests/test_core_corners_browser.py -v
"""

import os
import sys
import threading

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import zimi.server as srv  # noqa: E402
from conftest_zim import build_fixture_zim  # noqa: E402
from pdf_fixture import multipage_pdf  # noqa: E402
from zimi import http  # noqa: E402

PHONE = {"width": 390, "height": 844}


def _skip_without_browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")


@pytest.fixture
def base(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "wikipedia_en_all_2026-10.zim"))
    build_fixture_zim(
        str(zdir / "zimgit-water.zim"),
        {"Scraper": "nautiluszim 1.1.1", "Name": "zimgit-water"},
        files={"files/Here.pdf": multipage_pdf(2)},
    )
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    # A title index for the suggestion's vocabulary (words seen twice survive its prune), read before any search.
    from test_did_you_mean import _make_title_index
    from zimi import search

    _make_title_index(
        str(tmp_path / "data" / "titles"),
        "wikipedia",
        [
            "Water purification",
            "Water purification methods",
            "Boil water",
            "Fire",
            "Fire safety",
        ],
    )
    search._reset_vocab()
    search._ensure_vocab()
    search._join_vocab_build()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), http.ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.release_zim_handles(list(srv.get_zim_files()))


def _page(pw, scheme="dark"):
    br = pw.chromium.launch()
    ctx = br.new_context(
        viewport=PHONE,
        has_touch=True,
        is_mobile=True,
        color_scheme=scheme,
        service_workers="block",
    )
    return br, ctx.new_page()


def _search(pg, base, text):
    pg.goto(base + "/")
    # The box is in the page before the app's script has wired it: type once Home is drawn, or Enter can go nowhere.
    pg.wait_for_function("() => typeof mode !== 'undefined' && mode === 'home'", timeout=60_000)
    pg.fill("#q", text)
    pg.press("#q", "Enter")


@pytest.mark.local_gate   # the suggestion's second search outlasts a shared runner's wait; it passes on any desktop
def test_nothing_found_runs_the_suggestion(base):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw)
        _search(pg, base, "watr purifcation")
        pg.wait_for_selector(".dym-ran", timeout=30000)
        line = pg.inner_text(".dym-ran")
        assert "water purification" in line and "watr purifcation" in line
        assert pg.locator("a.result").count() >= 1
        assert "No results found" not in pg.inner_text("#output")
        # The typed words are a tap away; taking them keeps them (no second correction).
        pg.click(".dym-ran a[data-typed]")
        pg.wait_for_selector(".empty", timeout=30000)
        assert pg.input_value("#q") == "watr purifcation"
        assert pg.locator(".dym-ran").count() == 0
        br.close()


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_empty_hint_uses_the_secondary_text_colour(base, scheme):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw, scheme)
        # A word of its own per scheme: the server keeps a search's answer, and the second run must ask afresh.
        _search(pg, base, "zzzqqq" if scheme == "dark" else "qqqzzz")
        try:
            pg.wait_for_selector(".empty .hint", timeout=30000)
        except Exception:
            # Say what the page showed instead of only that the wait ran out.
            raise AssertionError("no hint under the empty line; the output was: " + repr(pg.inner_text("#output")[:400]))
        same = pg.evaluate(
            "() => { const h = document.querySelector('.empty .hint'), p = document.querySelector('.empty p');"
            " const hs = getComputedStyle(h), ps = getComputedStyle(p);"
            " return [hs.opacity, hs.color === ps.color]; }"
        )
        assert same == ["1", True]
        br.close()


def test_search_tips_are_a_full_width_sheet_of_real_rows(base):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw)
        pg.goto(base + "/")
        pg.wait_for_selector("#search-help")
        pg.click("#search-help")
        pg.wait_for_selector(".search-tips")
        box = pg.evaluate(
            "() => { const r = document.querySelector('.suggest-dropdown').getBoundingClientRect();"
            " return [r.left, r.width, r.bottom, innerWidth, innerHeight]; }"
        )
        assert box[0] == 0 and box[1] == box[3], box
        assert box[2] <= box[4], box  # not clipped at the foot
        # Explanations are text, not things that look pressable.
        assert pg.locator(".search-tips .search-chip").count() == 0
        assert pg.locator(".search-example-note").count() >= 5
        # A row puts its syntax into the box and closes; nothing is searched.
        row = pg.locator(".search-example").nth(1)
        syntax = row.locator(".search-example-q").inner_text()
        row.dispatch_event("mousedown")
        assert pg.input_value("#q") == syntax
        assert (
            pg.evaluate(
                "() => getComputedStyle(document.querySelector('.suggest-dropdown')).display"
            )
            == "none"
        )
        assert pg.evaluate("() => !document.querySelector('.results')")
        br.close()


def test_a_pdf_that_will_not_open_has_the_missing_page_card(base):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw)
        pg.goto(base + "/?a=zimgit-water%2Ffiles%2FNope.pdf")
        frame = None
        for _ in range(100):
            frame = next((f for f in pg.frames if "/static/pdfjs/" in f.url), None)
            if frame and frame.query_selector(".zp-msg main"):
                break
            pg.wait_for_timeout(200)
        assert frame is not None
        card = frame.inner_text(".zp-msg main")
        assert "files/Nope.pdf" in card
        assert "missing or damaged" in card
        assert frame.query_selector(".zp-msg-back") is not None
        # The card is a surface of its own (it can be pressed), not a grey line over the page.
        assert frame.evaluate(
            "() => getComputedStyle(document.querySelector('.zp-msg')).pointerEvents !== 'none'"
        )
        br.close()


def test_zimis_pieces_have_one_home_and_home_customizing_is_a_preference(base):
    """Offline Readiness (with the add-ons inside it) closes the Files tab; Server has no second add-ons list; Customize
    categories is in Preferences."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    def present(pg, section, sel):
        pg.evaluate("(s) => switchMs(s)", section)
        pg.wait_for_selector("#ms-pane > *", state="attached")
        return pg.evaluate("(q) => !!document.querySelector('#ms-pane ' + q)", sel)

    with sync_playwright() as pw:
        br, pg = _page(pw)
        pg.goto(base + "/")
        pg.wait_for_selector("#q")
        pg.evaluate("() => enterManage(null, 'library')")
        pg.wait_for_selector(".offline-fold", state="attached", timeout=30000)
        assert pg.evaluate(
            "() => document.querySelector('#ms-pane').lastElementChild.classList.contains('offline-fold')"
        )
        assert not present(pg, "library", "#ms-reorder")
        assert present(pg, "preferences", "#ms-reorder")
        assert not present(pg, "server", "#ms-addons") and not present(
            pg, "server", ".offline-fold"
        )
        br.close()


def test_zimis_own_zims_are_community_rows_that_add_the_packages_copy(base):
    """No Zimi category: the community row of zimi_mul_games is the row, marked own so Add installs the release's copy
    (zimi_games), never a community download; one the catalog lacks joins Community."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw)
        pg.goto(base + "/")
        pg.wait_for_selector("#q")
        pg.evaluate("() => enterManage(null, 'library')")
        pg.wait_for_selector(".offline-fold", state="attached", timeout=30000)
        got = pg.evaluate("""() => {
              const items = [{ name: 'zimi_mul_games', category: COMMUNITY_CAT, source: 'community' }, { name: 'wikipedia_en_all' }];
              _mergeOwnCatalogRows(items, [{ name: 'zimi_games', category: COMMUNITY_CAT }, { name: 'zimi_almanac', category: COMMUNITY_CAT }]);
              return { items: items.map(i => [i.name, !!i.own, i.category || '']), keys: BROWSE_CATEGORIES.map(c => c.key),
                       add: _ownZimName('zimi_mul_games') };
            }""")
        assert got["items"] == [
            ["zimi_mul_games", True, "community"],
            ["wikipedia_en_all", False, ""],
            ["zimi_almanac", False, "community"],
        ]
        assert "zimi" not in got["keys"] and got["add"] == "zimi_games"
        br.close()


def test_the_community_mark_is_one_solid_drawing_everywhere(base):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw)
        pg.goto(base + "/")
        pg.wait_for_selector("#q")
        got = pg.evaluate("""() => {
              const tile = BROWSE_CATEGORIES.find(c => c.key === COMMUNITY_CAT).icon;
              const card = communityIcon(16);
              const paths = s => s.replace(/^<svg[^>]*>/, '').replace(/<\\/svg>$/, '');
              return { same: paths(tile) === paths(card), tile, card };
            }""")
        assert got[
            "same"
        ], "the category tile and the card's mark are different drawings"
        for svg in (got["tile"], got["card"]):
            assert 'fill="currentColor"' in svg and "stroke" not in svg
        br.close()


def test_a_compact_library_tile_is_shorter_and_narrower_than_a_full_card(base):
    """compact fit 5 to the full card's 4 and stood taller. At a wide window and on a phone it is
    now shorter and narrower than the card, so more fit a row."""
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    read = """() => {
      const c = document.querySelector('#output .stats-grid:not(.pick-tiles) > .stat-card');
      const b = c.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    }"""
    with sync_playwright() as pw:
        for size in ({"width": 1440, "height": 900}, PHONE):
            br = pw.chromium.launch()
            pg = br.new_context(viewport=size, service_workers="block").new_page()
            pg.goto(base + "/")
            pg.wait_for_selector(
                "#output .stats-grid:not(.pick-tiles) > .stat-card", timeout=30000
            )
            pg.evaluate("() => _setLibraryView('list')")
            pg.wait_for_selector(
                "#output .stats-grid:not(.tiles):not(.pick-tiles) > .stat-card"
            )
            card = pg.evaluate(read)
            pg.evaluate("() => _setLibraryView('tiles')")
            pg.wait_for_selector("#output .stats-grid.tiles > .stat-card")
            tile = pg.evaluate(read)
            assert tile["h"] < card["h"] and tile["w"] < card["w"], (size, tile, card)
            br.close()


def test_addons_offline_says_so(base):
    _skip_without_browser()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw)
        pg.goto(base + "/")
        pg.wait_for_selector("#q")
        pg.evaluate("() => enterManage(null, 'library')")
        pg.wait_for_selector(".offline-fold", state="attached", timeout=30000)
        pg.evaluate("() => { document.querySelector('.offline-fold').open = true; }")
        pg.wait_for_selector("#ms-addons .ms-hint", timeout=30000)
        text = pg.inner_text("#ms-addons")
        assert "ZIMI_OFFLINE" in text and "Could not load" not in text
        br.close()
