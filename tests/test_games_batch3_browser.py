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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, shell_ready, truthy, visible  # noqa: E402,F401
from test_games_persist_browser import GAMES as SHIPPED_GAMES, VIEW, browser  # noqa: E402,F401

GAMES = os.environ.get("GAMES_ROOT") or SHIPPED_GAMES   # GAMES_ROOT: the games folder of another commit, to see a test fail there


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
    c = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, device_scale_factor=2, **ctx)
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
    files = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(GAMES, "text", "*.json")))
    src = open(os.path.join(GAMES, "text.js"), encoding="utf-8").read()
    listed = re.search(r"var SHIPPED = \[([^\]]*)\]", src).group(1)
    assert sorted(re.findall(r"'(\w+)'", listed)) == files


@pytest.mark.parametrize("lang,expect", [("ja", "en"), ("ko", "en"), ("fr", "fr"), ("pt-BR", "pt-br")])
def test_a_language_without_a_text_file_is_english_everywhere(browser, served, lang, expect):
    c, page = open_game(browser, served, "flags.html", lang=lang)
    got = page.evaluate("() => [ZimiText.lang, document.documentElement.lang, GamesLib.uiLang(), GamesLib.countryName('Turkey')]")
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
    rows = [("SAVEFILE", "Simon Tatham's Portable Puzzle Collection"), ("VERSION", "1"), ("GAME", game), ("PARAMS", params), ("CPARAMS", params),
            ("SEED", "1"), ("DESC", desc), ("NSTATES", "1"), ("STATEPOS", "1")]
    return "".join("%-8s:%d:%s\n" % (k, len(v), v) for k, v in rows)


# Five by five, three colours: the one group of three (top, second and third columns) is the only move, and once it is gone none is left.
STUCK_AFTER_ONE = "2,3,3,2,3,3,2,3,1,2,1,3,1,2,3,3,1,2,3,2,2,3,1,2,3"


def test_same_game_stuck_has_a_sheet(browser, served):
    c, page = open_game(browser, served, "puzzles/samegame.html")
    page.wait_for_function(truthy("document.documentElement.classList.contains('zf-running')"))
    page.evaluate(LOAD_TEXT, tatham_save("Same Game", "5x5c3s2", STUCK_AFTER_ONE))
    frames(page, 4)
    assert page.locator(".ar-sheet-card").count() == 0 or not page.locator(".ar-sheet-card").is_visible()
    box = page.locator("#puzzlecanvas").bounding_box()
    for _ in range(2):   # the first tap selects the group, the second removes it
        page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.1)
        frames(page, 4)
    visible(page, ".ar-sheet-card h2", 6000)
    text = page.locator(".ar-sheet-card").inner_text()
    assert "No moves left" in text and "Undo a few moves" in text and "New game" in text, text
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


def test_carrom_slider_tracks_show_in_dark(served):
    """In WebKit (the phone's engine) the browser's own track is the page's colour on a dark page."""
    import io

    Image = pytest.importorskip("PIL.Image")
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        try:
            wk = p.webkit.launch()
        except Exception as e:
            pytest.skip("WebKit is not installed: %s" % e)
        _slider_tracks(wk, served, Image, io)
        wk.close()


def _slider_tracks(browser, served, Image, io):
    c, page = open_game(browser, served, "carrom.html", color_scheme="dark")
    page.click("#cr-slide")
    box = page.locator(".cr-sliders input").first.bounding_box()
    right = {"x": box["x"] + box["width"] * 0.8, "y": box["y"], "width": box["width"] * 0.18, "height": box["height"]}   # past the thumb: only the track is there
    img = Image.open(io.BytesIO(page.screenshot(clip=right))).convert("RGB")
    ground = img.getpixel((0, 0))
    far = max(sum(abs(a - b) for a, b in zip(px, ground)) for px in img.getdata())
    assert far > 90, "the track is not drawn against the dark page (%s)" % far
    shot(page, "04-carrom-sliders")
    c.close()
