"""The Almanac's Tables and Calculations in a real browser.

On the shipped files, served by Zimi, in headless Chromium at a phone's width
(390px), San Francisco chosen as the place:

  1. The tiles: three rows, every table, calculation and constants table, scrolling inside
     themselves; the page never scrolls sideways.
  2. Every table opens with rows, its time window changes them (a day, a
     month, a year), and the print rules are there for it.
  3. Every calculation shows an answer from its defaults, with no button.
  4. Inputs: a place searched and picked (San Francisco to New York, about
     4,130 km); a unit picked (100 °F is 37.78 °C); a number dragged
     sideways and typed; a date's drum changed.
  5. Back (the view's, Escape, the browser's) returns to the Almanac where
     it was, still open.

The sums themselves are held in tests/test_almanac_tables.cjs.

Run: pytest tests/test_almanac_tables_browser.py -v
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
from urllib.parse import unquote, urljoin

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
VIEW = {"width": 390, "height": 844}
SF = {
    "lat": 37.7749,
    "lon": -122.4194,
    "name": "San Francisco, California, United States",
}
TABLES = [
    "sunmoon",
    "tides",
    "twilight",
    "phases",
    "seasons",
    "calendars",
    "nav",
    "stars",
    "eclipses",
    "suntime",
]
CALCS = [
    "distance",
    "sundial",
    "sunmoonday",
    "units",
    "sight",
    "days",
    "convert",
    "zones",
]
CONSTS = ["k_earth", "k_sunmoon", "k_time", "k_nav", "k_physics", "k_units"]
DRAWN = (
    "() => { var o = document.getElementById('tb-out'); var a = document.getElementById('tk-answer');"
    " return (o && !o.classList.contains('tb-busy') && o.firstChild && !o.querySelector('.tb-wait'))"
    " || (a && a.textContent.length > 0); }"
)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("tables")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


@pytest.fixture(scope="module")
def page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        ctx = br.new_context(
            viewport=VIEW,
            device_scale_factor=2,
            has_touch=True,
            service_workers="block",
            locale="en-US",
            timezone_id="America/Los_Angeles",
            reduced_motion="reduce",
        )
        ctx.add_init_script(
            "localStorage.setItem('zimi_almanac_place', %s);"
            % json.dumps(json.dumps(SF))
        )
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(served + "/#almanac", wait_until="load")
        pg.wait_for_function("() => document.getElementById('alm-group-tables')")
        pg.evaluate("typeof _cancelAllRAF === 'function' && _cancelAllRAF()")
        yield pg
        br.close()


def _open(pg, id_):
    pg.evaluate("(id) => _almRefOpen(id)", id_)
    pg.wait_for_function(
        "(id) => window.AlmanacRef && document.getElementById('alm-ref') && document.getElementById('alm-ref-title')",
        arg=id_,
        timeout=30000,
    )
    pg.wait_for_function(DRAWN, timeout=60000)


def _rows(pg):
    return pg.evaluate(
        "document.querySelectorAll('#tb-out tbody tr:not(.tb-grp)').length"
    )


def _no_side_scroll(pg):
    return pg.evaluate(
        "() => { var r = document.getElementById('alm-ref'), c = document.getElementById('almanac-content');"
        " return document.documentElement.scrollWidth <= innerWidth && c.scrollWidth <= c.clientWidth"
        " && (!r || r.scrollWidth <= r.clientWidth); }"
    )


def _seg(pg, v):
    pg.click("[data-tk-seg='win'][data-v='%s']" % v)
    pg.wait_for_timeout(50)
    pg.wait_for_function(DRAWN, timeout=60000)


def _how_is_made(page, id_, md):
    """Under every view, closed: inputs, method, constants; in Print and Share."""
    how = page.evaluate(
        "() => { const d = document.querySelector('#tb-how details'); return d && { open: d.open,"
        " groups: [...d.querySelectorAll('h4')].map((h) => h.textContent), lines: d.querySelectorAll('li').length }; }"
    )
    assert how and not how["open"] and how["lines"] >= 1, (id_, how)
    assert "Method" in how["groups"], (id_, how)
    assert "## How this is made" in md and "### Method" in md, (id_, md[-600:])
    # Its Equations: closed inside it, and in the Markdown as LaTeX.
    eqs = page.evaluate(
        "() => { const e = document.querySelector('#tb-how details.tb-eqs'); return e && { open: e.open, n: e.querySelectorAll('.tb-eq').length }; }"
    )
    assert eqs and not eqs["open"] and eqs["n"] >= 1, (id_, eqs)
    assert "### Equations" in md and md.count("$$") >= 2 * eqs["n"], (id_, md[-600:])
    # On paper they are open, in the printed copy; the view's stay closed.
    page.evaluate("_tbPrintOn()")
    assert page.evaluate(
        "() => { const d = [...document.querySelectorAll('#alm-book .tb-how, #alm-book .tb-eqs')]; return d.length === 2 && d.every((x) => x.open); }"
    )
    page.evaluate("_tbPrintOff()")
    assert not page.evaluate(
        "!!document.getElementById('alm-book') || [...document.querySelectorAll('#tb-how details')].some((d) => d.open)"
    )


def test_the_tiles(page):
    tiles = page.evaluate(
        "[...document.querySelectorAll('.alm-tile')].map(b => b.dataset.tb)"
    )
    assert tiles == TABLES + CALCS + CONSTS
    assert page.evaluate("document.querySelectorAll('.alm-tiles').length") == 3
    # Each row scrolls inside itself; the print chips are gone.
    assert page.evaluate(
        "[...document.querySelectorAll('.alm-tiles')].every(r => r.scrollWidth > r.clientWidth)"
    )
    assert page.evaluate("document.querySelectorAll('.alm-sheet').length") == 0
    assert _no_side_scroll(page)
    # The equations' renderer is not on the Almanac's path: it comes only
    # when Equations are opened (or printed).
    assert page.evaluate(
        "!window.temml && !document.querySelector('script[src*=\"temml\"]')"
    )


@pytest.mark.parametrize("id_", TABLES)
def test_every_table_opens_and_its_window_changes_its_rows(page, id_):
    _open(page, id_)
    assert page.evaluate("document.getElementById('alm-ref-title').textContent")
    if id_ == "tides":
        # The station is the Almanac's own (its data arrives with the tide section).
        page.wait_for_function(
            "() => typeof _at !== 'undefined' && _at.data", timeout=30000
        )
        page.evaluate("AlmanacRef.open('tides')")
        page.wait_for_function(DRAWN)
    _seg(page, "day")
    day = _rows(page)
    _seg(page, "month")
    month = _rows(page)
    if id_ in ("sunmoon", "twilight", "phases", "tides", "calendars", "suntime"):
        assert day == 1 and month >= 28, (id_, day, month)
    elif id_ == "nav":
        assert day > month or day >= 24, (id_, day, month)
    _seg(page, "year")
    year = _rows(page)
    if id_ in ("phases", "seasons", "eclipses", "stars"):
        assert year > 0 and year >= month, (id_, month, year)
    if id_ == "seasons":
        assert year == 4
    assert _no_side_scroll(page)
    # Print: the book of this one table is the page, its heading the title
    # block, the view (and its controls) set aside.
    assert page.evaluate(
        "document.querySelector('#tb-print-head .tb-printhead h1') !== null"
    )
    page.evaluate("_tbPrintOn()")
    page.emulate_media(media="print")
    shown = page.evaluate(
        "() => { const b = document.getElementById('alm-book'); return [getComputedStyle(b).display,"
        " getComputedStyle(document.getElementById('alm-ref')).display,"
        " getComputedStyle(b.querySelector('.tb-printhead')).display, b.querySelectorAll('.tb-controls').length,"
        " b.querySelectorAll('.tb-book-page').length, !!b.querySelector('.tb-book-title')]; }"
    )
    page.emulate_media(media="screen")
    page.evaluate("_tbPrintOff()")
    assert shown == ["block", "none", "block", 0, 1, False], shown
    # Share: the same view as Markdown, its name, place and window, then a table.
    md = page.evaluate("_tbMarkdown()")
    name = page.evaluate("document.getElementById('alm-ref-title').textContent")
    lines = md.split("\n")
    assert lines[0] == "# " + name and lines[2], (id_, lines[:3])
    assert "| --- |" in md, (id_, md[:300])
    _how_is_made(page, id_, md)
    # Each table's rows are as wide as its head.
    for block in "\n".join(ln if ln.startswith("| ") else "" for ln in lines).split(
        "\n\n"
    ):
        widths = {ln.count(" | ") for ln in block.split("\n") if ln}
        assert len(widths) <= 1, (id_, widths)
    assert not page.errors, page.errors


def test_a_table_on_a_phone(page):
    """Eric's iPhone review: the day and the place on one line, the day opens
    a calendar, a phase on every day, Print sets the page up itself, the
    frozen column hides what scrolls under it, a compact Start again."""
    _open(page, "phases")
    _seg(page, "month")
    row = page.evaluate(
        "() => { const r = document.querySelector('.tb-controls-row'); const a = r.querySelector('.tb-stepper').getBoundingClientRect(),"
        " b = r.querySelector('.tk-place').getBoundingClientRect();"
        " return [Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 4, b.right <= innerWidth]; }"
    )
    assert row == [True, True], row
    lit = page.evaluate("t('tb_lit', { n: '' }).trim()")
    cells = page.evaluate(
        "() => [...document.querySelectorAll('#tb-out tbody tr:not(.tb-grp) td')].map(td => [!!td.querySelector('svg'), td.textContent])"
    )
    assert len(cells) >= 28 and all(g and lit in txt for g, txt in cells), cells[:3]
    # The day is a date input: a pick moves the window there.
    page.evaluate(
        "() => { const i = document.querySelector('[data-tb-date-in]'); i.value = '2027-03-15'; i.dispatchEvent(new Event('change')); }"
    )
    page.wait_for_function(DRAWN)
    assert (
        page.evaluate("document.querySelector('[data-tb-date-in]').value")
        == "2027-03-15"
    )
    assert "2027" in page.inner_text("[data-tb-today]")
    # Start again: the Almanac's day and place.
    page.click("[data-tb-reset]")
    page.wait_for_function(DRAWN)
    assert "2027" not in page.inner_text("[data-tb-today]")
    # Print: the view is set up for paper before the dialog is asked for.
    page.evaluate(
        "() => { _tb.pdfOff = true; window.__printed = null; window.__p = window.print; window.print = () => { window.__printed ="
        " document.documentElement.classList.contains('alm-ref-print') && !!document.getElementById('alm-book'); }; }"
    )
    page.click("[data-tb-act='print']")
    page.wait_for_function("() => window.__printed !== null", timeout=30000)
    assert page.evaluate("window.__printed") is True
    # The view is where it was, still the open view.
    assert page.evaluate(
        "!!document.querySelector('#alm-ref #tb-out table') && document.getElementById('alm-ref-title').textContent === t('tb_phases')"
    )
    page.evaluate(
        "() => { _tb.pdfOff = false; window.print = window.__p; window.dispatchEvent(new Event('afterprint')); }"
    )
    assert not page.evaluate(
        "document.documentElement.classList.contains('alm-ref-print')"
    )
    # The frozen first column is opaque, on a lit row too.
    _open(page, "sunmoon")
    _seg(page, "month")
    th = page.evaluate(
        "() => { const c = getComputedStyle(document.querySelector('#tb-out tr.tb-today th')); return [c.backgroundColor, c.position]; }"
    )
    assert th[1] == "sticky" and th[0].startswith("rgb("), th
    # A phase on every day of the Sun and Moon table too.
    assert (
        page.evaluate(
            "document.querySelectorAll('#tb-out tbody tr:not(.tb-grp) td:last-child svg').length"
        )
        >= 28
    )
    # A calculation's Start again is the same icon, beside Print.
    _open(page, "days")
    assert page.evaluate(
        "!!document.querySelector('.tb-bar [data-tb-reset]') && !document.querySelector('.tb-reset')"
    )
    assert _no_side_scroll(page)
    assert not page.errors, page.errors


def test_a_sheet_stands_above_the_keyboard(page):
    _open(page, "distance")
    page.click(".tk-place >> nth=0")
    page.wait_for_selector(".tk-pop.tk-sheet input")
    # The keyboard: the visual viewport loses its lower 300px.
    page.evaluate(
        "() => { const vv = window.visualViewport; Object.defineProperty(vv, 'height', { configurable: true, get: () => innerHeight - 300 });"
        " vv.dispatchEvent(new Event('resize')); }"
    )
    # (It moves by a transition: read it once that has run.)
    page.wait_for_function(
        "() => { const p = document.querySelector('.tk-pop'), q = p.querySelector('input'), top = innerHeight - 300;"
        " return p.getBoundingClientRect().bottom <= top + 1 && q.getBoundingClientRect().bottom <= top; }",
        timeout=5000,
    )
    page.evaluate("() => { delete window.visualViewport.height; }")
    page.keyboard.press("Escape")
    assert not page.evaluate("!!document.querySelector('.tk-pop')")
    assert not page.errors, page.errors


@pytest.mark.parametrize("id_", CALCS)
def test_every_calculation_answers_from_its_defaults(page, id_):
    _open(page, id_)
    big = page.evaluate("document.querySelector('.tk-big').textContent")
    assert big and big != "–", (id_, big)
    assert page.evaluate("document.querySelectorAll('#tk-working tr').length") > 0
    assert page.evaluate(
        "document.querySelector('.tk-calc, button[data-calculate]') === null"
    )
    assert _no_side_scroll(page)
    # Share: its answer first, then what it was worked from, then the working.
    md = page.evaluate("_tbMarkdown()")
    assert md.startswith("# ") and ("**" + big.strip()) in md, (id_, md[:200])
    assert "\n- " in md and "| --- |" in md, (id_, md[:400])
    _how_is_made(page, id_, md)
    assert not page.errors, page.errors


@pytest.mark.parametrize("id_", CONSTS)
def test_every_constants_table(page, id_):
    _open(page, id_)
    rows = page.evaluate(
        "[...document.querySelectorAll('#tb-out tbody tr')].map((r) => [...r.cells].map((c) => c.textContent))"
    )
    assert len(rows) >= 6, (id_, rows)
    for r in rows:
        assert len(r) == 3 and r[0] and r[1] and r[2], (id_, r)
        assert "NaN" not in r[1] and r[1] != "–" and "undefined" not in "".join(r), (
            id_,
            r,
        )
    md = page.evaluate("_tbMarkdown()")
    assert md.startswith("# ") and "| --- | --- | --- |" in md, (id_, md[:300])
    assert page.evaluate(
        "!!document.querySelector('.tb-bar [data-tb-act=copy]') && !!document.querySelector('.tb-bar [data-tb-act=print]')"
        " && !document.querySelector('.tb-bar [data-tb-reset]')"
    )
    assert _no_side_scroll(page)
    assert not page.errors, page.errors


def test_constants_read_the_sums_own_numbers(page):
    _open(page, "k_earth")
    cells = page.evaluate(
        "[...document.querySelectorAll('#tb-out tbody tr')].map((r) => r.cells[1].textContent)"
    )
    assert "6,378.137 km" in cells and "1 / 298.257223563" in cells, cells
    _open(page, "k_sunmoon")
    cells = page.evaluate(
        "[...document.querySelectorAll('#tb-out tbody tr')].map((r) => r.cells[1].textContent)"
    )
    assert (
        "29.530589 d" in cells and "27.554550 d" in cells and "27.212221 d" in cells
    ), cells
    # How this is made links a constant to its tile.
    _open(page, "sunmoon")
    page.evaluate("document.querySelector('#tb-how details').open = true")
    page.click("#tb-how [data-tb-go='k_sunmoon']")
    page.wait_for_function(
        "document.getElementById('alm-ref-title').textContent === 'Sun and Moon' && !!document.querySelector('.tb-consts')"
    )
    assert not page.errors, page.errors


ICONS = (
    "(sel) => [...document.querySelectorAll(sel)].map((b) => [b.dataset.tbAct || b.dataset.almBook || (b.hasAttribute('data-tb-reset') ? 'reset' : ''),"
    " b.getAttribute('aria-label'), b.getAttribute('title'), b.textContent.trim(), Math.round(b.getBoundingClientRect().width),"
    " Math.round(b.getBoundingClientRect().height), !!b.querySelector('svg')])"
)


def test_share_sends_markdown_or_copies_it(page):
    page.evaluate(
        "() => { if (document.getElementById('alm-ref')) _tbClose(); window.__shared = null; window.__copied = null;"
        " navigator.share = (d) => { window.__shared = d; return Promise.resolve(); };"
        " window.__ct = _copyText; _copyText = (s) => { window.__copied = s; }; }"
    )
    _open(page, "days")
    # Start again, Copy, Share, Print: icons only, 44px, named in words.
    icons = page.evaluate(ICONS, ".tb-bar-end button")
    assert [i[0] for i in icons] == ["reset", "copy", "share", "print"], icons
    words = [
        "Start again from now and here",
        "Copy as Markdown",
        "Share",
        "Print or PDF",
    ]
    assert [i[1] for i in icons] == words and [i[2] for i in icons] == words, icons
    assert all(i[3] == "" and i[4] >= 44 and i[5] >= 44 and i[6] for i in icons), icons
    # At the right of the title.
    assert page.evaluate(
        "document.querySelector('.tb-bar-end').getBoundingClientRect().left >= document.getElementById('alm-ref-title').getBoundingClientRect().right"
    )
    page.click("[data-tb-act='share']")
    page.wait_for_function("() => window.__shared")
    shared = page.evaluate("window.__shared")
    assert shared and shared["text"].startswith("# ") and shared["title"], shared
    page.click("[data-tb-act='copy']")
    page.wait_for_function("() => window.__copied")
    assert page.evaluate("window.__copied") == shared["text"]
    # No share sheet: Share puts it on the clipboard ("Copied"), and a view
    # opened without one has no Share at all.
    page.evaluate(
        "() => { window.__copied = null; delete navigator.share; Navigator.prototype.share = undefined; }"
    )
    page.click("[data-tb-act='share']")
    page.wait_for_function("() => window.__copied")
    assert page.evaluate("window.__copied") == shared["text"]
    _open(page, "sundial")
    assert [i[0] for i in page.evaluate(ICONS, ".tb-bar-end button")] == [
        "reset",
        "copy",
        "print",
    ]
    page.evaluate("() => { _copyText = window.__ct; }")
    assert not page.errors, page.errors


def _pick_place(page, key, query):
    page.click("[data-tk-place='%s']" % key)
    page.fill(".tk-pop .tk-search", query)
    page.click(".tk-pop .tk-opt")


def test_distance_after_picking_places(page):
    _open(page, "distance")
    _pick_place(page, "a", "San Francisco")
    _pick_place(page, "b", "New York")
    page.click("[data-tk-seg='unit'][data-v='km']")
    big = page.evaluate("document.querySelector('.tk-big').textContent")
    km = float(big.split(" ")[0].replace(",", ""))
    assert abs(km - 4130) < 15, big


def test_units_after_picking_and_typing(page):
    _open(page, "units")
    page.click("[data-tk-pick='kind']")
    page.click(".tk-pop .tk-opt[data-v='temperature']")
    page.click("[data-tk-pick='from']")
    page.click(".tk-pop .tk-opt[data-v='f']")
    page.click("[data-tk-pick='to']")
    page.click(".tk-pop .tk-opt[data-v='c']")
    # Tap the number to type it.
    page.click("[data-tk='v']")
    page.fill("[data-tk='v'] .tk-in", "100")
    page.keyboard.press("Enter")
    assert page.evaluate("document.querySelector('.tk-big').textContent") == "37.78 °C"
    # Drag it sideways: it moves, and the answer follows.
    box = page.locator("[data-tk='v']").bounding_box()
    y = box["y"] + box["height"] / 2
    page.mouse.move(box["x"] + 5, y)
    page.mouse.down()
    page.mouse.move(box["x"] + 5 + 70, y, steps=8)
    page.mouse.up()
    v = page.evaluate("_tb.calc.units.v")
    assert v > 100, v
    assert page.evaluate("document.querySelector('.tk-big').textContent") != "37.78 °C"
    # And the keys.
    page.focus("[data-tk='v']")
    before = page.evaluate("_tb.calc.units.v")
    page.keyboard.press("ArrowUp")
    assert page.evaluate("_tb.calc.units.v") == before + 1


def test_a_date_drum_and_an_angle(page):
    _open(page, "sight")
    before = page.evaluate("_tb.calc.sight.ms")
    page.click("[data-tk-date='ms']")
    page.focus("[data-tk='ms.day']")
    page.keyboard.press("ArrowUp")
    assert page.evaluate("_tb.calc.sight.ms") - before == 86400000
    page.click("[data-tk-done]")
    # An angle typed the navigator's way.
    page.click("[data-tk='lat']")
    page.fill("[data-tk='lat'] .tk-in", "41 27.3 N")
    page.keyboard.press("Enter")
    assert abs(page.evaluate("_tb.calc.sight.lat") - 41.455) < 1e-9
    assert (
        page.evaluate("document.querySelector(\"[data-tk='lat'] .tk-v\").textContent")
        == "41° 27.3′"
    )


def test_the_page_scrolls_to_its_very_end(page):
    """At 390x844 the page reaches its end and stays there: the header
    stepping aside grows the scroller, and the browser's pull back at the
    end must not bring it back (which shrank the scroller and left the last
    lines out of reach). The footer clears a phone's home indicator."""
    page.evaluate("() => { if (document.getElementById('alm-ref')) _tbClose(); }")
    end = (
        "() => { const c = document.getElementById('almanac-content'); c.scrollTop = c.scrollHeight;"
        " return new Promise((r) => setTimeout(() => r({ gap: c.scrollHeight - c.scrollTop - c.clientHeight,"
        " foot: c.querySelector('.alm-footer').getBoundingClientRect().bottom - c.getBoundingClientRect().bottom }), 300)); }"
    )
    for _ in range(3):
        got = page.evaluate(end)
        assert got["gap"] <= 1 and got["foot"] <= 0, got
    css = page.evaluate(
        "[...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch (e) { return []; } })"
        ".filter((r) => r.selectorText === '.alm-footer').map((r) => r.cssText).join(' ')"
    )
    assert "safe-area-inset-bottom" in css, css
    page.evaluate("document.getElementById('almanac-content').scrollTop = 0")
    assert not page.errors, page.errors


def test_back_returns_to_the_almanac_where_it_was(page):
    page.evaluate(
        "window.AlmanacRef && document.getElementById('alm-ref') && AlmanacRef.close()"
    )
    page.wait_for_timeout(300)
    page.evaluate("document.getElementById('alm-group-tables').scrollIntoView()")
    # The late sections (the tide) and the phone's header settle first.
    page.wait_for_timeout(2000)
    page.evaluate("document.getElementById('alm-group-tables').scrollIntoView()")
    page.wait_for_timeout(500)
    top = page.evaluate("document.getElementById('almanac-content').scrollTop")
    page.evaluate("document.querySelector(\".alm-tile[data-tb='seasons']\").click()")
    page.wait_for_function(DRAWN, timeout=60000)
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.getElementById('alm-ref')")
    assert page.evaluate("_almanacOpen")
    assert (
        abs(page.evaluate("document.getElementById('almanac-content').scrollTop") - top)
        < 2
    )
    # The browser's Back: the view goes, the Almanac stays.
    page.evaluate("document.querySelector(\".alm-tile[data-tb='units']\").click()")
    page.wait_for_function(DRAWN, timeout=60000)
    page.go_back()
    page.wait_for_function("() => !document.getElementById('alm-ref')")
    page.wait_for_timeout(300)
    assert page.evaluate("_almanacOpen")
    # The view's own Back.
    page.evaluate("document.querySelector(\".alm-tile[data-tb='days']\").click()")
    page.wait_for_function(DRAWN, timeout=60000)
    page.click("[data-tb-close]")
    page.wait_for_function("() => !document.getElementById('alm-ref')")
    page.wait_for_timeout(300)
    assert page.evaluate("_almanacOpen")
    assert not page.errors, page.errors


def test_add_a_clock_from_a_searchable_sheet(page):
    """+ Add a clock opens a sheet: a search on top, every zone below with its
    time now; typing filters, a tap adds the clock."""
    page.evaluate(
        "() => { const r = document.getElementById('alm-ref'); if (r) _tbClose(); }"
    )
    page.wait_for_selector(".alm-tz-add", state="attached", timeout=30000)
    page.locator(".alm-tz-add").scroll_into_view_if_needed()
    page.click(".alm-tz-add")
    page.wait_for_selector(".alm-clock-sheet .tk-search")
    n_all = page.evaluate(
        "document.querySelectorAll('.alm-clock-sheet .tk-opt').length"
    )
    assert n_all > 60, n_all
    sub = page.inner_text(".alm-clock-sheet .tk-opt .tk-opt-sub >> nth=0")
    assert "UTC" in sub and ":" in sub, sub
    page.fill(".alm-clock-sheet .tk-search", "kathm")
    assert (
        page.evaluate("document.querySelectorAll('.alm-clock-sheet .tk-opt').length")
        == 1
    )
    page.click(".alm-clock-sheet .tk-opt")
    assert not page.evaluate("!!document.querySelector('.alm-clock-sheet, .tk-scrim')")
    assert "Asia/Kathmandu" in page.evaluate(
        "localStorage.getItem('zimi_almanac_clocks')"
    )
    assert "Kathmandu" in page.inner_text("#almanac-tz-pills")
    page.evaluate("_almClockRemove('Asia/Kathmandu')")
    assert not page.errors, page.errors


SHOWN = "[...document.querySelectorAll('#alm-group-tables .alm-tile:not([hidden])')].map((b) => b.dataset.tb)"
ACTIVE_CHIP = "document.querySelector('#alm-subject-chips .pill.active').dataset.subj"


def test_subject_chips_filter_all_three_rows(page):
    """The pill row above the tiles: All, then a chip per subject; each chip
    leaves only its subject's tiles in every row, and All brings them back.
    The row scrolls inside itself; the page never scrolls sideways."""
    page.evaluate(
        "() => { if (document.getElementById('alm-ref')) _tbClose(); _almSubjectChip(''); }"
    )
    chips = page.evaluate(
        "[...document.querySelectorAll('#alm-subject-chips .pill')].map((c) => c.dataset.subj)"
    )
    assert chips == [""] + page.evaluate("ALM_TB_SUBJECT_ORDER"), chips
    assert page.evaluate(ACTIVE_CHIP) == ""
    for s in chips[1:]:
        page.click("#alm-subject-chips [data-subj='%s']" % s)
        assert page.evaluate(SHOWN) == [
            k
            for k in TABLES + CALCS + CONSTS
            if k in page.evaluate("(s) => ALM_TB_SUBJECTS[s]", s)
        ], s
        assert page.evaluate(ACTIVE_CHIP) == s
        assert (
            page.evaluate(
                "document.querySelectorAll('#alm-subject-chips [aria-pressed=\"true\"]').length"
            )
            == 1
        )
        assert _no_side_scroll(page), s
    page.click("#alm-subject-chips [data-subj='']")
    assert page.evaluate(SHOWN) == TABLES + CALCS + CONSTS
    assert not page.errors, page.errors


def _md_sections(md):
    """The book's Markdown cut at each tile's ## heading: {name: body}."""
    out = {}
    for part in md.split("\n## ")[1:]:
        name, _, body = part.partition("\n")
        out[name] = body
    return out


def test_the_whole_book_of_what_is_shown(page):
    """At the right of the title, Copy, Share (where there is a share sheet)
    and Print: icons, named in words. One document of exactly the tiles the
    chips show, each as it stands now (a window changed is the window
    printed), under a title page: the place, where it is, the days, what is
    shown and the contents. Paper gets a page per tile, How this is made
    open, the equations drawn, none of the view's ids; and it is gone after."""
    page.evaluate(
        "() => { if (document.getElementById('alm-ref')) _tbClose();"
        " window.__copied = null; window.__printed = 0; window.__ct = _copyText;"
        " _copyText = (s) => { window.__copied = s; }; window.__pr = window.print;"
        " window.print = () => { window.__printed++; };"
        " if (typeof _tb !== 'undefined') _tb.pdfOff = true; }"
    )
    icons = page.evaluate(
        ICONS, "#alm-group-tables .alm-group-head .alm-book-bar button"
    )
    share = page.evaluate("!!navigator.share")
    assert [i[0] for i in icons] == (
        ["copy", "share", "print"] if share else ["copy", "print"]
    ), icons
    assert all(
        i[1] and i[1] == i[2] and i[3] == "" and i[4] >= 44 and i[5] >= 44 and i[6]
        for i in icons
    ), icons
    assert page.evaluate(
        "() => { const h = document.getElementById('alm-group-tables-t').getBoundingClientRect(),"
        " b = document.querySelector('#alm-group-tables .alm-book-bar').getBoundingClientRect();"
        " return b.left >= h.right - 1 && Math.abs((b.top + b.bottom) / 2 - (h.top + h.bottom) / 2) < 6; }"
    )
    assert not page.evaluate(
        "document.querySelector('.alm-book-btn, .alm-book-bar span')"
    )

    def copy():
        page.evaluate("window.__copied = null")
        page.click("[data-alm-book='copy']")
        page.wait_for_function("() => window.__copied", timeout=60000)
        return page.evaluate("window.__copied")

    def names(subj):
        return page.evaluate(
            "(s) => [...ALM_TB_TABLES, ...ALM_TB_CALCS, ...ALM_TB_CONSTS].filter((k) => !s || ALM_TB_SUBJECTS[s].includes(k))"
            ".map((k) => (_tbKind(k) === 'const' ? t('tb_consts') + ' · ' : '') + t('tb_' + k))",
            subj,
        )

    try:
        # Sun and Moon set to a week, Twilight to a year: the book says so.
        _open(page, "sunmoon")
        _seg(page, "week")
        week = " ".join(page.inner_text("[data-tb-today]").split())
        _open(page, "twilight")
        _seg(page, "year")
        page.evaluate("_tbClose()")
        page.click("#alm-subject-chips [data-subj='sun']")
        md = copy()
        assert md.startswith("# Tables and calculations\n"), md[:200]
        head = md.split("\n## ")[0]
        assert (
            "San Francisco" in head
            and "Showing: Sun" in head
            and "America/Los_Angeles" in head
        ), head
        assert "**Contents**" in head, head
        secs = _md_sections(md)
        assert list(secs) == names("sun"), (list(secs), names("sun"))
        assert ("San Francisco · " + week) in secs["Sun and Moon"].split("\n")[1], secs[
            "Sun and Moon"
        ][:200]
        sm_rows = [
            l
            for l in secs["Sun and Moon"].split("### ")[0].split("\n")
            if l.startswith("| ") and "---" not in l
        ]
        assert len(sm_rows) == 1 + 7, sm_rows
        assert secs["Twilight"].split("\n")[1].endswith(" · 2026"), secs["Twilight"][
            :200
        ]
        # A table in every tile's section, and How this is made a level down.
        for n, body in secs.items():
            assert "| --- |" in body, (n, body[:300])
        assert (
            "### How this is made" in md and "#### Equations" in md and "\n$$\n" in md
        )
        # All: every tile, once each.
        page.click("#alm-subject-chips [data-subj='']")
        md = copy()
        assert "Showing: All" in md
        assert list(_md_sections(md)) == names(""), list(_md_sections(md))
        # Which Zimi made it closes the copy, as it signs the paper.
        ver = page.evaluate("_zimiVersion")
        assert ver, "the shell knows its version from /health"
        assert md.endswith("\n\n*Made with Zimi " + ver + "*\n"), md[-200:]
        # Paper: one chip's tiles, a page each, as they stand.
        page.click("#alm-subject-chips [data-subj='eclipses']")
        page.click("[data-alm-book='print']")
        page.wait_for_function("() => window.__printed === 1", timeout=60000)
        book = page.evaluate(
            "() => { const b = document.getElementById('alm-book'); return b && { pages: [...b.querySelectorAll('.tb-book-page')].map((p) => p.dataset.tb),"
            " heads: b.querySelectorAll('.tb-book-page .tb-printhead h2').length, title: b.querySelector('.tb-book-title').innerText,"
            " toc: [...b.querySelectorAll('.tb-book-toc li')].map((li) => li.querySelector('.tb-toc-n').textContent + ' ' + li.querySelector('.tb-toc-name').textContent),"
            " tocLinks: [...b.querySelectorAll('.tb-book-toc li a')].map((a) => a.getAttribute('href')), marks: [...b.querySelectorAll('.tb-toc-pg')].map((m) => m.dataset.pdfPage),"
            " parts: [...b.querySelectorAll('.tb-book-part h1')].map((h) => h.textContent),"
            " chapters: [...b.querySelectorAll('.tb-book-page')].map((p) => p.id + ' ' + p.querySelector('.tb-printhead h2').textContent),"
            " outline: [...b.querySelectorAll('h1, h2, h3')].map((h) => h.tagName).join(''),"
            " sumh: [...b.querySelectorAll('summary')].every((s) => s.firstElementChild && s.firstElementChild.classList.contains('tb-sumh')) && b.querySelectorAll('.tb-sumh').length > 0,"
            " ariaHeads: b.querySelectorAll('[role=\"heading\"]').length,"
            " closed: b.querySelectorAll('details:not([open])').length, math: b.querySelectorAll('.tb-eq math').length,"
            " eqs: b.querySelectorAll('.tb-eq').length, ids: [...b.querySelectorAll('[id]')].filter((n) => !/^tb-(ch|part)-/.test(n.id)).length, controls: b.querySelectorAll('.tb-controls, button:not(.tb-how-k)').length,"
            " printing: document.documentElement.classList.contains('alm-ref-print') && document.documentElement.classList.contains('alm-book-print'),"
            " pageRules: (document.getElementById('alm-book-pages') || {}).textContent || '' }; }"
        )
        ecl = page.evaluate(
            "[...document.querySelectorAll('#alm-group-tables .alm-tile:not([hidden])')].map((b) => b.dataset.tb)"
        )
        assert sorted(ecl) == sorted(page.evaluate("ALM_TB_SUBJECTS.eclipses")), ecl
        assert book and book["pages"] == ecl and book["heads"] == len(ecl), book
        # Parts (Tables, Constants: no calculation is shown), each tile a
        # numbered chapter; the contents lists every one and links to it,
        # its page number left for the PDF to fill.
        names = page.evaluate("(ids) => ids.map((k) => t('tb_' + k))", ecl)
        assert book["parts"] == [
            "Part I\u00a0·\u00a0Tables",
            "Part II\u00a0·\u00a0Constants",
        ], book["parts"]
        nums = ["1.1", "1.2", "2.1"]
        assert book["toc"] == [n + " " + m for n, m in zip(nums, names)], book["toc"]
        assert book["chapters"] == [
            "tb-ch-%s %s %s" % (n.replace(".", "-"), n, m) for n, m in zip(nums, names)
        ], book["chapters"]
        assert book["tocLinks"] == ["#tb-ch-" + n.replace(".", "-") for n in nums], book
        assert book["marks"] == ["tb-ch-" + n.replace(".", "-") for n in nums], book
        # The outline's headings: Contents, then each part and its chapters
        # only (Eric, 2026-10-05: "PDF depth sounds okay"). How this is made
        # and Equations keep a heading's look in their summaries but are no
        # headings, ARIA's included (Chromium's outline takes those too).
        assert re.fullmatch(r"H1(H1(H2)+)+", book["outline"]), book["outline"]
        assert book["sumh"] and book["ariaHeads"] == 0, book
        assert "Showing: Eclipses" in book["title"], book
        assert book["closed"] == 0 and book["ids"] == 0 and book["controls"] == 0, book
        assert book["eqs"] > 0 and book["math"] == book["eqs"], book
        assert book["printing"], book
        assert "counter(page)" in book["pageRules"], book
        # Each table chapter starts a page under its running head; the
        # constants run on under their part's.
        assert (
            '@page tb-c-1 { @top-left { content: "Part I · Tables";'
            in book["pageRules"]
        ), book["pageRules"]
        assert (
            '@top-right { content: "1.1 ' + names[0] + '";' in book["pageRules"]
        ), book["pageRules"]
        assert (
            '@page tb-p-2 { @top-left { content: "Part II · Constants";'
            in book["pageRules"]
        ), book["pageRules"]
        # The running foot names the Zimi; the title page says it made it.
        assert '"Zimi ' + ver + ' · " counter(page)' in book["pageRules"], book[
            "pageRules"
        ]
        assert (
            '@bottom-center { content: "Made with Zimi ' + ver + '"'
            in book["pageRules"]
        ), book["pageRules"]
        # On paper the book is all there is: serif, black on white.
        page.emulate_media(media="print")
        look = page.evaluate(
            "() => { const b = document.getElementById('alm-book'), s = getComputedStyle(b);"
            " return [s.display, s.color, s.backgroundColor, /Charter|serif/.test(s.fontFamily),"
            " document.getElementById('alm-subject-chips').getClientRects().length,"
            " getComputedStyle(b.querySelector('.tb-table thead')).display]; }"
        )
        page.emulate_media(media="screen")
        assert look == [
            "block",
            "rgb(0, 0, 0)",
            "rgb(255, 255, 255)",
            True,
            0,
            "table-header-group",
        ], look
        # A table wider than portrait paper gets a landscape page.
        assert page.evaluate(
            "() => { const b = document.getElementById('alm-book'), s = b.querySelector('.tb-book-page'), tb = s.querySelector('.tb-out table');"
            " _tbBookWide(b); const before = s.classList.contains('tb-book-wide'); tb.querySelector('tbody td').textContent = 'x'.repeat(400); _tbBookWide(b);"
            " _tbBookPageRules(b, 'x', false); const rules = document.getElementById('alm-book-pages').textContent;"
            " return !before && s.classList.contains('tb-book-wide') && getComputedStyle(s).page === 'tb-wide-1'"
            " && rules.includes('@page tb-wide-1 { size: landscape; @top-left'); }"
        )
        page.evaluate("_tbPrintOff()")
        assert page.evaluate(
            "!document.getElementById('alm-book') && !document.getElementById('alm-book-pages')"
            " && !document.documentElement.classList.contains('alm-book-print')"
        )
    finally:
        page.evaluate(
            "() => { _copyText = window.__ct; window.print = window.__pr; _tb.pdfOff = false; _almSubjectChip(''); }"
        )
    assert not page.errors, page.errors


def test_one_tile_prints_and_copies_as_its_own_book(page):
    """A tile's own Print and Copy: the same design for just that tile, its
    heading the title block (where, when, the coordinates and zone), as it
    stands now."""
    page.evaluate(
        "() => { window.__copied = null; window.__printed = 0; window.__ct = _copyText;"
        " _copyText = (s) => { window.__copied = s; }; window.__pr = window.print;"
        " window.print = () => { window.__printed++; };"
        " if (typeof _tb !== 'undefined') _tb.pdfOff = true; }"
    )
    try:
        _open(page, "seasons")
        page.evaluate("_tb.pdfOff = true")
        _seg(page, "year")
        page.click("[data-tb-step='1']")
        page.wait_for_function(DRAWN)
        page.click("[data-tb-act='copy']")
        page.wait_for_function("() => window.__copied", timeout=60000)
        md = page.evaluate("window.__copied")
        lines = md.split("\n")
        assert lines[0] == "# Seasons" and lines[2].startswith(
            "San Francisco · 2027"
        ), lines[:5]
        assert "37°46.5′N" in lines[3] and "*Worked out offline" in md, lines[:6]
        assert "| --- |" in md and "\n## How this is made\n" in md, md[:400]
        page.click("[data-tb-act='print']")
        page.wait_for_function("() => window.__printed === 1", timeout=60000)
        one = page.evaluate(
            "() => { const b = document.getElementById('alm-book'); return b && [b.classList.contains('alm-book-one'), !!b.querySelector('.tb-book-title'),"
            " b.querySelectorAll('.tb-book-page').length, b.querySelector('.tb-printhead h1').textContent,"
            " b.querySelector('.tb-printhead .tb-sub').textContent, !!b.querySelector('.tb-printhead .tb-made'),"
            " !!document.querySelector('#alm-ref #tb-out table')]; }"
        )
        assert (
            one
            and one[:4] == [True, False, 1, "Seasons"]
            and "2027" in one[4]
            and one[5]
            and one[6]
        ), one
        page.evaluate("_tbPrintOff()")
    finally:
        page.evaluate(
            "() => { _copyText = window.__ct; window.print = window.__pr; _tb.pdfOff = false; }"
        )
    assert not page.errors, page.errors


PDF_SHOWN = (
    "() => { const f = document.getElementById('reader-frame'); try {"
    " const a = f.contentWindow.PDFViewerApplication; return !!(a && a.pagesCount > 0); } catch (e) { return false; } }"
)


def test_print_opens_a_pdf_in_the_reader(page):
    """Eric, 2026-10-04: "I want a good PDF open it in the PDF viewer which
    should support printing." Print: the icon spins, a second tap does
    nothing, the server's PDF opens in Zimi's PDF reader under its own name,
    the reader's Print prints that file (no pdf.js re-render), and Back is
    the tables view where it was."""
    _open(page, "seasons")
    page.evaluate(
        "() => { window.__posts = 0; const f = window.fetch; window.__f = f;"
        " window.fetch = (u, o) => { if (u === TB_PDF_URL) window.__posts++; return f(u, o); }; }"
    )
    try:
        page.click("[data-tb-act='print']")
        assert page.evaluate(
            "document.querySelector('[data-tb-act=print]').classList.contains('alm-busy')"
        )
        page.evaluate("_tbBookPrint([_tb.id])")
        page.wait_for_function(PDF_SHOWN, timeout=120000)
        assert page.evaluate("window.__posts") == 1
        got = page.evaluate(
            "() => { const w = document.getElementById('reader-frame').contentWindow;"
            " return { n: w.PDFViewerApplication.pagesCount, href: w.location.href,"
            " title: w.document.querySelector('.zp-title b').textContent,"
            " almanac: getComputedStyle(document.getElementById('almanac-view')).display,"
            " busy: document.querySelectorAll('.alm-busy').length }; }"
        )
        assert got["n"] >= 1 and got["almanac"] == "none" and got["busy"] == 0, got
        assert "/almanac/pdf/" in got["href"], got
        assert got["title"].startswith("Seasons - San Francisco - 20"), got
        assert "\u2014" not in got["title"] and "\u2013" not in got["title"], got
        # The file itself: the running foot names the Zimi that made it.
        if shutil.which("pdftotext"):
            pdf_path = unquote(
                re.search(r"/almanac/pdf/[^&#?]+", unquote(got["href"])).group(0)
            )
            res = page.request.get(urljoin(page.url, pdf_path))
            assert res.ok, pdf_path
            text = subprocess.run(
                ["pdftotext", "-", "-"],
                input=res.body(),
                capture_output=True,
                check=True,
            ).stdout.decode()
            ver = page.evaluate("_zimiVersion")
            assert ("Zimi " + ver + " · 1 / ") in text, text[-400:]
            # The equations are drawn: their letters are in the file, not
            # just their fraction bars (the maths font is data the render
            # waits for).
            maths = [c for c in text if 0x1D400 <= ord(c) <= 0x1D7FF]
            assert len(maths) > 20, text[:600]
        fr = page.frame_locator("#reader-frame")
        page.evaluate(
            "() => { const w = document.getElementById('reader-frame').contentWindow; w.__pdfjsPrints = 0;"
            " w.PDFViewerApplication.triggerPrinting = () => { w.__pdfjsPrints++; }; }"
        )
        fr.locator(".zp-more").click()
        fr.locator('.zp-menu [data-zp="print"]').click()
        frame = page.frame(url=lambda u: "viewer.html" in u)
        frame.wait_for_function(
            "() => !!document.querySelector('iframe.zp-print-frame')", timeout=5000
        )
        src = frame.evaluate(
            "() => document.querySelector('iframe.zp-print-frame').getAttribute('src')"
        )
        assert src.startswith("/almanac/pdf/") and src.endswith("raw=1"), src
        assert frame.evaluate("window.__pdfjsPrints") == 0
        page.evaluate("goBack()")
        page.wait_for_function(
            "() => !readerOpen && getComputedStyle(document.getElementById('almanac-view')).display !== 'none'",
            timeout=10000,
        )
        assert page.evaluate(
            "_almanacOpen && document.getElementById('alm-ref-title').textContent === t('tb_seasons')"
            " && !!document.querySelector('#alm-ref #tb-out table')"
        )
    finally:
        page.evaluate("() => { window.fetch = window.__f; }")
    assert not page.errors, page.errors


def _pdf_outline(data):
    """The PDF's outline titles, read off its /Title entries."""
    out = []
    for raw in re.findall(rb"/Title\s*(\((?:[^)\\]|\\.)*\)|<[0-9A-Fa-f]+>)", data):
        out.append(
            bytes.fromhex(raw[1:-1].decode()).decode("utf-16")
            if raw.startswith(b"<")
            else raw[1:-1].decode("latin-1")
        )
    return out


def test_the_whole_book_as_a_pdf_has_parts_chapters_and_page_numbers(page):
    """Eric, 2026-10-05: "Add proper like chapter markings and whatnot to the
    PDF." All the tiles, through the server: a part page each for Tables,
    Calculations and Constants; every tile a numbered chapter, in the PDF's
    outline under its part and in the contents with the page it starts on;
    and Zimi's PDF reader lists the parts and chapters in its contents."""
    if page.evaluate("!!document.getElementById('alm-ref')"):
        page.evaluate("_tbClose()")
    page.click("#alm-subject-chips [data-subj='']")
    page.evaluate("_almBook('print')")
    # The book's own file (the reader may still hold an earlier one).
    page.wait_for_function(
        "() => { const f = document.getElementById('reader-frame'); try { return /almanac\\/pdf\\/[^/]+\\/Almanac/.test(decodeURIComponent(f.contentWindow.location.href))"
        " && f.contentWindow.PDFViewerApplication.pagesCount > 0; } catch (e) { return false; } }",
        timeout=180000,
    )
    try:
        href = page.evaluate(
            "document.getElementById('reader-frame').contentWindow.location.href"
        )
        found = re.search(r"/almanac/pdf/[^&#?]+", unquote(href))
        assert found, href
        pdf_path = unquote(found.group(0))
        data = page.request.get(urljoin(page.url, pdf_path)).body()
        tiles = page.evaluate(
            "() => { const ks = [...ALM_TB_TABLES, ...ALM_TB_CALCS, ...ALM_TB_CONSTS];"
            " return [['table', 'Tables'], ['calc', 'Calculations'], ['const', 'Constants']].map(([k, n], i) =>"
            " [['Part ' + ['I', 'II', 'III'][i] + ' · ' + n], ks.filter((x) => _tbKind(x) === k).map((x, j) => (i + 1) + '.' + (j + 1) + ' ' + t('tb_' + x))]); }"
        )
        want = [x for part in tiles for x in part[0] + part[1]]
        outline = _pdf_outline(data)
        assert b"/Outlines" in data
        # Every part and chapter is a bookmark (their order and nesting are
        # read back below, from the reader's contents).
        # (A part's title joins its two lines with no-break spaces.)
        outline = [x.replace(" ", " ") for x in outline]
        assert set(want + ["Contents"]) <= set(outline), (want, outline)
        # The contents: every chapter, with a page number that is where its
        # heading is.
        if shutil.which("pdftotext"):

            def text(first, last=None):
                return subprocess.run(
                    [
                        "pdftotext",
                        "-layout",
                        "-f",
                        str(first),
                        "-l",
                        str(last or first),
                        "-",
                        "-",
                    ],
                    input=data,
                    capture_output=True,
                    check=True,
                ).stdout.decode()

            def words(s):
                return re.sub(r"\s+", " ", s)

            toc = text(2)
            for part in tiles:
                for ch in part[1]:
                    num, name = ch.split(" ", 1)
                    m = re.search(
                        re.escape(num) + r"\s+" + re.escape(name) + r"\b.*?(\d+)\s*$",
                        toc,
                        re.M,
                    )
                    assert m, (ch, toc)
                    assert words(ch) in words(text(int(m.group(1)))), (ch, m.group(1))
            # A part's own page: its name and its chapters.
            assert "Tables" in text(3) and words(tiles[0][1][0]) in words(
                text(3)
            ), text(3)
        # Zimi's reader: Contents lists the parts, then their chapters.
        fr = page.frame_locator("#reader-frame")
        fr.locator(".zp-toc-btn").click()
        fr.locator(".zp-toc").first.wait_for(timeout=10000)
        listed = page.frame(url=lambda u: "viewer.html" in u).evaluate(
            "() => [...document.querySelector('.zp-toc').querySelectorAll(':scope > li > button')].map((b) => b.textContent.replace(/\u00a0/g, ' '))"
        )
        assert listed == ["Contents"] + [p[0][0] for p in tiles], listed
        nested = page.frame(url=lambda u: "viewer.html" in u).evaluate(
            "() => [...document.querySelector('.zp-toc').querySelectorAll(':scope > li:nth-child(2) > ul > li > button')].map((b) => b.textContent)"
        )
        assert nested == tiles[0][1], nested
    finally:
        page.evaluate("goBack()")
        page.wait_for_function("() => !readerOpen", timeout=10000)
    assert not page.errors, page.errors


def test_a_busy_server_is_asked_once_more_and_a_slow_pdf_says_so(page):
    """The server is drawing someone else's PDF (a 503 naming its wait):
    the icons keep spinning, the page asks once more after the wait, and the
    PDF opens. One still coming after TB_PDF_SLOW_MS says so, quietly, until
    the reader opens."""
    _open(page, "seasons")
    seen = []

    def busy_once(route):
        seen.append(route.request.method)
        if len(seen) == 1:
            route.fulfill(
                status=503,
                headers={"Retry-After": "1", "Content-Type": "application/json"},
                body='{"error": "busy"}',
            )
        else:
            route.continue_()

    page.route("**/almanac/pdf", busy_once)
    page.evaluate("() => { window.__slow = TB_PDF_SLOW_MS; TB_PDF_SLOW_MS = 300; }")
    toast = "[...document.querySelectorAll('body > div')].some((d) => d.textContent === t('tb_pdf_making'))"
    try:
        page.click("[data-tb-act='print']")
        page.wait_for_function("() => " + toast, timeout=5000)
        page.wait_for_timeout(500)
        assert len(seen) == 1 and page.evaluate(
            "document.querySelector('[data-tb-act=print]').classList.contains('alm-busy')"
        )
        page.wait_for_function(PDF_SHOWN, timeout=120000)
        assert len(seen) == 2
        assert not page.evaluate(toast)
        assert page.evaluate("document.querySelectorAll('.alm-busy').length") == 0
        page.evaluate("goBack()")
        page.wait_for_function("() => !readerOpen", timeout=10000)
    finally:
        page.unroute("**/almanac/pdf")
        page.evaluate("() => { TB_PDF_SLOW_MS = window.__slow; }")
    assert not page.errors, page.errors


def test_still_busy_after_the_retry_prints_the_page(page):
    """Busy twice: the toast, then the browser's own dialog over the book."""
    _open(page, "seasons")
    seen = []

    def busy(route):
        seen.append(1)
        route.fulfill(
            status=503,
            headers={"Retry-After": "1", "Content-Type": "application/json"},
            body='{"error": "busy"}',
        )

    page.route("**/almanac/pdf", busy)
    page.evaluate(
        "() => { window.__printed = 0; window.__pr = window.print; window.print = () => { window.__printed++; }; }"
    )
    try:
        page.click("[data-tb-act='print']")
        page.wait_for_function("() => window.__printed === 1", timeout=30000)
        assert len(seen) == 2
        assert page.evaluate(
            "[...document.querySelectorAll('body > div')].some((d) => d.textContent === t('tb_pdf_failed'))"
        )
        page.evaluate("_tbPrintOff()")
    finally:
        page.unroute("**/almanac/pdf")
        page.evaluate("() => { window.print = window.__pr; }")
    assert not page.errors, page.errors


def test_print_falls_back_to_the_page_when_the_pdf_fails(page):
    """No PDF (the server failed): a short toast, then the browser's dialog
    over the book, asked for once it is all there."""
    _open(page, "seasons")
    page.route(
        "**/almanac/pdf",
        lambda route: route.fulfill(status=500, body='{"error": "render failed"}'),
    )
    page.evaluate(
        "() => { window.__printed = 0; window.__pr = window.print; window.__book = 0;"
        " window.print = () => { window.__printed++; window.__book = document.querySelectorAll('#alm-book .tb-book-page').length; }; }"
    )
    try:
        page.click("[data-tb-act='print']")
        page.wait_for_function("() => window.__printed === 1", timeout=60000)
        assert page.evaluate("window.__book") == 1
        assert page.evaluate(
            "[...document.querySelectorAll('body > div')].some((d) => d.textContent === t('tb_pdf_failed'))"
        )
        assert not page.evaluate("readerOpen")
        page.evaluate("_tbPrintOff()")
    finally:
        page.unroute("**/almanac/pdf")
        page.evaluate("() => { window.print = window.__pr; }")
    assert not page.errors, page.errors


def test_no_section_table_icons_the_chips_choose(page):
    """The chips replaced the table icon each section ended with: none is
    left on the page, and a chip still chooses a subject's tiles."""
    page.evaluate("() => { if (document.getElementById('alm-ref')) _tbClose(); }")
    assert page.evaluate("document.querySelectorAll('.alm-subject-link').length") == 0
    page.click("#alm-subject-chips [data-subj='tides']")
    assert page.evaluate(SHOWN) == page.evaluate("ALM_TB_SUBJECTS.tides")
    assert page.evaluate(ACTIVE_CHIP) == "tides"
    page.click("#alm-subject-chips [data-subj='']")
    assert (
        page.evaluate(
            "document.querySelectorAll('#alm-group-tables .alm-tile[hidden]').length"
        )
        == 0
    )
    assert not page.errors, page.errors


def test_equations_open_and_draw_as_mathml(page):
    """A table's Equations: Temml loads only when they are opened, every
    equation is drawn as <math>, a long one scrolls in its own line (the
    page never sideways), and Print draws them too. The tide's lists its
    station's constituents."""
    page.evaluate("() => { if (document.getElementById('alm-ref')) _tbClose(); }")
    _open(page, "suntime")
    page.evaluate("document.querySelector('#tb-how details').open = true")
    page.click("#tb-how details.tb-eqs > summary")
    page.wait_for_function(
        "() => { const e = document.querySelectorAll('#tb-how .tb-eq'); return e.length && [...e].every((x) => x.querySelector('math')); }",
        timeout=20000,
    )
    n = page.evaluate("document.querySelectorAll('#tb-how .tb-eq math').length")
    assert n >= 10, n
    assert page.evaluate("document.querySelectorAll('#tb-how .tb-eq-src').length") == 0
    assert _no_side_scroll(page)
    # Still drawn after the table redraws (another month).
    page.click("[data-tb-step='1']")
    page.wait_for_function(DRAWN, timeout=60000)
    page.wait_for_function(
        "() => document.querySelector('#tb-how details.tb-eqs').open && document.querySelectorAll('#tb-how .tb-eq math').length > 0"
    )
    # The tide's: its station's constituents in a table.
    _open(page, "tides")
    page.evaluate(
        "() => { document.querySelector('#tb-how details').open = true; document.querySelector('#tb-how details.tb-eqs').open = true; }"
    )
    page.wait_for_function(
        "() => document.querySelectorAll('#tb-how .tb-eq math').length > 0",
        timeout=20000,
    )
    rows = page.evaluate(
        "document.querySelectorAll('#tb-how .tb-eq-terms tbody tr').length"
    )
    assert rows >= 5, rows
    assert "M2" in page.inner_text("#tb-how .tb-eq-terms")
    assert not page.errors, page.errors
