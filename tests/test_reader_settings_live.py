"""The reading settings and the way into an article, in a real browser.

Eric, 2026-09-29, from his iPhone: Text size changed the header and not the
article; opening Pizza from search (English Wikipedia maxi) took unexpectedly
long; Reader View's Auto swatch was still wrong.

- Text size: Wikipedia's skin sizes its body box in rem
  (.vector-body{font-size:1rem;line-height:1.6}); the article's paragraphs
  must follow the reader's size and spacing, not the skin's 16px.
- The way in: a search result opens in Zimipedia's reader; the text is on
  screen when the page's DOM is, not when its last picture has loaded.
- Auto's swatch: the Light and Dark swatches a half each, in the same ring
  as every swatch, in every reading-settings sheet, light UI and dark.

The fixture is mwoffliner's Parsoid HTML (tests/wiki_fixture.py); the skin's
rule and a long article are laid onto it in the browser.

Run: pytest tests/test_reader_settings_live.py -v
"""

import os
import sys
import threading
import time
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import wiki  # noqa: E402

READY = "() => { var d = document.getElementById('reader-frame').contentDocument; return !!(d && d.querySelector('.zw-bar')); }"
# Wikipedia's skin: the body box in rem (skins.vector.styles + vector-2022.css).
SKIN = "<style>.vector-body{font-size:1rem;line-height:1.6}</style></head>"
IMG_DELAY_S = 3.0  # a picture read slowly out of a big ZIM on a NAS
TEXT_BOUND_MS = 2500  # click to text on screen, with the pictures still coming
SECTIONS = 60  # a long article: ~1 MB of Parsoid HTML


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
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


SLOW_PREFIX = "/slowimg/"


@pytest.fixture
def slow_images(monkeypatch):
    """Pictures that take IMG_DELAY_S each, from the same server (a picture
    read slowly out of a big ZIM)."""
    import wiki_fixture

    from zimi.http import ZimHandler

    png = wiki_fixture._png(40, 30)
    plain = ZimHandler.do_GET

    def do_GET(self):
        if not self.path.startswith(SLOW_PREFIX):
            return plain(self)
        time.sleep(IMG_DELAY_S)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(png)))
        self.end_headers()
        self.wfile.write(png)

    monkeypatch.setattr(ZimHandler, "do_GET", do_GET)
    return SLOW_PREFIX


def _boot(pg, base):
    pg.goto(base + "/")
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=30000,
    )


def _q(pg, js):
    return pg.evaluate(
        "() => { var f = document.getElementById('reader-frame'), d = f.contentDocument, w = f.contentWindow; return ("
        + js
        + "); }"
    )


def _skin(route):
    """The article as the server has it, with Wikipedia's skin rule."""
    resp = route.fetch()
    body = resp.text().replace("</head>", SKIN, 1)
    route.fulfill(response=resp, body=body)


def _search_open(pg, base, query, path):
    _boot(pg, base)
    pg.evaluate("() => _setOpenInApps(true)")
    pg.fill("#q", query)
    pg.press("#q", "Enter")
    hit = 'a.result[data-zim="wikipedia"][data-path="%s"]' % path
    pg.wait_for_selector(hit, timeout=15000)
    return hit


PARA = "(function(){ var p = [].slice.call(d.querySelectorAll('.zimi-reader p')).filter(function(x){ return x.textContent.length > 80; })[0]; var cs = w.getComputedStyle(p); return [parseFloat(cs.fontSize), parseFloat(cs.lineHeight)]; })()"


def test_text_size_resizes_the_articles_text_not_only_its_title(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"], service_workers="block")
        try:
            pg = ctx.new_page()
            pg.route("**/w/wikipedia/Albert_Einstein", _skin)
            hit = _search_open(pg, served, "Albert Einstein", "Albert_Einstein")
            pg.click(hit)
            pg.wait_for_function(READY, timeout=30000)
            pg.wait_for_timeout(500)
            assert _q(
                pg,
                "[].some.call(d.querySelectorAll('style'), function(s) { return s.textContent.indexOf('.vector-body{') >= 0; })",
            ), "the skin's rule is on the page"
            size0 = _q(
                pg, "parseFloat(d.documentElement.style.getPropertyValue('--zw-size'))"
            )
            fs0, lh0 = _q(pg, PARA)
            assert fs0 == size0, "the text is the reader's size, not the skin's 16px"
            title0 = _q(
                pg,
                "parseFloat(w.getComputedStyle(d.querySelector('.zimi-reader-title')).fontSize)",
            )
            fr = pg.frame_locator("#reader-frame")
            fr.locator(".zw-bar .zb-aa").click()
            pg.wait_for_timeout(300)
            fr.locator('.zw-set-sheet [data-size="4"]').click()  # Larger
            fr.locator("#zb-lh").fill("4")
            fr.locator("#zb-lh").dispatch_event("input")
            fr.locator("#zb-lh").dispatch_event("change")
            pg.wait_for_timeout(300)
            size1 = _q(
                pg, "parseFloat(d.documentElement.style.getPropertyValue('--zw-size'))"
            )
            fs1, lh1 = _q(pg, PARA)
            title1 = _q(
                pg,
                "parseFloat(w.getComputedStyle(d.querySelector('.zimi-reader-title')).fontSize)",
            )
            assert size1 > size0
            assert fs1 == size1, "Text size reaches the paragraphs"
            assert title1 > title0
            assert lh1 / fs1 > lh0 / fs0, "Line spacing reaches them too"
        finally:
            br.close()


STEPS = "(sel) => [...document.querySelectorAll(sel)].map(b => b.getAttribute('aria-label') + (b.getAttribute('aria-checked') === 'true' ? '*' : '') + '|' + b.textContent).join(' ')"
FRAME_STEPS = "() => [...document.getElementById('reader-frame').contentDocument.querySelectorAll('.zw-set-sheet .tsz-btn')].map(b => b.getAttribute('aria-label') + (b.getAttribute('aria-checked') === 'true' ? '*' : '') + '|' + b.textContent).join(' ')"


def test_text_size_is_five_named_steps_and_an_old_size_lands_on_the_nearest(served):
    """Eric, 2026-09-30: text size as Smaller, Small, Default, Large, Larger,
    five A's that grow, no numbers. A size saved on the old scales (30px in
    Zimipedia, 85% in Reader View) opens on the nearest step, not the default."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"], service_workers="block")
        try:
            pg = ctx.new_page()
            pg.goto(served + "/")
            pg.evaluate(
                "() => { localStorage.setItem('zimi_wiki_prefs', JSON.stringify({size: 30, lh: 2, margin: 1}));"
                " localStorage.setItem('zimi_reader_font_scale', '85'); }"
            )
            hit = _search_open(pg, served, "Albert Einstein", "Albert_Einstein")
            pg.click(hit)
            pg.wait_for_function(READY, timeout=30000)
            pg.wait_for_timeout(500)
            assert (
                _q(pg, "d.documentElement.style.getPropertyValue('--zw-size')")
                == "25px"
            ), "30px, off the new scale, opens on Larger (25px)"
            fr = pg.frame_locator("#reader-frame")
            fr.locator(".zw-bar .zb-aa").click()
            pg.wait_for_timeout(300)
            assert pg.evaluate(FRAME_STEPS) == (
                "Smaller|A Small|A Default|A Large|A Larger*|A"
            )
            assert not _q(
                pg,
                "/\\d/.test(d.querySelector('.zw-set-sheet .zb-sizes').closest('.zb-set').textContent)",
            ), "no number on the size row"
            fr.locator('.zw-set-sheet .tsz-btn[aria-label="Small"]').click()
            pg.wait_for_timeout(300)
            assert (
                _q(pg, "d.documentElement.style.getPropertyValue('--zw-size')")
                == "17px"
            )
            assert (
                pg.evaluate(
                    "() => JSON.parse(localStorage.getItem('zimi_wiki_prefs')).size"
                )
                == 17
            )
            # Reader View's own control, in the ... menu: the same five, 85%
            # (Smaller before) still Smaller. The article outside Zimipedia.
            pg.evaluate("() => _setOpenInApps(false)")
            pg.goto(served + "/w/wikipedia/Albert_Einstein")
            pg.wait_for_function(
                "() => { try { return _readerViewAvailable(); } catch (e) { return false; } }",
                timeout=30000,
            )
            pg.evaluate("() => { if (!_readerViewOn) _readerViewToggle(); }")
            pg.wait_for_timeout(500)
            pg.click(".topbar-more")
            pg.wait_for_timeout(300)
            assert pg.evaluate(STEPS, "#topbar-menu.visible .tsz-btn") == (
                "Smaller*|A Small|A Default|A Large|A Larger|A"
            )
            pg.locator('#topbar-menu.visible .tsz-btn[aria-label="Large"]').click()
            pg.wait_for_timeout(300)
            assert (
                pg.evaluate("() => localStorage.getItem('zimi_reader_font_scale')")
                == "115"
            )
            assert (
                pg.evaluate("() => document.documentElement.scrollWidth - innerWidth")
                <= 1
            )
        finally:
            br.close()


def _long_article(img_base):
    """About 1 MB of Parsoid sections, with pictures that load slowly."""
    import wiki_fixture

    body = "".join(
        wiki_fixture.section(
            i,
            2,
            "S%d" % i,
            "Section %d" % i,
            (
                '<figure typeof="mw:File/Thumb"><img src="%s%d.png" width="40" height="30" alt=""></figure>'
                % (img_base, i)
                if i % 5 == 1
                else ""
            )
            + "".join("<p>%s</p>" % (wiki_fixture.FILLER * 2) for _ in range(8)),
        )
        for i in range(1, SECTIONS + 1)
    )
    return wiki_fixture.page("Albert Einstein", body).decode("utf-8")


WATCH = """() => { window.__tt = {}; var t0 = performance.now();
  var loop = function() {
    var f = document.getElementById('reader-frame'), d = null; try { d = f.contentDocument; } catch (e) {}
    var now = performance.now() - t0;
    if (d && /Albert_Einstein$/.test(d.location.pathname)) {
      var ov = document.getElementById('reader-loading');
      var shown = getComputedStyle(f).visibility !== 'hidden' && !(ov && !ov.classList.contains('hidden'));
      if (shown && !__tt.text) {
        var ps = d.querySelectorAll('.zimi-reader p');
        for (var i = 0; i < ps.length && i < 20; i++) { var r = ps[i].getBoundingClientRect();
          if (ps[i].textContent.length > 80 && r.top < f.clientHeight && r.bottom > 0 && r.height > 0) { __tt.text = now; break; } }
      }
    }
    if (!__tt.text && now < 60000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop); }"""


def test_a_long_article_from_search_shows_its_text_before_its_pictures(
    served, slow_images
):
    """Click to text on screen within TEXT_BOUND_MS, sooner than a picture
    can load (IMG_DELAY_S): the reader no longer waits for the page's load
    event to show it."""
    from playwright.sync_api import sync_playwright

    html = _long_article(slow_images)
    assert len(html) > 850000

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"], service_workers="block")
        try:
            pg = ctx.new_page()
            pg.route(
                "**/w/wikipedia/Albert_Einstein",
                lambda r: r.fulfill(
                    status=200, content_type="text/html; charset=utf-8", body=html
                ),
            )
            hit = _search_open(pg, served, "Albert Einstein", "Albert_Einstein")
            # Zimipedia's reader code is here, as it is after a first article.
            pg.evaluate("() => new Promise(function(ok) { _wikiReaderLoad(ok); })")
            pg.evaluate(WATCH)
            pg.click(hit)
            pg.wait_for_function("() => __tt.text", timeout=70000)
            tt = pg.evaluate("() => __tt")
            # Before, the reader showed the page at its load event, which
            # waited on every picture: never sooner than IMG_DELAY_S.
            assert tt["text"] < TEXT_BOUND_MS < IMG_DELAY_S * 1000, tt
            # And it is Zimipedia's reader, laid out, with nothing sideways.
            pg.wait_for_function(READY, timeout=30000)
            assert _q(pg, "d.querySelectorAll('.zimi-reader p').length") > 400
            assert _q(pg, "d.documentElement.scrollWidth <= w.innerWidth")
        finally:
            br.close()


DOTS = """(sel) => { var root = document.getElementById('reader-frame').contentDocument;
  var find = function(k) { return document.querySelector(sel.replace('KEY', k)) || root.querySelector(sel.replace('KEY', k)); };
  var out = {}; ['auto', 'light', 'sepia', 'dark'].forEach(function(k) { var e = find(k); var cs = e.ownerDocument.defaultView.getComputedStyle(e);
    out[k] = { w: cs.width, h: cs.height, bw: cs.borderTopWidth, bc: cs.borderTopColor, bs: cs.borderTopStyle, r: cs.borderRadius, bg: cs.backgroundImage, c: cs.backgroundColor }; });
  return out; }"""


def _same_ring(dots):
    ring = lambda d: (d["w"], d["h"], d["bw"], d["bc"], d["bs"], d["r"])  # noqa: E731
    for k in ("light", "sepia", "dark"):
        assert ring(dots["auto"]) == ring(dots[k]), (k, dots)
    bg = dots["auto"]["bg"]
    assert "90deg" in bg, bg
    # Auto paints sepia by day and dark by night, so its swatch is those two.
    assert "rgb(244, 236, 216)" in bg and "rgb(10, 10, 11)" in bg, (
        "Auto is the Sepia swatch and the Dark one: %s" % bg
    )
    assert "rgb(251, 251, 249)" not in bg, bg
    assert dots["light"]["c"] == "rgb(251, 251, 249)"
    assert dots["dark"]["c"] == "rgb(10, 10, 11)"


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_autos_swatch_is_light_and_dark_in_the_ring_every_swatch_has(served, scheme):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**pw.devices["iPhone 13"], color_scheme=scheme)
        try:
            pg = ctx.new_page()
            # Reader View's sheet (the book button's palette).
            _boot(pg, served)
            pg.evaluate("() => _setOpenInApps(false)")
            pg.evaluate("() => openArticle('wikipedia', 'Physics', 'Physics')")
            pg.wait_for_function(
                "() => { var d = document.getElementById('reader-frame').contentDocument; return d && /Physics$/.test(d.location.pathname) && d.readyState === 'complete'; }",
                timeout=15000,
            )
            pg.wait_for_timeout(500)
            pg.evaluate(
                "() => { if (!_readerViewOn) _readerViewToggle(); _toggleReaderPalette(); }"
            )
            pg.wait_for_selector("#reader-palette.visible .rv-sw-auto", timeout=5000)
            _same_ring(pg.evaluate(DOTS, "#reader-palette .rv-sw-KEY .rv-sw-dot"))
            pg.evaluate("() => _closeReaderPalette()")
            # The reading sheet Zimipedia's reader and the books share.
            hit = _search_open(pg, served, "Albert Einstein", "Albert_Einstein")
            pg.click(hit)
            pg.wait_for_function(READY, timeout=30000)
            pg.frame_locator("#reader-frame").locator(".zw-bar .zb-aa").click()
            pg.wait_for_timeout(300)
            _same_ring(pg.evaluate(DOTS, ".zw-set-sheet .zb-dot-KEY"))
        finally:
            br.close()
