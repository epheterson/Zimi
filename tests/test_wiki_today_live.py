"""Zimipedia's Today in a real browser: the day's article and the picture of
the day keep their pictures' shapes, and the article is not the whole first
screen. Eric, 2026-09-30, on a desktop: "That ginormous hero in pedia isn't
doing it for me that's a ton of space and the picture of the day is a bad
shape it's all cropped off".

Every picture in the fixture has one shape, so whichever the day picks has
it: an ordinary landscape, a tall portrait and a wide panorama. The size
comes from the server (/wiki/today reads it while it works the day out) or,
for an answer kept from before it did, from the picture once it loads.

Run: pytest tests/test_wiki_today_live.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ARTICLES = ("Mount_Rainier", "Lake_Baikal", "Sahara", "Fjord", "Aurora", "Tea")
SHAPES = {"landscape": (1200, 800), "portrait": (600, 1200), "panorama": (2400, 600)}
DESKTOP = {"width": 1280, "height": 800}
PHONE = {"width": 390, "height": 844}


def _picture(w, h):
    from conftest_zim import solid_png

    return solid_png(w, h)


def _library(zdir, shape):
    from wiki_fixture import _zim, page

    w, h = SHAPES[shape]
    items = [("Main_Page", "Main Page", page("Main Page", "<p>Main.</p>"), "text/html")]
    for i, path in enumerate(ARTICLES):
        title = path.replace("_", " ")
        img = "I/%s.jpg" % path
        body = (
            '<section data-mw-section-id="0"><figure><img src="./%s" alt="%s"></figure>'
            "<p><b>%s</b> is a place with %d metres of something to read about, "
            "and a second sentence of it.</p></section>" % (img, title, title, 1000 + i)
        )
        items.append((path, title, page(title, body), "text/html"))
        items.append((img, "", _picture(w, h), "image/png"))
    _zim(
        os.path.join(zdir, "wikipedia_en_all_maxi_2026-08.zim"),
        "wikipedia_en_all",
        "eng",
        "Wikipedia",
        items,
        "Main_Page",
    )


@pytest.fixture(params=sorted(SHAPES))
def served(request, tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi import wiki
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    _library(str(zdir), request.param)
    monkeypatch.delenv("ZIMI_APPS", raising=False)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    for cache in (
        wiki._pick_cache,
        wiki._extra_cache,
        wiki._otd_cache,
        wiki._front_cache,
    ):
        cache.clear()
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], SHAPES[request.param]
    httpd.shutdown()


# What the page shows: the picture's own shape, the shape it is drawn at
# (the element's box, and how its pixels are fitted in it), the article's
# card, and the screen.
MEASURE = """() => {
  var d = document.querySelector('#reader-frame').contentDocument, w = d.defaultView;
  var one = function(img) {
    if (!img || !img.complete || !img.naturalWidth) return null;
    var b = img.getBoundingClientRect();
    return { natural: img.naturalWidth / img.naturalHeight, drawn: b.width / b.height, height: b.height, fit: w.getComputedStyle(img).objectFit };
  };
  var hero = d.querySelector('.hero');
  return { vh: w.innerHeight, hero: one(d.querySelector('.hero img')), card: hero && hero.getBoundingClientRect().height,
    potd: one(d.querySelector('.potd img')), potdTop: d.querySelector('.potd') && d.querySelector('.potd').getBoundingClientRect().top };
}"""
READY = """() => { var f = document.querySelector('#reader-frame'); var d = f && f.contentDocument;
  var ok = function(s) { var i = d && d.querySelector(s); return !!(i && i.complete && i.naturalWidth); };
  return ok('.hero img') && ok('.potd img'); }"""


def _today(pw, base, viewport, strip=False):
    br = pw.chromium.launch()
    ctx = br.new_context(viewport=viewport)
    pg = ctx.new_page()
    if strip:
        # An answer from before the server read sizes: no width or height.
        def unsized(route):
            r = route.fetch()
            body = r.text()
            for k in ("width", "height"):
                body = body.replace('"%s":' % k, '"no_%s":' % k)
            route.fulfill(response=r, body=body)

        pg.route("**/wiki/today*", unsized)
        pg.route("**/wiki/home*", unsized)
    pg.goto(base + "/#wiki")
    pg.wait_for_function(READY, timeout=20000)
    pg.wait_for_timeout(200)
    return br, pg, pg.evaluate(MEASURE)


def _whole(m, label):
    """Drawn at its own shape (within 2%), and not cropped to fill a box."""
    assert m, label + ": no picture"
    assert m["fit"] != "cover", label + ": cropped to fill its box"
    assert (
        abs(m["drawn"] / m["natural"] - 1) < 0.02
    ), "%s: drawn at %.3f, the picture is %.3f" % (label, m["drawn"], m["natural"])


def test_pictures_keep_their_shape(served):
    from playwright.sync_api import sync_playwright

    base, (w, h) = served
    with sync_playwright() as pw:
        for viewport in (DESKTOP, PHONE):
            br, pg, m = _today(pw, base, viewport)
            label = "%dpx %dx%d" % (viewport["width"], w, h)
            _whole(m["potd"], "picture of the day " + label)
            _whole(m["hero"], "article of the day " + label)
            assert abs(m["potd"]["natural"] - w / h) < 0.01
            br.close()


def test_shape_from_the_picture_when_the_server_sent_none(served):
    from playwright.sync_api import sync_playwright

    base, _ = served
    with sync_playwright() as pw:
        br, pg, m = _today(pw, base, DESKTOP, strip=True)
        _whole(m["potd"], "picture of the day, measured")
        _whole(m["hero"], "article of the day, measured")
        br.close()


def test_the_article_leaves_room_for_the_day(served):
    """On a desktop the day's article is a third of the screen, and the
    picture of the day starts on the first screen."""
    from playwright.sync_api import sync_playwright

    base, _ = served
    with sync_playwright() as pw:
        br, pg, m = _today(pw, base, DESKTOP)
        assert m["hero"]["height"] <= m["vh"] / 3 + 1, m
        assert m["card"] <= m["vh"] * 0.45, m
        assert m["potdTop"] < m["vh"], m
        br.close()


def test_the_picture_shows_large(served):
    from playwright.sync_api import sync_playwright

    base, _ = served
    with sync_playwright() as pw:
        br, pg, _m = _today(pw, base, DESKTOP)
        fr = pg.frame_locator("#reader-frame")
        small = fr.locator(".potd img").bounding_box()
        fr.locator(".potd .stage").click()
        big = fr.locator("#big")
        assert big.evaluate("d => d.open")
        # Larger than in its column, whole: the picture fitted into the
        # screen, never cut to fill it.
        big_img = fr.locator("#big img")
        fit, nw, nh = big_img.evaluate("i => [getComputedStyle(i).objectFit, i.naturalWidth, i.naturalHeight]")
        box = big_img.bounding_box()
        assert fit == "contain"
        scale = min(box["width"] / nw, box["height"] / nh)
        assert scale * nw * scale * nh > small["width"] * small["height"], (small, box)
        pg.keyboard.press("Escape")
        assert not big.evaluate("d => d.open")
        # The caption still opens the article.
        assert fr.locator(".potd a.cap[data-path]").count() == 1
        br.close()


def test_server_reads_the_size():
    from zimi.previews import image_size

    for w, h in SHAPES.values():
        assert image_size(_picture(w, h)) == (w, h)
    assert json.dumps(image_size(b"not a picture")) == "null"
