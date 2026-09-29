"""Reading, as a person meets it, in a real browser: the 1.12 UX pass.

Each test is one thing that went wrong in front of a reader on a 390px phone
or a desk, fixed, and held here against the real page:

- Zimipedia's reader: Reader View's own rules showed Read next's empty
  pictures as an 80px gap and let a card's three lines run out over the next
  card; a strip chip asked a wiki with no icon for one; at the foot of an
  article the bar named a section two above the one on screen.
- Side by side, the other language's name and its close scrolled away with
  the section the pane opened on; the contents rail's Hebrew label stood
  across the rail from the English list under it.

The library is mwoffliner-shaped (tests/wiki_fixture.py).

Run: pytest tests/test_reading_ux_live.py -v
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

PHONE = {
    "viewport": {"width": 390, "height": 844},
    "is_mobile": True,
    "has_touch": True,
}
DESK = {"viewport": {"width": 1440, "height": 900}}
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
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
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


def _page(pw, opts, lang=None):
    br = pw.chromium.launch()
    ctx = br.new_context(**opts)
    if lang:
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_ui_lang', %r); } catch (e) {}" % lang
        )
    pg = ctx.new_page()
    return br, pg


def _boot(pg, base):
    pg.goto(base + "/")
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=30000,
    )


def _search(pg, text):
    pg.click("#q")
    pg.fill("#q", text)
    pg.keyboard.press("Enter")
    pg.wait_for_function(
        "() => !!document.querySelector('#output .result, #output .empty')",
        timeout=30000,
    )


def _zimipedia(pg, zim, path):
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


def _q(pg, js, arg=None):
    return pg.evaluate(
        "(arg) => { var f = document.getElementById('reader-frame'), d = f.contentDocument, w = f.contentWindow; return ("
        + js
        + "); }",
        arg,
    )


def test_the_reader_keeps_what_reader_view_would_undo(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw, PHONE)
        missing = []
        pg.on("response", lambda r: missing.append(r.url) if r.status == 404 else None)
        try:
            _boot(pg, served)
            _zimipedia(pg, "wikipedia", "Albert_Einstein")
            # The strip: the fixture's wikis have no icon, and none is asked for.
            chips = _q(pg, "d.querySelectorAll('.zw-strip a').length")
            assert (
                chips >= 2 and _q(pg, "d.querySelectorAll('.zw-strip img').length") == 0
            )
            assert not [u for u in missing if u.endswith("/-/icon")], missing
            assert (
                _q(pg, "w.getComputedStyle(d.querySelector('.zw-strip em')).overflow")
                == "hidden"
            )
            # A footnote mark does not open up its line.
            assert (
                _q(
                    pg,
                    "w.getComputedStyle(d.querySelector('.zimi-reader p sup')).lineHeight",
                )
                == "0px"
            )
            # The foot of the page: Read next, its empty pictures taking no room.
            _q(pg, "w.scrollTo(0, d.documentElement.scrollHeight)")
            pg.wait_for_function(
                "() => { var d = document.getElementById('reader-frame').contentDocument; return !!d.querySelector('.zw-next em') && d.querySelector('.zw-next em').textContent.length > 0; }",
                timeout=10000,
            )
            pg.wait_for_timeout(400)
            nx = _q(
                pg,
                """(function(){ var a = d.querySelector('.zw-next a'), img = a.querySelector('img'), b = a.querySelector('b');
                  return { hidden: img.hidden, shown: w.getComputedStyle(img).display, gap: b.getBoundingClientRect().left - a.getBoundingClientRect().left,
                    clip: w.getComputedStyle(a.querySelector('em')).overflow }; })()""",
            )
            assert nx["hidden"] and nx["shown"] == "none", nx
            assert nx["gap"] < 20, (
                "the title starts at the card's edge, not after an empty picture: %r"
                % nx
            )
            assert nx["clip"] == "hidden", "three lines, and no more over the next card"
            # The bar names the last section on screen, not one above it.
            _q(pg, "w.scrollTo(0, d.documentElement.scrollHeight)")
            pg.wait_for_timeout(400)
            at = _q(
                pg,
                "{ label: d.querySelector('.zw-cbtn span').textContent, y: w.scrollY,"
                " refs: d.getElementById('References').getBoundingClientRect().top }",
            )
            assert at["label"] == "References", at
        finally:
            br.close()


def test_side_by_side_keeps_its_name_and_close_and_the_rail_label_stands_over_its_list(
    served,
):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw, DESK, lang="he")
        try:
            _boot(pg, served)
            _zimipedia(pg, "wikipedia", "Albert_Einstein")
            rail = _q(
                pg,
                """(function(){ var b = d.querySelector('.zw-rail b span'), li = d.querySelector('.zw-rail li button');
                  return { dir: b.getAttribute('dir'), label: b.getBoundingClientRect().left, list: li.getBoundingClientRect().left }; })()""",
            )
            assert rail["dir"] == "rtl" and abs(rail["label"] - rail["list"]) < 20, rail
            # Read to a section, then open Hebrew beside it: it lands there,
            # under its own name and close.
            _q(
                pg,
                "w.scrollTo(0, d.getElementById('Legacy').getBoundingClientRect().top + w.scrollY - 60)",
            )
            pg.wait_for_timeout(400)
            _q(pg, "w.scrollBy(0, -40)")
            pg.wait_for_timeout(400)
            pg.frame_locator("#reader-frame").locator(".zw-lbtn").click()
            pg.frame_locator("#reader-frame").locator(
                ".zw-lang-list li", has_text="עברית"
            ).locator(".zw-side").click()
            pg.wait_for_function(
                "() => !!document.getElementById('reader-frame').contentDocument.querySelector('.zw-pane h2')",
                timeout=10000,
            )
            pg.wait_for_timeout(400)
            p = _q(
                pg,
                """(function(){ var pane = d.querySelector('.zw-pane'), head = pane.querySelector('.zw-pane-head'),
                  x = head.querySelector('button'), bar = d.querySelector('.zw-bar').getBoundingClientRect();
                  var hit = d.elementFromPoint(x.getBoundingClientRect().left + 8, x.getBoundingClientRect().top + 8);
                  var landed = [].filter.call(pane.querySelectorAll('h2'), function(h) { return h.getBoundingClientRect().top > 0; })[0];
                  return { scrolled: pane.scrollTop, head: head.getBoundingClientRect().top, bar: bar.bottom, closeOnTop: hit === x,
                    landed: landed && landed.getBoundingClientRect().top, headBottom: head.getBoundingClientRect().bottom }; })()""",
            )
            assert p["scrolled"] > 0, "the pane opened at the section, not its top"
            assert abs(p["head"] - p["bar"]) < 2 and p["closeOnTop"], p
            assert p["landed"] >= p["headBottom"], (
                "the section sits under the pane's name, not beneath it: %r" % p
            )
        finally:
            br.close()
