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
    "Tornado": ("A tornado is a violently rotating column of air touching the ground and a cloud.", ["Coal-fired power station"], (90, 110, 140)),
    "Coal-fired power station": ("A coal-fired power station converts the heat of burning coal into electricity.", ["Tornado"], None),
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    import games_library_fixture as fx
    from zimi import ownzims

    base = tmp_path_factory.mktemp("city")
    zdir, built, data = base / "lib", base / "built", base / "data"
    for d in (zdir, built, data):
        d.mkdir()
    fx._wiki(str(zdir / "wikipedia_en_city_2026-01.zim"), "wikipedia_en_city", "Wikipedia", "en", "eng", ARTICLES)
    shutil.copytree(GAMES, base / "src" / "games")
    was = (ownzims.OUT_DIR, ownzims.SOURCE_ROOT)
    ownzims.OUT_DIR, ownzims.SOURCE_ROOT = str(built), str(base / "src")
    try:
        made = ownzims.build(ownzims.OWN[0])
    finally:
        ownzims.OUT_DIR, ownzims.SOURCE_ROOT = was
    shutil.copy(made, zdir / os.path.basename(made))
    port = free_port()
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1", ZIMI_BUILTIN_ZIMS="0", ZIMI_APPS="1", ZIMI_MANAGE_OPEN="1", ZIM_DIR=str(zdir), ZIMI_DATA_DIR=str(data))
    proc = subprocess.Popen([sys.executable, "-m", "zimi", "serve", "--port", str(port)], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        pg.wait_for_function("() => { const f = document.getElementById('reader-frame'); return f && f.contentWindow && f.contentWindow.__zimcity && f.contentWindow.__zimcity.city; }", timeout=30000)
        fr = next(f for f in pg.frames if f is not pg.main_frame and "zimcity.html" in f.url)
        fr.wait_for_function("() => window.__zimcity.library.articleFor('city.msg.tornado')", timeout=30000)
        yield pg, fr
        b.close()


def test_a_coal_plant_inspected_links_to_its_article(page):
    pg, page = page
    page.evaluate("""() => { const z = window.__zimcity, map = z.city.map;
      for (let y = 40; y < 46; y++) for (let x = 40; x < 46; x++) map.setTile(x, y, 0, 0);
      z.city.tools.coal.doTool(42, 42, z.city.sim.blockMaps); z.city.tools.coal.modifyIfEnoughFunding(z.city.sim.budget); }""")
    page.evaluate("() => { document.getElementById('cy-pause').click(); }")
    # open the inspect sheet the way a long press does
    page.evaluate("() => window.__zimcity.view.centreOn(42, 42)")
    box = page.evaluate("() => { const r = document.getElementById('cy-map').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
    at = pg.query_selector("#reader-frame").bounding_box()
    pg.mouse.move(at["x"] + box[0], at["y"] + box[1])
    pg.mouse.down()
    pg.wait_for_timeout(700)
    pg.mouse.up()
    a = page.wait_for_selector(".cy-read a")
    assert a.text_content() == "Read about Coal-fired power station"
    assert a.get_attribute("href").endswith("/Coal-fired_power_station")
    pg.keyboard.press("Escape")


def test_a_tornado_brings_a_news_card_with_the_lead(page):
    pg, page = page
    page.evaluate("() => window.__zimcity.news('city.msg.tornado')")
    card = page.wait_for_selector("#cy-news:not([hidden])")
    text = card.text_content()
    assert "Tornado" in text and "violently rotating column of air" in text, text
    assert page.query_selector("#cy-news img")   # the article's picture
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "zimcity-news.png"))
    page.click(".cy-news-close")
    assert page.evaluate("() => document.getElementById('cy-news').hidden")


def test_a_story_the_library_lacks_shows_nothing(page):
    pg, page = page
    assert page.evaluate("() => window.__zimcity.library.articleFor('city.msg.earthquake')") is None
    page.evaluate("() => window.__zimcity.news('city.msg.earthquake')")
    page.wait_for_timeout(500)
    assert page.evaluate("() => document.getElementById('cy-news').hidden")
