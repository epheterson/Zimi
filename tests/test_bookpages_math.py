r"""A LibreTexts textbook's formulas read as math in the e-reader, not TeX.

Eric, 2026-09-30 (1.12.1): LibreTexts textbooks showed raw TeX in the
e-reader: their pages write \(..\) and \[..\] for the MathJax the ZIM ships,
and no script runs in the book's page.

The book's page marks each formula and names the ZIM's MathJax; the shell
draws them with it, offline, as they come into view. A book without TeX
(or a ZIM without MathJax) is served byte for byte as before, and the shell
never loads the math code for it.

The browser tests use a stand-in MathJax (the same calls, a box for each
formula) so they run without MathJax on disk; the real one was checked by
hand with the ZIM's own tex-svg.js 3.2.2.

Run: pytest tests/test_bookpages_math.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import books_sources_fixture as fx  # noqa: E402
from test_books_sources import _fetch, _libretexts, shelf_lib  # noqa: E402,F401

BOOK = "Bookshelves/Probability_Theory/Probability_Mathematical_Statistics_and_Stochastic_Processes_(Siegrist)"
ROOT = "_zimi_book_/index/page_10114"
MATHJAX = "mathjax/es5/tex-svg.js"
# LibreTexts' block of macros at a page's head, as its pages have it.
PREAMBLE = (
    '<div class="Headertext">'
    "<p>\\( \\newcommand{\\vecs}[1]{\\overset { \\scriptstyle \\rightharpoonup} {\\mathbf{#1}}&nbsp;}&nbsp;\\)</p>"
    "<p>\\(\\newcommand{\\R}{\\mathbb{R}}\\)</p></div>"
)
FILLER = "".join(
    "<p>Sets are the foundation of probability, paragraph %d of the section.</p>" % i
    for i in range(25)
)


def _math_body(title):
    return (
        PREAMBLE
        + "<p>Let \\(\\vecs{v} \\in \\R^n\\) and \\(A \\subseteq B\\) be as in %s.</p>"
        % title
        + FILLER
        + "<p>The union: \\[ A \\cup B = \\{x \\in S: x \\in A \\text{ or } x \\in B\\} \\]</p>"
        + "<p>Example \\(\\PageIndex{1}\\) shows $$\\sum_{i=1}^{n} x_i^2 = \\int_0^1 f(t)\\,dt + "
        + " + ".join("a_{%d}" % i for i in range(40))
        + "$$</p>"
        + "<pre>\\(verbatim\\)</pre>"
        + FILLER
    )


def textbook(mathjax=None, math=True):
    """Siegrist's statistics book, each chapter with formulas (``math``), in
    a ZIM with ``mathjax`` (bytes) at mindtouch2zim's path, or none."""
    filename, meta, entries, main = _libretexts()
    shared = json.loads(fx.LIBRETEXTS_SHARED)
    for p in shared["pages"]:
        if p["path"].startswith(BOOK):
            body = (
                _math_body(p["title"])
                if math
                else "<p>%s text.</p>%s" % (p["title"], FILLER)
            )
            entries[f"content/page_content_{p['id']}.json"] = (
                "application/json",
                json.dumps({"htmlBody": body}),
                "",
            )
    if mathjax is not None:
        entries[MATHJAX] = ("application/javascript", mathjax, "")
    return filename, meta, entries, main


# The calls the reader makes of MathJax 3, answered with a box per formula
# (none for a formula that only defines a macro), and a count of them.
STUB = rb"""(function () {
  var cfg = window.MathJax || {};
  window.__mjConfig = cfg; window.__mjCalls = 0;
  var NS = 'http://www.w3.org/2000/svg';
  window.MathJax = {
    startup: { promise: Promise.resolve() },
    svgStylesheet: function () { var s = document.createElement('style'); s.textContent = 'mjx-container{display:inline-block}'; return s; },
    tex2svgPromise: function (tex, o) {
      window.__mjCalls++;
      var c = document.createElement('mjx-container');
      c.setAttribute('jax', 'SVG');
      if (o && o.display) c.setAttribute('display', 'true');
      var svg = document.createElementNS(NS, 'svg');
      var wide = tex.length > 150;
      svg.setAttribute('width', wide ? '120ex' : '4ex'); svg.setAttribute('height', '2ex');
      svg.setAttribute('viewBox', wide ? '0 0 1200 20' : '0 0 40 20');
      if (!/^\s*\\newcommand/.test(tex)) {
        var p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M0 0H40V20H0Z'); p.setAttribute('fill', 'currentColor');
        svg.appendChild(p);
      }
      c.appendChild(svg);
      return Promise.resolve(c);
    }
  };
})();"""


@pytest.fixture
def served(shelf_lib):
    from http.server import ThreadingHTTPServer

    from zimi import bookpages
    from zimi.http import ZimHandler

    bookpages._reset_for_tests()
    httpd = []

    def serve(zims, name="libretexts.org_en_stats_2026-01"):
        names = shelf_lib(zims)
        h = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=h.serve_forever, daemon=True).start()
        httpd.append(h)
        return (
            "http://127.0.0.1:%d" % h.server_address[1],
            names[name],
        )

    yield serve
    for h in httpd:
        h.shutdown()
    bookpages._reset_for_tests()


def _page(base, zim):
    status, _ctype, body, _h = _fetch(base + "/w/" + zim + "/" + ROOT)
    assert status == 200, body[:300]
    return body.decode("utf-8")


# ── the page ───────────────────────────────────────────────────────────────


def test_a_textbooks_formulas_are_marked_for_its_zims_mathjax(served):
    base, zim = served([textbook(STUB)])
    page = _page(base, zim)
    head = page[: page.index("<body>")]
    assert '<meta name="zimi-math" content="/w/%s/%s">' % (zim, MATHJAX) in head
    # Each formula, inline or display, is marked; TeX in <pre> is not.
    assert '<span class="zb-tex">\\(A \\subseteq B\\)</span>' in page
    assert '<span class="zb-tex">\\[ A \\cup B' in page
    assert '<span class="zb-tex">$$\\sum_{i=1}' in page
    assert "<pre>\\(verbatim\\)</pre>" in page
    # The page's macros are kept for its formulas, out of sight.
    assert '<div class="Headertext" hidden>' in page
    assert '<span class="zb-tex">\\( \\newcommand{\\vecs}' in page
    # \PageIndex is the page's own number, as the ZIM's reader has it.
    assert 'Example <span class="zb-tex">\\(1.1\\)</span>' in page
    assert 'Example <span class="zb-tex">\\(18.1\\)</span>' in page
    assert "\\PageIndex" not in page


def test_no_math_costs_a_book_nothing(served):
    """A ZIM with no MathJax, or a book with no TeX: no mark, no meta."""
    base, zim = served([textbook(None)])
    page = _page(base, zim)
    assert "zimi-math" not in page and "zb-tex" not in page
    assert page.count("\\(") > 10  # the TeX is as the page wrote it


def test_a_book_without_tex_names_no_mathjax(served):
    base, zim = served([textbook(STUB, math=False)])
    page = _page(base, zim)
    assert "zimi-math" not in page and "zb-tex" not in page


def test_marking_leaves_tags_and_verbatim_text_alone():
    from zimi import bookpages

    got, n = bookpages.mark_tex(
        '<p title="\\(no\\)">a < b and \\(x &lt; y\\)</p><code>$$c$$</code><br/>\\[d\\]'
    )
    assert n == 2
    assert got == (
        '<p title="\\(no\\)">a < b and <span class="zb-tex">\\(x &lt; y\\)</span></p>'
        '<code>$$c$$</code><br/><span class="zb-tex">\\[d\\]</span>'
    )
    assert bookpages.mark_tex("<p>plain</p>") == ("<p>plain</p>", 0)
    assert (
        bookpages._lt_front("1.02: Sets") == "1.2."
        and bookpages._lt_front("Home") == ""
    )


# ── in the reader ──────────────────────────────────────────────────────────

_READ = r"""() => { var f = document.getElementById('reader-frame'), d = f.contentDocument, w = f.contentWindow;
  var on = d.querySelectorAll('.zb-tex.zb-tex-on');
  var seen = Array.prototype.filter.call(on, function(s) { var r = s.getBoundingClientRect(); return r.bottom > 0 && r.top < w.innerHeight && r.right > 0 && r.left < w.innerWidth; });
  var wide = d.querySelector('.zb-tex-d.zb-tex-on svg[width="120ex"]');
  var box = wide && wide.closest('.zb-tex-d');
  var src = d.querySelector('.zb-tex-on .zb-tex-src');
  var ink = d.querySelector('.zb-tex-on svg path');
  return { marked: d.querySelectorAll('.zb-tex').length, drawn: on.length, onScreen: seen.length,
    calls: f.contentWindow.parent.document.querySelector('iframe[srcdoc]') ? f.contentWindow.parent.document.querySelector('iframe[srcdoc]').contentWindow.__mjCalls : -1,
    srcShown: src ? getComputedStyle(src).display !== 'none' : null,
    preambleShown: !!d.querySelector('.Headertext') && d.querySelector('.Headertext').getBoundingClientRect().height > 0,
    rawOnScreen: Array.prototype.filter.call(d.querySelectorAll('.zb-tex:not(.zb-tex-on)'), function(s) { var r = s.getBoundingClientRect(); return r.height && r.bottom > 0 && r.top < w.innerHeight && r.right > 0 && r.left < w.innerWidth; }).length,
    ink: ink ? getComputedStyle(ink).fill : '', text: getComputedStyle(d.querySelector('.zimi-reader')).color,
    wideScrolls: box ? box.scrollWidth > box.clientWidth + 1 : null,
    pageFits: d.documentElement.scrollWidth <= w.innerWidth + 1,
    label: (d.querySelector('.zb-tex-on [role="math"]') || {getAttribute: function() { return ''; }}).getAttribute('aria-label') }; }"""


def _open(base, zim, device, theme="dark", root=ROOT):
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    br = pw.chromium.launch()
    ctx = br.new_context(**device(pw)) if callable(device) else br.new_context(**device)
    ctx.add_init_script(
        "try{localStorage.setItem('zimi_reader_theme', %s)}catch(e){}"
        % json.dumps(theme)
    )
    pg = ctx.new_page()
    loaded = []
    pg.on("request", lambda r: loaded.append(r.url))
    pg.goto(base + "/")
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=30000,
    )
    pg.evaluate("(b) => openArticle(b.zim, b.path)", {"zim": zim, "path": root})
    pg.wait_for_function(
        "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.querySelector('.zb-foot'); }",
        timeout=30000,
    )
    return pw, br, pg, loaded


@pytest.mark.parametrize(
    "phone,theme", [(True, "dark"), (False, "light")], ids=["390px-dark", "desktop-light"]
)
def test_the_e_reader_draws_a_textbooks_formulas(served, phone, theme):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    base, zim = served([textbook(STUB)])
    device = (
        (lambda pw: pw.devices["iPhone 13"])
        if phone
        else {"viewport": {"width": 1280, "height": 800}}
    )
    pw, br, pg, loaded = _open(base, zim, device, theme)
    try:
        pg.wait_for_function(
            "() => document.getElementById('reader-frame').contentDocument.querySelector('.zb-tex-on svg path')",
            timeout=15000,
        )
        pg.wait_for_timeout(800)
        got = pg.evaluate(_READ)
        if os.environ.get("ZIMI_SHOTS"):
            pg.screenshot(
                path=os.path.join(
                    os.environ["ZIMI_SHOTS"],
                    "math-%s-%s.png" % ("phone" if phone else "desk", theme),
                )
            )
        assert any("/static/bookmath.js" in u for u in loaded)
        assert any(u.endswith("/w/%s/%s" % (zim, MATHJAX)) for u in loaded)
        # The formulas on screen are drawn, their TeX hidden, the macros'
        # block out of sight, and no TeX left to read on the screen.
        assert (
            got["onScreen"] > 0
            and got["srcShown"] is False
            and not got["preambleShown"]
        )
        assert not got["rawOnScreen"], got
        # Drawn in the reader's ink, whatever the theme, and labelled.
        assert got["ink"] == got["text"], got
        assert got["label"]
        # Drawn as they come near, not the whole textbook at once.
        assert got["drawn"] < got["marked"], got
        # A formula too wide for the column scrolls in its line; the page does not.
        if phone:
            assert got["pageFits"]
    finally:
        br.close()
        pw.stop()


def test_a_book_without_math_never_loads_the_math_code(served):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    base, zim = served([textbook(STUB, math=False)])
    pw, br, pg, loaded = _open(base, zim, {"viewport": {"width": 1280, "height": 800}})
    try:
        pg.wait_for_timeout(800)
        assert not any("bookmath" in u or "mathjax" in u for u in loaded), loaded
    finally:
        br.close()
        pw.stop()

