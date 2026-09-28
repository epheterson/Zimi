"""Search chips and the "?" on a 390px phone, in English and Hebrew (#94).

A real browser, the way a phone uses it: type a query with operators, read
the chips, tap a chip's × and an example behind the "?", in the library
search and in the catalog. Everything has to fit a 390px screen in a
left-to-right and a right-to-left UI: no chip past the edge, no sideways
scroll, and the "?" never on top of the ×, the magnifier or the words typed.
"""

import gzip
import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PHONE = {"width": 390, "height": 844}
QUERY = 'mercury -planet "the sun" OR fire lang:en in:wiki'


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim, build_wiki_fixture_zim

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_wiki_fixture_zim(str(zdir / "wikipedia_en_test.zim"))
    build_fixture_zim(str(zdir / "survival_en_test.zim"))
    monkeypatch.setenv("ZIMI_OFFLINE", "1")  # the catalog is the page's to stub
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _catalog_json():
    """A slice of the shipped catalog snapshot, served in place of Kiwix's."""
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "zimi",
        "assets",
        "catalog-snapshot.json.gz",
    )
    with gzip.open(path, "rt", encoding="utf-8") as f:
        entries = json.load(f)["entries"]
    items = [dict(e, icon="") for e in entries if "wikipedia" in e.get("name", "")][:60]
    return json.dumps({"items": items, "total": len(items)})


# Every place the chips and the "?" could spill: returns what does not fit.
_FIT = """() => {
  const vw = document.documentElement.clientWidth, out = [];
  const rect = el => el.getBoundingClientRect();
  const shown = el => { const r = rect(el); return r.width > 0 && getComputedStyle(el).display !== 'none'; };
  const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom && b.top < a.bottom;
  document.querySelectorAll('.search-chip, .search-example').forEach((el, i) => {
    const r = rect(el);
    if (r.width && (r.left < -0.5 || r.right > vw + 0.5)) out.push('chip ' + i + ' at ' + r.left + '..' + r.right);
  });
  const q = document.getElementById('q'), box = rect(q), cs = getComputedStyle(q);
  const text = { left: box.left + parseFloat(cs.paddingLeft), right: box.right - parseFloat(cs.paddingRight), top: box.top, bottom: box.bottom };
  const glass = rect(document.querySelector('.topbar-search .search-icon'));
  const help = document.getElementById('search-help'), clear = document.getElementById('search-clear');
  for (const [el, name] of [[help, '?'], [clear, 'x']]) {
    if (!shown(el)) continue;
    const r = rect(el);
    if (r.left < box.left || r.right > box.right) out.push(name + ' outside the box');
    if (overlap(r, glass)) out.push(name + ' on the magnifier');
    if (overlap(r, text)) out.push(name + ' on the typed words');
  }
  if (shown(help) && shown(clear) && overlap(rect(help), rect(clear))) out.push('? on the x');
  if (document.documentElement.scrollWidth > vw) out.push('the page scrolls sideways: ' + document.documentElement.scrollWidth);
  return out;
}"""


@pytest.mark.parametrize("lang", ["en", "he"])
def test_chips_and_help_fit_a_phone(served, lang):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport=PHONE,
            locale="he-IL" if lang == "he" else "en-US",
            is_mobile=True,
            has_touch=True,
        )
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.route(
            "**/manage/catalog?*",
            lambda route: route.fulfill(
                status=200, content_type="application/json", body=_catalog_json()
            ),
        )
        pg.goto(served + "/")
        pg.wait_for_function(
            "() => typeof zimsCache !== 'undefined' && zimsCache && zimsCache.length",
            timeout=30000,
        )
        assert pg.evaluate("document.documentElement.dir") == (
            "rtl" if lang == "he" else ""
        )

        # The empty box: the "?" is there, in the ×'s place.
        help_ = pg.locator("#search-help")
        assert help_.is_visible()
        assert pg.evaluate(_FIT) == []

        # Typing: the "?" and the × side by side, neither on the words.
        pg.locator("#q").tap()
        pg.locator("#q").fill(QUERY)
        assert help_.is_visible() and pg.locator("#search-clear").is_visible()
        assert pg.evaluate(_FIT) == []

        # The search: one chip per operator, all on the screen.
        pg.keyboard.press("Enter")
        pg.wait_for_selector("#output .search-chips")
        chips = pg.locator("#output .search-chip")
        assert chips.count() == 5
        labels = [chips.nth(i).inner_text().strip() for i in range(5)]
        if lang == "he":
            assert labels[0] == "ללא planet" and labels[3] == "אנגלית", labels
        else:
            assert labels == [
                "without planet",
                "exact: the sun",
                '"the sun" or fire',
                "English",
                "Test Wikipedia",  # in:wiki names the one source it matches
            ], labels
        assert pg.evaluate(_FIT) == []

        # A chip's × searches again without that one operator.
        pg.locator("#output .search-chip-x").first.tap()
        pg.wait_for_function(
            "() => document.querySelectorAll('#output .search-chip').length === 4"
        )
        assert (
            pg.evaluate("document.getElementById('q').value")
            == 'mercury "the sun" OR fire lang:en in:wiki'
        )
        assert pg.evaluate(_FIT) == []

        # The "?": examples in the UI's language, each a tap from a search.
        pg.locator("#q").fill("")
        pg.evaluate("document.activeElement.blur()")
        help_.tap()
        examples = pg.locator("#suggest-dropdown .search-example")
        assert examples.count() == 5
        first = pg.evaluate("t('search_example_exact')")
        assert examples.first.inner_text().startswith(first)
        if lang == "he":
            assert "פאנל סולארי" in first
        assert pg.evaluate(_FIT) == []
        examples.nth(1).tap()  # the exclusion
        pg.wait_for_selector("#output .search-chips")
        assert pg.evaluate("document.getElementById('q').value") == pg.evaluate(
            "t('search_example_without')"
        )
        assert pg.evaluate(_FIT) == []

        # The catalog: the same chips under its count, the same "?".
        pg.evaluate("async () => { await enterManage(); switchManageTab('browse'); }")
        pg.wait_for_function("() => manageTab === 'browse' && _catalogCache !== null")
        pg.locator("#q").tap()
        pg.locator("#q").fill("wikipedia -medicine lang:fr")
        pg.keyboard.press("Enter")
        pg.wait_for_selector("#catalog-results .search-chips", timeout=20000)
        assert pg.locator("#catalog-results .search-chip").count() == 2
        pg.evaluate("document.activeElement.blur()")
        assert pg.evaluate(_FIT) == []
        pg.locator("#q").tap()
        help_.tap()
        assert pg.locator("#suggest-dropdown .search-example").count() == 3
        assert pg.evaluate(_FIT) == []
        assert errors == []
        br.close()
