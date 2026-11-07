"""ZimCity inside a real Zimi with an English Wikipedia: a tile's inspect sheet links to its article, and something
happening in the city (a tornado) brings a news card with the article's lead; with no Zimi around neither is drawn.

The games' folder is built into a games ZIM in a scratch directory (never the committed one) beside a small Wikipedia
that has some of ZimCity's articles and not others.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_zimcity_library.py -v      (SHOTS=<dir> keeps a picture of the card)
"""

import os
import shutil
import socket
import subprocess
import sys

import pytest

pytest.importorskip("playwright")
pytest.importorskip("libzim")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)
from games_wait import wait_for_server  # noqa: E402

GAMES = os.path.join(ROOT, "zimi", "builtin", "games")
ARTICLES = {
    "Tornado": (
        "A tornado is a violently rotating column of air touching the ground and a cloud.",
        ["Coal-fired power station"],
        (90, 110, 140),
    ),
    "Coal-fired power station": (
        "A coal-fired power station converts the heat of burning coal into electricity.",
        ["Tornado"],
        None,
    ),
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    import games_library_fixture as fx

    base = tmp_path_factory.mktemp("city")
    zdir, data = base / "lib", base / "data"
    for d in (zdir, data):
        d.mkdir()
    fx._wiki(
        str(zdir / "wikipedia_en_city_2026-01.zim"),
        "wikipedia_en_city",
        "Wikipedia",
        "en",
        "eng",
        ARTICLES,
    )
    fx.games_zim(zdir)
    port = free_port()
    env = dict(
        os.environ,
        ZIMI_TORRENT="0",
        ZIMI_OFFLINE="1",
        ZIMI_BUILTIN_ZIMS="0",
        ZIMI_APPS="1",
        ZIMI_MANAGE_OPEN="1",
        ZIM_DIR=str(zdir),
        ZIMI_DATA_DIR=str(data),
    )
    proc = subprocess.Popen(
        [sys.executable, "-m", "zimi", "serve", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_for_server(port):
            pytest.skip("the library did not start")
        yield "http://127.0.0.1:%d" % port
    finally:
        proc.terminate()


@pytest.fixture(scope="module")
def page(zimi):
    """The game as Zimi shows it: inside the reader's frame (the page itself is Zimi's shell). Yields (page, frame)."""
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 390, "height": 844})
        pg.goto(zimi + "/w/zimi_games/zimcity.html")
        pg.wait_for_function(
            "() => { const f = document.getElementById('reader-frame'); return f && f.contentWindow && f.contentWindow.__zimcity && f.contentWindow.__zimcity.city; }",
            timeout=30000,
        )
        fr = next(
            f for f in pg.frames if f is not pg.main_frame and "zimcity.html" in f.url
        )
        fr.wait_for_function(
            "() => window.__zimcity.library.articleFor('city.msg.tornado')",
            timeout=30000,
        )
        yield pg, fr
        b.close()


def test_a_coal_plant_inspected_links_to_its_article(page):
    pg, page = page
    page.evaluate(
        """() => { const z = window.__zimcity, map = z.city.map;
      for (let y = 40; y < 46; y++) for (let x = 40; x < 46; x++) map.setTile(x, y, 0, 0);
      z.city.tools.coal.doTool(42, 42, z.city.sim.blockMaps); z.city.tools.coal.modifyIfEnoughFunding(z.city.sim.budget); }"""
    )
    page.evaluate("() => { document.getElementById('cy-pause').click(); }")
    # open the inspect sheet the way a long press does
    page.evaluate("() => window.__zimcity.view.centreOn(42, 42)")
    box = page.evaluate(
        "() => { const r = document.getElementById('cy-map').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"
    )
    at = pg.query_selector("#reader-frame").bounding_box()
    pg.mouse.move(at["x"] + box[0], at["y"] + box[1])
    pg.mouse.down()
    pg.wait_for_timeout(700)
    pg.mouse.up()
    a = page.wait_for_selector(".cy-read a")
    assert a.text_content() == "Read about Coal-fired power station"
    assert a.get_attribute("href").endswith("/Coal-fired_power_station")
    pg.keyboard.press("Escape")


NEWS_CLEAR_OF_THE_MIDDLE = "() => { const n = document.getElementById('cy-news').getBoundingClientRect(), m = document.getElementById('cy-map').getBoundingClientRect(); return n.bottom < m.top + m.height / 2; }"
IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"


def test_on_an_iphone_inside_zimi_the_tray_clears_the_home_indicator(zimi, page):
    """WebKit gives the reader's frame no insets and can give Zimi's page none either (a page under a browser bar that
    floats over it). On an iPhone whose window reaches the bottom of the screen the tray still stands clear of the
    34 px indicator, upright and (21 px) on its side, and the news card keeps off the middle of the map.
    """
    ctx = page[0].context.browser.new_context(
        viewport={"width": 390, "height": 844},
        screen={"width": 390, "height": 844},
        user_agent=IPHONE_UA,
        device_scale_factor=3,
        is_mobile=True,
        has_touch=True,
    )
    pg = ctx.new_page()
    pg.goto(zimi + "/w/zimi_games/zimcity.html")
    pg.wait_for_function(
        "() => { const f = document.getElementById('reader-frame'); return f && f.contentWindow && f.contentWindow.__zimcity && f.contentWindow.__zimcity.city; }",
        timeout=30000,
    )
    fr = next(
        f for f in pg.frames if f is not pg.main_frame and "zimcity.html" in f.url
    )
    lowest = "() => { const t = [...document.querySelectorAll('.cy-tool')].map((b) => b.getBoundingClientRect().bottom); return Math.max(...t) + window.frameElement.getBoundingClientRect().top; }"
    assert fr.evaluate(lowest) <= 844 - 34
    if os.environ.get("SHOTS"):
        pg.screenshot(
            path=os.path.join(os.environ["SHOTS"], "zimcity-iphone-in-zimi.png")
        )
    pg.set_viewport_size({"width": 844, "height": 390})
    pg.wait_for_timeout(300)
    assert fr.evaluate(lowest) <= 390 - 21
    fr.wait_for_function(
        "() => window.__zimcity.library.articleFor('city.msg.tornado')", timeout=30000
    )
    fr.evaluate(
        "() => { window.__zimcity.step(16 * 17); window.__zimcity.news('city.msg.tornado'); }"
    )
    fr.wait_for_selector("#cy-news:not([hidden])")
    assert fr.evaluate(NEWS_CLEAR_OF_THE_MIDDLE)
    if os.environ.get("SHOTS"):
        pg.screenshot(
            path=os.path.join(os.environ["SHOTS"], "zimcity-iphone-in-zimi-side.png")
        )
    ctx.close()


def test_the_about_sheets_links_are_relative_and_every_one_opens_a_real_page(
    zimi, page
):
    """ZimCity's About names where the simulation comes from: each link is relative to the page (so it resolves inside a
    ZIM in kiwix-serve too), opens a page with text on it, and the notes' own references to the licences are links.
    """
    import re

    pg, fr = page
    fr.evaluate("() => document.querySelector('.gs-menu-btn').click()")
    fr.evaluate(
        "() => [...document.querySelectorAll('.gs-tile')].find((b) => /About/.test(b.textContent)).click()"
    )
    fr.wait_for_selector(".cy-credit a")
    hrefs = fr.evaluate(
        "() => [...document.querySelectorAll('.gs-about a')].map((a) => a.getAttribute('href'))"
    )
    assert len(hrefs) >= 4, hrefs
    base = zimi + "/w/zimi_games/"
    # relative, or (the shell's "Read about") made from the shell script's own address: never a site-absolute /path
    assert all(h.startswith(base) or not h.startswith(("/", "http")) for h in hrefs), hrefs
    # fetched from inside the page, as a click would (the page's own address decides what a relative link means)
    page_text = "(url) => fetch(url).then((r) => r.ok ? r.text() : '')"
    for h in hrefs:
        assert len(fr.evaluate(page_text, h.split("#")[0])) > 500, h
    notes = fr.evaluate(page_text, "zimcity/ENGINE.md")
    linked = set(re.findall(r'href="([^"]+)"', notes))
    assert {"LICENSE.txt", "COPYING.txt", "MicropolisPublicNameLicense.md"} <= linked, linked
    for h in ("LICENSE.txt", "COPYING.txt", "MicropolisPublicNameLicense.md"):
        assert len(fr.evaluate(page_text, "zimcity/" + h)) > 500, h
    fr.evaluate("() => document.querySelector('.gs-sheet:not([hidden]) .gs-x').click()")   # the Menu, closed again


def test_a_tornado_brings_a_news_card_with_the_lead(page):
    """Not in a city's first months (its census is not measured yet); after that the card, clear of the map's middle."""
    pg, page = page
    page.evaluate(
        "() => { const z = window.__zimcity; z.city.bornAt = z.city.sim._cityTime; z.news('city.msg.tornado'); }"
    )
    page.wait_for_timeout(500)
    assert page.evaluate("() => document.getElementById('cy-news').hidden")
    page.evaluate("() => window.__zimcity.step(16 * 17)")
    page.evaluate("() => window.__zimcity.news('city.msg.tornado')")
    card = page.wait_for_selector("#cy-news:not([hidden])")
    assert page.evaluate(NEWS_CLEAR_OF_THE_MIDDLE)
    text = card.text_content()
    assert "Tornado" in text and "violently rotating column of air" in text, text
    assert page.query_selector("#cy-news img")  # the article's picture
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "zimcity-news.png"))
    page.click(".cy-news-close")
    assert page.evaluate("() => document.getElementById('cy-news').hidden")


def test_a_story_the_library_lacks_shows_nothing(page):
    pg, page = page
    assert (
        page.evaluate(
            "() => window.__zimcity.library.articleFor('city.msg.earthquake')"
        )
        is None
    )
    page.evaluate("() => window.__zimcity.news('city.msg.earthquake')")
    page.wait_for_timeout(500)
    assert page.evaluate("() => document.getElementById('cy-news').hidden")
