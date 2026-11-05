"""The shelf and the boards after the 1.15.3 design pass.

The shelf has one "today": Game of the day leads the Daily row as its first, larger tile, not a section of its own. Every
section header follows one rule. The type chip that means "no choice" (All types) stays quiet when pressed. A sheet whose
only action is Close closes from a quiet x beside its title. On the boards a daily left unsolved is the quiet row, the
viewer's row says "(you)", and no coloured squares repeat what the time column says.

Run: pytest tests/test_games_design_pass_browser.py -v
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_games_daily_browser import browser, site  # noqa: E402,F401


def _shelf(browser, site, scheme="light"):  # noqa: F811
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        color_scheme=scheme,
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
    )
    page = ctx.new_page()
    page.goto(site + "index.html")
    page.wait_for_selector(".ar-daily a.ar-game", state="attached")
    return ctx, page


def test_game_of_the_day_is_a_wider_tile_in_the_daily_row_not_a_section_of_its_own(
    site, browser
):  # noqa: F811
    ctx, page = _shelf(browser, site)
    got = page.evaluate("""() => {
      const f = document.querySelector('.ar-daily a.ar-feature'), small = document.querySelector('.ar-daily a.ar-game:not(.ar-feature)');
      return { today: document.querySelectorAll('.ar-today').length, tag: (f.querySelector('.ar-feature-tag') || {}).textContent || '',
               line: document.querySelector('.ar-daily-line').textContent,
               wide: f.getBoundingClientRect().width, next: small.getBoundingClientRect().width };
    }""")
    assert got["today"] == 0, got
    assert got["tag"] == "Game of the day", got
    assert got["wide"] > got["next"] * 1.6, got
    assert got["line"] == "Done today: 0 of 7", got  # the seven everyday dailies, not "0 of 63"
    ctx.close()


def test_every_section_header_follows_one_rule_and_all_types_is_quiet(
    site, browser
):  # noqa: F811
    for scheme in ("light", "dark"):
        ctx, page = _shelf(browser, site, scheme)
        got = page.evaluate("""() => {
          const css = (e) => { const s = getComputedStyle(e); return [s.fontSize, s.fontWeight, s.color, s.letterSpacing].join(' '); };
          const heads = ['.ar-continue > h2', '.ar-daily > h2', '.sh-list > .ar-section > h2'].map(q => document.querySelector(q)).filter(Boolean);
          const all = document.querySelector('.sh-chip-all'), other = document.querySelector('.sh-chip:not(.sh-chip-all):not([hidden])');
          return { heads: heads.map(css), n: heads.length, pressed: all.getAttribute('aria-pressed'),
                   allBg: getComputedStyle(all).backgroundColor, otherBg: getComputedStyle(other).backgroundColor };
        }""")
        assert got["n"] == 3 and len(set(got["heads"])) == 1, got
        assert got["pressed"] == "true" and got["allBg"] == got["otherBg"], got
        ctx.close()


def test_a_sheet_that_only_closes_has_a_quiet_x_and_no_action_row(
    site, browser
):  # noqa: F811
    ctx, page = _shelf(browser, site)
    page.click(".ar-daily-stats")
    page.wait_for_selector(".ar-sheet-card")
    got = page.evaluate(
        """() => { const c = document.querySelector('.ar-sheet-card');
      return { x: !!c.querySelector('.ar-sheet-head .gs-x'), row: !!c.querySelector('.ar-sheet-actions'),
               marks: [...c.querySelectorAll('.gs-earned li > span:first-child')].map(s => s.textContent) }; }"""
    )
    assert got["x"] and not got["row"], got
    assert got["marks"] and set(got["marks"]) == {
        "–"
    }, got  # nothing earned yet: a muted dash, never a hollow circle
    page.click(".ar-sheet-head .gs-x")
    assert page.locator(".ar-sheet").count() == 0
    ctx.close()


BOARD = {
    "runs": [
        {"name": "Mum", "r": "win", "ms": 65000},
        {"name": "kid", "r": "lose", "you": True},
    ],
    "best": [],
    "you": {"name": "kid", "on": True},
}


def test_the_daily_board_marks_you_in_words_and_keeps_an_unsolved_row_quiet(
    site, browser
):  # noqa: F811
    ctx, page = _shelf(browser, site)
    page.route(
        "**/games/board?*",
        lambda r: r.fulfill(
            status=200, content_type="application/json", body=json.dumps(BOARD)
        ),
    )
    page.evaluate("ZimiShell.boardSheet('sudoku.html')")
    page.wait_for_selector(".gs-board-row")
    rows = page.evaluate(
        """() => [...document.querySelectorAll('.gs-board-row')].map(r => ({ text: r.textContent,
      quiet: r.classList.contains('gs-board-quiet'), weight: getComputedStyle(r.querySelector('.gs-board-val')).fontWeight }))"""
    )
    assert "(you)" in rows[1]["text"] and "(you)" not in rows[0]["text"], rows
    assert (
        rows[1]["quiet"]
        and int(rows[1]["weight"]) < 500
        and int(rows[0]["weight"]) >= 600
    ), rows
    assert not any(sq in r["text"] for r in rows for sq in "🟩🟥🟨⬜"), rows
    ctx.close()


def test_an_empty_daily_board_says_so_plainly(site, browser):  # noqa: F811
    ctx, page = _shelf(browser, site)
    body = dict(BOARD, runs=[])
    page.route(
        "**/games/board?*",
        lambda r: r.fulfill(
            status=200, content_type="application/json", body=json.dumps(body)
        ),
    )
    page.evaluate("ZimiShell.boardSheet('sudoku.html')")
    page.wait_for_selector(".ar-sheet-card .gs-text")
    assert "No one here has played today's daily yet." in page.inner_text(
        ".ar-sheet-card"
    )
    ctx.close()


EVERYDAY = ["fiveletters.html", "sudoku.html", "minicrossword.html", "chesspuzzles.html", "spellingbee.html", "minesweeper.html", "solitaire.html"]


def test_the_everyday_dailies_lead_and_the_rest_follow_as_more(site, browser):  # noqa: F811
    """Eric, twice: the normal dailies first. Five Letters, Sudoku, Mini crossword, Chess puzzle, Spelling Bee,
    Minesweeper, Solitaire, in that order, then a quiet "More dailies"; Game of the day leads that second group (or,
    when it is one of the seven, is that tile, wider, in its place)."""
    ctx, page = _shelf(browser, site)
    got = page.evaluate("""() => {
      const row = [...document.querySelectorAll('.ar-daily .ar-games > *')];
      const path = (a) => a.getAttribute('href').split('?')[0];
      const sep = row.findIndex(e => e.classList.contains('ar-daily-sep'));
      const f = document.querySelector('.ar-daily a.ar-feature');
      return { main: row.slice(0, sep).map(path), afterSep: path(row[sep + 1]), feature: path(f),
               featureMain: f.classList.contains('ar-daily-main'), after: row.length - sep - 1,
               sep: row[sep].textContent, chessHref: (document.querySelector('.ar-daily a[href^="chesspuzzles.html"]') || {}).href || '' };
    }""")
    assert got["main"] == EVERYDAY, got
    assert got["sep"] == "More dailies" and got["after"] > 10, got
    if not got["featureMain"]:
        assert got["afterSep"] == got["feature"], got   # it leads the second group
    assert "?daily=" in got["chessHref"], got
    ctx.close()


def test_game_of_the_day_that_is_an_everyday_daily_stays_in_its_place(site, browser):  # noqa: F811
    """A day whose pick is one of the seven: that tile is the wider one, in its own place, and is not shown twice."""
    ctx, page = _shelf(browser, site)
    day = page.evaluate("""async (want) => {
      const rows = await (await fetch('games.json')).json(), R = window.ZimiRecent, d = new Date(Date.UTC(2026, 10, 1));
      for (let i = 0; i < 2000; i++, d.setUTCDate(d.getUTCDate() + 1)) {
        const day = d.toISOString().slice(0, 10), g = R.dayPick(rows, day);
        if (g && want.includes(g.path)) return [day, g.path];
      }
      return null;
    }""", EVERYDAY)
    ctx.close()
    assert day, "no day in 2000 picks one of the seven"
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    # The server's day is the one the shelf goes by: answer it with that day.
    page.route("**/games-day*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"day": day[0]})))
    page.goto(site + "index.html")
    page.wait_for_selector(".ar-daily a.ar-feature", state="attached")
    got = page.evaluate("""() => { const row = [...document.querySelectorAll('.ar-daily .ar-games > *')], sep = row.findIndex(e => e.classList.contains('ar-daily-sep'));
      return { main: row.slice(0, sep).map(a => [a.getAttribute('href').split('?')[0], a.classList.contains('ar-feature')]),
               copies: [...document.querySelectorAll('.ar-daily a.ar-game')].filter(a => a.getAttribute('href').split('?')[0] === %r).length }; }""" % day[1])
    assert [p for p, _ in got["main"]] == EVERYDAY, got
    assert [p for p, f in got["main"] if f] == [day[1]] and got["copies"] == 1, got
    ctx.close()
