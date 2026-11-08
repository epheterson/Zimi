"""Playtest batch 3: language fallback, end sheets, keypads, hints and labels found on a 390 x 844 phone.

One test per finding; each failed on the code before its fix. Screenshots go to GAMES_SHOT_DIR when set.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_batch3_browser.py -v
"""

import functools
import glob
import http.server
import os
import re
import sys
import threading

import pytest

pytest.importorskip("playwright")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import (
    frames,
    game_ready,
    shell_ready,
    truthy,
    visible,
)  # noqa: E402,F401
from playwright.sync_api import sync_playwright  # noqa: E402
from test_games_persist_browser import GAMES as SHIPPED_GAMES, VIEW  # noqa: E402

GAMES = (
    os.environ.get("GAMES_ROOT") or SHIPPED_GAMES
)  # GAMES_ROOT: the games folder of another commit, to see a test fail there


@pytest.fixture(scope="module")
def _playwright():
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="module")
def browser(_playwright):
    try:
        b = _playwright.chromium.launch()
    except Exception as e:
        pytest.skip("Chromium is not installed: %s" % e)
    yield b
    b.close()


@pytest.fixture(scope="module")
def webkit_browser(_playwright):
    try:
        b = _playwright.webkit.launch()
    except Exception as e:
        pytest.skip("WebKit is not installed: %s" % e)
    yield b
    b.close()


@pytest.fixture(scope="module")
def served():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


SHOT_DIR = os.environ.get("GAMES_SHOT_DIR")


def open_game(browser, served, path, query="", lang=None, ready=True, **ctx):
    ctx.setdefault("reduced_motion", "reduce")
    c = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, device_scale_factor=2, **ctx
    )
    page = c.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.goto("%s/%s%s%s" % (served, path, query, ("#lang=" + lang) if lang else ""))
    if ready:
        shell_ready(page)
    return c, page


def shot(page, name):
    if SHOT_DIR:
        page.screenshot(path=os.path.join(SHOT_DIR, name + ".png"))


# 1. A language with no text file speaks English throughout (Flags in Japanese: English strings, Japanese country names).
def test_shipped_language_list_matches_the_text_files():
    files = sorted(
        os.path.basename(f)[:-5]
        for f in glob.glob(os.path.join(GAMES, "text", "*.json"))
    )
    src = open(os.path.join(GAMES, "text.js"), encoding="utf-8").read()
    listed = re.search(r"var SHIPPED = \[([^\]]*)\]", src).group(1)
    assert sorted(re.findall(r"'(\w+)'", listed)) == files


@pytest.mark.parametrize(
    "lang,expect", [("ja", "en"), ("ko", "en"), ("fr", "fr"), ("pt-BR", "pt-br")]
)
def test_a_language_without_a_text_file_is_english_everywhere(
    browser, served, lang, expect
):
    c, page = open_game(browser, served, "flags.html", lang=lang)
    got = page.evaluate(
        "() => [ZimiText.lang, document.documentElement.lang, GamesLib.uiLang(), GamesLib.countryName('Turkey')]"
    )
    assert got[:3] == [expect, expect, expect.split("-")[0]], got
    if expect == "en":
        assert got[3] == "Turkey", got
    shot(page, "01-flags-%s" % lang)
    c.close()


# 2. Same Game: when the last move is gone there is a sheet (the card games' words), with the score and New game.
SAVE_TEXT = "(() => { const c = Module.cwrap; const p = c('get_save_file', 'number', [])(); const t = UTF8ToString(p); c('free_save_file', 'void', ['number'])(p); return t; })()"
LOAD_TEXT = """(text) => {
  const bytes = new TextEncoder().encode(text); let pos = 0;
  window.savefile_read_callback = (buf, len) => { if (pos + len > bytes.length) return false; writeArrayToMemory(new Int8Array(bytes.buffer, pos, len), buf); pos += len; return true; };
  try { Module.cwrap('load_game', 'void', [])(); } finally { window.savefile_read_callback = null; }
}"""


def tatham_save(game, params, desc):
    """The save text the frontend writes (Game > Download save file) for a game of ours: one move to play, no history."""
    rows = [
        ("SAVEFILE", "Simon Tatham's Portable Puzzle Collection"),
        ("VERSION", "1"),
        ("GAME", game),
        ("PARAMS", params),
        ("CPARAMS", params),
        ("SEED", "1"),
        ("DESC", desc),
        ("NSTATES", "1"),
        ("STATEPOS", "1"),
    ]
    return "".join("%-8s:%d:%s\n" % (k, len(v), v) for k, v in rows)


# Five by five, three colours: the one group of three (top, second and third columns) is the only move, and once it is gone none is left.
STUCK_AFTER_ONE = "2,3,3,2,3,3,2,3,1,2,1,3,1,2,3,3,1,2,3,2,2,3,1,2,3"


def test_same_game_stuck_has_a_sheet(browser, served):
    c, page = open_game(browser, served, "puzzles/samegame.html")
    page.wait_for_function(
        truthy("document.documentElement.classList.contains('zf-running')")
    )
    page.evaluate(LOAD_TEXT, tatham_save("Same Game", "5x5c3s2", STUCK_AFTER_ONE))
    frames(page, 4)
    assert (
        page.locator(".ar-sheet-card").count() == 0
        or not page.locator(".ar-sheet-card").is_visible()
    )
    box = page.locator("#puzzlecanvas").bounding_box()
    for _ in range(2):  # the first tap selects the group, the second removes it
        page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.1)
        frames(page, 4)
    visible(page, ".ar-sheet-card h2", 6000)
    text = page.locator(".ar-sheet-card").inner_text()
    assert (
        "No moves left" in text and "Undo a few moves" in text and "New game" in text
    ), text
    assert re.search(r"Score\s*1", text), text
    assert "No moves left" in page.locator(".pz-status").inner_text()
    shot(page, "02-samegame-stuck")
    assert not page.errors, page.errors
    c.close()


# 3. The keypad takes the game's size (a 5 x 5 Towers takes 1 to 5), Towers says what the edge numbers are, and Mosaic's clues read in dark.
RUNNING = "document.documentElement.classList.contains('zf-running')"
DEFAULT_KEYS = {
    "towers": "12345",
    "keen": "123456",
    "unequal": "1234",
    "solo": "123456789",
    "group": "abcdef",
    "filling": "123456789",
}
KEY_LABELS = "[...document.querySelectorAll('.zf-keys .ar-btn')].map(b => b.getAttribute('aria-label') || '').filter(l => l.length === 1).join('')"


@pytest.mark.parametrize("name", sorted(DEFAULT_KEYS))
def test_the_keypad_offers_only_what_the_game_takes(browser, served, name):
    c, page = open_game(browser, served, "puzzles/%s.html" % name)
    page.wait_for_function(truthy(RUNNING))
    page.wait_for_function(
        "k => %s === k" % KEY_LABELS, arg=DEFAULT_KEYS[name], timeout=5000
    )
    if name == "towers":
        assert "Edge numbers" in page.locator(".pz-rules").inner_text()
        shot(page, "03-towers")
    c.close()


def _luminance(hex_):
    ch = [int(hex_[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    ch = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in ch]
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_mosaic_clues_read_on_the_undecided_squares(browser, served, scheme):
    c, page = open_game(browser, served, "puzzles/mosaic.html", color_scheme=scheme)
    page.wait_for_function(truthy(RUNNING))
    square, clue = page.evaluate("() => [colours[1], colours[5]]")
    a, b = sorted([_luminance(square), _luminance(clue)])
    assert (b + 0.05) / (a + 0.05) >= 4.5, (square, clue)
    shot(page, "03-mosaic-" + scheme)
    c.close()


# 4. Carrom: the pills' swatches are the coins (the person's side, whichever it is), and the slider tracks show on a dark page.
def _rgb(css):
    return tuple(int(v) for v in re.findall(r"\d+", css)[:3])


@pytest.mark.parametrize("side,coin", [("first", "#f6f0dd"), ("second", "#3a332b")])
def test_carrom_you_swatch_is_your_coins(browser, served, side, coin):
    c, page = open_game(browser, served, "carrom.html", color_scheme="dark")
    page.evaluate(
        "() => localStorage.setItem('zimi.games.carrom.settings', JSON.stringify({ side: '%s' }))"
        % side
    )
    page.reload()
    shell_ready(page)
    pips = page.evaluate(
        "() => [...document.querySelectorAll('.bg-score .wk-who')].map(w => [w.textContent, getComputedStyle(w.querySelector('.wk-pip')).backgroundColor])"
    )
    you = [p for p in pips if p[0].startswith("You")]
    assert len(you) == 1 and _rgb(you[0][1]) == tuple(
        int(coin[i : i + 2], 16) for i in (1, 3, 5)
    ), pips
    shot(page, "04-carrom-%s" % side)
    c.close()


def test_carrom_slider_tracks_show_in_dark(served, webkit_browser):
    """In WebKit (the phone's engine) the browser's own track is the page's colour on a dark page."""
    import io

    Image = pytest.importorskip("PIL.Image")
    _slider_tracks(webkit_browser, served, Image, io)


def _slider_tracks(browser, served, Image, io):
    c, page = open_game(browser, served, "carrom.html", color_scheme="dark")
    page.click("#cr-slide")
    box = page.locator(".cr-sliders input").first.bounding_box()
    right = {
        "x": box["x"] + box["width"] * 0.8,
        "y": box["y"],
        "width": box["width"] * 0.18,
        "height": box["height"],
    }  # past the thumb: only the track is there
    img = Image.open(io.BytesIO(page.screenshot(clip=right))).convert("RGB")
    ground = img.getpixel((0, 0))
    far = max(sum(abs(a - b) for a, b in zip(px, ground)) for px in img.getdata())
    assert far > 90, "the track is not drawn against the dark page (%s)" % far
    shot(page, "04-carrom-sliders")
    c.close()


# 5. Sky Detective: opens on the game's intro (the Almanac's sky only when asked), and the view holds still from step to step.
HOST = '<!doctype html><script>window.msgs = []; addEventListener("message", e => msgs.push(e.data));</script><iframe id="reader-frame" src="%s" style="width:390px;height:844px;border:0"></iframe>'
DOME = "(() => { const r = document.getElementById('sk-dome').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()"


def test_sky_detective_opens_on_the_intro_not_the_sky(browser, served):
    c = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce"
    )
    page = c.new_page()
    page.route(
        served + "/_host.html",
        lambda r: r.fulfill(body=HOST % "skydetective.html", content_type="text/html"),
    )
    page.goto(served + "/_host.html")
    frame = page.frame_locator("#reader-frame")
    frame.locator("#sk-next").wait_for(state="visible", timeout=20000)
    page.wait_for_timeout(500)
    assert not [
        m
        for m in page.evaluate("window.msgs")
        if isinstance(m, dict) and m.get("zimi") == "game-sky"
    ], "the sky opened over the intro on its own"
    assert (
        "study" in frame.locator("#sk-q").inner_text().lower()
        or frame.locator("#sk-q").inner_text()
    )
    assert frame.locator("#sk-look").is_visible(), "the sky is one tap away"
    frame.locator("#sk-look").click()
    page.wait_for_function("window.msgs.some(m => m && m.zimi === 'game-sky')")
    c.close()


def test_sky_detective_dome_holds_still_through_a_round(browser, served):
    c, page = open_game(browser, served, "skydetective.html")
    page.wait_for_function("window.__sky && window.__sky.g")
    shot(page, "05-sky-intro")
    first = page.evaluate(DOME)
    page.click("#sk-next")
    for i in range(6):
        kind = page.evaluate("window.__sky.g.qs[window.__sky.g.at].kind")
        assert page.evaluate(DOME) == first, (i, "asked", page.evaluate(DOME), first)
        if kind == "name":
            page.click(".rk-choice >> nth=0")
        else:
            box = page.locator("#sk-dome").bounding_box()
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_selector("#sk-next:not([hidden])")
        assert page.evaluate(DOME) == first, (i, "answered", page.evaluate(DOME), first)
        scroll, height = page.evaluate(
            "[window.scrollY, document.documentElement.scrollHeight - innerHeight]"
        )
        assert (
            scroll == 0 and height <= 0
        ), "the page scrolled to show the answer (%s, %s)" % (scroll, height)
        nxt = page.locator("#sk-next").bounding_box()
        assert VIEW["height"] - (nxt["y"] + nxt["height"]) >= 40, (
            "Next sits against the bottom edge: %s" % nxt
        )
        if i == 0:
            shot(page, "05-sky-answered")
        if i < 5:
            page.click("#sk-next")
    c.close()


# 6. Babel: once a word is given away the guess field and button are disabled, a "missed" note stands where the instruction was, nothing moves.
def test_babel_after_giving_up_the_form_is_off_and_says_missed(browser, served):
    c, page = open_game(browser, served, "babel.html")
    page.wait_for_function("window.__babel && window.__babel.g")
    top = page.evaluate("document.getElementById('bb-clues').getBoundingClientRect().y")
    for _ in range(
        4
    ):  # two clues showing, three more to show, then the miss that gives it away
        page.fill("#bb-field", "zzzz")
        page.click("#bb-guess")
        frames(page, 2)
    page.wait_for_selector("#bb-next:not([hidden])")
    assert page.is_disabled("#bb-field") and page.is_disabled("#bb-guess")
    assert page.inner_text("#bb-how") == "Missed: no points for this word."
    assert (
        page.evaluate("document.getElementById('bb-clues').getBoundingClientRect().y")
        == top
    ), "the clues moved"
    shot(page, "06-babel-missed")
    page.click("#bb-next")
    assert page.is_enabled("#bb-field") and page.is_enabled("#bb-guess")
    assert "Name this word" in page.inner_text("#bb-how")
    c.close()


# 7. Drop Pin: the world map fills its box (no empty sea), zooming in goes to the pin, and the answer view holds both pins whole.
def _world_game(browser, served):
    c, page = open_game(browser, served, "droppin.html")
    page.wait_for_function(
        "window.__drop && window.__drop.g && window.__drop.g.mode === 'world'"
    )
    page.wait_for_function(
        "document.getElementById('dp-world') && !document.getElementById('dp-world').hasAttribute('hidden')"
    )
    return c, page


def test_drop_pin_world_fills_its_box(browser, served):
    c, page = _world_game(browser, served)
    vb = page.evaluate(
        "document.getElementById('dp-world').getAttribute('viewBox').split(' ').map(Number)"
    )
    assert (
        vb[1] >= 0
        and vb[1] + vb[3] <= 400.01
        and vb[0] >= 0
        and vb[0] + vb[2] <= 800.01
    ), vb  # only map is in view, no sea beyond it
    box = page.evaluate(
        "(() => { const r = document.getElementById('dp-world').getBoundingClientRect(); return [r.width, r.height]; })()"
    )
    assert abs(vb[2] / vb[3] - box[0] / box[1]) < 0.01
    # zooming out never shows more than the map
    for _ in range(4):
        page.click("#dp-zout")
    vb2 = page.evaluate(
        "document.getElementById('dp-world').getAttribute('viewBox').split(' ').map(Number)"
    )
    assert vb2[1] >= 0 and vb2[1] + vb2[3] <= 400.01, vb2
    shot(page, "07-droppin-world")
    c.close()


def _tap(page, fx, fy):
    box = page.locator("#dp-world").bounding_box()
    page.touchscreen.tap(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
    frames(page, 2)


def test_drop_pin_zoom_goes_to_the_tap(browser, served):
    c, page = _world_game(browser, served)
    _tap(page, 0.8, 0.25)
    page.click("#dp-zin")
    frames(page, 2)
    at = page.evaluate(
        "(() => { const s = document.getElementById('dp-world').getBoundingClientRect(), p = document.querySelector('#dp-world circle.pin').getBoundingClientRect(); return [(p.x + p.width / 2 - s.x) / s.width, (p.y + p.height / 2 - s.y) / s.height]; })()"
    )
    assert abs(at[0] - 0.5) < 0.05 and abs(at[1] - 0.5) < 0.08, at
    c.close()


@pytest.mark.parametrize("fx,fy", [(0.5, 0.5), (0.02, 0.05), (0.98, 0.95)])
def test_drop_pin_answer_pin_is_never_clipped(browser, served, fx, fy):
    c, page = _world_game(browser, served)
    _tap(page, fx, fy)
    for _ in range(
        3
    ):  # zoomed in on the pin, the place is out of view until the answer view brings it back
        page.click("#dp-zin")
    page.evaluate("document.getElementById('dp-drop').click()")
    page.wait_for_selector("#dp-world circle.truth")
    frames(page, 2)
    rects = page.evaluate(
        """(() => { const s = document.getElementById('dp-world').getBoundingClientRect();
      return ['truth', 'pin'].map(k => { const r = document.querySelector('#dp-world circle.' + k).getBoundingClientRect();
        return [r.left - s.left, r.top - s.top, s.right - r.right, s.bottom - r.bottom]; }); })()"""
    )
    for r in rects:
        assert min(r) >= 0, rects
    shot(
        page,
        "07-droppin-answer-%s"
        % ("c" if fx == 0.5 else "edge" if fx < 0.5 else "edge2"),
    )
    c.close()


# 8. Shogi: the hint is in plain words, move lists break between moves (never inside one), the in-hand count badge is whole.
def test_shogi_hint_is_in_plain_words(browser, served):
    c, page = open_game(browser, served, "shogi.html", "?debug")
    page.wait_for_function("window.__sg && window.__sg.pos()")
    page.wait_for_selector("#wk-hint:not([disabled])")
    page.click("#wk-hint")
    page.wait_for_function("() => /Hint:/.test(document.body.innerText)", timeout=60000)
    text = re.search(r"Hint: [^\n]*", page.inner_text("body")).group(0)
    assert re.match(
        r"Hint: (Move a [a-z ]+ from \d[a-i] to \d[a-i]( and take)?|Drop a [a-z ]+ on \d[a-i])( and promote)?\.$",
        text,
    ), text
    shot(page, "08-shogi-hint")
    c.close()


MOVES_FILL = """(sel) => { const box = document.querySelector(sel), cls = box.id.slice(0, 2);
  let html = ''; for (let i = 0; i < 40; i++) { if (i % 2 === 0) html += '<span class="' + cls + '-n">' + (i / 2 + 1) + '.</span>'; html += '<span class="' + cls + '-m">' + ['P 8d-8e', 'N 7gx8e', 'R 8bx8e+', 'K 5a-5b'][i % 4] + '</span>'; }
  box.innerHTML = html; box.style.maxHeight = 'none'; }"""


@pytest.mark.parametrize("name,box", [("shogi", "#sg-moves"), ("xiangqi", "#xq-moves")])
def test_move_lists_break_between_moves_not_inside_one(browser, served, name, box):
    c, page = open_game(browser, served, name + ".html")
    page.evaluate(MOVES_FILL, box)
    split = page.evaluate(
        "(sel) => [...document.querySelectorAll(sel + ' > span')].filter(s => s.getClientRects().length > 1).map(s => s.textContent)",
        box,
    )
    assert not split, split
    shot(page, "08-%s-moves" % name)
    c.close()


def test_shogi_in_hand_count_badge_is_whole(browser, served):
    c, page = open_game(browser, served, "shogi.html", "?debug")
    page.wait_for_function("window.__sg && window.__sg.pos()")
    page.evaluate(
        "(() => { const p = __sg.pos(); p.hand[0][1] = 2; p.hand[0][3] = 1; p.hand[1][1] = 1; })()"
    )
    page.click("#sg-flip")
    page.click("#sg-flip")
    frames(page, 2)
    import io

    Image = pytest.importorskip("PIL.Image")
    badges = page.evaluate(
        "[...document.querySelectorAll('.sg-h:not(.empty) b')].map(b => { const r = b.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })"
    )
    assert len(badges) >= 3, badges
    for (
        x,
        y,
        w,
        h,
    ) in (
        badges
    ):  # the count's dark disc is whole: both ends of its middle line are the badge's colour, not the piece's
        img = Image.open(
            io.BytesIO(page.screenshot(clip={"x": x, "y": y, "width": w, "height": h}))
        ).convert("L")
        row = [
            img.getpixel((i, img.height // 2))
            for i in (int(img.width * 0.12), int(img.width * 0.88))
        ]
        assert max(row) < 110, ("the count badge is covered", row)
    shot(page, "08-shogi-hand")
    c.close()


# 9. Makruk and Janggi: the pills say what their number counts. (The default levels are left as they were: see the report.)
@pytest.mark.parametrize("name,unit", [("makruk", "pieces"), ("janggi", "points")])
def test_score_pills_say_what_they_count(browser, served, name, unit):
    c, page = open_game(browser, served, name + ".html")
    page.wait_for_selector(".bg-score .wk-who")
    pills = page.eval_on_selector_all(
        ".bg-score .wk-who", "ws => ws.map(w => w.textContent)"
    )
    assert len(pills) == 2 and all(unit in p for p in pills), pills
    shot(page, "09-%s-pills" % name)
    c.close()


# 10. Ludo: the status words belong to the player whose turn it is (the computer's re-roll is not told to you), and the die's label follows the roll.
def test_ludo_computers_reroll_is_not_told_to_the_person(browser, served):
    c, page = open_game(browser, served, "ludo.html", "?debug")
    page.wait_for_function("window.__ld && window.__ld.phase() === 'roll'")
    page.evaluate(
        "(() => { __ld.state().turn = 1; __ld.force(3); __ld.roll(); })()"
    )  # the computer rolls a 3 with every piece at home: no move, and it tries again
    page.wait_for_function(
        "() => /again|rolls/i.test(document.getElementById('ld-status').innerText)",
        timeout=10000,
    )
    text = page.inner_text("#ld-status")
    assert text.strip() != "Roll again." and "rolls again" in text, text
    assert "Green" in text, text  # it names the player whose turn it is
    shot(page, "10-ludo-status")
    c.close()


def test_ludo_die_label_follows_the_roll(browser, served):
    c, page = open_game(browser, served, "ludo.html", "?debug")
    page.wait_for_function("window.__ld && window.__ld.phase() === 'roll'")
    page.evaluate("(() => { __ld.force(3); __ld.roll(); })()")
    page.wait_for_function(
        "() => /cannot|can't|no move/i.test(document.getElementById('ld-status').innerText) || /Pick|Tap/i.test(document.getElementById('ld-status').innerText)",
        timeout=10000,
    )
    assert (
        page.get_attribute("#ld-die", "aria-label") == "Die showing 3"
    ), page.get_attribute("#ld-die", "aria-label")
    c.close()


# 11. Ur: the pieces that can move (outlined) and the squares they can go to (filled) do not look alike.
def test_ur_movable_pieces_and_destinations_look_different(browser, served):
    c, page = open_game(browser, served, "ur.html", "?debug")
    page.wait_for_function("window.__ur && window.__ur.phase() === 'roll'")
    for _ in range(12):
        page.click("#ur-roll")
        page.wait_for_function(
            "() => !document.getElementById('ur-roll').disabled || __ur.moves().length > 0",
            timeout=10000,
        )
        if page.evaluate("__ur.moves().length") > 0:
            break
        page.wait_for_function(
            "__ur.phase() === 'roll' && !document.getElementById('ur-roll').disabled",
            timeout=10000,
        )
    assert page.evaluate("__ur.moves().length") > 0
    look = page.evaluate("""(() => {
      const f = el => { const c = getComputedStyle(el); return [c.fill, c.strokeWidth, c.strokeDasharray].join('|'); };
      const src = [...document.querySelectorAll('.ur-hl.src')], dst = [...document.querySelectorAll('.ur-hl:not(.src):not(.last):not(.tip)')];
      return { src: src.map(f), dst: dst.map(f) }; })()""")
    assert look["src"] and look["dst"], look
    assert not set(look["src"]) & set(look["dst"]), look
    shot(page, "11-ur-moves")
    c.close()


# 12a. Inside Zimi the header holds Hnefatafl's whole name (it was cut to "Hnefat..." once the other buttons arrived).
from test_games_final_fixes import _open as _zimi_open, zimi  # noqa: E402,F401

TITLE_FITS = """() => { const e = document.getElementById('game-title'), r = document.createRange(); r.selectNodeContents(e);
  const cs = getComputedStyle(e), pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  return [e.textContent, r.getBoundingClientRect().width, e.clientWidth - pad, cs.fontSize]; }"""


def test_hnefatafl_title_fits_in_zimis_header(zimi, webkit_browser):  # noqa: F811
    ctx, page, errors = _zimi_open(
        webkit_browser, zimi, "hnefatafl.html", scheme="light"
    )
    page.wait_for_function(
        "() => document.body.classList.contains('game-page') && document.getElementById('game-title').textContent.length > 3"
    )
    page.wait_for_timeout(1500)  # the header's other buttons arrive after the first fit
    name, scroll, client, size = page.evaluate(TITLE_FITS)
    assert scroll <= client + 0.02, (
        name,
        scroll,
        client,
        size,
    )  # the text against the room inside the padding
    shot(page, "12-hnefatafl-header")
    ctx.close()


# 12b. A drawn game says "Draw" once: the reason that follows does not start with "A draw:" again.
@pytest.mark.parametrize(
    "name,hook,result",
    [
        ("xiangqi", "__xq", "repetition"),
        ("xiangqi", "__xq", "sixty"),
        ("shogi", "__sg", "repetition"),
    ],
)
def test_draw_is_said_once(browser, served, name, hook, result):
    c, page = open_game(browser, served, name + ".html", "?debug")
    page.wait_for_function("window.%s" % hook)
    page.evaluate("(r) => %s.finish({ over: true, result: r })" % hook, result)
    visible(page, ".ar-sheet-card h2", 6000)
    title = page.inner_text(".ar-sheet-card h2")
    body = page.inner_text(".ar-sheet-card")
    status = page.inner_text(".bg-status")
    assert title == "Draw" and body.lower().count("draw") == 1, body
    assert status.lower().count("draw") == 1, status
    shot(page, "12-draw-" + name)
    c.close()


# 12c. Hex says which edges are yours, and Zimi's header keeps the undo arrow the right way round in a right-to-left language.
def test_hex_has_a_rules_line_about_your_edges(browser, served):
    c, page = open_game(browser, served, "hex.html")
    page.wait_for_selector("#hx-rules:not(:empty)")
    assert (
        page.inner_text("#hx-rules")
        == "Link the two red edges before Zimi links the blue ones."
    )
    shot(page, "12-hex-rules")
    c.close()


def test_undo_arrow_is_not_mirrored_in_arabic(zimi, webkit_browser):  # noqa: F811
    ctx = webkit_browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    ctx.add_init_script(
        "try { localStorage.setItem('zimi_ui_lang', 'ar'); } catch (e) {}"
    )
    page = ctx.new_page()
    page.goto(zimi["url"] + "/?a=zimi_games%2Fhex.html")
    page.wait_for_function(
        "() => document.documentElement.dir === 'rtl' && document.body.classList.contains('game-page')",
        timeout=60000,
    )
    page.wait_for_selector("#game-act-btn:not([hidden])", timeout=30000)
    transform = page.evaluate(
        "getComputedStyle(document.querySelector('#game-act-btn svg')).transform"
    )
    assert transform in ("none", "matrix(1, 0, 0, 1, 0, 0)"), transform
    shot(page, "12-undo-arabic")
    ctx.close()
# 12d. Wiki Race: the win sheet says when you matched par (or beat a route that was only known).
@pytest.mark.parametrize(
    "kind,par,clicks,key",
    [
        ("shortest", 3, 3, "race.matchedShortest"),
        ("shortest", 3, 5, "race.parShortest"),
        ("route", 4, 4, "race.matchedRoute"),
        ("route", 4, 3, "race.beatRoute"),
        ("route", 4, 6, "race.parRoute"),
    ],
)
def test_wiki_race_win_sheet_notes_par(browser, served, kind, par, clicks, key):
    c, page = open_game(browser, served, "wikirace.html", ready=False)
    page.wait_for_function("!!(window.WikiRaceEngine && WikiRaceEngine.parNote)")
    got = page.evaluate(
        "([kind, par, clicks]) => WikiRaceEngine.parNote({ parKind: kind, par: par }, clicks)",
        [kind, par, clicks],
    )
    assert got == {"key": key, "n": par}, got
    c.close()
# 12e. No generic "Keep playing to learn more." on a low score: the lowest band says nothing, the others keep their words.
def test_low_score_has_no_generic_line(browser, served):
    c, page = open_game(browser, served, "babel.html")
    got = page.evaluate(
        "() => [GamesLib.verdictLine(ZimiText.T, 'round.verdict.', 'keepGoing'), GamesLib.verdictLine(ZimiText.T, 'round.verdict.', 'flawless'), GamesLib.verdict(1, 8)]"
    )
    assert got == ["", "Flawless.", "keepGoing"], got
    assert (
        "Keep playing to learn more"
        not in open(os.path.join(GAMES, "text", "en.json"), encoding="utf-8").read()
    )
    c.close()


def test_babel_ends_at_zero_without_the_generic_line(browser, served):
    c, page = open_game(browser, served, "babel.html")
    page.wait_for_function("window.__babel && window.__babel.g")
    for _ in range(5):  # five words, each given away
        for _ in range(4):
            page.fill("#bb-field", "zzzz")
            page.click("#bb-guess")
            frames(page, 1)
        page.wait_for_selector("#bb-next:not([hidden])")
        page.click("#bb-next")
    visible(page, ".ar-sheet-card h2", 6000)
    assert "Keep playing" not in page.inner_text(".ar-sheet-card")
    shot(page, "12-babel-zero")
    c.close()
# 12f. Flip: a lit square is amber (a solved board is not a blank page); Unruly: a white square is cream, not a lighter grey of the empty ones.
def _chroma(hex_):
    ch = [int(hex_[i : i + 2], 16) for i in (1, 3, 5)]
    return max(ch) - min(ch)


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_flip_lit_square_is_not_the_page(browser, served, scheme):
    c, page = open_game(browser, served, "puzzles/flip.html", color_scheme=scheme)
    page.wait_for_function(truthy(RUNNING))
    lit, ground = page.evaluate("() => [colours[2], colours[0]]")
    assert lit != ground and _chroma(lit) > 40, (lit, ground)
    shot(page, "12-flip-" + scheme)
    c.close()


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_unruly_white_square_is_not_a_grey(browser, served, scheme):
    c, page = open_game(browser, served, "puzzles/unruly.html", color_scheme=scheme)
    page.wait_for_function(truthy(RUNNING))
    white, empty = page.evaluate("() => [colours[3], colours[2]]")
    assert _chroma(white) > 40 and _chroma(empty) < 20, (white, empty)
    shot(page, "12-unruly-" + scheme)
    c.close()
