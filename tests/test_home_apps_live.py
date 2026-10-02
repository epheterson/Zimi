"""The home page's order governs the apps, and the Apps title opens their page.

tripplehelix, #100: "There's no reason why the sorting UI is below the apps
and the title isn't clickable like everything else." Eric, 2026-09-28: "for
the sort we can sort the apps by recently updated (i.e. contains zims that
were recently updated, added, etc..)", and an Apps page with the ZIMs inside
each app.

In a real browser, at a desktop width and on a phone, light and dark, left
to right and right to left: the order and view controls sit on the Apps
heading, above the row, clear of its name and on the screen; the apps move
with the order (an app holding a ZIM updated an hour ago comes first under
Recently updated, and the tiles slide rather than being drawn again); the
Apps heading opens the Apps page, each app with the ZIMs inside it in the
same order, led by its own tile (which opens the app; an empty app is only
its tile, outlined in dots), its cards the ZIMs; Back returns
to it.

Run: pytest tests/test_home_apps_live.py -v
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

SHOTS = os.environ.get("ZIMI_SHOTS", "")
DAY = 86400
HOME = (
    "() => typeof mode !== 'undefined' && mode === 'home' && !homeScope"
    " && !!document.querySelector('#output .apps-grid')"
)

# file, metadata, (days since it arrived, hours since it was updated or None,
# articles). Askubuntu arrived last; CrashCourse's new build landed an hour ago.
LIBRARY = [
    (
        "ted_en_all_2026-01.zim",
        {"Scraper": "ted2zim 3.0.2", "Name": "ted_en_all", "Title": "All TED videos"},
        (60, None, 5000),
    ),
    (
        "blender_2026-01.zim",
        {
            "Scraper": "youtube2zim 3.4",
            "Name": "blender",
            "Title": "Blender Studio films",
        },
        (55, None, 300),
    ),
    (
        "crashcourse_2026-01.zim",
        {"Scraper": "youtube2zim 3.4", "Name": "crashcourse", "Title": "CrashCourse"},
        (50, 1, 800),
    ),
    (
        "gutenberg_en_all_2026-01.zim",
        {
            "Scraper": "gutenberg2zim 3.0.1",
            "Name": "gutenberg_en_all",
            "Title": "Project Gutenberg Library",
        },
        (40, None, 60000),
    ),
    (
        "askubuntu.com_en_all_2026-01.zim",
        {
            "Scraper": "sotoki 2.2",
            "Name": "askubuntu.com_en_all",
            "Title": "Ask Ubuntu",
        },
        (10, None, 900000),
    ),
    (
        "apod_en_all_2026-01.zim",
        {"Name": "apod_en_all", "Title": "Astronomy Picture of the Day"},
        (30, None, 9000),
    ),
    ("water.zim", {"Title": "Water"}, (70, None, 3)),
]
APP_ZIMS = {
    "tube": {"ted", "blender", "crashcourse"},
    "books": {"gutenberg"},
    "exchange": {"askubuntu"},
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("home")
    zdir = tmp / "zims"
    zdir.mkdir()
    for filename, meta, _ in LIBRARY:
        build_fixture_zim(str(zdir / filename), meta)
    mp = pytest.MonkeyPatch()
    mp.delenv("ZIMI_APPS", raising=False)
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    srv.load_cache(force=True)
    # The dates and sizes the library list carries, as a library a few months
    # old has them: what the order reads, and all it reads.
    now = time.time()
    by_file = {srv._zim_short_name(f): when for f, _, when in LIBRARY}
    for z in srv._zim_list_cache:
        days, hours, entries = by_file[z["name"]]
        z["first_seen"] = now - days * DAY
        z["updated_at"] = now - hours * 3600 if hours else None
        z["entries"] = entries
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


# The first heading, what it holds, and where things are.
LAYOUT = r"""() => {
  const r = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
  const head = document.querySelector('#output .cat-heading');
  const grid = document.querySelector('#output .apps-grid');
  const ctl = head && head.querySelector('.lib-controls');
  const range = document.createRange();
  range.selectNodeContents(head.firstChild);
  return { heading: head.firstChild.textContent, clickable: head.classList.contains('clickable'),
    aboveApps: head.nextElementSibling === grid, sort: !!(ctl && ctl.querySelector('.lib-sort')),
    view: !!(ctl && ctl.querySelector('.lib-view-toggle')), controls: document.querySelectorAll('#output .lib-controls').length,
    ctl: ctl ? r(ctl) : null, grid: r(grid), text: r(range), vw: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth };
}"""
# The app tiles in the row, in order, each marked so a rebuild would show.
TILES = "() => Array.from(document.querySelectorAll('#output .apps-grid .app-tile')).map(a => a.dataset.app + (a.__kept ? '' : '*'))"
MARK = "() => document.querySelectorAll('#output .apps-grid .app-tile').forEach(a => { a.__kept = 1; })"
SORTED = """(names) => names.every((n, i) => i === 0 || names[i - 1].localeCompare(n, undefined, {sensitivity: 'base', numeric: true}) <= 0)"""
# The Apps page: each app's section, its banner and the ZIMs under it, and
# how they are drawn: the banner taller than a ZIM's card and wider than the
# ZIMs, which sit set in under it; the gap to the next section.
PAGE = r"""() => Array.from(document.querySelectorAll('#output > .app-section')).map(s => {
  const lead = s.firstElementChild, zims = Array.from(s.querySelectorAll('.stats-grid > .stat-card'));
  const b = lead.getBoundingClientRect(), z = zims[0] && zims[0].getBoundingClientRect(), next = s.nextElementSibling;
  return { title: lead.querySelector('.zt').textContent, app: lead.dataset.app, leads: lead.classList.contains('app-banner'),
    empty: lead.classList.contains('app-empty'), border: getComputedStyle(lead).borderTopStyle,
    taller: !z || b.height > z.height + 8, setIn: !z || z.width < b.width - 16,
    gap: next ? next.getBoundingClientRect().top - s.getBoundingClientRect().bottom : null,
    zims: zims.map(c => c.dataset.zim), titles: zims.map(c => c.querySelector('.zt').textContent) };
})"""
PAGE_SHAPE = r"""() => ({ headings: Array.from(document.querySelectorAll('#output .cat-heading')).map(h => h.firstChild.textContent),
  height: document.documentElement.scrollHeight })"""


def _sort(pg, key):
    pg.select_option("#output .lib-sort", key)
    pg.wait_for_timeout(600)
    # The control names the order it is in, at once (it kept the old name
    # until the page was drawn again).
    assert pg.evaluate(
        "(k) => document.querySelector('#output .lib-sort-now').textContent === t(_LIBRARY_SORT_LABELS[k])",
        key,
    ), key


@pytest.mark.parametrize(
    "size,phone",
    [({"width": 1440, "height": 900}, False), ({"width": 390, "height": 844}, True)],
    ids=["desktop", "phone"],
)
@pytest.mark.parametrize("scheme", ["dark", "light"])
@pytest.mark.parametrize("lang", ["en", "he"])
def test_the_order_governs_the_apps_and_their_title_opens_their_page(
    served, size, phone, scheme, lang
):
    from playwright.sync_api import sync_playwright

    tag = "%s-%s-%s" % ("phone" if phone else "desktop", scheme, lang)
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
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            pg.wait_for_timeout(500)
            assert pg.evaluate("document.documentElement.dir") == (
                "rtl" if lang == "he" else ""
            )
            apps = pg.evaluate("t('apps_section')")
            if SHOTS:
                pg.screenshot(path=os.path.join(SHOTS, "home-%s.png" % tag))

            # The controls on the Apps heading, above the row, clear of its name.
            at = pg.evaluate(LAYOUT)
            assert at["heading"] == apps and at["clickable"] and at["aboveApps"], at
            assert at["sort"] and at["view"] and at["controls"] == 1, at
            ctl, text, grid = at["ctl"], at["text"], at["grid"]
            assert ctl["b"] <= grid["t"], "the controls sit above the apps"
            assert (
                ctl["l"] >= 0 and ctl["r"] <= at["vw"]
            ), "the controls are on the screen"
            assert ctl["l"] >= text["r"] or ctl["r"] <= text["l"], "clear of the name"
            assert at["scrollW"] <= at["vw"], "nothing pushes the page sideways"
            # An app with nothing inside is outlined in dots, not set up yet.
            borders = pg.evaluate(
                "() => Object.fromEntries(Array.from(document.querySelectorAll('#output .apps-grid .app-tile'))"
                ".map(a => [a.dataset.app, getComputedStyle(a).borderTopStyle]))"
            )
            assert borders["reddot"] == borders["maps"] == "dotted", borders
            assert borders["tube"] == borders["books"] == "solid", borders

            # The apps follow the order, sliding into place: Ask Ubuntu arrived
            # last, CrashCourse's new build landed an hour ago.
            pg.evaluate(MARK)
            _sort(pg, "added")
            assert pg.evaluate(TILES)[0] == "exchange", pg.evaluate(TILES)
            _sort(pg, "updated")
            tiles = pg.evaluate(TILES)
            assert tiles[0] == "tube", "an app holding a just-updated ZIM comes first"
            assert all(not t.endswith("*") for t in tiles), "moved, not drawn again"
            _sort(pg, "alpha")
            names = pg.evaluate(
                "() => Array.from(document.querySelectorAll('#output .apps-grid .app-tile .zt')).map(e => e.textContent)"
            )
            assert pg.evaluate(SORTED, names), names

            # The Apps heading opens the Apps page: each app, what is inside it.
            mid = ((text["l"] + text["r"]) / 2, (text["t"] + text["b"]) / 2)
            pg.mouse.click(*mid)
            pg.wait_for_function("() => homeScope && homeScope.type === 'apps'")
            pg.wait_for_timeout(300)
            assert "scope=apps" in pg.url
            page = pg.evaluate(PAGE)
            by_app = {p["app"]: p for p in page}
            titles = {
                a: pg.evaluate("(a) => _appTitle(a)", a)
                for a in ("tube", "books", "exchange", "maps", "reddot")
            }
            # Each app is a section: its banner, then its ZIMs set in under it
            # (Eric, 2026-09-29: "not having sections and app looking too
            # close to zims with no spacing"); one heading on top holds the
            # controls.
            shape = pg.evaluate(PAGE_SHAPE)
            assert shape["headings"] == [apps], shape
            for app, zims in APP_ZIMS.items():
                sec = by_app[app]
                assert sec["leads"] and sec["title"] == titles[app], sec
                assert set(sec["zims"]) == zims and not sec["empty"], (app, sec)
                assert sec["border"] == "solid", sec
                assert sec["taller"] and sec["setIn"], sec
                assert pg.evaluate(SORTED, sec["titles"]), sec["titles"]
            assert all(p["gap"] >= 24 for p in page if p["gap"] is not None), page
            for app in ("reddot", "maps"):
                sec = by_app[app]
                assert sec["empty"] and not sec["zims"], "an empty app is its door"
                assert sec["border"] == "dotted", "drawn as not set up yet"
            assert pg.evaluate(
                SORTED, [p["title"] for p in page]
            ), "the apps in the library's order"
            assert "apod" not in sum(
                (p["zims"] for p in page), []
            ), "only what is inside the apps"
            if SHOTS:
                pg.screenshot(
                    path=os.path.join(SHOTS, "apps-page-%s.png" % tag), full_page=True
                )
            # Still short: five sections, five ZIMs, in under two phone
            # screens.
            if phone:
                assert shape["height"] < 2 * 844, shape

            # The same order governs the page: most articles puts ZimiExchange first.
            _sort(pg, "entries")
            page = pg.evaluate(PAGE)
            assert page[0]["title"] == titles["exchange"], [p["title"] for p in page]
            tube = next(p for p in page if p["title"] == titles["tube"])
            assert tube["zims"] == [
                "ted",
                "crashcourse",
                "blender",
            ], tube
            # And the view: tiles, the apps' doors with them.
            pg.locator("#output .lib-view-btn").nth(1).click()
            pg.wait_for_timeout(300)
            assert pg.evaluate(
                "() => document.querySelectorAll('#output .stats-grid').length"
                " === document.querySelectorAll('#output .stats-grid.tiles').length"
            )
            if SHOTS:
                pg.screenshot(
                    path=os.path.join(SHOTS, "apps-page-tiles-%s.png" % tag),
                    full_page=True,
                )

            # A card opens its ZIM; Back returns to the Apps page.
            pg.locator('#output .stat-card[data-zim="crashcourse"]').click()
            pg.wait_for_function("() => mode === 'source'")
            pg.go_back()
            pg.wait_for_function(
                "() => homeScope && homeScope.type === 'apps' && !!document.querySelector('#output .stat-card[data-zim]')"
            )
            # An app's banner, heading its section, opens the app.
            pg.locator("#output .app-section .app-banner[data-app='tube']").click()
            pg.wait_for_function("() => _tubeOpen && readerOpen")
            assert not errors, errors
        finally:
            br.close()
