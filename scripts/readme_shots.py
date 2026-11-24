#!/usr/bin/env python3
"""Retake the README screenshots against a running Zimi.

The README shows six pictures: the homepage, a search, the language menu
open on an article, the catalog drilled into a category, the sharing
settings, and the Create page at the moment a capture finishes with its two
pictures (live beside packaged). They go stale every release; this retakes
them all the same way, so a refresh is one command and not an afternoon.

    python3 scripts/readme_shots.py --base http://127.0.0.1:8931 --out docs/screenshots/

Point --base at a server whose library has a few real ZIMs (Wikipedia for
the article shots) and management open (ZIMI_MANAGE_OPEN=1 on a scratch
server; the catalog and sharing shots live behind Manage). The Create shot
captures --create-url with the rendered engine and waits for the done card,
so the server needs Playwright's Chromium too.

Pick shots with --only (comma-separated names) to retake one.
"""

import argparse
import sys
import time

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

NETWORK_IDLE_MS = 4000

DESKTOP = {"width": 1440, "height": 900}
ARTICLE = {"width": 1280, "height": 800}
SETTLE_MS = 1200  # fonts, icons and the Discover strip after networkidle
CREATE_TIMEOUT_MS = 8 * 60 * 1000
# What the Home draws once the library has answered: the app tiles row.
HOME_READY = ".apps-grid .app-tile"
SCRATCH_ZIMS = "~/Zimi/zims"
SERVER_BOOT_S = 120


def _scratch_env(zim_dir, data_dir):
    """A server of its own: manage open (first-run setup counts as done), offline, no torrent."""
    import os

    env = dict(os.environ)
    env.update(
        ZIM_DIR=str(zim_dir),
        ZIMI_DATA_DIR=str(data_dir),
        ZIMI_MANAGE_OPEN="1",
        ZIMI_OFFLINE="1",
        ZIMI_TORRENT="0",
    )
    return env


class ScratchServer:
    """`zimi serve` on a free port over symlinks to real ZIMs (read-only use), data in a temp dir."""

    def __init__(self, zims=SCRATCH_ZIMS):
        self.zims = zims

    def __enter__(self):
        import os
        import socket
        import subprocess
        import tempfile
        import urllib.request
        from pathlib import Path

        self.tmp = tempfile.TemporaryDirectory(prefix="zimi-shots-")
        root = Path(self.tmp.name)
        (root / "zims").mkdir()
        (root / "data").mkdir()
        for z in sorted(Path(os.path.expanduser(self.zims)).glob("*.zim")):
            (root / "zims" / z.name).symlink_to(z)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        self.base = "http://127.0.0.1:%d" % port
        env = _scratch_env(root / "zims", root / "data")
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "zimi", "serve", "--port", str(port)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        t0 = time.time()
        while time.time() - t0 < SERVER_BOOT_S:
            try:
                urllib.request.urlopen(self.base + "/health", timeout=2).read()
                return self
            except Exception:
                time.sleep(1)
        self.__exit__()
        sys.exit("scratch server did not come up")

    def __exit__(self, *exc):
        import os
        import signal

        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
            self.proc.wait(timeout=20)
        except Exception:
            pass
        self.tmp.cleanup()


def _settle(page, ms=SETTLE_MS):
    # The live-changes stream (/events) never lets the network go idle; a short wait is all it gets.
    try:
        page.wait_for_load_state("networkidle", timeout=NETWORK_IDLE_MS)
    except PlaywrightTimeout:
        pass
    page.wait_for_timeout(ms)


def shot_homepage(page, base, out, favorites, tiles=False):
    page.set_viewport_size(DESKTOP)
    page.goto(base + "/")
    page.wait_for_selector(HOME_READY, timeout=30000)
    if favorites:
        # Starred through the same door the star button uses; a second run
        # would un-star, so only names not yet starred are sent.
        page.evaluate(
            """async (names) => {
                const r = await fetch('/collections'); const have = r.ok ? ((await r.json()).favorites || []) : [];
                for (const n of names) if (!have.includes(n))
                    await fetch('/favorites', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({zim: n})});
            }""",
            favorites,
        )
        page.reload()
        page.wait_for_selector(HOME_READY, timeout=30000)
    if tiles:
        page.evaluate("_setLibraryView('tiles')")
        page.wait_for_selector(".lib-view-btn.active[title*='ile']", timeout=10000)
    _settle(page)
    page.screenshot(path=str(out / "homepage.png"))


def shot_search(page, base, out, query):
    page.set_viewport_size(DESKTOP)
    page.goto(base + "/")
    page.fill("#q", query)
    page.keyboard.press("Enter")
    page.wait_for_selector(".result", timeout=30000)
    _settle(page)
    page.screenshot(path=str(out / "search.png"))


def shot_language(page, base, out, query, source):
    page.set_viewport_size(ARTICLE)
    page.goto(base + "/")
    page.fill("#q", query)
    page.keyboard.press("Enter")
    page.wait_for_selector(".result", timeout=30000)
    _settle(page)
    # The list re-renders as sources answer; take the element after it settles.
    hit = (
        page.locator(".result").filter(has_text=source).first
        if source
        else page.locator(".result").first
    )
    hit.click()
    page.wait_for_selector("iframe", timeout=30000)
    _settle(page, 2500)
    page.click("#lang-selector-btn")
    page.wait_for_selector("#lang-dropdown.visible", timeout=10000)
    # The ↔ markers arrive once the article's translations are resolved
    # against the library; the menu re-renders when they land.
    try:
        page.wait_for_selector(".ld-interlang", timeout=30000)
    except Exception:
        print(
            "language-dropdown: no translation markers (is another language's Wikipedia installed?)"
        )
    page.wait_for_timeout(600)
    page.screenshot(path=str(out / "language-dropdown.png"))


def shot_catalog(page, base, out, category):
    page.set_viewport_size(DESKTOP)
    page.goto(base + "/?manage=library")
    page.wait_for_selector(".manage-tab[data-tab='browse']", timeout=30000)
    page.click(".manage-tab[data-tab='browse']")
    page.wait_for_selector(".browse-cat-card", timeout=60000)
    page.evaluate("cat => drillCategory(cat)", category)
    page.wait_for_selector(
        "#manage-browse .catalog-item",
        timeout=60000,
    )
    _settle(page)
    page.screenshot(path=str(out / "browse-library.png"))


def shot_sharing(page, base, out):
    page.set_viewport_size(DESKTOP)
    page.goto(base + "/?manage=server")
    page.wait_for_selector(".manage-tab-settings.active", timeout=30000)
    _settle(page)
    page.screenshot(path=str(out / "sharing.png"))


def shot_create(page, base, out, url, engine):
    page.set_viewport_size(DESKTOP)
    page.goto(base + "/#create")
    page.wait_for_selector("#create-source", timeout=30000)
    page.fill("#create-source", url)
    page.keyboard.press("Tab")
    # The probe answers and the engine fold appears with its pick.
    page.wait_for_selector("#create-engine-fold", timeout=90000)
    if engine:
        page.evaluate("document.getElementById('create-engine-fold').open = true")
        radio = page.locator("input[name='create-engine'][value='%s']" % engine)
        if radio.count() and radio.is_enabled():
            radio.check()
            page.evaluate("document.getElementById('create-engine-fold').open = false")
    page.click("#create-start")
    page.wait_for_selector(".create-done", timeout=CREATE_TIMEOUT_MS)
    # Both pictures, decoded, before the frame is taken.
    page.wait_for_function(
        "() => { const i = [...document.querySelectorAll('.create-shot img')];"
        " return i.length === 2 && i.every(x => x.complete && x.naturalWidth > 0); }",
        timeout=60000,
    )
    _settle(page, 800)
    page.screenshot(path=str(out / "create.png"))


APP_SETTLE_MS = 4000  # an app page's covers and pictures after its first paint


def _shot_app(page, base, out, name, opener):
    """An app's home in the reader frame, opened the way its tile opens it."""
    page.set_viewport_size(DESKTOP)
    page.goto(base + "/")
    page.wait_for_selector(HOME_READY, timeout=30000)
    page.evaluate("() => " + opener)
    page.mouse.move(0, 0)  # no pointer resting over a tile
    page.frame_locator("#reader-frame").locator("body *:visible").first.wait_for(timeout=60000)
    _settle(page, APP_SETTLE_MS)
    page.screenshot(path=str(out / (name + ".png")))


def shot_zimipedia(page, base, out):
    _shot_app(page, base, out, "zimipedia", "openWiki()")


def shot_bookshelf(page, base, out):
    _shot_app(page, base, out, "bookshelf", "openBooks()")


def shot_games(page, base, out):
    _shot_app(page, base, out, "games", "openGames()")


def shot_solar_system(page, base, out):
    """The Almanac's 3D view on the whole-solar-system preset (the Sun centred, every orbit)."""
    page.set_viewport_size(DESKTOP)
    page.goto(base + "/#almanac", wait_until="load")
    page.wait_for_function(
        "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
        timeout=60000,
    )
    page.evaluate("openAlmanacEarth({ target: 'earth' })")
    page.wait_for_function(
        "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen", timeout=90000, polling=200
    )
    page.evaluate("_aePreset('sun')")
    page.evaluate("_aePreset('planets')")
    page.wait_for_function("() => window.__aeSettled && window.__aeSettled()", timeout=60000)
    page.mouse.move(0, 0)
    _settle(page, APP_SETTLE_MS)
    page.screenshot(path=str(out / "solar-system.png"))


SHOTS = (
    "homepage",
    "solar-system",
    "games",
    "search",
    "language-dropdown",
    "browse-library",
    "sharing",
    "create",
    "zimipedia",
    "bookshelf",
)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--base",
        default="",
        help="a running Zimi; left out, a scratch server starts on a free port over --zims (read-only)",
    )
    ap.add_argument("--zims", default=SCRATCH_ZIMS, help="ZIM folder for the scratch server")
    ap.add_argument("--out", default="screenshots")
    ap.add_argument(
        "--only", default="", help="comma-separated subset of: " + ", ".join(SHOTS)
    )
    ap.add_argument(
        "--tiles",
        action="store_true",
        help="homepage in tile view instead of list view",
    )
    ap.add_argument(
        "--favorites",
        default="",
        help="comma-separated ZIM names to star before the homepage shot",
    )
    ap.add_argument("--query", default="photosynthesis")
    ap.add_argument(
        "--article",
        default="Earth",
        help="search that lands on an article with language links",
    )
    ap.add_argument(
        "--category", default="wikipedia", help="catalog category to drill into"
    )
    ap.add_argument(
        "--article-source",
        default="Wikipedia",
        help="open the first result from this source (its language menu is the shot)",
    )
    ap.add_argument("--create-url", default="https://www.spacejam.com/1996/")
    ap.add_argument("--create-engine", default="rendered")
    args = ap.parse_args()

    from pathlib import Path

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    want = [s for s in args.only.split(",") if s] or list(SHOTS)
    bad = [s for s in want if s not in SHOTS]
    if bad:
        sys.exit("unknown shot(s): " + ", ".join(bad))

    if args.base:
        run(args, want, out)
    else:
        with ScratchServer(args.zims) as srv:
            args.base = srv.base
            run(args, want, out)


def run(args, want, out):
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(
            viewport=DESKTOP, device_scale_factor=1, color_scheme="dark"
        )
        page = ctx.new_page()
        for name in want:
            t0 = time.time()
            if name == "homepage":
                shot_homepage(
                    page,
                    args.base,
                    out,
                    [f for f in args.favorites.split(",") if f],
                    args.tiles,
                )
            elif name == "search":
                shot_search(page, args.base, out, args.query)
            elif name == "language-dropdown":
                shot_language(page, args.base, out, args.article, args.article_source)
            elif name == "browse-library":
                shot_catalog(page, args.base, out, args.category)
            elif name == "sharing":
                shot_sharing(page, args.base, out)
            elif name == "zimipedia":
                shot_zimipedia(page, args.base, out)
            elif name == "bookshelf":
                shot_bookshelf(page, args.base, out)
            elif name == "games":
                shot_games(page, args.base, out)
            elif name == "solar-system":
                shot_solar_system(page, args.base, out)
            elif name == "create":
                shot_create(page, args.base, out, args.create_url, args.create_engine)
            print("%-18s %5.1fs  %s" % (name, time.time() - t0, out / (name + ".png")))
        browser.close()


if __name__ == "__main__":
    main()
