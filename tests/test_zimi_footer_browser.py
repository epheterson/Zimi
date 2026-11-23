"""Zimi's footer, "Zimi 1.15.5 · Powered by Kiwix", the line Home ends on, is also the last line of the Games' shelf (and the foot
of a game's Menu) and of the Almanac, in Zimi and in their standalone ZIMs (Kiwix, a browser tab). One definition:
games/zimifooter.js builds it and zimifooter.css draws it; Home's own markup is that function's output. Inside Zimi the line
says the version, outside it the build's year (zimibuild.js, which ownzims writes into each ZIM beside its Date).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_zimi_footer_browser.py -v
"""

import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import functools
import http.server
import threading

import pytest

from test_games_persist_browser import GAMES, VIEW, browser  # noqa: E402,F401

ZIMI = os.path.join(os.path.dirname(GAMES), "..")
STATIC = os.path.join(ZIMI, "static")


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    """The Games as their ZIM is built: the folder plus Zimi's footer files, staged from static/ (ownzims)."""
    from zimi import ownzims

    folder = tmp_path_factory.mktemp("games")
    ownzims._stage_games(str(folder))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(folder))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()
YEAR = "window.ZIMI_BUILT_YEAR = 2031;\n"


def _year(route):
    route.fulfill(body=YEAR, content_type="text/javascript")


def _read(*parts):
    with open(os.path.join(ZIMI, *parts), encoding="utf-8") as f:
        return f.read()


def _words(page_or_el):
    return re.sub(r"\s+", " ", page_or_el.inner_text()).strip()


def test_homes_markup_is_the_functions_output(browser, served):
    """The one copy that cannot be shared: Home's footer is static HTML (its words are translated in place). Same classes, same
    links, same order, as ZimiFooter.inner writes."""
    page = browser.new_context(viewport=VIEW).new_page()
    page.goto("%s/index.html" % served)
    built = page.evaluate("ZimiFooter.inner({ version: '1.2.3', poweredBy: 'Powered by' })")
    home = re.search(r'<footer id="footer"[^>]*>\s*(.*?)\s*<div class="footer-sub">', _read("templates", "index.html"), re.S).group(1)

    def norm(html):
        html = re.sub(r'\s(?:id|data-i18n)="[^"]*"', "", html)
        html = re.sub(r"<span class=\"footer-version\">[^<]*</span>", '<span class="footer-version"></span>', html)
        return re.sub(r"\s+", " ", html).strip()

    assert norm(built) == norm(home), (norm(built), norm(home))


def test_outside_zimi_the_shelf_and_the_menu_end_on_zimis_footer(browser, served):
    page = browser.new_context(viewport=VIEW).new_page()
    page.route("**/zimibuild.js", _year)
    page.goto("%s/index.html" % served)
    foot = page.wait_for_selector(".ar-shelf > .footer")
    assert _words(foot) == "Zimi © 2031 · Powered by Kiwix", _words(foot)
    hrefs = foot.eval_on_selector_all("a", "els => els.map(e => e.href)")
    assert hrefs == ["https://github.com/epheterson/Zimi", "https://kiwix.org/"], hrefs
    # The shelf's very last line: nothing of the page below it.
    assert page.evaluate("document.querySelector('.ar-shelf').lastElementChild.classList.contains('footer')")
    page.goto("%s/chess.html" % served)
    page.click(".gs-menu-btn")
    menu = page.wait_for_selector(".gs-card > .footer")
    assert menu.is_visible() and "2031" in _words(menu)


def test_outside_zimi_the_footer_says_the_version_the_zim_was_built_with(browser, served):
    page = browser.new_context(viewport=VIEW).new_page()
    page.route(
        "**/zimibuild.js",
        lambda route: route.fulfill(body="window.ZIMI_BUILT_YEAR = 2031;\nwindow.ZIMI_BUILT_VERSION = '1.16.0';\n", content_type="text/javascript"),
    )
    page.goto("%s/index.html" % served)
    foot = page.wait_for_selector(".ar-shelf > .footer")
    assert _words(foot) == "Zimi 1.16.0 · Powered by Kiwix", _words(foot)


def test_a_page_read_from_its_folder_has_no_year(browser, served):
    page = browser.new_context(viewport=VIEW).new_page()
    page.route("**/zimibuild.js", lambda route: route.abort())
    page.goto("%s/index.html" % served)
    foot = page.wait_for_selector(".ar-shelf > .footer")
    assert _words(foot) == "Zimi · Powered by Kiwix", _words(foot)


def test_inside_zimis_reader_it_says_the_version(browser, served):
    page = browser.new_context(viewport=VIEW).new_page()
    # Zimi's reader, as shell.js recognises it: a same-origin parent whose #reader-frame holds the page.
    page.route(
        "%s/host.html" % served,
        lambda r: r.fulfill(
            body='<script>var _zimiVersion = "9.9.9";</script><iframe id="reader-frame" src="index.html" style="width:390px;height:800px"></iframe>',
            content_type="text/html",
        ),
    )
    page.goto("%s/host.html" % served)
    frame = page.frame_locator("#reader-frame")
    foot = frame.locator(".ar-shelf > .footer")
    foot.wait_for()
    assert re.sub(r"\s+", " ", foot.inner_text()).strip() == "Zimi 9.9.9 · Powered by Kiwix"


def test_the_build_writes_its_year_beside_the_date():
    import datetime

    from libzim.reader import Archive

    from zimi import ownzims

    for own in ownzims.OWN:
        archive = Archive(ownzims.zim_path(own))
        year = archive.get_metadata("Date").decode()[:4]
        body = bytes(archive.get_entry_by_path(ownzims.BUILD_FILE).get_item().content).decode()
        assert re.fullmatch(r"window.ZIMI_BUILT_YEAR = %s;\nwindow.ZIMI_BUILT_VERSION = '[\d.]+';\n" % year, body), (own.name, body)
    assert int(year) <= datetime.date.today().year


def test_the_word_zimi_is_the_headers_wordmark_and_follows_red(browser, served):
    page = browser.new_context(viewport=VIEW).new_page()
    page.route("**/zimibuild.js", _year)
    page.goto("%s/index.html" % served)
    word = page.wait_for_selector(".ar-shelf > .footer .zimi-brand")
    style = "e => { const c = getComputedStyle(e); return [c.backgroundImage, c.webkitTextFillColor, c.fontWeight, parseFloat(c.letterSpacing) / parseFloat(c.fontSize), c.textDecorationLine]; }"
    image, fill, weight, tracking, decoration = word.evaluate(style)
    gradient = re.search(r"--brand-gradient:\s*([^;]+);", _read("static", "zimifooter.css")).group(1)
    rgb = {"#f59e0b": "rgb(245, 158, 11)", "#f97316": "rgb(249, 115, 22)", "#ef4444": "rgb(239, 68, 68)"}
    for hexed, plain in rgb.items():
        gradient = gradient.replace(hexed, plain)
    assert image == gradient and fill == "rgba(0, 0, 0, 0)", (image, fill)
    assert weight == "700" and abs(tracking + 0.028) < 0.001 and decoration == "none", (weight, tracking, decoration)
    page.evaluate("document.documentElement.style.setProperty('--amber', '#ff2010'); document.documentElement.classList.add('night-red')")
    image, fill = word.evaluate(style)[:2]
    assert image == "none" and fill == "rgb(255, 32, 16)", (image, fill)


def test_the_wordmark_is_one_rule_in_one_file():
    """The header's Zimi, the sign-in screen's and the footer's are the same rule, in zimifooter.css, and nobody else draws it."""
    css = _read("static", "zimifooter.css")
    assert re.search(r":is\(\.zimi-brand, \.topbar \.logo, \.pw-brand span, \.footer \.footer-brand\)", css)
    for name in ("app.css", "apps.css", "tokens.css"):
        assert "--brand-gradient" not in _read("static", name), name
    assert "var(--brand-gradient)" not in _read("static", "app.css")


def test_the_almanac_carries_the_same_footer_files():
    from zimi import almanacstage

    with tempfile.TemporaryDirectory() as tmp:
        almanacstage.stage(tmp)
        for name in ("zimifooter.js", "zimifooter.css"):
            with open(os.path.join(tmp, name), encoding="utf-8") as f, open(os.path.join(STATIC, name), encoding="utf-8") as g:
                assert f.read() == g.read(), name
        with open(os.path.join(tmp, "index.html"), encoding="utf-8") as f:
            page = f.read()
        assert '<link rel="stylesheet" href="zimifooter.css">' in page and '<script src="zimifooter.js"></script>' in page
        assert '<script src="zimibuild.js"></script>' in page
        with open(os.path.join(tmp, "almanac.js"), encoding="utf-8") as f:
            src = f.read()
        foot = src[src.index("html += '<div class=\"alm-footer\">'") :]
        foot = foot[: foot.index("\n")]
        assert foot.index("t('alm_footer')") < foot.index("_almFooter()"), foot


def test_the_games_zim_is_staged_with_the_same_footer_files():
    import filecmp

    from zimi import ownzims

    with tempfile.TemporaryDirectory() as tmp:
        ownzims._stage_games(tmp)
        for name in ("zimifooter.js", "zimifooter.css"):
            assert filecmp.cmp(os.path.join(tmp, name), os.path.join(STATIC, name), shallow=False), name
        assert not os.path.exists(os.path.join(GAMES, "zimifooter.js"))  # one copy: static/'s


def test_the_footer_follows_red_ink_on_a_zim_page(browser, served):
    page = browser.new_context(viewport=VIEW).new_page()
    page.route("**/zimibuild.js", _year)
    page.goto("%s/index.html" % served)
    foot = page.wait_for_selector(".ar-shelf > .footer")
    page.evaluate("document.documentElement.classList.add('night-red')")
    colours = foot.evaluate("e => [getComputedStyle(e).color, ...[...e.querySelectorAll('a:not(.zimi-brand)')].map(a => getComputedStyle(a).color)]")
    assert set(colours) == {"rgb(255, 32, 16)"}, colours


def test_the_shell_inlines_the_footer_for_home():
    from zimi import http

    assert "<!--@zimifooter" not in http.SEARCH_UI_HTML
    head = http.SEARCH_UI_HTML.split("</head>", 1)[0]
    assert "root.ZimiFooter" in head and ".zimi-brand" in head


FOOTER_GAP = 16  # --sp-4: one margin above the footer on Home, the Games and the Almanac

CENTRE_JS = """sel => {
  const f = document.querySelector(sel);
  f.scrollIntoView({ block: 'center' });
  const range = document.createRange(); range.selectNodeContents(f);
  const text = range.getBoundingClientRect(), box = f.getBoundingClientRect(), parent = f.parentElement.getBoundingClientRect();
  const cs = getComputedStyle(f), pcs = getComputedStyle(f.parentElement);
  const innerLeft = parent.left + parseFloat(pcs.paddingLeft), innerRight = parent.right - parseFloat(pcs.paddingRight);
  const prev = f.previousElementSibling ? f.previousElementSibling.getBoundingClientRect().bottom : null;
  return { textCentre: (text.left + text.right) / 2, boxCentre: (box.left + box.right) / 2, columnCentre: (innerLeft + innerRight) / 2,
           marginTop: parseFloat(cs.marginTop), gapAbove: prev === null ? null : box.top - prev, align: cs.textAlign,
           hit: [...f.querySelectorAll('a')].map(a => parseFloat(getComputedStyle(a, '::after').height)) };
}"""


def _assert_centred(page, sel, margin_top):
    for width in (390, 1280):
        page.set_viewport_size({"width": width, "height": 844})
        page.wait_for_timeout(300)
        m = page.evaluate(CENTRE_JS, sel)
        assert m["align"] == "center", (width, m)
        assert abs(m["textCentre"] - m["boxCentre"]) <= 1, (width, m)  # the words sit in the middle of the line's box
        assert abs(m["boxCentre"] - m["columnCentre"]) <= 1, (width, m)  # and the box in the middle of its column
        assert m["hit"] and all(h >= 44 for h in m["hit"]), (width, m)  # every link keeps its 44px touch box
        assert m["marginTop"] == margin_top, (width, m)
        assert m["gapAbove"] is None or m["gapAbove"] >= margin_top - 1, (width, m)  # the room above it is held


def test_the_footer_is_centred_with_its_margin_in_the_games(browser, served):
    page = browser.new_context(viewport=VIEW).new_page()
    page.route("**/zimibuild.js", _year)
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".ar-shelf > .footer")
    _assert_centred(page, ".ar-shelf > .footer", FOOTER_GAP)


def test_the_footer_is_centred_with_its_margin_in_the_almanac(browser):
    from zimi import almanacstage

    with tempfile.TemporaryDirectory() as tmp:
        almanacstage.stage(tmp)
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp)
        handler.log_message = lambda *a, **k: None
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            page = browser.new_context(viewport=VIEW).new_page()
            page.route("**/zimibuild.js", _year)
            page.goto("http://127.0.0.1:%d/index.html" % srv.server_address[1])
            page.wait_for_selector(".alm-footer + .footer", state="attached", timeout=60000)
            _assert_centred(page, ".alm-footer + .footer", FOOTER_GAP)
        finally:
            srv.shutdown()


def test_outside_zimi_the_almanac_ends_on_the_same_credit(browser):
    """1.15.6 credited Zimi, linked, under the standalone Almanac; the shared footer keeps that promise (name linked, build year)."""
    from zimi import almanacstage

    with tempfile.TemporaryDirectory() as tmp:
        almanacstage.stage(tmp)
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp)
        handler.log_message = lambda *a, **k: None
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            page = browser.new_context(viewport=VIEW).new_page()
            page.route("**/zimibuild.js", _year)
            page.goto("http://127.0.0.1:%d/index.html" % srv.server_address[1])
            foot = page.wait_for_selector(".alm-footer + .footer", state="attached", timeout=60000)
            assert _words(foot) == "Zimi © 2031 · Powered by Kiwix", _words(foot)
            hrefs = foot.eval_on_selector_all("a", "els => els.map(e => e.href)")
            assert hrefs == ["https://github.com/epheterson/Zimi", "https://kiwix.org/"], hrefs
        finally:
            srv.shutdown()


def test_the_footer_is_centred_with_its_margin_on_home(browser):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "zims")), os.makedirs(os.path.join(tmp, "data"))
        old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
        srv.ZIM_DIR, srv.ZIMI_DATA_DIR = os.path.join(tmp, "zims"), os.path.join(tmp, "data")
        srv.load_cache(force=True)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            page = browser.new_context(viewport=VIEW).new_page()
            page.goto("http://127.0.0.1:%d/" % httpd.server_address[1])
            page.wait_for_selector("#footer", state="attached")
            page.evaluate("document.getElementById('footer').style.display = ''")
            _assert_centred(page, "#footer", FOOTER_GAP)
        finally:
            httpd.shutdown()
            srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old
