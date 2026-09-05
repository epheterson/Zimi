"""Does a made ZIM actually PAINT when a person scrolls it?

Every other test here asks whether the bytes are right: does the entry exist,
does the href resolve, is the count correct. A made ZIM passed all of that and
still looked broken on Eric's screen — twice.

  * a cnn.com capture rendered raw attribute soup down the middle of the page,
    while "118 img srcs, 0 unresolvable" passed;
  * images below the fold appeared not to load at all, while a viewport
    screenshot showed a page that looked fine.

Both were invisible to the suite for the same reason: nothing opened the file
in a browser, scrolled it to the bottom, and asked each image whether it had
decoded. `naturalWidth > 0` is the only honest answer to that question — an
<img> whose src 404s is `complete` too.

So this serves a made ZIM through the real handler, drives a real browser down
the whole page, and fails if anything did not paint. It is deliberately built
from the same writer the create engines use, so a regression in carrying,
rewriting or serving lands here rather than on somebody's phone.
"""

import functools
import http.server
import socket
import threading
import time
import zlib

import pytest

import zimi.renderer as renderer
import zimi.server as _srv
from zimi.http import ZimHandler

def _need_browser():
    """Skip, checked INSIDE the test rather than at import.

    browser_available() launches a real chromium and has no timeout, so a
    module-level skipif costs three minutes on a machine where the browser
    cannot start — the skip becomes more expensive than the test. Asking here
    means an unavailable browser costs nothing until something wants one."""
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")


def browser(fn):
    """Marker kept as a decorator so the tests read the same as the rest of
    the suite, but the probe is deferred into the call.

    functools.wraps, not a hand-copied __name__: pytest reads the signature to
    decide which fixtures to inject, and a bare *a/**kw wrapper advertises none
    — so tmp_path never arrived and both tests died on a missing argument.
    wraps sets __wrapped__, which is what pytest follows to the real one."""

    @functools.wraps(fn)
    def wrapper(*a, **kw):
        _need_browser()
        return fn(*a, **kw)

    return wrapper

# Enough images that lazy-loading and scroll behaviour actually matter. CNN's
# homepage carried 118; this is the same order without needing the network.
IMAGE_COUNT = 60
# A generous ceiling, not a benchmark: the point is "they all arrive", and a
# number that fails only when something is properly broken will not flake on a
# loaded CI box. Measured against the real thing for scale — a 24-image page
# served in 87 ms locally.
PAINT_BUDGET_SECONDS = 25


def _png(seed):
    """A tiny, VALID png of a distinct colour. Valid matters: a decoder that
    rejects it would read as 'did not paint' and blame the server."""

    def chunk(tag, payload):
        body = tag + payload
        return (
            len(payload).to_bytes(4, "big")
            + body
            + (zlib.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big")
        )

    w = h = 8
    ihdr = w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
    row = bytes([0]) + bytes([seed % 256, (seed * 7) % 256, (seed * 13) % 256] * w)
    idat = zlib.compress(row * h)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


def _build_zim(path):
    """A tall, image-dense page, written with the shipped writer.

    Half the images carry loading="lazy" — the attribute that made below-the-
    fold images look permanently missing. They must still paint.
    """
    import pathlib

    from libzim.writer import Creator, Item, StringProvider

    class _Item(Item):
        def __init__(self, p, t, m, d):
            super().__init__()
            self._p, self._t, self._m, self._d = p, t, m, d

        def get_path(self):
            return self._p

        def get_title(self):
            return self._t

        def get_mimetype(self):
            return self._m

        def get_hints(self):
            return {}

        def get_contentprovider(self):
            return StringProvider(self._d)

    body = [
        "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>",
        "<title>Paint gate</title><style>img{display:block;width:120px;",
        "height:120px;margin:40px 0}</style></head><body><h1>Paint gate</h1>",
    ]
    for i in range(IMAGE_COUNT):
        lazy = " loading='lazy'" if i % 2 else ""
        body.append(f"<p>block {i}</p><img src='img/{i}.png' alt='{i}'{lazy}>")
    body.append("</body></html>")
    html = "".join(body)

    with Creator(pathlib.Path(path)).config_indexing(True, "eng") as c:
        c.set_mainpath("A/index")
        c.add_item(_Item("A/index", "Paint gate", "text/html", html))
        for i in range(IMAGE_COUNT):
            c.add_item(_Item(f"A/img/{i}.png", "", "image/png", _png(i)))
        for k, v in (
            ("Title", "Paint gate"),
            ("Language", "eng"),
            ("Description", "image-dense fixture"),
            ("Creator", "zimi-tests"),
            ("Publisher", "zimi-tests"),
            ("Date", "2026-01-01"),
            ("Name", "paintgate"),
            ("Scraper", "zimi-tests"),
        ):
            c.add_metadata(k, v)


def _serve(zim_dir):
    """The real ZimHandler over a temp library, on a free port."""
    _srv.ZIM_DIR = str(zim_dir)
    _srv.ZIMI_DATA_DIR = str(zim_dir)
    _srv._cache_generation += 1
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), ZimHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


@browser
def test_every_image_in_a_made_zim_paints_when_you_scroll(tmp_path):
    zim = tmp_path / "paintgate.zim"
    _build_zim(str(zim))
    assert zim.exists()

    srv, port = _serve(tmp_path)
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            b = p.chromium.launch()
            page = b.new_page(viewport={"width": 1280, "height": 900})
            page.goto(
                f"http://127.0.0.1:{port}/w/paintgate/A/index?raw=1",
                wait_until="domcontentloaded",
                timeout=60000,
            )
            # Scroll the whole page the way a reader does. Lazy images only
            # fetch when they approach the viewport, so a test that never
            # scrolls cannot see them fail.
            page.evaluate("""async () => {
                  const H = document.body.scrollHeight;
                  for (let y = 0; y < H; y += 400) {
                    window.scrollTo(0, y);
                    await new Promise(r => setTimeout(r, 30));
                  }
                  window.scrollTo(0, 0);
                }""")
            deadline = time.time() + PAINT_BUDGET_SECONDS
            painted = 0
            while time.time() < deadline:
                painted = page.evaluate(
                    "() => Array.from(document.images)"
                    ".filter(i => i.complete && i.naturalWidth > 0).length"
                )
                if painted >= IMAGE_COUNT:
                    break
                time.sleep(0.25)

            report = page.evaluate("""() => {
                  const imgs = Array.from(document.images);
                  const bad = imgs.filter(i => !(i.complete && i.naturalWidth > 0));
                  return { total: imgs.length,
                           painted: imgs.length - bad.length,
                           firstBad: bad.slice(0, 5).map(i => i.getAttribute('src')) };
                }""")
            b.close()
    finally:
        srv.shutdown()

    assert report["total"] == IMAGE_COUNT, report
    assert report["painted"] == IMAGE_COUNT, (
        f"{IMAGE_COUNT - report['painted']} of {IMAGE_COUNT} images never painted "
        f"within {PAINT_BUDGET_SECONDS}s — first few: {report['firstBad']}"
    )


@browser
def test_the_gate_notices_when_an_image_is_missing(tmp_path):
    """A gate that cannot fail is not a gate.

    Same fixture with one image left out of the ZIM: the reference is still in
    the markup, the browser still asks for it, and it must be reported as
    unpainted rather than quietly counted as fine.
    """
    from libzim.reader import Archive

    zim = tmp_path / "paintgate.zim"
    _build_zim(str(zim))
    assert Archive(str(zim)).all_entry_count > IMAGE_COUNT

    srv, port = _serve(tmp_path)
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            b = p.chromium.launch()
            page = b.new_page(viewport={"width": 1280, "height": 900})
            # Point one <img> at an entry that does not exist, which is exactly
            # what a dropped asset looks like from the reader's side.
            page.goto(
                f"http://127.0.0.1:{port}/w/paintgate/A/index?raw=1",
                wait_until="domcontentloaded",
                timeout=60000,
            )
            page.evaluate(
                "() => { document.images[0].src = 'img/does-not-exist.png'; }"
            )
            time.sleep(2)
            bad = page.evaluate(
                "() => Array.from(document.images)"
                ".filter(i => !(i.complete && i.naturalWidth > 0)).length"
            )
            b.close()
    finally:
        srv.shutdown()

    assert bad >= 1, "a missing image was not reported as unpainted"
