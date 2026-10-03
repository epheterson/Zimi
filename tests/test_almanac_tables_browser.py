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
import sys
import threading

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
    page.evaluate("_tbPrintOn()")
    assert page.evaluate("document.querySelector('#tb-how details').open")
    page.evaluate("_tbPrintOff()")
    assert not page.evaluate("document.querySelector('#tb-how details').open")


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
    # Print: the rules that make the view the page, and its heading for paper.
    assert page.evaluate(
        "document.querySelector('#tb-print-head .tb-printhead h1') !== null"
    )
    page.emulate_media(media="print")
    page.evaluate("document.documentElement.classList.add('alm-ref-print')")
    shown = page.evaluate(
        "() => [getComputedStyle(document.querySelector('.tb-printhead')).display,"
        " getComputedStyle(document.querySelector('.tb-head')).display,"
        " getComputedStyle(document.querySelector('.tb-controls')).display]"
    )
    page.evaluate("document.documentElement.classList.remove('alm-ref-print')")
    page.emulate_media(media="screen")
    assert shown == ["block", "none", "none"], shown
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
        "() => { window.__p = window.print; window.print = () => { window.__printed = document.documentElement.classList.contains('alm-ref-print'); }; }"
    )
    page.click("[data-tb-print]")
    assert page.evaluate("window.__printed") is True
    page.evaluate(
        "() => { window.print = window.__p; window.dispatchEvent(new Event('afterprint')); }"
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
        "!!document.querySelector('.tb-bar [data-tb-share]') && !document.querySelector('.tb-bar [data-tb-reset]')"
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


def test_share_sends_markdown_or_copies_it(page):
    _open(page, "days")
    page.evaluate(
        "() => { window.__shared = null; window.__copied = null;"
        " navigator.share = (d) => { window.__shared = d; return Promise.resolve(); };"
        " window.__ct = _copyText; _copyText = (s) => { window.__copied = s; }; }"
    )
    page.click("[data-tb-share]")
    shared = page.evaluate("window.__shared")
    assert shared and shared["text"].startswith("# ") and shared["title"], shared
    # No share sheet: onto the clipboard ("Copied").
    page.evaluate(
        "() => { delete navigator.share; Navigator.prototype.share = undefined; }"
    )
    page.click("[data-tb-share]")
    assert page.evaluate("window.__copied") == shared["text"]
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


def test_a_sections_own_tiles_and_back_to_it(page):
    """Tides' table icon opens the tiles with the Tides chip chosen, another
    chip filters from there, and Back returns to the tide section with every
    tile again."""
    page.evaluate("() => { if (document.getElementById('alm-ref')) _tbClose(); }")
    link = page.locator("#almanac-place + .alm-subject-link")
    link.scroll_into_view_if_needed()
    # An icon, named for what it opens.
    icon = page.evaluate(
        "() => { const b = document.querySelector('#almanac-place + .alm-subject-link'), r = b.getBoundingClientRect();"
        " return { label: b.getAttribute('aria-label'), title: b.title, text: b.textContent.trim(), svg: !!b.querySelector('svg'),"
        " w: r.width, h: r.height, right: innerWidth - r.right }; }"
    )
    assert (
        icon["label"] == "Tables, calculations, constants"
        and icon["title"] == icon["label"]
    ), icon
    assert icon["svg"] and not icon["text"], icon
    assert 32 <= icon["w"] <= 44 and 32 <= icon["h"] <= 44, icon
    assert icon["right"] < 40, icon  # at the section's trailing edge
    link.click()
    assert page.evaluate(SHOWN) == page.evaluate("ALM_TB_SUBJECTS.tides")
    assert page.evaluate(ACTIVE_CHIP) == "tides"
    page.click("#alm-subject-chips [data-subj='']")
    assert page.evaluate(
        "document.querySelectorAll('#alm-group-tables .alm-tile:not([hidden])').length"
    ) == len(TABLES + CALCS + CONSTS)
    page.click("#alm-subject-chips [data-subj='eclipses']")
    assert sorted(page.evaluate(SHOWN)) == sorted(
        page.evaluate("ALM_TB_SUBJECTS.eclipses")
    )
    page.go_back()
    page.wait_for_function(
        "() => document.querySelector('#alm-subject-chips .pill.active').dataset.subj === ''"
    )
    assert page.evaluate("_almanacOpen")
    assert (
        page.evaluate(
            "document.querySelectorAll('#alm-group-tables .alm-tile[hidden]').length"
        )
        == 0
    )
    top = page.evaluate(
        "document.getElementById('almanac-place').getBoundingClientRect().top"
    )
    assert -900 < top < 900, top
    assert not page.errors, page.errors
