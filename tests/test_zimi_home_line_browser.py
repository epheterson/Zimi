"""The one line naming Zimi, drawn where the Games and the Almanac are read outside it (Kiwix, a browser tab) and never inside
Zimi's reader: the shelf under its description, the foot of a game's Menu, the Almanac's foot. The address is written once,
in games/zimihome.js, and the Almanac's ZIM carries a copy of that file.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_zimi_home_line_browser.py -v
"""

import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import GAMES, VIEW, browser, served  # noqa: E402,F401


def home_url():
    with open(os.path.join(GAMES, "zimihome.js"), encoding="utf-8") as f:
        return re.search(r"ZIMI_HOME = '([^']+)'", f.read()).group(1)


def test_outside_zimi_the_shelf_and_the_menu_name_zimi(browser, served):
    url = home_url()
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto("%s/index.html" % served)
    line = page.wait_for_selector(".ar-shelf header .gs-home")
    assert line.get_attribute("href") == url
    # The address is readable as text, for a reader with no network.
    assert url.replace("https://", "") in line.text_content()
    assert line.is_visible()
    page.goto("%s/chess.html" % served)
    page.click(".gs-menu-btn")
    menu_line = page.wait_for_selector(".gs-card .gs-home")
    assert menu_line.get_attribute("href") == url and menu_line.is_visible()
    ctx.close()


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
            and "function _almHomeLine" in page
        )
