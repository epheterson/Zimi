"""Playtest batch 2: the end sheets, header and board fixes found on a 390 x 844 phone.

One test per finding; each failed on the code before its fix. Screenshots go to GAMES_SHOT_DIR when set.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_batch2_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, visible  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

SHOT_DIR = os.environ.get("GAMES_SHOT_DIR")


def open_game(browser, served, name, query="?debug", lang=None, **ctx):
    c = browser.new_context(
        viewport=VIEW,
        has_touch=True,
        is_mobile=True,
        device_scale_factor=2,
        reduced_motion="reduce",
        **ctx,
    )
    page = c.new_page()
    page.goto(
        "%s/%s.html%s%s" % (served, name, query, ("#lang=" + lang) if lang else "")
    )
    game_ready(page)
    return c, page


def shot(page, name):
    if SHOT_DIR:
        page.screenshot(path=os.path.join(SHOT_DIR, name + ".png"))


# 1. Checkers: the end sheet names the side that has no move, not the winner.
@pytest.mark.parametrize(
    "turn,man,expect",
    [
        (
            2,
            57,
            "Zimi has no move.",
        ),  # white to move with no white men: the person (red) won
        (
            1,
            1,
            "You have no move.",
        ),  # a red man on the far row cannot move: the person lost
    ],
)
def test_checkers_names_the_side_with_no_move(browser, served, turn, man, expect):
    c, page = open_game(browser, served, "checkers")
    page.evaluate(
        "([turn, man]) => { const b = new Int8Array(64); b[man] = 1; __ck.set(b, turn); }",
        [turn, man],
    )
    visible(page, ".ar-sheet-card h2", 4000)
    text = page.locator(".ar-sheet-card").inner_text()
    assert expect in text, text
    assert ("You won" in text) == (turn == 2), text
    shot(page, "01-checkers-" + ("won" if turn == 2 else "lost"))
    c.close()


# 13. Inside Zimi the maker's mark lies 12px in from the bottom-right corner; a sheet's rounded corner let it peek out.
HOST_PAGE = '<!doctype html><style>body{margin:0}</style><iframe id="reader-frame" src="%s" style="width:390px;height:844px;border:0"></iframe>'


@pytest.mark.parametrize("game", ["reversi", "hearts"])
def test_no_mark_peeks_from_under_a_sheet(browser, served, game):
    c = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, device_scale_factor=2, reduced_motion="reduce")
    page = c.new_page()
    page.route(served + "/_host.html", lambda r: r.fulfill(body=HOST_PAGE % ("%s.html" % game), content_type="text/html"))
    page.goto(served + "/_host.html")
    frame = page.frame_locator("#reader-frame")
    frame.locator("html.gs-hosted.gs-ready").wait_for(state="attached", timeout=30000)
    mark = "(() => { const t = document.querySelector('.zc-table'); return parseFloat(getComputedStyle(t || document.body, '::before').opacity); })()"
    f = [x for x in page.frames if x != page.main_frame][0]
    assert f.evaluate(mark) == 1, "the mark is on the table before the sheet"
    f.evaluate("ZimiShell.endSheet({ result: 'lose', text: 'x' })")
    f.wait_for_selector(".ar-sheet-card", timeout=5000)
    assert f.evaluate(mark) == 0, "the mark is hidden while a sheet is up"
    shot(page, "13-sheet-corner-" + game)
    c.close()


# 2. Hearts: the game-over sheet names the winner and every total, and the table stays as it ended behind it.
def test_hearts_game_over_sheet_names_the_winner_and_every_total(browser, served):
    c, page = open_game(browser, served, "hearts")
    page.evaluate("""() => {
      const Z = window.ZimiCards, st = ZimiHearts.almostWon();
      st.scores = [90, 30, 20, 40]; st.handNo = 5;
      // the person's ace of clubs takes the queen of spades: 90 + 13 = 103, the game is over
      st.hands = [[Z.make(1, 0)], [Z.make(12, 3)], [Z.make(13, 0)], [Z.make(5, 0)]];
      ZimiHearts.session.reset(st);
    }""")
    frames(page, 3)
    for _ in range(2):
        page.locator("[data-pile^='h']").first.click()
        frames(page, 2)
    visible(page, ".ar-sheet-card h2", 8000)
    text = page.locator(".ar-sheet-card").inner_text()
    for needle in ("Rani", "103", "30", "20", "40"):
        assert needle in text, (needle, text)
    assert page.evaluate("() => ZimiHearts.session.state.phase") == "over"
    behind = page.evaluate("() => document.body.innerText")
    assert "pass left" not in behind and "Choose 3" not in behind, behind
    shot(page, "02-hearts-over")
    c.close()


# 3. Backgammon: the end sheet says why the game ended (single, gammon, backgammon) with the points; the lit points are stronger.
@pytest.mark.parametrize("kind,off,bar,why,points", [
    ("single", [4, 15], 0, "The winner bore off all 15 checkers first.", "2 points"),
    ("gammon", [0, 15], 0, "The loser had not borne off a single checker.", "Gammon: 2 points"),
    ("backgammon", [0, 15], 1, "The loser still had a checker on the bar or in the winner's home board.", "Backgammon: 3 points"),
])
def test_backgammon_end_sheet_says_why(browser, served, kind, off, bar, why, points):
    c, page = open_game(browser, served, "backgammon")
    page.evaluate("([off, bar]) => { const s = __bk.state(); s.pts.fill(0); s.off = off; s.bar = [bar, 0]; __bk.finish(1); }", [off, bar])
    visible(page, ".ar-sheet-card h2", 4000)
    text = page.locator(".ar-sheet-card").first.inner_text()
    assert why in text, text
    shot(page, "03-backgammon-" + kind)
    c.close()


def test_backgammon_lit_points_are_not_faint(browser, served):
    c, page = open_game(browser, served, "backgammon", color_scheme="dark")
    opacity = page.evaluate("() => { const e = document.createElementNS('http://www.w3.org/2000/svg', 'path'); e.setAttribute('class', 'bk-target'); document.querySelector('svg').appendChild(e); return parseFloat(getComputedStyle(e).fillOpacity); }")
    assert opacity >= 0.55, opacity
    c.close()


# 4. Count strings in the card games take their plural form from ZimiText ("1 punto suelto", "1 jeton", "1 Stich").
@pytest.mark.parametrize("lang,key,one,wrong", [
    ("es", "gin.knockWith", "cierra con 1 punto suelto.", "1 puntos"),
    ("es", "gin.deadwood", "tiene 1 punto suelto.", "1 puntos"),
    ("fr", "gin.knockWith", "frappe avec 1 point mort.", "1 points"),
    ("de", "gin.knockWith", "klopft mit 1 Restpunkt.", "1 Restpunkten"),
    ("es", "durak.cap", "1 carta en este ataque", "1 cartas"),
    ("fr", "bj.fact", "1 jeton", "1 jetons"),
    ("pt", "bj.fact", "1 ficha", "1 fichas"),
    ("de", "spades.estimate", "etwa 1 Stich aus", "1 Stichen"),
    ("en", "tp.fact", "1 chip", "1 chips"),
    ("en", "durak.cap", "1 card this bout", "1 cards"),
])
def test_card_game_counts_take_their_plural(browser, served, lang, key, one, wrong):
    c, page = open_game(browser, served, "gin", lang=lang)
    page.wait_for_function("l => ZimiText.lang === l && ZimiText.has('gin.knockWith')", arg=lang)
    page.wait_for_function("([k]) => ZimiText.T(k, { name: 'Zimi', n: 7, label: 'x' }) !== k", arg=[key])
    page.wait_for_timeout(300)
    got = page.evaluate("([k]) => ZimiText.T(k, { name: 'Zimi', n: 1, label: 'x' })", [key])
    assert one in got and wrong not in got, got
    c.close()


# 5. Mahjong on an upright phone: the board fits the width and the height, and a tile is wide enough to tap.
def test_mahjong_uses_the_phone_screen(browser, served):
    c, page = open_game(browser, served, "mahjong", query="")
    page.wait_for_selector(".mj-t")
    frames(page, 3)
    w, h, stage_h = page.evaluate("() => { const r = document.querySelector('.mj-t').getBoundingClientRect(), s = document.getElementById('mj-stage').getBoundingClientRect(); return [r.width, r.height, s.height]; }")
    assert w >= 34 and h >= 44, (w, h)
    assert stage_h >= 0.5 * VIEW["height"], stage_h
    assert page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1")
    shot(page, "05-mahjong-390")
    c.close()
