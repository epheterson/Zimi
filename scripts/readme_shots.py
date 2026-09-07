#!/usr/bin/env python3
"""Retake the README screenshots against a running Zimi.

The README shows six pictures: the homepage, a search, the language menu
open on an article, the catalog drilled into a category, the sharing
settings, and the Create page at the moment a capture finishes with its two
pictures (live beside packaged). They go stale every release; this retakes
them all the same way, so a refresh is one command and not an afternoon.

    python3 scripts/readme_shots.py --base http://127.0.0.1:8931 --out screenshots/

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

from playwright.sync_api import sync_playwright

DESKTOP = {"width": 1440, "height": 900}
ARTICLE = {"width": 1280, "height": 800}
SETTLE_MS = 1200  # fonts, icons and the Discover strip after networkidle
CREATE_TIMEOUT_MS = 8 * 60 * 1000


def _settle(page, ms=SETTLE_MS):
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(ms)


def shot_homepage(page, base, out, favorites, tiles=False):
    page.set_viewport_size(DESKTOP)
    page.goto(base + "/")
    page.wait_for_selector(".card-info, .discover-card", timeout=30000)
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
        page.wait_for_selector(".card-info, .discover-card", timeout=30000)
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
    hit = page.locator(".result").filter(has_text=source).first if source else page.locator(".result").first
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
        print("language-dropdown: no translation markers (is another language's Wikipedia installed?)")
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


SHOTS = (
    "homepage",
    "search",
    "language-dropdown",
    "browse-library",
    "sharing",
    "create",
)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--base", default="http://127.0.0.1:8899")
    ap.add_argument("--out", default="screenshots")
    ap.add_argument(
        "--only", default="", help="comma-separated subset of: " + ", ".join(SHOTS)
    )
    ap.add_argument("--tiles", action="store_true", help="homepage in tile view instead of list view")
    ap.add_argument("--favorites", default="", help="comma-separated ZIM names to star before the homepage shot")
    ap.add_argument("--query", default="water purification")
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

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(
            viewport=DESKTOP, device_scale_factor=1, color_scheme="dark"
        )
        page = ctx.new_page()
        for name in want:
            t0 = time.time()
            if name == "homepage":
                shot_homepage(page, args.base, out, [f for f in args.favorites.split(',') if f], args.tiles)
            elif name == "search":
                shot_search(page, args.base, out, args.query)
            elif name == "language-dropdown":
                shot_language(page, args.base, out, args.article, args.article_source)
            elif name == "browse-library":
                shot_catalog(page, args.base, out, args.category)
            elif name == "sharing":
                shot_sharing(page, args.base, out)
            elif name == "create":
                shot_create(page, args.base, out, args.create_url, args.create_engine)
            print("%-18s %5.1fs  %s" % (name, time.time() - t0, out / (name + ".png")))
        browser.close()


if __name__ == "__main__":
    main()
