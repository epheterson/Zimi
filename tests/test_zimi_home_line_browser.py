"""The credit line ("© <year> Zimi" after the mark, Zimi a link), drawn where the Games and the Almanac are read outside Zimi
(Kiwix, a browser tab) and never inside Zimi's reader: under the shelf's title, the foot of a game's Menu, the Almanac's foot.
The address is written once, in games/zimihome.js (the Almanac's ZIM carries a copy); the year is the build's, zimibuild.js,
which ownzims writes into each ZIM beside its Date. The mark sits on the digits, measured.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_zimi_home_line_browser.py -v
"""

import os
import re
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import GAMES, VIEW, browser, served  # noqa: E402,F401


def home_url():
    with open(os.path.join(GAMES, "zimihome.js"), encoding="utf-8") as f:
        return re.search(r"ZIMI_HOME = '([^']+)'", f.read()).group(1)


# The mark's centre against the centre of the digits' height (baseline up to the top of "0"), in px: the optical seat.
MARK_OFFSET = """sel => { const line = document.querySelector(sel), img = line.querySelector('img'), span = line.querySelector('span');
  const probe = document.createElement('i'); probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  span.appendChild(probe); const base = probe.getBoundingClientRect().bottom; probe.remove();
  const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(span); c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
  const digits = c.measureText('0').actualBoundingBoxAscent; const r = img.getBoundingClientRect();
  return (r.top + r.height / 2) - (base - digits / 2); }"""


def test_outside_zimi_the_shelf_and_the_menu_credit_zimi(browser, served):
    url = home_url()
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    # The year is the build's (zimibuild.js, which ownzims writes into the ZIM), never the reader's clock: a year no clock says.
    page.route(
        "**/zimibuild.js",
        lambda r: r.fulfill(
            body="window.ZIMI_BUILT_YEAR = 2031;\n", content_type="text/javascript"
        ),
    )
    page.goto("%s/index.html" % served)
    line = page.wait_for_selector(".ar-shelf > .gs-home")
    assert (
        line.is_visible() and line.inner_text().strip() == "© 2031 Zimi"
    ), line.inner_text()
    link = line.query_selector("a")
    assert link.inner_text() == "Zimi" and link.get_attribute("href") == url
    # The shelf's very last line: under Credits, nothing of the page below it.
    below = page.evaluate(
        "() => { const b = document.querySelector('.ar-shelf > .gs-home').getBoundingClientRect().bottom;"
        " return Array.from(document.querySelectorAll('body *')).filter(e => e.offsetWidth && e.getBoundingClientRect().top >= b - 0.5"
        " && !e.closest('.gs-home') && (e.innerText || '').trim()).map(e => e.innerText.trim().slice(0, 30)); }"
    )
    assert below == [], below
    assert page.evaluate(
        "document.querySelector('.ar-shelf').lastElementChild.classList.contains('gs-home')"
    )
    # The shipped default (zimihome.js ZIMI_HOME_MARK = 'none'): no mark in the line, the words alone.
    assert line.query_selector("img") is None
    page.goto("%s/chess.html" % served)
    page.click(".gs-menu-btn")
    menu_line = page.wait_for_selector(".gs-card .gs-home")
    assert (
        menu_line.is_visible()
        and menu_line.query_selector("a").get_attribute("href") == url
    )
    assert "2031" in menu_line.inner_text()
    assert menu_line.query_selector("img") is None
    ctx.close()


def test_a_page_read_from_its_folder_has_no_year(browser, served):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto("%s/index.html" % served)  # no zimibuild.js in the source folder
    line = page.wait_for_selector(".ar-shelf > .gs-home")
    assert line.inner_text().strip() == "© Zimi"
    ctx.close()


def test_the_build_writes_its_year_beside_the_date():
    import datetime

    from zimi import ownzims
    from libzim.reader import Archive

    for own in ownzims.OWN:
        archive = Archive(ownzims.zim_path(own))
        year = archive.get_metadata("Date").decode()[:4]
        body = bytes(
            archive.get_entry_by_path(ownzims.BUILD_FILE).get_item().content
        ).decode()
        assert body == "window.ZIMI_BUILT_YEAR = %s;\n" % year, (own.name, body)
    assert int(year) <= datetime.date.today().year


def test_inside_zimis_reader_nothing_is_drawn(browser, served):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    # Zimi's reader, as shell.js recognises it: a same-origin parent whose #reader-frame holds the page.
    page.route(
        "%s/host.html" % served,
        lambda r: r.fulfill(
            body='<iframe id="reader-frame" src="index.html" style="width:390px;height:800px"></iframe>',
            content_type="text/html",
        ),
    )
    page.goto("%s/host.html" % served)
    frame = page.frame_locator("#reader-frame")
    frame.locator(".ar-game").first.wait_for()
    assert frame.locator(".gs-home").count() == 0
    inner = next(f for f in page.frames if f.url.endswith("/index.html"))
    assert inner.evaluate("!!(window.ZimiShell && ZimiShell.hosted)")
    assert inner.evaluate("typeof window.ZIMI_HOME") == "undefined"  # not even fetched
    ctx.close()


def test_the_almanac_carries_the_same_address():
    from zimi import almanacstage

    with tempfile.TemporaryDirectory() as tmp:
        almanacstage.stage(tmp)
        with (
            open(os.path.join(tmp, "zimihome.js"), encoding="utf-8") as f,
            open(os.path.join(GAMES, "zimihome.js"), encoding="utf-8") as g,
        ):
            assert f.read() == g.read()
        assert os.path.exists(os.path.join(tmp, "mark.svg"))
        with open(os.path.join(tmp, "index.html"), encoding="utf-8") as f:
            page = f.read()
        assert (
            '<script src="zimihome.js"></script>' in page
            and '<script src="zimibuild.js"></script>' in page
        )
        # The line is drawn by local.js: an href written in index.html's own script is a dead link to zimcheck.
        assert "href=" not in page.split("<script>", 1)[1]
        with open(os.path.join(tmp, "local.js"), encoding="utf-8") as f:
            assert "root._almHomeLine = function" in f.read()
        # The Almanac page ends on the line: the footer's own sentence first, then the credit.
        with open(os.path.join(tmp, "almanac.js"), encoding="utf-8") as f:
            src = f.read()
        foot = src[src.index("html += '<div class=\"alm-footer\">'") :]
        foot = foot[: foot.index("'</div>';")]
        assert foot.index("t('alm_footer')") < foot.index("_almHomeLine()"), foot


def test_the_mark_and_the_name_are_one_link_and_the_switch_moves_the_mark(
    browser, served
):
    url = home_url()
    for at, want in (
        ("before", ["IMG", "Zimi"]),
        ("after", ["Zimi", "IMG"]),
        ("none", ["Zimi"]),
    ):
        ctx = browser.new_context(viewport=VIEW)
        page = ctx.new_page()
        body = "window.ZIMI_HOME = '%s';\nwindow.ZIMI_HOME_MARK = '%s';\n" % (url, at)

        def serve(
            body,
        ):  # Playwright hands a two-argument handler the request too: one argument only
            return lambda r: r.fulfill(body=body, content_type="text/javascript")

        page.route("**/zimihome.js", serve(body))
        page.goto("%s/index.html" % served)
        page.wait_for_selector(".ar-shelf > .gs-home a")
        got = page.evaluate(
            "Array.from(document.querySelector('.ar-shelf > .gs-home a').childNodes).map(n => n.nodeType === 3 ? n.textContent : n.tagName)"
        )
        assert got == want, (at, got)
        assert page.locator(".ar-shelf > .gs-home").inner_text().strip() == "© Zimi"
        if at != "none":
            assert abs(page.evaluate(MARK_OFFSET, ".ar-shelf > .gs-home")) <= 0.5, at
        ctx.close()


# The credit line's own centre against the page's: the text of "(c) <year> Zimi" (not the link's padding), px.
LINE_CENTRE = """sel => { const line = document.querySelector(sel), w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let l = Infinity, r = -Infinity, n; while ((n = w.nextNode())) { if (!n.textContent.trim()) continue; const g = document.createRange(); g.selectNodeContents(n);
    const b = g.getBoundingClientRect(); l = Math.min(l, b.left); r = Math.max(r, b.right); }
  return (l + r) / 2 - document.documentElement.clientWidth / 2; }"""
CENTRE_WIDTHS = (390, 820, 1440)
CENTRE_TOLERANCE_PX = 1
CREDIT_MARGIN_TOP = "20px"


@pytest.mark.parametrize("width", CENTRE_WIDTHS)
@pytest.mark.parametrize("rtl", [False, True])
def test_the_games_credit_line_is_centred(browser, served, width, rtl):
    ctx = browser.new_context(viewport={"width": width, "height": 844})
    page = ctx.new_page()
    page.goto("%s/index.html%s" % (served, "#lang=ar&dir=rtl" if rtl else ""))
    page.wait_for_selector(".ar-shelf > .gs-home")
    page.wait_for_timeout(500)
    off = page.evaluate(LINE_CENTRE, ".ar-shelf > .gs-home")
    assert abs(off) <= CENTRE_TOLERANCE_PX, (width, rtl, off)
    assert page.evaluate("getComputedStyle(document.querySelector('.ar-shelf > .gs-home')).marginTop") == CREDIT_MARGIN_TOP
    ctx.close()


@pytest.fixture(scope="module")
def almanac_served():
    import functools
    import http.server
    import threading

    from zimi import almanacstage

    tmp = tempfile.mkdtemp(prefix="zimi-alm-home-")
    almanacstage.stage(tmp)
    with open(os.path.join(tmp, "zimibuild.js"), "w", encoding="utf-8") as f:
        f.write("window.ZIMI_BUILT_YEAR = 2031;\n")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


@pytest.mark.parametrize("width", CENTRE_WIDTHS)
def test_the_almanacs_credit_line_is_centred_and_last(browser, almanac_served, width):
    ctx = browser.new_context(viewport={"width": width, "height": 844}, service_workers="block")
    page = ctx.new_page()
    page.goto(almanac_served + "/index.html")
    page.wait_for_selector(".alm-home", state="attached", timeout=90_000)
    page.wait_for_timeout(500)
    off = page.evaluate(LINE_CENTRE, ".alm-home")
    assert abs(off) <= CENTRE_TOLERANCE_PX, (width, off)
    assert page.evaluate("document.querySelector('.alm-footer').lastElementChild.classList.contains('alm-home')")
    assert page.evaluate("getComputedStyle(document.querySelector('.alm-home')).marginTop") == CREDIT_MARGIN_TOP
    ctx.close()


def test_the_standalone_3d_views_gear_is_not_drawn(browser, almanac_served):
    """Everything the gear holds (Zimi's satellite-data setting, the Almanac HD download, who may change them) needs Zimi's
    server: from the ZIM file the button is hidden and its panel cannot open."""
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
    page = ctx.new_page()
    page.goto(almanac_served + "/index.html")
    page.wait_for_function("() => typeof openAlmanacEarth === 'function'", timeout=120_000)
    page.evaluate("openAlmanacEarth({ target: 'earth' })")
    page.wait_for_selector("#ae-gear", state="attached", timeout=120_000)
    assert page.evaluate("document.getElementById('ae-gear').hidden")
    assert page.evaluate("getComputedStyle(document.getElementById('ae-gear')).display") == "none"
    assert not page.evaluate("/whoever runs this Zimi|Almanac HD/i.test(document.getElementById('almanac-view').innerText)")
    ctx.close()
