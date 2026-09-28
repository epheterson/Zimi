"""Links that leave the library, in a real browser, in every reader (#99).

tripplehelix: "It can be confusing as to which links take you to the web."
Every reader marks a link to the web with a small arrow and says where it goes
before it goes; a link an installed ZIM can answer is not the web and opens in
the library; Settings can hide web links as plain text instead.

Served through the real handler from ZIMs written here, driven at a phone's
390px (touch) and at a desktop width (mouse), light and dark, right to left.
Set ZIMI_SHOTS_DIR to keep the screenshots.

Run: pytest tests/test_external_links_reader.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

SHOTS = os.environ.get("ZIMI_SHOTS_DIR", "")
PROSE = (
    "A paragraph long enough for Reader View to take the page, which wants a few "
    "hundred characters of real text before it calls something an article. "
) * 3

INDEX = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Where links go</title>
<style>body{{font:17px/1.55 Georgia,serif;margin:16px;max-width:40em;color:#202122;background:#fff}}a{{color:#0645ad}}</style></head>
<body><main><h1 id="top">Where links go</h1>
<p>Read <a id="rel" href="Other">another page here</a>, the
<a id="lib" href="https://library.example/Some_page">same page in an installed ZIM</a>,
<a id="xzim" href="https://library.example/Water">a page that ZIM holds</a>, or
<a id="web" href="https://elsewhere.example/a/b">an outside site</a> and
<a id="proto" href="//cdn.elsewhere.example/x">a protocol-relative one</a>.</p>
<p>Write to <a id="mail" href="mailto:someone@example.org">someone</a>, call
<a id="tel" href="tel:+15551234">a number</a>, <a id="js" href="javascript:void(0)">do nothing</a>,
or go back <a id="anchor" href="#top">to the top</a>.</p>
<p><a id="img" href="https://pictures.example/"><img src="Other" alt="" width="40" height="20"></a></p>
<p>{PROSE}</p></main></body></html>"""

RTL = f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>روابط</title>
<style>body{{font:18px/1.6 sans-serif;margin:16px;color:#202122;background:#fff}}</style></head>
<body><main><h1>إلى أين تذهب الروابط</h1>
<p>اقرأ <a id="web" href="https://elsewhere.example/ar">موقعًا خارجيًا</a> أو
<a id="rel" href="Other">صفحة هنا</a>.</p><p>{PROSE}</p></main></body></html>"""

# MediaWiki draws its own icon on a.external: one mark per link, not two.
MW = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refs</title>
<style>.mw-parser-output a.external{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Crect width='10' height='10'/%3E%3C/svg%3E");
background-repeat:no-repeat;background-position:center right;padding-right:13px}</style></head>
<body><div class="mw-parser-output"><p>A reference:
<a id="ref" class="external text" href="https://elsewhere.example/ref">the source</a>.</p></div></body></html>"""

QUESTION_LINK = '<a href="https://elsewhere.example/onions">a site about onions</a>'


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import _MediaItem, build_fixture_zim
    from libzim.writer import Creator
    from sotoki_fixture import QUESTION

    from zimi import exchange
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    with Creator(str(zdir / "extlinks_en_2026-01.zim")).config_indexing(
        False, "eng"
    ) as cr:
        cr.set_mainpath("A/index")
        for path, html in (
            ("A/index", INDEX),
            ("A/rtl", RTL),
            ("A/mw", MW),
            ("A/Other", "<p>other</p>"),
        ):
            cr.add_item(_MediaItem(path, "text/html", html.encode()))
        for key, value in {
            "Name": "extlinks_en",
            "Title": "Links",
            "Language": "eng",
            "Description": "links",
            "Date": "2026-01-01",
        }.items():
            cr.add_metadata(key, value)
    # A capture of library.example: its host is in the domain map, so a link
    # to it is the library.
    build_fixture_zim(
        str(zdir / "library.example_en_2026-01.zim"), {"Name": "library.example_en"}
    )
    question = QUESTION.replace("</b>. See", "</b>. See " + QUESTION_LINK + " and")
    build_fixture_zim(
        str(zdir / "cooking.stackexchange.com_en_all_2026-07.zim"),
        {"Scraper": "sotoki v3.1.1", "Name": "cooking.stackexchange.com_en_all"},
        files={"questions/567/how-can-i-chop-onions-without-crying": question.encode()},
    )
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    exchange._reset_for_tests()
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def _context(pw, phone=False, dark=False, lang=None, hide=False):
    br = pw.chromium.launch()
    opts = (
        dict(pw.devices["iPhone 13"])
        if phone
        else {"viewport": {"width": 1280, "height": 800}}
    )
    opts["color_scheme"] = "dark" if dark else "light"
    ctx = br.new_context(**opts)
    # The web is not here: every outside request is refused, so a tab that
    # opens is a popup event and nothing more.
    outside = []

    def route(r):
        if "127.0.0.1" in r.request.url:
            r.continue_()
        else:
            outside.append(r.request.url)
            r.abort()

    ctx.route("**/*", route)
    ctx.zimi_outside = outside
    init = []
    if lang:
        init.append("localStorage.setItem('zimi_ui_lang', %r);" % lang)
    if hide:
        init.append("localStorage.setItem('zimi_external_links', 'hide');")
    if init:
        ctx.add_init_script("try{" + "".join(init) + "}catch(e){}")
    return br, ctx


def _went(pg, ctx, prefix):
    """Whether the browser set off for ``prefix`` (the request, refused)."""
    for _ in range(30):
        if any(u.startswith(prefix) for u in ctx.zimi_outside):
            return True
        pg.wait_for_timeout(100)
    return False


def _open(pg, base, path, zim="extlinks"):
    if not pg.url.startswith(base):
        pg.goto(base + "/")
        pg.wait_for_function(
            "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
            timeout=30000,
        )
        pg.wait_for_function(
            "() => Object.keys(_domainZimMap).length > 0", timeout=30000
        )
    pg.evaluate("([z, p]) => openArticle(z, p)", [zim, path])
    pg.wait_for_function(
        "() => { var d = document.getElementById('reader-frame').contentDocument;"
        " return d && d.getElementById('zimi-ext-style') && document.getElementById('reader-loading').classList.contains('hidden'); }",
        timeout=30000,
    )
    pg.wait_for_timeout(300)


MARKS = """() => { var d = document.getElementById('reader-frame').contentDocument, out = {};
  d.querySelectorAll('a[id]').forEach(function(a) { out[a.id] = {
    ext: a.classList.contains('zimi-ext'), bare: a.classList.contains('zimi-ext-bare'),
    off: a.classList.contains('zimi-ext-off'), href: a.getAttribute('href'),
    after: d.defaultView.getComputedStyle(a, '::after').getPropertyValue('display'),
    content: d.defaultView.getComputedStyle(a, '::after').getPropertyValue('content') }; });
  return out; }"""

SHEET = """() => { var s = document.getElementById('ext-sheet');
  return s && s.classList.contains('open') ? { text: s.innerText, open: !!s.querySelector('[data-ext=open]'),
    dir: getComputedStyle(s).direction, rect: s.getBoundingClientRect().toJSON() } : null; }"""


def _frame_box(pg, sel):
    return pg.frame_locator("#reader-frame").locator(sel).bounding_box()


def test_desktop_marks_the_web_says_where_on_hover_and_opens_on_click(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, ctx = _context(pw, dark=True)
        pg = ctx.new_page()
        try:
            _open(pg, served, "A/index")
            m = pg.evaluate(MARKS)
            # The web, marked; everything else left alone.
            assert (
                m["web"]["ext"]
                and m["proto"]["ext"]
                and m["web"]["after"] == "inline-block"
            )
            for kept in ("rel", "lib", "xzim", "mail", "tel", "js", "anchor"):
                assert not m[kept]["ext"], kept
            # A page another installed ZIM holds is underlined as one: /resolve
            # asked about the links the marking pass found, and only the page
            # the ZIM has is taken.
            pg.wait_for_function(
                "() => document.getElementById('reader-frame').contentDocument.getElementById('xzim').classList.contains('zimi-xzim')",
                timeout=10000,
            )
            assert not pg.evaluate(
                "() => document.getElementById('reader-frame').contentDocument.getElementById('lib').classList.contains('zimi-xzim')"
            )
            # A picture that is a link says where it goes but grows no arrow.
            assert m["img"]["ext"] and m["img"]["bare"]
            assert m["img"]["content"] in ("none", "normal")
            # A mouse resting on it: where it goes, before it goes.
            pg.frame_locator("#reader-frame").locator("#web").hover()
            pg.wait_for_function(
                "() => document.getElementById('ext-sheet') && document.getElementById('ext-sheet').classList.contains('open')"
            )
            sheet = pg.evaluate(SHEET)
            assert (
                "Opens elsewhere.example on the web" in sheet["text"] and sheet["open"]
            )
            link = _frame_box(pg, "#web")
            assert (
                sheet["rect"]["top"] >= link["y"] + link["height"]
            ), "the sheet sits below the link"
            _shot(pg, "ext-desktop-dark-hover")
            # Moving away puts it away.
            pg.mouse.move(5, 790)
            pg.wait_for_timeout(500)
            assert pg.evaluate(SHEET) is None
            # A click opens the web in a new tab.
            pg.frame_locator("#reader-frame").locator("#web").click()
            assert _went(pg, ctx, "https://elsewhere.example/a/b")
            # And a link an installed ZIM answers opens in the library.
            pg.frame_locator("#reader-frame").locator("#lib").click()
            pg.wait_for_function(
                "() => currentArticle && currentArticle.zim === 'library.example'",
                timeout=15000,
            )
        finally:
            br.close()


def test_a_phone_asks_first_and_copies_the_link(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, ctx = _context(pw, phone=True)
        pg = ctx.new_page()
        opened = []
        ctx.on("page", lambda p: opened.append(p.url))
        try:
            _open(pg, served, "A/index")
            box = _frame_box(pg, "#web")
            pg.touchscreen.tap(box["x"] + 8, box["y"] + box["height"] / 2)
            pg.wait_for_timeout(400)
            sheet = pg.evaluate(SHEET)
            assert sheet and "elsewhere.example" in sheet["text"] and sheet["open"]
            assert not opened, "a tap asks before it goes"
            assert (
                sheet["rect"]["right"] <= 390 - 7 and sheet["rect"]["left"] >= 7
            ), "inside a 390px screen"
            _shot(pg, "ext-phone-light-tap")
            pg.locator("#ext-sheet [data-ext=copy]").tap()
            pg.wait_for_timeout(300)
            assert pg.evaluate(SHEET) is None
            # Open, from the sheet, goes.
            pg.touchscreen.tap(box["x"] + 8, box["y"] + box["height"] / 2)
            pg.wait_for_timeout(300)
            pg.locator("#ext-sheet [data-ext=open]").tap()
            assert _went(pg, ctx, "https://elsewhere.example/")
        finally:
            br.close()


def test_offline_the_sheet_says_so_instead_of_opening_a_dead_tab(served, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, ctx = _context(pw)
        pg = ctx.new_page()
        opened = []
        ctx.on("page", lambda p: opened.append(p.url))
        try:
            _open(pg, served, "A/index")
            pg.wait_for_function("() => _extServerOffline === true")
            pg.frame_locator("#reader-frame").locator("#web").click()
            pg.wait_for_timeout(400)
            sheet = pg.evaluate(SHEET)
            assert sheet and "needs the internet" in sheet["text"]
            assert not sheet["open"], "no Open when there is no web to open"
            assert not opened
            _shot(pg, "ext-desktop-light-offline")
        finally:
            br.close()


def test_hidden_they_read_as_plain_text_and_the_setting_is_kept(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, ctx = _context(pw, phone=True, dark=True, hide=True)
        pg = ctx.new_page()
        try:
            _open(pg, served, "A/index")
            m = pg.evaluate(MARKS)
            assert m["web"]["off"] and m["web"]["href"] is None and not m["web"]["ext"]
            assert m["rel"]["href"] == "Other" and m["mail"]["href"].startswith(
                "mailto:"
            )
            text = pg.frame_locator("#reader-frame").locator("#web").inner_text()
            assert text == "an outside site", "the words stay"
            _shot(pg, "ext-phone-dark-hidden")
            # Kept with the person's other reading preferences.
            assert pg.evaluate("() => _PREF_KEYS.indexOf(SK.EXT_LINKS) >= 0")
            # Back to marking, live, on the page already open.
            pg.evaluate("() => _setExtLinkMode('mark')")
            m = pg.evaluate(MARKS)
            assert (
                m["web"]["ext"] and m["web"]["href"] == "https://elsewhere.example/a/b"
            )
            assert (
                pg.evaluate("() => localStorage.getItem('zimi_external_links')") is None
            )
        finally:
            br.close()


def test_the_setting_is_in_settings(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, ctx = _context(pw)
        pg = ctx.new_page()
        try:
            pg.goto(served + "/?manage=preferences")
            seg = pg.locator("#ext-links-seg")
            seg.wait_for(timeout=30000)
            assert seg.locator("button").count() == 2
            seg.locator("button").nth(1).click()
            assert (
                pg.evaluate("() => localStorage.getItem('zimi_external_links')")
                == "hide"
            )
            assert seg.locator("button.active").inner_text().strip() == "Hide them"
            seg.scroll_into_view_if_needed()
            _shot(pg, "ext-settings-light")
        finally:
            br.close()


def test_right_to_left_and_reader_view_and_a_page_with_its_own_mark(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, ctx = _context(pw, lang="ar")
        pg = ctx.new_page()
        try:
            _open(pg, served, "A/rtl")
            m = pg.evaluate(MARKS)
            assert m["web"]["ext"] and not m["rel"]["ext"]
            flip = pg.evaluate(
                """() => { var d = document.getElementById('reader-frame').contentDocument;
                return d.defaultView.getComputedStyle(d.getElementById('web'), '::after').transform; }"""
            )
            assert flip.startswith(
                "matrix(-1"
            ), "the arrow points the way the text runs"
            pg.frame_locator("#reader-frame").locator("#web").hover()
            pg.wait_for_function(
                "() => { var s = document.getElementById('ext-sheet'); return !!s && s.classList.contains('open'); }"
            )
            sheet = pg.evaluate(SHEET)
            assert sheet["dir"] == "rtl" and "elsewhere.example" in sheet["text"]
            _shot(pg, "ext-desktop-rtl-hover")
            # Reader View copies the page, marks and all.
            pg.mouse.move(5, 790)
            pg.evaluate("() => _readerViewToggle()")
            assert pg.evaluate(
                """() => !!document.getElementById('reader-frame').contentDocument
                .querySelector('.zimi-reader a.zimi-ext')"""
            )
            _shot(pg, "ext-desktop-rtl-reader-view")
            # MediaWiki draws its own icon: ours steps aside.
            _open(pg, served, "A/mw")
            m = pg.evaluate(MARKS)
            assert m["ref"]["ext"] and m["ref"]["after"] == "none"
            assert pg.evaluate(
                "() => document.getElementById('reader-frame').contentDocument.documentElement.classList.contains('zimi-ext-own')"
            )
        finally:
            br.close()


def test_an_app_page_showing_zim_html_marks_it_too(served):
    """ZimiExchange shows a question's own HTML in a page of Zimi's: its link
    out gets the same mark, and a click there asks the shell, not the frame."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, ctx = _context(pw, phone=True)
        pg = ctx.new_page()
        opened = []
        ctx.on("page", lambda p: opened.append(p.url))
        try:
            pg.goto(served + "/")
            pg.wait_for_function(
                "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
                timeout=30000,
            )
            pg.evaluate(
                "() => openExchange(false, 'cooking.stackexchange/questions/567/how-can-i-chop-onions-without-crying')"
            )
            link = pg.frame_locator("#reader-frame").locator(
                '#q-body a[href^="https://elsewhere.example"]'
            )
            link.wait_for(timeout=30000)
            assert "zimi-ext" in (link.get_attribute("class") or "")
            box = link.bounding_box()
            pg.touchscreen.tap(box["x"] + 6, box["y"] + box["height"] / 2)
            pg.wait_for_timeout(400)
            sheet = pg.evaluate(SHEET)
            assert sheet and "elsewhere.example" in sheet["text"]
            assert not opened
            assert pg.evaluate(
                "() => document.getElementById('reader-frame').contentWindow.location.pathname"
            ).startswith("/static/")
            _shot(pg, "ext-phone-exchange")
        finally:
            br.close()
