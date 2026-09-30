"""Bookshelf's covers in a real browser: one box for every book.

tripplehelix, #101: "Bookshelf, when book has no image displays too big.
There's no height set for default book covers." At 1796px a book without a
picture (the cover Zimi sets in type) grew past its column and over its
neighbours, and at 390px its title was set too small to read.

Every cover on a shelf is one box: a 2:3 book at the shelf's width, the
picture fitted inside it, the typographic cover filling the same box with
its title large enough to read. Checked at a desktop width and on a phone,
light and dark, left to right and right to left, with a shelf that mixes
pictures (upright, wide and narrow) and books without one.

Run: pytest tests/test_books_covers_live.py -v
"""

import io
import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import books  # noqa: E402

G2Z = "gutenberg2zim-3.0.1"
SHOTS = os.environ.get("ZIMI_SHOTS", "")

# (id, title, author, picture): a picture is (width, height) or None. Long
# titles and short ones, as the Gutenberg catalog has them; the ones without
# a picture are the covers #101 is about.
BOOKS = [
    (101, "A tour through North America", "Patrick Shirreff", (300, 450)),
    (102, "Tommy's Thanksgiving Visit", "Mary Taylor Cornish", None),
    (103, "Ossianic Controversy", "John M'Pherson", (300, 460)),
    (104, "Le Sultane française au Maroc", "Stéphane Pichon", (300, 440)),
    (105, "Eire, and other poems", "Robin Flower", (320, 480)),
    (106, "Las mejores tradiciones peruanas", "Ricardo Palma", None),
    (
        107,
        "Annals of the strikes in the anthracite region",
        "J. A. (Joseph) Ross",
        None,
    ),
    (108, "Wide", "A. Writer", (600, 300)),
    (109, "Narrow", "A. Writer", (150, 600)),
    (110, "Aeneidos", "Virgil", None),
    (
        111,
        "The History of the Decline and Fall of the Roman Empire, Volume 1",
        "Edward Gibbon",
        None,
    ),
    (112, "Mr. Ray's travels", "John Ray", (300, 450)),
    (113, "Tales", "Carl Ewald", None),
    (114, "Georgicon", "Virgil", (300, 450)),
]


def _jpeg(size, hue):
    from PIL import Image, ImageDraw

    img = Image.new("RGB", size, (hue, 120, 255 - hue))
    ImageDraw.Draw(img).rectangle(
        [8, 8, size[0] - 9, size[1] - 9], outline=(255, 255, 255), width=4
    )
    out = io.BytesIO()
    img.save(out, "JPEG", quality=70)
    return out.getvalue()


def _page(title, author, created):
    return (
        '<html lang="en"><head><meta content="text/html; charset=utf-8" http-equiv="Content-Type"/>\n'
        '<meta content="%s" name="dc.title"/>\n<meta content="%s, 1800-1870" name="dc.creator"/>\n'
        '<meta content="%s" name="dcterms.created"/>\n'
        '<link href="http://www.gutenberg.org/ebooks/1" rel="dcterms.isFormatOf"/>\n'
        "<title>%s</title></head><body><h2>I</h2><p>Words.</p></body></html>"
        % (title, author, created, title)
    ).encode()


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    try:
        import PIL  # noqa: F401
    except ImportError:
        pytest.skip("Pillow draws the covers")
    from http.server import ThreadingHTTPServer

    from conftest_zim import _MediaItem
    from libzim.writer import Creator

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("covers")
    zdir = tmp / "zims"
    zdir.mkdir()
    rows = [[t, a, "110", i, "PR"] for i, t, a, _pic in BOOKS]
    files = {
        "full_by_popularity.js": (
            "application/javascript",
            ("var json_data = %s;" % json.dumps(rows)).encode(),
        ),
        "languages.js": (
            "application/javascript",
            b'var languages_json_data = [["English", "en", %d]];' % len(BOOKS),
        ),
    }
    for n, (i, t, a, pic) in enumerate(BOOKS):
        files[books.book_path(t, i)] = (
            "text/html",
            _page(t, a, "20%02d-01-01" % (n + 1)),
        )
        if pic:
            files[books.cover_image(i)] = ("image/jpeg", _jpeg(pic, (n * 37) % 255))
    path = str(zdir / "gutenberg_en_all_2026-01.zim")
    with Creator(path).config_indexing(False, "eng") as cr:
        cr.set_mainpath(books.book_path(BOOKS[0][1], BOOKS[0][0]))
        for fpath, (mime, blob) in files.items():
            cr.add_item(_MediaItem(fpath, mime, blob))
        for key, value in {
            "Scraper": G2Z,
            "Name": "gutenberg_en_all",
            "Title": "Project Gutenberg Library",
            "Language": "eng",
            "Description": "books",
            "Date": "2026-01-04",
        }.items():
            cr.add_metadata(key, value)
    mp = pytest.MonkeyPatch()
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    books._reset_for_tests()
    srv.load_cache(force=True)
    # The records name which books have a picture: read them now, so the
    # shelf shows both kinds of cover from its first paint.
    books.build_all_details()
    books._builder.wait()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


# Every shelf on the page: each cover's box, its picture's, its title's size,
# and any two books that overlap.
MEASURE = r"""() => {
  const r = el => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  const hit = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return Array.from(document.querySelectorAll('.strip, .grid')).map(shelf => {
    const bks = Array.from(shelf.querySelectorAll(':scope > .bk'));
    const rows = bks.map(bk => {
      const c = bk.querySelector('.cover'), img = c && c.querySelector('img'), tt = c && c.querySelector('.tt');
      return { bk: r(bk), cover: c ? r(c) : null, img: img ? r(img) : null, typo: !!tt,
        tt: tt ? parseFloat(getComputedStyle(tt).fontSize) : 0, ttBox: tt ? r(tt) : null };
    });
    const overlaps = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      if (hit(rows[i].bk, rows[j].bk) > 1 || hit(rows[i].cover, rows[j].cover) > 1) overlaps.push([i, j]);
    }
    return { cls: shelf.className, rows, overlaps };
  });
}"""


def _check(shelves, phone):
    assert shelves, "the front shows its shelves"
    kinds = set()
    for s in shelves:
        rows = s["rows"]
        assert rows, s["cls"]
        w0, h0 = rows[0]["cover"]["w"], rows[0]["cover"]["h"]
        assert w0 > 40, "a cover has a width of its own (%s)" % w0
        for n, row in enumerate(rows):
            c = row["cover"]
            kinds.add("typo" if row["typo"] else "picture")
            assert (
                abs(c["w"] - w0) < 0.6 and abs(c["h"] - h0) < 0.6
            ), "book %d on %s is %.1fx%.1f, the shelf's box is %.1fx%.1f" % (
                n,
                s["cls"],
                c["w"],
                c["h"],
                w0,
                h0,
            )
            assert abs(c["h"] / c["w"] - 1.5) < 0.02, "a book is 2:3"
            assert c["w"] <= row["bk"]["w"] + 0.6, "the cover stays in its column"
            if row["img"]:
                i = row["img"]
                assert (
                    abs(i["x"] - c["x"]) < 0.6
                    and abs(i["y"] - c["y"]) < 0.6
                    and abs(i["w"] - c["w"]) < 0.6
                    and abs(i["h"] - c["h"]) < 0.6
                ), "the picture fills the box, no more"
            if row["typo"]:
                assert row["tt"] >= (12 if phone else 14), (
                    "a typeset title is readable: %.1fpx" % row["tt"]
                )
                t = row["ttBox"]
                assert (
                    t["x"] >= c["x"] - 0.6
                    and t["x"] + t["w"] <= c["x"] + c["w"] + 0.6
                    and t["y"] >= c["y"] - 0.6
                    and t["y"] + t["h"] <= c["y"] + c["h"] + 0.6
                ), "the title stays on its cover"
        assert not s["overlaps"], "books overlap on %s: %s" % (s["cls"], s["overlaps"])
    assert kinds == {"typo", "picture"}, "the shelf mixes both kinds of cover"


def _open(pg, base):
    pg.goto(base + "/#books")
    pg.wait_for_function(
        "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument"
        " && f.contentDocument.querySelectorAll('.strip .bk').length >= 10; }",
        timeout=30000,
    )
    frame = pg.frame_locator("#reader-frame")
    # Every picture has arrived (or failed over to its typeset cover).
    pg.wait_for_function(
        "() => Array.from(document.getElementById('reader-frame').contentDocument.images)"
        ".every(i => i.complete)",
        timeout=15000,
    )
    pg.wait_for_timeout(300)
    return frame


def _frame(pg):
    return next(
        f for f in pg.frames if f.url.split("?")[0].endswith("/static/books.html")
    )


@pytest.mark.parametrize(
    "size,phone",
    [({"width": 1796, "height": 980}, False), ({"width": 390, "height": 844}, True)],
    ids=["desktop", "phone"],
)
@pytest.mark.parametrize("scheme", ["dark", "light"])
@pytest.mark.parametrize("lang", ["en", "he"])
def test_every_cover_on_a_shelf_is_one_box(served, size, phone, scheme, lang):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport=size,
            color_scheme=scheme,
            locale="he-IL" if lang == "he" else "en-US",
            is_mobile=phone,
            has_touch=phone,
        )
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            _open(pg, served)
            fr = _frame(pg)
            if lang == "he":
                assert fr.evaluate("document.documentElement.dir") == "rtl"
            if SHOTS:
                pg.screenshot(
                    path=os.path.join(
                        SHOTS,
                        "books-%s-%s-%s.png"
                        % ("phone" if phone else "desktop", scheme, lang),
                    )
                )
            _check(fr.evaluate(MEASURE), phone)
            # All books, as a grid: the same box, a page of them.
            fr.evaluate("go({v:'list',sort:'popular'})")
            fr.wait_for_function(
                "() => document.querySelectorAll('#books .grid .bk').length >= 10"
            )
            fr.wait_for_function(
                "() => Array.from(document.images).every(i => i.complete)"
            )
            _check(fr.evaluate(MEASURE), phone)
            assert not errors, errors
        finally:
            br.close()
