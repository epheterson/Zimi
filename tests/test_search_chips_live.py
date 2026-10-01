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
        console = []
        pg.on("console", lambda m: console.append(m.type + ": " + m.text[:200]))
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
        # Typed once the catalog is on screen, as a person would.
        try:
            pg.wait_for_function(
                "() => { var r = document.getElementById('catalog-results');"
                " return _browseView === 'gallery' && !!r && r.children.length > 0; }",
                timeout=30000,
            )
        except Exception:
            state = pg.evaluate(
                """() => ({ mode, manageTab, view: _browseView, manageEnabled,
                  pw: _managePwRequired, cache: _catalogCache && _catalogCache.length,
                  results: !!document.getElementById('catalog-results'),
                  output: (document.getElementById('output') || {}).innerHTML.slice(0, 400),
                  req: performance.getEntriesByType('resource').map(e => e.name.replace(location.origin, ''))
                    .filter(n => /manage|catalog/.test(n)) })"""
            )
            raise AssertionError(
                "catalog never painted: %r; errors %r; console %r" % (state, errors, console[-15:])
            )
        pg.locator("#q").tap()
        pg.locator("#q").fill("wikipedia -medicine lang:fr")
        pg.keyboard.press("Enter")
        try:
            pg.wait_for_selector("#catalog-results .search-chips", timeout=20000)
        except Exception:
            # What the catalog shows instead, for a failure seen only on CI.
            state = pg.evaluate(
                """() => ({ mode, manageTab, view: _browseView, q: q.value,
                  cache: _catalogCache && _catalogCache.length,
                  html: (document.getElementById('catalog-results') || {}).innerHTML })"""
            )
            state["html"] = (state.get("html") or "")[:600]
            raise AssertionError("catalog chips never showed: %r; page errors %r" % (state, errors))
        assert pg.locator("#catalog-results .search-chip").count() == 2
        pg.evaluate("document.activeElement.blur()")
        assert pg.evaluate(_FIT) == []
        pg.locator("#q").tap()
        help_.tap()
        assert pg.locator("#suggest-dropdown .search-example").count() == 3
        assert pg.evaluate(_FIT) == []
        assert errors == []
        br.close()


def _hold_full_pass(monkeypatch, scoped_too=True):
    """The server's full-text pass waits until the returned Event is set;
    the quick pass answers at once, so its line of the answer arrives alone."""
    import zimi.server as srv

    release = threading.Event()
    real = srv.search_all

    def held(q, limit=5, filter_zim=None, fast=False):
        if not fast and (scoped_too or not filter_zim):
            release.wait(20)
        return real(q, limit=limit, filter_zim=filter_zim, fast=fast)

    monkeypatch.setattr(srv, "search_all", held)
    srv._search_cache_clear()
    return release


def test_a_search_that_lands_after_you_open_settings_leaves_settings_alone(
    served, monkeypatch
):
    """The full-text pass of a search can land seconds after the title pass.
    Opened Settings in between, the late pass painted the search results
    over Settings (CI, a slow runner, caught it). A search whose page you
    have left draws nothing. Both passes come in one answer now: the title
    pass's line is drawn while the full-text pass is still running."""
    from playwright.sync_api import sync_playwright

    release = _hold_full_pass(monkeypatch)
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        # The service worker would answer /search itself, out of the route's reach.
        pg = br.new_page(viewport=PHONE, service_workers="block")
        seen = []
        pg.on("request", lambda r: seen.append(r.url) if "/search" in r.url else None)
        pg.goto(served + "/")
        pg.wait_for_function("() => typeof doSearch === 'function' && _manageProbed", timeout=30000)
        pg.evaluate("() => { doSearch('water', true); }")
        # The quick line drawn, the full-text pass still held on the server.
        pg.wait_for_function(
            "() => document.getElementById('fts-indicator')", timeout=15000
        )
        pg.evaluate("async () => { await enterManage(); switchManageTab('browse'); }")
        pg.wait_for_function(
            "() => mode === 'manage' && !!document.getElementById('catalog-results')",
            timeout=15000,
        )
        release.set()
        pg.wait_for_timeout(800)
        assert pg.evaluate(
            "() => !!document.getElementById('catalog-results')"
        ), "the late search painted over Settings"
        assert pg.evaluate(
            "() => !document.getElementById('fts-indicator') || !document.querySelector('#output .result')"
        )
        assert len(seen) == 1, "one search, one request: %r" % seen
        br.close()


def test_an_older_search_landing_late_never_replaces_a_newer_one(served, monkeypatch):
    """'More from <source>' starts a scoped search while the all-sources
    search's full-text pass may still be on its way. Landing after, that pass
    replaced the scoped results with every source's (CI, a slow runner)."""
    from playwright.sync_api import sync_playwright

    release = _hold_full_pass(monkeypatch, scoped_too=False)
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport=PHONE, service_workers="block")
        pg.goto(served + "/")
        pg.wait_for_function("() => typeof doSearch === 'function' && _manageProbed", timeout=30000)
        # On the slow runner the older response was already arriving, so
        # cancelling it did nothing; cancelling is switched off to say the same.
        pg.evaluate(
            "() => { AbortController.prototype.abort = function () {}; doSearch('water', true); }"
        )
        pg.wait_for_function(
            "() => document.getElementById('fts-indicator')", timeout=15000
        )
        # A newer search, scoped to one source, runs to the end.
        pg.evaluate(
            "() => { currentSource = 'survival_en_test'; doSearch('water', true); }"
        )
        pg.wait_for_function(
            "() => allResults && allResults._query === 'water' && !allResults.partial"
            " && (window._newer = allResults)",
            timeout=15000,
        )
        release.set()
        pg.wait_for_timeout(800)
        assert pg.evaluate(
            "allResults === window._newer && currentSource === 'survival_en_test'"
        ), "the older search landed over the newer one"
        assert pg.evaluate("allResults.results.length") > 0
        br.close()
