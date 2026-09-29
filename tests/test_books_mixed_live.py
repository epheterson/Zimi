"""Bookshelf with more than Gutenberg, on a phone, in a real browser.

The 1.12 UX pass found a mixed shelf showed only Gutenberg on its front:
Most read and Newest to Project Gutenberg, then Gutenberg's subjects, and
the textbooks and document libraries beside them reachable only by search.
A book from them showed a title and a language, not what it is, where it
is from or what Read opens. And the ways in were small under a thumb: an
era's row 32px, a fact's link 16px.

Now the front names every source with its books, a source's list offers
no Most read (Gutenberg's count of readers), a book's page says its source,
its format and what the source says of it, with Read before the facts on a
phone, and every way in on the page takes a 44px thumb.

Run: pytest tests/test_books_mixed_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import books  # noqa: E402

pytest.importorskip("libzim.writer")

PHONE = {"width": 390, "height": 844}
# A thumb's target, less a hair for sub-pixel rounding.
THUMB = 43.5


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import books_sources_fixture as fx
    from test_books_sources import _gutenberg, _libretexts, _water

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("mixed")
    zdir = tmp / "zims"
    zdir.mkdir()
    for filename, metadata, entries, main in (_gutenberg(), _water(), _libretexts()):
        fx.build_zim(str(zdir / filename), metadata, entries, main)
    mp = pytest.MonkeyPatch()
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    for pool in (srv._archive_pool, srv._suggest_pool, srv._fts_pool):
        pool.clear()
    books._reset_for_tests()
    srv.load_cache(force=True)
    books.build_all_details()
    books._builder.wait()
    books._sources.wait()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    books._reset_for_tests()
    srv.release_zim_handles(list(srv.get_zim_files()))
    mp.undo()


def _frame(pg):
    return next(
        f for f in pg.frames if f.url.split("?")[0].endswith("/static/books.html")
    )


# Every way in on the page (a link, a button), but the chips (apps.css gives
# them their 44px with a pseudo-element) and the covers (a whole book).
SMALL = (
    r"""() => Array.from(document.querySelectorAll('#view a, #view button')).filter(e => {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !e.closest('.chip') && !e.classList.contains('bk') && r.height < %s;
}).map(e => (e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().height) + 'px "' + e.textContent.trim().slice(0, 30) + '"')"""
    % THUMB
)


@pytest.mark.parametrize("lang", ["en", "he"])
def test_a_mixed_shelf_on_a_phone(served, lang):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport=PHONE,
            is_mobile=True,
            has_touch=True,
            locale="he-IL" if lang == "he" else "en-US",
        )
        ctx.add_init_script(
            "try{localStorage.setItem('zimi_ui_lang', %r)}catch(e){}" % lang
        )
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(served + "/#books")
            pg.wait_for_function(
                "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument"
                " && f.contentDocument.querySelectorAll('.tiles .tile').length >= 3; }",
                timeout=30000,
            )
            fr = _frame(pg)
            # The front: Gutenberg's most read, and every source with its books.
            heads = fr.evaluate(
                "Array.from(document.querySelectorAll('.shelf-h h2')).map(h => h.textContent)"
            )
            sources = fr.evaluate(
                "Array.from(document.querySelectorAll('.tile .nm')).map(n => n.textContent)"
            )
            assert (
                "Water Treatment Library" in sources
                and "Statistics LibreTexts" in sources
            ), (heads, sources)
            assert not fr.evaluate(SMALL), fr.evaluate(SMALL)
            # A source: its own list, no Most read over books nobody counted.
            fr.evaluate(
                "go({v:'list', zim: %r})"
                % next(
                    z["name"]
                    for z in srv.list_zims()
                    if z["file"].startswith("zimgit-water")
                )
            )
            fr.wait_for_function(
                "() => document.querySelectorAll('#books .bk').length === 7"
            )
            assert fr.evaluate(
                "document.querySelector('.head h2').textContent"
            ).startswith("Water Treatment Library")
            sorts = fr.evaluate(
                "Array.from(document.querySelectorAll('.head .sorts .chip')).map(c => c.textContent)"
            )
            assert len(sorts) == 2, sorts
            # A book of it: what it is, where from, and Read before the facts.
            fr.evaluate("document.querySelector('#books .bk').click()")
            fr.wait_for_function(
                "() => document.querySelector('.book .facts') && /For people/.test((document.querySelector('.book .desc') || {}).textContent || '')"
            )
            got = fr.evaluate(
                """() => ({ read: document.querySelector('.actions .read').getBoundingClientRect().top,
                  facts: document.querySelector('.facts').getBoundingClientRect().top,
                  dd: Array.from(document.querySelectorAll('.facts dd')).map(d => d.textContent),
                  rows: Array.from(document.querySelectorAll('.facts dd a')).map(a => a.getBoundingClientRect().height) })"""
            )
            assert got["read"] < got["facts"], "on a phone Read comes before the facts"
            assert "Water Treatment Library" in got["dd"] and "PDF" in got["dd"], got[
                "dd"
            ]
            assert got["rows"] and min(got["rows"]) >= THUMB, got["rows"]
            assert not fr.evaluate(SMALL), fr.evaluate(SMALL)
            # The eras, a row each a thumb tall.
            fr.evaluate("tab('eras')")
            fr.wait_for_function("() => document.querySelectorAll('.era').length > 0")
            heights = fr.evaluate(
                "Array.from(document.querySelectorAll('.era')).map(e => e.getBoundingClientRect().height)"
            )
            assert min(heights) >= THUMB, heights
            assert not errors, errors
        finally:
            br.close()
