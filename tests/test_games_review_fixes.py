"""Behaviour fixed after CodeRabbit's review of the arcade games (1.15.0): each test fails on the code before the fix.

Run: pytest tests/test_games_review_fixes.py -v
Set ZIMI_GAMES_DIR to run the same tests against another copy of the games folder (to prove them against older code).
"""

import functools
import http.server
import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, truthy  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.environ.get("ZIMI_GAMES_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")
VIEW = {"width": 390, "height": 844}


@pytest.fixture(scope="module")
def served():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        for kind in (p.chromium, p.webkit):
            try:
                b = kind.launch()
            except Exception:
                continue
            yield b
            b.close()
            return
        pytest.skip("no browser installed")


@pytest.fixture
def open_game(served, browser):
    ctxs = []

    def go(name, query=""):
        ctx = browser.new_context(viewport=VIEW)
        ctxs.append(ctx)
        page = ctx.new_page()
        page.errors = []
        page.on("pageerror", lambda e: page.errors.append(str(e)))
        page.url_of = "%s/%s.html%s" % (served, name, query)
        page.goto(page.url_of)
        return page

    yield go
    for c in ctxs:
        c.close()


def test_snake_draws_a_full_board_without_throwing(open_game):
    """With no food left (the board is full) draw() read a shadowed `fx` and threw, so the win never finished."""
    page = open_game("snake")
    game_ready(page, "__snake.g")
    page.keyboard.press("ArrowRight")
    page.wait_for_function(truthy("__snake.mode === 'playing'"))
    page.evaluate("__snake.g.food = null")
    frames(page, 5)
    assert not page.errors, page.errors


def test_2048_two_quick_moves_leave_the_board_matching_the_tiles(open_game):
    page = open_game("2048")
    game_ready(page, "__t2048.g")
    for key in ("ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"):
        page.evaluate("k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))", key)
    page.wait_for_timeout(400)   # past the slide: the pending tiles have arrived
    shown = page.evaluate("[...document.querySelectorAll('.tf-tile')].map(t => [Number(t.dataset.at), t.textContent]).sort((a, b) => a[0] - b[0])")
    cells = page.evaluate("__t2048.g.cells.map((c, i) => c && [i, String(c.v)]).filter(Boolean)")
    assert shown == cells


def test_a_replayed_sokoban_solution_is_not_the_players_best(open_game):
    page = open_game("sokoban")
    game_ready(page, "window.__sk")
    page.evaluate("document.getElementById('sk-solution').click()")
    page.wait_for_function(truthy("__sk.won()"), timeout=60000)
    frames(page, 3)
    kept = page.evaluate("localStorage.getItem('zimi.games.sokoban')")
    assert not (json.loads(kept).get("best") if kept else None), kept


def test_a_matched_memory_card_keeps_the_arrow_keys_working(open_game):
    page = open_game("memory")
    game_ready(page, "__memory.g")
    ids = page.evaluate("__memory.g.cards.map(c => c.id)")
    first = ids[0]
    other = ids.index(first, 1)
    cards = page.locator(".mm-card")
    cards.nth(0).click()
    cards.nth(other).click()
    frames(page, 3)
    page.keyboard.press("ArrowRight")
    assert page.evaluate("document.activeElement.classList.contains('mm-card')")


def test_changing_the_mode_in_the_menu_mid_race_does_not_change_the_race(open_game):
    page = open_game("kart")
    game_ready(page, "__kart.g")
    page.evaluate("document.querySelector('.ar-sheet-actions .gs-primary').click()")
    page.wait_for_function(truthy("__kart.g.race"))
    page.evaluate("__kart.prefs.mode = 'trial'")   # what the in-game Menu does when Mode is changed
    page.evaluate("__kart.g.race.over = true")
    page.wait_for_function(truthy("__kart.g.mode === 'result'"))
    page.wait_for_function(truthy("document.querySelector('.ar-sheet:not([hidden]) h2')"))
    assert "Race 1 of 3" in page.evaluate("document.querySelector('.ar-sheet:not([hidden]) h2').textContent")
    assert not page.errors, page.errors
    assert not page.evaluate("Object.keys(__kart.prefs.best || {}).length"), "no record from a race that was not a trial"


def test_roadrush_checkpoints_passed_stay_passed_after_a_reload(open_game):
    page = open_game("roadrush")
    game_ready(page, "__roadrush.game")
    page.evaluate("__roadrush.begin()")
    page.wait_for_function(truthy("__roadrush.mode === 'playing' || __roadrush.mode === 'countdown'"))
    page.evaluate("""(() => { const g = __roadrush.game, cp = g.road.checkpoints[0];
      cp.hit = true; g.player.pos = cp.index * __roadrush.E.SEG + 50; g.time = 40; })()""")
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    page.goto("about:blank")
    page.goto(page.url_of)
    game_ready(page, "__roadrush.game && __roadrush.mode === 'paused'")
    assert page.evaluate("__roadrush.game.road.checkpoints.map(c => c.hit)") == [True, False]


def test_pet_tabs_keep_the_focus_between_ticks(open_game):
    page = open_game("pet")
    game_ready(page, "__pet.pet")
    page.evaluate("document.querySelector('#pt-tabs button').focus()")
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    page.wait_for_timeout(2500)   # the clock ticks hud() every second
    assert page.evaluate("document.activeElement.parentElement && document.activeElement.parentElement.id") == "pt-tabs"


def test_minesweeper_ignores_keys_after_the_game_ends(open_game):
    page = open_game("minesweeper", "?debug")
    game_ready(page, "window.__msLose")
    page.evaluate("window.__ends = 0; const o = ZimiShell.endSheet; ZimiShell.endSheet = function () { window.__ends++; return o.apply(this, arguments); }; 0")
    page.evaluate("__msLose()")
    page.wait_for_function(truthy("__ms.game().status === 'lost'"))
    before = page.evaluate("document.getElementById('ms-time').textContent")
    page.wait_for_function(truthy("document.querySelector('.ar-sheet:not([hidden])')"))   # the end sheet
    page.get_by_role("button", name="Close").first.click()   # the board is left finished, with the keys live again
    page.wait_for_function(truthy("!document.querySelector('.ar-sheet:not([hidden])')"))
    for key in ("ArrowRight", "ArrowRight", "Space", "Enter", "c"):
        page.keyboard.press(key)
    page.wait_for_timeout(300)
    assert page.evaluate("document.getElementById('ms-time').textContent") == before
    assert page.evaluate("window.__ends") == 1, "the end sheet opens once"
    assert not page.errors, page.errors


def test_a_waiting_shogi_hand_keeps_its_counts(open_game):
    """The side not to move has its pieces disabled; their counts stay visible, and only an empty slot fades."""
    page = open_game("shogi")
    game_ready(page, "document.getElementById('sg-hand-top')")
    seen = page.evaluate("""(() => {
      const box = document.getElementById('sg-hand-top');
      const mk = (cls, n) => { const b = document.createElement('button'); b.className = 'sg-h' + cls; b.disabled = true; b.innerHTML = '<b>' + n + '</b>'; box.appendChild(b); return getComputedStyle(b.querySelector('b')).visibility; };
      return [mk('', 2), mk(' empty', 0)];
    })()""")
    assert seen == ["visible", "hidden"], seen


def test_go_problems_reply_does_not_outlive_a_restart(open_game):
    page = open_game("goproblems", "?debug")
    game_ready(page, "window.__gp")
    fresh = page.evaluate("""(() => {
      const gp = __gp, i = gp.problems.indexOf(gp.problem()), board = document.getElementById('gp-board');
      for (let p = 0; p < 400 && !gp.thinking(); p++) { try { gp.play(p); } catch (e) {} }
      if (!gp.thinking()) return null;
      gp.load(i);   // Restart while White is still to answer
      return [board.innerHTML, document.body.innerText];
    })()""")
    assert fresh, "no first move that White answers was found"
    page.wait_for_timeout(1200)   # past the reply delay
    assert page.evaluate("[document.getElementById('gp-board').innerHTML, document.body.innerText]") == fresh, "White answered on the restarted problem"
    assert page.evaluate("[__gp.thinking(), __gp.over()]") == [False, False]
    assert not page.errors, page.errors


def test_morris_undo_takes_the_repetition_count_back(open_game):
    page = open_game("morris", "?debug")
    game_ready(page, "window.__mo")
    page.locator(".mo-pt").nth(4).click()
    page.wait_for_function(truthy("Object.keys(__mo.seen()).length >= 1"))
    page.wait_for_function(truthy("!document.getElementById('wk-undo').disabled"))
    page.wait_for_function(truthy("Object.values(__mo.seen()).reduce((a, b) => a + b, 0) >= 2"), timeout=120000)   # the computer has answered
    page.click("#wk-undo")
    frames(page, 3)
    assert page.evaluate("Object.values(__mo.seen()).reduce((a, b) => a + b, 0)") == 0



def test_freecell_without_a_deal_parameter_is_a_random_deal(open_game):
    page = open_game("freecell")
    game_ready(page, "ZimiFreeCell.session.state")
    assert page.evaluate("ZimiFreeCell.session.state.deal") != 1   # 1 in 32,000 by chance


def test_a_typed_seat_name_is_text_in_the_koikoi_pill(open_game, browser):
    page = open_game("koikoi")
    page.evaluate("""localStorage.setItem('zimi.games.koikoi.seats', JSON.stringify({ kinds: ['person', 'person'] }));
      localStorage.setItem('zimi.games.players', JSON.stringify(['<i id=pwn>x', 'Bo', 'Cy', 'Di'])); 0""")
    page.goto(page.url_of)
    game_ready(page)
    page.wait_for_function(truthy("document.querySelector('.kk-pill')"))
    frames(page, 3)
    assert page.evaluate("document.getElementById('pwn')") is None, "a typed name became markup"
    assert "<i id=pwn>x" in page.evaluate("document.querySelector('.kk-pill').textContent")


def test_echo_new_game_cancels_a_strict_mode_ending_on_its_way(open_game):
    page = open_game("echo")
    game_ready(page, "__echo.g")
    page.click(".gs-sp-play")   # the first tap, on the start splash, starts the game
    page.wait_for_function(truthy("__echo.status === 'input'"), timeout=60000)
    wrong = page.evaluate("(__echo.g.seq[0] + 1) % 4")
    page.click('.ec-pad[data-c="%d"]' % wrong)   # a miss: the game ends in about half a second
    page.evaluate("window.__ends = 0; const o = ZimiShell.endSheet; ZimiShell.endSheet = function () { window.__ends++; return o.apply(this, arguments); }; 0")
    page.evaluate("document.getElementById('ec-new').click(); 0")   # New game before it does
    page.wait_for_timeout(1500)
    assert page.evaluate("window.__ends") == 0, "the old round's ending opened an end sheet on the new round"
    assert not page.errors, page.errors


def test_black_promotion_buttons_draw_black_pieces(open_game):
    page = open_game("chesspuzzles")
    game_ready(page, "window.ZimiChessBoard")
    svgs = page.evaluate("""(() => {
      const E = ZimiChessEngine(), out = {};
      for (const white of [true, false]) {
        const box = document.createElement('div');
        ZimiChessBoard.promoButtons(E, box, () => {});
        ZimiChessBoard.promoColour(box, white);
        out[white] = box.querySelector('svg').outerHTML;
      }
      return out;
    })()""")
    assert svgs["true"] != svgs["false"], "the promotion pieces are white for both sides"
# ── queued from the bots' review of 1.15.3 ──

DAY = "2026-11-04"
PAUSE = "(() => { const b = document.querySelector('.ar-bar [id$=\"pause\"]'); if (b && /^pause/i.test(b.textContent)) b.click(); return 1; })()"
PUZZLE_SAVE = "(() => { const c = Module.cwrap; const p = c('get_save_file', 'number', [])(); const t = UTF8ToString(p); c('free_save_file', 'void', ['number'])(p); return t; })()"
PUZZLE_UP = "typeof Module !== 'undefined' && document.documentElement.classList.contains('zf-running')"


def test_a_daily_memory_game_comes_back_whatever_size_the_player_keeps(open_game):
    """A daily is sixteen cards; its save said the player's own size (20 cards), so takeUp refused it and the day's progress was lost."""
    page = open_game("memory", "?daily=" + DAY)
    game_ready(page, "window.__memory && __memory.g")
    page.evaluate(
        "localStorage.setItem('zimi.games.memory.settings', JSON.stringify({ set: 'animals', size: 'large', people: 1 })); 0"
    )
    page.reload()
    game_ready(page, "window.__memory && __memory.g")
    assert page.evaluate("__memory.g.cards.length") == 16
    page.locator(".mm-card").first.click()
    assert page.evaluate("__memory.g.first") >= 0
    page.evaluate("window.dispatchEvent(new Event('pagehide')); 0")
    page.reload()
    game_ready(page, "window.__memory && __memory.g")
    assert (
        page.evaluate("__memory.g.first") >= 0
    ), "the day's game was dealt again instead of coming back"
    assert (
        page.evaluate(
            "JSON.parse(localStorage.getItem('zimi.games.memory.settings')).size"
        )
        == "large"
    ), "a daily changed the size the player keeps"
    assert not page.errors, page.errors


def test_a_shogi_drop_selection_clears_the_hint(open_game):
    page = open_game("shogi", "?debug")
    game_ready(page, "window.__sg")
    page.evaluate(
        "(() => { const p = __sg.pos(); p.hand[0][1] = 1; p.hand[0][2] = 1; })()"
    )
    page.wait_for_function(
        "() => { const b = document.getElementById('wk-hint'); return b && !b.disabled; }"
    )
    page.locator("#wk-hint").click()
    page.wait_for_function(
        "() => /^Hint: /.test(document.getElementById('wk-status').textContent)",
        timeout=60000,
    )
    assert page.locator("#sg-board .sel").count() >= 1
    page.locator(".sg-h:not(.empty):not([disabled])").first.click()
    assert (
        page.locator("#sg-board .sel").count() == 0
    ), "the board still shows the old hint beside the new selection"
    assert not page.errors, page.errors


def test_a_resumed_daily_stacker_deals_on_from_the_days_seed(open_game):
    """The saved game kept its queue but dealt the next bags from chance, so a resumed daily stopped being the day's."""
    page = open_game("stacker", "?daily=" + DAY)
    game_ready(page, "window.__stacker && __stacker.g")
    page.click(".gs-sp-play")   # the first tap, on the start splash, starts the game
    page.wait_for_function(truthy("__stacker.mode === 'playing'"))
    page.evaluate(PAUSE)
    page.evaluate("window.dispatchEvent(new Event('pagehide')); 0")
    before = page.evaluate(
        "[__stacker.g.rng.seed, __stacker.g.rng.draws, ZimiShell.seed()]"
    )
    assert before[0] == before[2]
    page.reload()
    game_ready(page, "window.__stacker && __stacker.mode === 'paused'")
    assert (
        page.evaluate("[__stacker.g.rng.seed, __stacker.g.rng.draws, ZimiShell.seed()]")
        == before
    )
    assert not page.errors, page.errors


def test_hearts_sizes_its_cards_like_the_other_card_games_on_a_narrow_phone(
    served, browser
):
    """At 320 px thirteen cards do not fit one row at five columns; every other card game goes to seven and Hearts stayed at five."""
    ctx = browser.new_context(viewport={"width": 320, "height": 640})
    page = ctx.new_page()
    page.goto(served + "/hearts.html")
    game_ready(page, "document.querySelector('.zc-card')")
    wide = page.evaluate(
        "Math.max(...[...document.querySelectorAll('.zc-card')].map(c => c.getBoundingClientRect().width))"
    )
    pad, gap = 6, 4  # the table's own (cards.js measure) at this width
    assert wide <= (320 - 2 * pad - 6 * gap) / 7 + 1, wide
    ctx.close()


def test_a_daily_puzzle_with_its_own_game_id_is_that_game_not_the_saved_day(open_game):
    page = open_game("puzzles/fifteen", "?daily=" + DAY)
    game_ready(page, PUZZLE_UP)
    page.evaluate("window.dispatchEvent(new Event('pagehide')); 0")
    assert "4x4" in page.evaluate(PUZZLE_SAVE)
    page.goto(page.url_of + "#3x3#77")
    page.reload()
    game_ready(page, PUZZLE_UP)
    assert "3x3" in page.evaluate(
        PUZZLE_SAVE
    ), "the saved daily overwrote the game ID in the address"
    assert not page.errors, page.errors
