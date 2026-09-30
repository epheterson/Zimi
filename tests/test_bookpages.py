"""A book whose chapters are pages of its ZIM (Wikisource, Wikibooks,
LibreTexts, a ZIM that is one book) reads in the e-reader as one book.

Eric, 2026-09-30 (1.12.1): Wikisource works, LibreTexts textbooks and
whole-ZIM books open in the e-reader the way Gutenberg books do, instead of
as plain article pages.

Before this, the shelf's Read opened the work's first page as an article:
no contents, no place kept, the chapters a click away each.

Run: pytest tests/test_bookpages.py -v
"""

import json
import os
import sys
import threading
import urllib.parse

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import books_sources_fixture as fx  # noqa: E402
import zimi.server as srv  # noqa: E402
from test_books_sources import (  # noqa: E402,F401
    _fetch,
    _htdp,
    _libretexts,
    _wikisource,
    shelf_lib,
)

WORK = "Adjuvilo"
# Long enough to take several pages on a phone.
PARAS = "".join(
    "<p>La problemo de lingvo internacia estas unu el tiuj kies definitiva solvo "
    "pli kaj pli trudas sin ĉiutage, paragrafo %d.</p>" % i
    for i in range(40)
)


def _page(title, body, ws=True):
    record = (
        '<div id="ws-data" class="ws-noexport" style="display:none;speak:none">'
        '<span class="ws-type">book</span><span class="ws-title">Adjuvilo</span>'
        '<span class="ws-author">Claudius Colas</span><span class="ws-year">1910</span></div>'
        if ws
        else ""
    )
    return (
        '<!DOCTYPE html><html lang="eo"><head><meta charset="UTF-8"><title>%s</title>'
        '<script>window.__ran = 1</script></head><body><h1 class="article-header">%s</h1>'
        '<div class="ws-noexport" id="headertemplate"><div><a href="Adjuvilo/Enkonduko">←</a></div>'
        "Adjuvilo · Claudius Colas</div>%s%s</body></html>" % (title, title, body, record)
    )


def _work():
    """eo Wikisource with Adjuvilo whole: its page links its chapters (not
    in path order: an appendix it does not link sorts first)."""
    filename, meta, entries, main = _wikisource()
    entries[WORK] = (
        "text/html",
        _page(
            WORK,
            '<ul><li><a href="Adjuvilo/Enkonduko">Enkonduko</a></li>'
            '<li><a href="Adjuvilo/%C4%88apitro_I">Ĉapitro I</a></li>'
            '<li><a href="Adjuvilo/%C4%88apitro_II">Ĉapitro II</a></li></ul>',
        ),
        WORK,
    )
    entries["Adjuvilo/Enkonduko"] = (
        "text/html",
        _page("Adjuvilo/Enkonduko", "<p>Enkonduka teksto.</p>" + PARAS),
        "Adjuvilo/Enkonduko",
    )
    entries["Adjuvilo/Ĉapitro_I"] = (
        "text/html",
        _page(
            "Adjuvilo/Ĉapitro I",
            '<h2>Sekcio</h2><p><img src="../_assets_/x.png" alt=""> Vidu '
            '<a href="%C4%88apitro_II">la duan</a> kaj <a href="../Aforismoj_(Lanti,_1946)">alian</a>.</p>'
            + PARAS,
        ),
        "Adjuvilo/Ĉapitro I",
    )
    entries["Adjuvilo/Ĉapitro_II"] = (
        "text/html",
        _page("Adjuvilo/Ĉapitro II", "<p>Dua ĉapitro.</p>" + PARAS),
        "Adjuvilo/Ĉapitro II",
    )
    entries["Adjuvilo/Aldono"] = (
        "text/html",
        _page("Adjuvilo/Aldono", "<p>Aldono.</p>"),
        "Adjuvilo/Aldono",
    )
    entries["_assets_/x.png"] = ("image/png", fx.PNG, "")
    return filename, meta, entries, main


def _textbook():
    """Statistics LibreTexts, Siegrist's book with its pages' bodies."""
    filename, meta, entries, main = _libretexts()
    shared = json.loads(fx.LIBRETEXTS_SHARED)
    under = "Bookshelves/Probability_Theory/Probability_Mathematical_Statistics_and_Stochastic_Processes_(Siegrist)"
    shared["pages"].insert(
        [p["path"] for p in shared["pages"]].index(under + "/02:_Probability_Spaces"),
        {"id": "10116", "title": "1.1: Sets", "path": under + "/01:_Foundations/1.01:_Sets"},
    )
    entries["content/shared.json"] = ("application/json", json.dumps(shared), "")
    for p in shared["pages"]:
        if p["path"].startswith(under):
            body = "<p>%s text. %s</p>" % (p["title"], PARAS)
            if p["id"] == "10115":
                body += '<p><a href="#/%s/02:_Probability_Spaces">next</a> <img src="content/f.png"></p>' % under
            entries[f"content/page_content_{p['id']}.json"] = (
                "application/json",
                json.dumps({"htmlBody": body}),
                "",
            )
    entries["index/page_10116"] = ("text/html", "<html></html>", "1.1: Sets")
    return filename, meta, entries, main


@pytest.fixture
def served(shelf_lib):
    from http.server import ThreadingHTTPServer

    from zimi import bookpages
    from zimi.http import ZimHandler

    bookpages._reset_for_tests()

    def serve(zims):
        names = shelf_lib(zims)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        served.httpd = httpd
        return "http://127.0.0.1:%d" % httpd.server_address[1], names

    served.httpd = None
    yield serve
    if served.httpd:
        served.httpd.shutdown()
    bookpages._reset_for_tests()


def _card(zim, title):
    from zimi import books

    return next(b for b in books.listing(zim=zim, limit=50)["books"] if b["title"] == title)


def _book_page(base, zim, path):
    status, ctype, body, headers = _fetch(
        base + "/w/" + zim + "/" + urllib.parse.quote(path)
    )
    assert status == 200 and ctype.startswith("text/html"), (status, body[:300])
    return body.decode("utf-8"), headers


def test_a_wikisource_work_is_one_book_of_its_chapters(served):
    base, names = served([_work()])
    zim = names["wikisource_eo_all_nopic_2026-07"]
    card = _card(zim, "Adjuvilo")
    assert card["path"] == "_zimi_book_/Adjuvilo"
    page, headers = _book_page(base, zim, card["path"])
    assert '<meta name="zimi-book" content="pages">' in page
    assert '<meta name="dc.creator" content="Claudius Colas">' in page
    assert '<meta name="dc.title" content="Adjuvilo">' in page
    # In the order the work links them, then the page it does not link.
    heads = [page.index("<h2>%s</h2>" % t) for t in ("Enkonduko", "Ĉapitro I", "Ĉapitro II", "Aldono")]
    assert heads == sorted(heads)
    # A link to another chapter lands on it; one out of the book leaves it;
    # a picture is the ZIM's.
    assert 'href="#zb-p3"' in page
    assert 'href="/w/%s/Aforismoj_%%28Lanti%%2C_1946%%29"' % zim in page
    assert 'src="/w/%s/_assets_/x.png"' % zim in page
    # The page's own title, its hidden record and its header's navigation
    # are not the book's; its headings sit under the chapters.
    assert "article-header" not in page and "ws-data" not in page and "headertemplate" not in page
    assert "<h5>Sekcio</h5>" in page
    # Nothing of the ZIM's runs.
    assert "__ran" not in page and "script-src 'none'" in headers.get("Content-Security-Policy", "")


def test_a_libretexts_textbook_is_one_book_of_its_pages(served):
    base, names = served([_textbook()])
    zim = names["libretexts.org_en_stats_2026-01"]
    card = _card(zim, "Probability, Mathematical Statistics, and Stochastic Processes (Siegrist)")
    assert card["path"] == "_zimi_book_/index/page_10114"
    page, _h = _book_page(base, zim, card["path"])
    assert '<meta name="dc.creator" content="Siegrist">' in page
    # Its 18 chapters and a section, in the tree's order; no front or back matter.
    assert page.count("<h2") == 19 and "Front Matter" not in page and "Back Matter" not in page
    assert page.index("<h2>1: Foundations</h2>") < page.index('<h2 data-zb-sub="">1.1: Sets</h2>') < page.index("<h2>2: Probability Spaces</h2>")
    # The app's own route to a page of the book lands on it.
    assert 'href="#zb-p3">next' in page
    assert 'src="/w/%s/content/f.png"' % zim in page


def test_a_zim_that_is_one_book_reads_from_its_contents(served):
    filename, meta, entries, main = _htdp()
    entries[main] = (
        "text/html",
        '<html><body><h1>How to Design Programs</h1><a href="part_one.html">I</a> <a href="part_two.html">II</a></body></html>',
        "HtDP",
    )
    entries["htdp.org/2020-8-1/Book/part_one.html"] = (
        "text/html",
        '<html><body><h1>Fixed-Size Data</h1><p>One.</p><a href="part_one_1.html">1</a><a href="index.html">up</a></body></html>',
        "Fixed-Size Data",
    )
    entries["htdp.org/2020-8-1/Book/part_one_1.html"] = (
        "text/html",
        "<html><body><h1>Arithmetic</h1><p>Numbers.</p></body></html>",
        "Arithmetic",
    )
    entries["htdp.org/2020-8-1/Book/part_two.html"] = (
        "text/html",
        "<html><body><h1>Arbitrarily Large Data</h1><p>Two.</p></body></html>",
        "Arbitrarily Large Data",
    )
    base, names = served([(filename, meta, entries, main)])
    zim = names["htdp.org_en_all_2026-08"]
    card = _card(zim, "How to Design Programs")
    assert card["path"] == "_zimi_book_/" + main
    page, _h = _book_page(base, zim, card["path"])
    got = [page.index(x) for x in ("<h2>Fixed-Size Data</h2>", '<h2 data-zb-sub="">Arithmetic</h2>', "<h2>Arbitrarily Large Data</h2>")]
    assert got == sorted(got)
    assert '<meta name="dc.title" content="How to Design Programs">' in page


def test_no_book_at_an_address_is_not_found(served):
    base, names = served([_work()])
    zim = names["wikisource_eo_all_nopic_2026-07"]
    assert _fetch(base + "/w/" + zim + "/_zimi_book_/Nenio")[0] == 404


def _open(base, card, device):
    """The shelf's card opened as Read opens it, in a real browser."""
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    br = pw.chromium.launch()
    ctx = br.new_context(**device(pw)) if callable(device) else br.new_context(**device)
    pg = ctx.new_page()
    pg.goto(base + "/")
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=30000,
    )
    pg.evaluate("(b) => openArticle(b.zim, b.path)", card)
    pg.wait_for_function(
        "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.querySelector('.zb-foot'); }",
        timeout=30000,
    )
    pg.wait_for_timeout(600)
    return pw, br, pg


_STATE = """() => { var d = document.getElementById('reader-frame').contentDocument;
  d.querySelector('.zb-toc').click();
  var toc = Array.prototype.map.call(d.querySelectorAll('.zb-toc-list li'), function(li) { return li.textContent; });
  d.querySelector('.zb-sheet.zb-open .zb-x').click();
  return { title: d.querySelector('.zb-title b').textContent, author: d.querySelector('.zb-title span').textContent,
    paged: d.documentElement.classList.contains('zb-paged'), held: document.body.classList.contains('chrome-held'), toc: toc,
    ran: !!document.getElementById('reader-frame').contentWindow.__ran }; }"""


@pytest.mark.parametrize("phone", [True, False], ids=["390px", "desktop"])
def test_a_wikisource_work_reads_in_the_e_reader(served, phone, tmp_path):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    base, names = served([_work()])
    zim = names["wikisource_eo_all_nopic_2026-07"]
    card = _card(zim, "Adjuvilo")
    device = (lambda pw: pw.devices["iPhone 13"]) if phone else {"viewport": {"width": 1280, "height": 800}}
    pw, br, pg = _open(base, card, device)
    try:
        got = pg.evaluate(_STATE)
        assert got["title"] == "Adjuvilo" and got["author"] == "Claudius Colas"
        # The contents are the work's chapters, the first page its own.
        assert got["toc"] == ["Adjuvilo", "Enkonduko", "Ĉapitro I", "Ĉapitro II", "Aldono"]
        assert got["held"] and got["paged"] == phone and not got["ran"]
        pg.screenshot(path=str(tmp_path / ("book-%s.png" % ("phone" if phone else "desk"))))
        if os.environ.get("ZIMI_SHOTS"):
            pg.screenshot(path=os.path.join(os.environ["ZIMI_SHOTS"], "book-%s.png" % ("phone" if phone else "desk")))
        # The place is kept, per book, as Gutenberg's is.
        if phone:
            pg.touchscreen.tap(365, 420)
        else:
            pg.mouse.move(640, 400)
            pg.mouse.wheel(0, 1500)
        pg.wait_for_timeout(1500)
        where = pg.evaluate("(k) => { var p = Saved.position(k); return p && p.where; }", card["zim"] + "\n" + card["path"])
        assert where and where.get("c", 0) > 0, where
    finally:
        br.close()
        pw.stop()
