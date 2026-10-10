"""The Almanac's deep links, in a browser: what the calendar can print, what the
tables show, and what an unresolved Q-ID looks like.

  - every holiday the calendar can print, in every system and for every country
    pack, is a link or is listed below with the reason it cannot be (so a new
    holiday without a Q-ID fails);
  - a regional holiday keeps its country on the way into the grid, so India's
    Independence Day is India's;
  - with the library answering, each table and constants page shows links, and
    the navigation page links its stars and columns;
  - with the library answering nothing, no table, page or panel shows a link
    (plain text, never a dead link).

The library is faked: /almanac-links answers every Q-ID asked (or none), and no
article is opened.

Run: pytest tests/test_almanac_qids_browser.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_live_sky_browser import GL_ARGS, browser, served  # noqa: E402,F401

PLACE = {"lat": 34.05, "lon": -118.24, "name": "Los Angeles, California, United States"}
POLL_MS = 100

# Holidays the calendar prints that have no article of their own to link, with the reason.
PLAIN_HOLIDAYS = {
    "1st White Night": "an Islamic night with no English Wikipedia article",
    "Aban Festival": "an Iranian month's festival with no article",
    "Azar Festival": "an Iranian month's festival with no article",
    "Constitution Day|ES": "English Wikipedia has only the list of Spain's public holidays",
    "Constitution Day|MX": "English Wikipedia has only the list of Mexico's public holidays",
    "International Mountain Day": "the title redirects to Japan's Mountain Day, a different day",
    "Mahayana NY": "the Mahayana new year has no article of its own",
    "Meatfare Sunday": "no English Wikipedia article",
    "New Year's": "the Buddhist new year, too general to name one article",
    "Paramony": "the title redirects to Christmas Eve, a different feast",
    "Po Wu": "no English Wikipedia article",
    "World Photography Day": "no English Wikipedia article",
    "World Science Day": "the title redirects to UNESCO, not to the day",
    "Xiayuan Fest.": "no English Wikipedia article",
}

ENUMERATE_HOLIDAYS = """() => {
  sessionStorage.setItem('zimi_almanac_holiday_scope', 'worldwide');
  const seen = {};
  for (const sys of _CAL_SYSTEMS) {
    for (let gy = 2024; gy <= 2030; gy++) {
      for (let gm = 1; gm <= 12; gm++) {
        const c = _jdnToCalendar(sys, _gregorianToJDN(gy, gm, 15));
        const ev = _getAlmanacEvents(sys, c.year, c.month);
        for (const d in ev) for (const e of ev[d]) {
          if (e.type !== 'holiday') continue;
          const raw = _th(e.label), n = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
          const M = AlmanacLinks.MAP;
          const rk = e.region ? 'holiday:' + n + '_' + e.region.toLowerCase() : null;
          const key = (rk && M[rk]) ? rk : (M['holiday:' + n] ? 'holiday:' + n : null);
          seen[e.label + '|' + e.region] = { label: e.label, region: e.region, key: key, sys: sys };
        }
      }
    }
  }
  return Object.values(seen);
}"""


def _page(browser, served, resolve=True):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, service_workers="block"
    )
    ctx.add_init_script(
        "localStorage.setItem('zimi_almanac_place', %s);"
        % json.dumps(json.dumps(PLACE))
    )
    pg = ctx.new_page()

    def links(route):
        qids = json.loads(route.request.post_data)["qids"]
        got = (
            {
                q: {"zim": "wikipedia_en_all_maxi", "path": "A/" + q, "title": q}
                for q in qids
            }
            if resolve
            else {}
        )
        route.fulfill(json={"links": got})

    pg.route("**/almanac-links", links)
    pg.goto(served + "/#almanac", wait_until="load")
    pg.wait_for_function(
        "() => typeof _almRefOpen === 'function' && window.AlmanacLinks",
        polling=POLL_MS,
        timeout=60000,
    )
    pg.evaluate(
        "() => { zimsCache = [{ name: 'wikipedia_en_all_maxi' }]; AlmanacLinks.reset(); }"
    )
    (
        pg.wait_for_function(
            "(want) => (document.querySelectorAll('.alm-link').length > 0) === want",
            arg=resolve,
            polling=POLL_MS,
            timeout=30000,
        )
        if resolve
        else pg.wait_for_timeout(1500)
    )
    return ctx, pg


def test_every_holiday_the_calendar_prints_links_or_says_why_not(browser, served):
    ctx, pg = _page(browser, served)
    try:
        rows = pg.evaluate(ENUMERATE_HOLIDAYS)
        assert len(rows) > 250, len(rows)
        loose = []
        for r in rows:
            plain = r["label"] + (
                "|" + r["region"] if r["region"] in ("ES", "MX") else ""
            )
            if (
                not r["key"]
                and plain not in PLAIN_HOLIDAYS
                and r["label"] not in PLAIN_HOLIDAYS
            ):
                loose.append("%s [%s] in %s" % (r["label"], r["region"], r["sys"]))
        assert not loose, loose
        # The reasons list holds nothing that now links or has gone.
        labels = {r["label"] + "|" + r["region"] for r in rows} | {
            r["label"] for r in rows
        }
        stale = [k for k in PLAIN_HOLIDAYS if k not in labels]
        assert not stale, stale
        linked = {
            k
            for k in PLAIN_HOLIDAYS
            if any(
                r["key"]
                for r in rows
                if r["label"] == k.split("|")[0]
                and (("|" not in k) or r["region"] == k.split("|")[1])
            )
        }
        assert not linked, linked
    finally:
        ctx.close()


def test_a_regional_holiday_keeps_its_country(browser, served):
    ctx, pg = _page(browser, served)
    try:
        got = pg.evaluate("""() => {
          sessionStorage.setItem('zimi_almanac_holiday_scope', 'worldwide');
          const out = {};
          for (const sys of ['gregorian', 'julian']) {
            const c = _jdnToCalendar(sys, _gregorianToJDN(2026, 8, 15));
            const ev = _getAlmanacEvents(sys, c.year, c.month);
            for (const d in ev) for (const e of ev[d]) if (e.label === 'Independence Day') out[sys + ':' + e.region] = e.src;
          }
          return out;
        }""")
        # August 15th: India's day, tagged with India, on both grids.
        assert "gregorian:IN" in got and "julian:IN" in got, got
        assert pg.evaluate(
            "() => AlmanacLinks.wrapHoliday('Independence Day', 'Independence Day', 'IN') !== 'Independence Day'"
        )
        assert pg.evaluate(
            "() => AlmanacLinks.MAP['holiday:independenceday_in'].q !== AlmanacLinks.MAP['holiday:independenceday_us'].q"
        )
    finally:
        ctx.close()


TABLES = [
    "sunmoon",
    "twilight",
    "phases",
    "seasons",
    "calendars",
    "nav",
    "stars",
    "eclipses",
    "suntime",
]
CONSTS = ["k_earth", "k_sunmoon", "k_time", "k_nav", "k_physics"]


def _open_tile(pg, tile, links=True):
    """Open a tile and wait for its table to be drawn: with a library answering, a
    link is on the sheet; with none, long enough that one would be."""
    pg.evaluate("(id) => _almRefOpen(id)", tile)
    pg.wait_for_function(
        "(id) => window._tb && _tb.id === id && document.querySelector('#tb-body') && document.querySelector('#tb-body').children.length",
        arg=tile, polling=POLL_MS, timeout=60000)
    if links:
        try:
            pg.wait_for_function("() => document.querySelectorAll('#alm-ref .alm-link').length > 0", polling=POLL_MS, timeout=40000)
        except Exception:
            pass   # counted as none by the caller, with the tile named
    else:
        pg.wait_for_timeout(2500)


def test_the_tables_link_what_they_name(browser, served):
    ctx, pg = _page(browser, served)
    try:
        counts = {}
        for tile in TABLES + CONSTS:
            _open_tile(pg, tile)
            counts[tile] = pg.evaluate(
                "() => document.querySelectorAll('#alm-ref .alm-link').length"
            )
        empty = [t for t, n in counts.items() if n == 0]
        assert not empty, (empty, counts)
        # The navigation page: its stars by name, its columns by their terms.
        _open_tile(pg, "nav")
        got = pg.evaluate("""() => {
          const keys = new Set([...document.querySelectorAll('#alm-ref .alm-link')].map((e) => e.dataset.almKey));
          return [...keys];
        }""")
        for k in (
            "star:sirius",
            "star:alpheratz",
            "star:al_na_ir",
            "star:polaris",
            "term:hour_angle",
            "term:declination",
            "term:first_point_of_aries",
            "planet:sun",
            "planet:moon",
            "planet:venus",
            "term:utc",
        ):
            assert k in got, (k, got)
        # Not one of them leaves the sheet in a dead state: each key is in the closed set.
        known = pg.evaluate("(keys) => keys.filter((k) => !AlmanacLinks.MAP[k])", got)
        assert not known, known
        # A constants page: names and the bodies it cites.
        _open_tile(pg, "k_physics")
        got = pg.evaluate(
            "() => [...new Set([...document.querySelectorAll('#alm-ref .alm-link')].map((e) => e.dataset.almKey))]"
        )
        for k in (
            "term:speed_of_light",
            "term:gravitational_constant",
            "org:codata",
            "org:si",
            "org:icao",
        ):
            assert k in got, (k, got)
    finally:
        ctx.close()


def test_with_nothing_resolved_nothing_is_a_link(browser, served):
    ctx, pg = _page(browser, served, resolve=False)
    try:
        assert pg.evaluate("() => document.querySelectorAll('.alm-link').length") == 0
        for tile in TABLES + CONSTS:
            _open_tile(pg, tile, links=False)
            assert (
                pg.evaluate(
                    "() => document.querySelectorAll('#alm-ref .alm-link').length"
                )
                == 0
            ), tile
    finally:
        ctx.close()
