"""Zimi's own ZIMs in a real kiwix-serve: the Games, the Almanac and its HD flavour each start with no page error.

The other tests open the own ZIMs through Zimi (and its ?raw=1, which serves only the ZIM's files). Kiwix is what the
community will open them with: its own URLs (/content/<book>/), its viewer (the page in an iframe under Kiwix's bar),
its Random. In 1.15.3 the Almanac broke there and nowhere else (a name its shell never declared). This is that
promise checked against the real server.

kiwix-serve is found at $KIWIX_SERVE or on PATH; without it the test skips, unless ZIMI_REQUIRE_KIWIX_SERVE=1 (CI,
which installs kiwix-tools first), where a missing binary fails.

Run: pytest tests/test_own_zims_kiwix_serve.py -v
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

GL_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]
VIEW = {"width": 390, "height": 844}
PLACE = '{"lat":37.77,"lon":-122.42,"name":"San Francisco"}'
READY_MS = 240_000
MONTH = "2026-11"
RANDOM_TRIES = 12
#: Games pages opened in Kiwix: one of each kind the shelf has (cards, board, a Logic puzzle).
GAME_PAGES = ("solitaire.html", "chess.html", "puzzles/net.html")


def _kiwix_serve():
    path = os.environ.get("KIWIX_SERVE") or shutil.which("kiwix-serve")
    if path and os.access(path, os.X_OK):
        return path
    if os.environ.get("ZIMI_REQUIRE_KIWIX_SERVE") == "1":
        pytest.fail("kiwix-serve is required here and was not found")
    pytest.skip("kiwix-serve is not installed (set KIWIX_SERVE)")


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def kiwix(tmp_path_factory):
    """kiwix-serve over the three own ZIMs as a release builds them: {base, books: {kind: book name}}."""
    binary = _kiwix_serve()
    from zimi import ownzims
    from test_almanac_hd_browser import _build_hd

    import build_almanac_maxi

    tmp = tmp_path_factory.mktemp("kiwix_own")
    zims = tmp / "zims"
    zims.mkdir()
    own = {o.name: o for o in ownzims.OWN}
    books = {
        "games": "zimi_games_%s" % MONTH,
        "almanac": "zimi_almanac_%s" % MONTH,
        "maxi": build_almanac_maxi.FILE_FMT[:-4] % MONTH,
    }
    ownzims.write_zim(own["zimi_games"], str(zims / (books["games"] + ".zim")))
    ownzims.write_zim(own["zimi_almanac"], str(zims / (books["almanac"] + ".zim")))
    _build_hd(str(tmp / "stage"), str(tmp / "tiles.zim"))
    build_almanac_maxi.build(str(tmp / "tiles.zim"), str(zims), month=MONTH)
    port = _free_port()
    proc = subprocess.Popen(
        [binary, "--address=127.0.0.1", "--port=%d" % port]
        + sorted(str(p) for p in zims.glob("*.zim")),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    base = "http://127.0.0.1:%d" % port
    deadline = time.time() + 30
    while True:
        try:
            urllib.request.urlopen(base + "/catalog/v2/entries", timeout=2).read()
            break
        except OSError:
            if proc.poll() is not None or time.time() > deadline:
                proc.kill()
                pytest.fail(
                    "kiwix-serve did not start: %s"
                    % proc.stderr.read().decode(errors="replace")[-500:]
                )
            time.sleep(0.2)
    yield {"base": base, "books": books}
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture(scope="module")
def browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


def _page(browser):
    ctx = browser.new_context(
        viewport=VIEW,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_almanac_place', %r); } catch (e) {}" % PLACE
    )
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    return ctx, pg, errors


def _content_frame(pg, book):
    """The viewer's iframe once it holds the book's page."""
    deadline = time.time() + 60
    while time.time() < deadline:
        for f in pg.frames:
            if "/content/%s/" % book in f.url:
                return f
        pg.wait_for_timeout(200)
    raise AssertionError(
        "the viewer never loaded %s: %s" % (book, [f.url for f in pg.frames])
    )


@pytest.mark.parametrize("kind", ["almanac", "maxi"])
def test_the_almanac_starts_in_kiwix_and_its_3d_view_opens(browser, kiwix, kind):
    book = kiwix["books"][kind]
    ctx, pg, errors = _page(browser)
    reqs = []
    pg.on("request", lambda r: reqs.append(r.url))
    try:
        # As a person opens it: Kiwix's viewer, the page in its iframe.
        pg.goto(kiwix["base"] + "/viewer#" + book, wait_until="load")
        fr = _content_frame(pg, book)
        fr.wait_for_function(
            "() => typeof openAlmanacEarth === 'function'", timeout=120_000
        )
        # The page itself is drawn: the Moon's card and the month.
        fr.wait_for_function(
            "() => !!document.querySelector('#almanac-head') && document.body.innerText.trim().length > 200",
            timeout=120_000,
        )
        fr.evaluate("openAlmanacEarth({ target: 'earth' })")
        fr.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=READY_MS,
            polling=200,
        )
        if kind == "maxi":
            # The sharp tiles come from the book itself, through Kiwix's own URLs.
            fr.wait_for_function(
                "() => { _ae.dirty = true; _aeKick(); return !!_ae.gl.hd; }",
                timeout=60_000,
                polling=250,
            )
        else:
            fr.wait_for_timeout(2000)
            assert fr.evaluate("_ae.gl.hd") is None
        # Nothing of the page went outside the book (a stray absolute /static/ is a 404 in Kiwix).
        stray = [
            u
            for u in reqs
            if u.startswith(kiwix["base"])
            and "/content/%s/" % book not in u
            and u != "%s/content/%s" % (kiwix["base"], book)
            and "/raw/%s/meta/" % book not in u
            and "/skin/" not in u
            and "/viewer" not in u
            and "/catalog/" not in u
            and "/search" not in u
            and "/random" not in u
        ]
        assert not stray, stray[:5]
        assert errors == [], errors
    finally:
        ctx.close()


def test_the_games_shelf_and_a_game_of_each_kind_start_in_kiwix(browser, kiwix):
    book = kiwix["books"]["games"]
    with open(
        os.path.join(ROOT, "zimi", "builtin", "games", "games.json"), encoding="utf-8"
    ) as f:
        shelf = json.load(f)
    ctx, pg, errors = _page(browser)
    try:
        pg.goto(kiwix["base"] + "/viewer#" + book, wait_until="load")
        fr = _content_frame(pg, book)
        # Every game on the shelf is a link on the page.
        want = sorted({g["path"] for g in shelf})
        fr.wait_for_function(
            "(want) => { var have = new Set(Array.from(document.querySelectorAll('a[href]'), a => a.getAttribute('href'))); return want.every(p => have.has(p)); }",
            arg=want,
            timeout=60_000,
        )
        for page in GAME_PAGES:
            pg.goto(kiwix["base"] + "/content/%s/%s" % (book, page), wait_until="load")
            pg.wait_for_timeout(1500)
            assert pg.evaluate("document.body.innerText.trim().length") > 0, page
            assert errors == [], (page, errors)
    finally:
        ctx.close()


@pytest.mark.parametrize("kind", ["games", "almanac", "maxi"])
def test_kiwix_random_lands_on_a_front_article(kiwix, kind):
    """Random in Kiwix lands on what zimi.txt's Articles names: a game or the Almanac, never a licence or a tile."""
    book = kiwix["books"][kind]
    seen = set()
    for _ in range(RANDOM_TRIES):
        with urllib.request.urlopen(
            kiwix["base"] + "/random?content=" + book, timeout=10
        ) as r:
            path = r.geturl().split("/content/%s/" % book, 1)[1].split("?")[0]
        seen.add(path)
    assert all(p.endswith(".html") for p in seen), seen
    assert not [
        p for p in seen if p in ("about.html", "puzzles.html") or p.startswith("hd/")
    ], seen
    if kind != "games":
        assert seen == {"index.html"}, seen
