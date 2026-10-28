"""The arcade games play out the same, frame for frame.

Each game runs on a fake clock with a seeded Math.random (ZimiUtil.mulberry32) and a scripted person: keys, touch-pad
presses, a pause from the Menu, from Escape and from the tab going hidden, a leave-and-return through the shell's
saved game, and then play to the end (or, for the Quest, to the win). At each checkpoint the fixture holds the game's
mode, score, lives, a digest of its whole state, the HUD strip, the status line, the Pause button and any sheet on
screen. Refactoring the page wiring the arcade games share (Play.arcadePage in playkit.js) must leave them as they are.

Record (only for a change of rules or wording): ZIMI_RECORD_ARCADE=1 pytest tests/test_games_arcade_fixtures.py
Screenshots at 390 px (rest, mid-game, end) for a before/after compare: ZIMI_ARCADE_SHOTS=<dir> pytest ...
Run: pytest tests/test_games_arcade_fixtures.py -v
"""

import functools
import http.server
import json
import os
import threading

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
GAMES = os.environ.get("ZIMI_GAMES_DIR") or os.path.join(
    os.path.dirname(HERE), "zimi", "builtin", "games"
)
FIXTURES = os.path.join(HERE, "fixtures", "games_arcade")
VIEW = {"width": 390, "height": 844}
STEP_MS = 500  # fake time between two looks while waiting for the end
MAX_WAIT_MS = 400_000  # a game that has not ended after this much fake time is stuck
START_KEY = (
    "q"  # mapped to nothing in any of these games: the ready line takes it as "any key"
)

INIT = """
(() => {
  // The page's frames come from the fake clock alone, every 16 ms from the call. (The fake requestAnimationFrame keeps a grid
  // whose phase follows how long the page took to load, and a different phase puts 18 frames in 300 ms instead of 19.)
  Object.defineProperty(performance, 'now', { configurable: true, value: () => Date.now() - %(t0)d });
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  let rng = null;
  const seed = %(seed)d;
  Math.random = function () {
    if (!rng) { if (!window.ZimiUtil) throw new Error('util.js is not loaded'); rng = window.ZimiUtil.mulberry32(seed); }
    return rng();
  };
})();
"""

# A script is a list of steps: ("press", key) ("down", key) ("up", key) ("pad", name, down) ("run", ms)
# ("hide",) (the tab goes hidden and comes back) ("click", css) ("leave",) (pagehide, reload, the saved game comes back)
# ("check", label) ("shot", label) ("over",) (play on until the game ends) ("force", js) (run js in the page).
SPACE = " "
# One ball to its end: launched at full charge with the ball saver spent, so the ball is lost when it drains.
PINBALL_BALL = [("down", SPACE), ("run", 900), ("up", SPACE), ("force", "__pinball.st.saver = 0"), ("run", 9000)]
SCRIPTS = {
    "rocks": dict(
        id="rk",
        api="__rocks",
        seed=21,
        script=[
            ("check", "rest"),
            ("shot", "rest"),
            ("press", START_KEY),
            ("run", 300),
            ("check", "started"),
            ("down", "ArrowUp"),
            ("run", 700),
            ("up", "ArrowUp"),
            ("down", "ArrowLeft"),
            ("run", 400),
            ("up", "ArrowLeft"),
            ("down", SPACE),
            ("run", 900),
            ("up", SPACE),
            ("pad", "right", True),
            ("run", 500),
            ("pad", "right", False),
            ("pad", "fire", True),
            ("run", 600),
            ("pad", "fire", False),
            ("check", "keys"),
            ("shot", "mid"),
            ("press", "Escape"),
            ("check", "escape"),
            ("run", 500),
            ("check", "held"),
            ("press", "p"),
            ("run", 500),
            ("check", "resumed"),
            ("hide",),
            ("check", "hidden"),
            ("click", "#rk-pause"),
            ("run", 400),
            ("check", "menu-resume"),
            ("down", "ArrowUp"),
            ("run", 300),
            ("leave",),
            ("check", "returned"),
            ("click", "#rk-pause"),
            ("run", 600),
            ("check", "returned-and-playing"),
            ("over",),
            ("check", "over"),
            ("shot", "end"),
            ("leave",),
            ("check", "over-returned"),
        ],
    ),
    "lastline": dict(
        id="ll",
        api="__lastline",
        seed=22,
        script=[
            ("check", "rest"),
            ("shot", "rest"),
            ("press", START_KEY),
            ("run", 300),
            ("check", "started"),
            ("down", "ArrowLeft"),
            ("run", 600),
            ("up", "ArrowLeft"),
            ("down", SPACE),
            ("run", 1200),
            ("up", SPACE),
            ("down", "d"),
            ("run", 700),
            ("up", "d"),
            ("pad", "fire", True),
            ("run", 800),
            ("pad", "fire", False),
            ("pad", "left", True),
            ("run", 400),
            ("pad", "left", False),
            ("check", "keys"),
            ("shot", "mid"),
            ("press", "p"),
            ("check", "paused"),
            ("run", 500),
            ("check", "held"),
            ("press", "Escape"),
            ("run", 400),
            ("check", "resumed"),
            ("hide",),
            ("check", "hidden"),
            ("click", "#ll-pause"),
            ("run", 400),
            ("check", "menu-resume"),
            ("down", SPACE),
            ("run", 300),
            ("leave",),
            ("check", "returned"),
            ("click", "#ll-pause"),
            ("run", 600),
            ("check", "returned-and-playing"),
            ("over",),
            ("check", "over"),
            ("shot", "end"),
            ("leave",),
            ("check", "over-returned"),
        ],
    ),
    "lander": dict(
        id="ld2",
        api="__lander",
        seed=23,
        script=[
            ("check", "rest"),
            ("shot", "rest"),
            ("press", START_KEY),
            ("run", 300),
            ("check", "started"),
            ("down", "ArrowRight"),
            ("run", 500),
            ("up", "ArrowRight"),
            ("down", "ArrowUp"),
            ("run", 400),
            ("up", "ArrowUp"),
            ("pad", "thrust", True),
            ("run", 300),
            ("pad", "thrust", False),
            ("pad", "left", True),
            ("run", 300),
            ("pad", "left", False),
            ("check", "keys"),
            ("shot", "mid"),
            ("press", "Escape"),
            ("check", "escape"),
            ("run", 500),
            ("check", "held"),
            ("press", "P"),
            ("run", 500),
            ("check", "resumed"),
            ("hide",),
            ("check", "hidden"),
            ("click", "#ld2-pause"),
            ("run", 400),
            ("check", "menu-resume"),
            ("run", 1000),
            ("check", "falling"),
            ("leave",),
            ("check", "returned"),
            ("click", "#ld2-pause"),
            ("run", 600),
            ("check", "returned-and-playing"),
            ("until", "between"),
            ("check", "between"),
            ("run", 1500),
            ("check", "between-armed"),
            ("leave",),
            ("check", "between-returned"),
            ("click", "#ld2-pause"),
            ("run", 600),
            ("check", "next-lander"),
            ("over", [("press", START_KEY)]),
            ("check", "over"),
            ("shot", "end"),
            ("leave",),
            ("check", "over-returned"),
        ],
    ),
    "pinball": dict(
        id="pb",
        api="__pinball",
        seed=24,
        script=[
            ("check", "rest"),
            ("shot", "rest"),
            ("press", START_KEY),
            ("run", 300),
            ("check", "started"),
            ("down", SPACE),
            ("run", 700),
            ("up", SPACE),
            ("run", 1500),
            ("down", "z"),
            ("run", 200),
            ("up", "z"),
            ("down", "/"),
            ("run", 200),
            ("up", "/"),
            ("run", 1500),
            ("check", "launched"),
            ("shot", "mid"),
            ("press", "Escape"),
            ("check", "escape"),
            ("run", 500),
            ("check", "held"),
            ("press", "p"),
            ("run", 500),
            ("check", "resumed"),
            ("hide",),
            ("check", "hidden"),
            ("click", "#pb-pause"),
            ("run", 400),
            ("check", "menu-resume"),
            ("leave",),
            ("check", "returned"),
            ("click", "#pb-pause"),
            ("run", 600),
            ("check", "returned-and-playing"),
            ("over", PINBALL_BALL),
            ("check", "over"),
            ("shot", "end"),
            ("leave",),
            ("check", "over-returned"),
        ],
    ),
    "crossing": dict(
        id="cr",
        api="__crossing",
        seed=25,
        script=[
            ("check", "rest"),
            ("shot", "rest"),
            ("press", START_KEY),
            ("run", 300),
            ("check", "started"),
            ("press", "ArrowUp"),
            ("run", 400),
            ("press", "ArrowUp"),
            ("run", 400),
            ("press", "ArrowLeft"),
            ("run", 400),
            ("pad", "up", True),
            ("pad", "up", False),
            ("run", 400),
            ("pad", "right", True),
            ("pad", "right", False),
            ("run", 400),
            ("check", "keys"),
            ("shot", "mid"),
            ("press", "Escape"),
            ("check", "escape"),
            ("run", 500),
            ("check", "held"),
            ("press", "p"),
            ("run", 500),
            ("check", "resumed"),
            ("hide",),
            ("check", "hidden"),
            ("click", "#cr-pause"),
            ("run", 400),
            ("check", "menu-resume"),
            ("run", 1500),
            ("leave",),
            ("check", "returned"),
            ("click", "#cr-pause"),
            ("run", 600),
            ("check", "returned-and-playing"),
            ("over",),
            ("check", "over"),
            ("shot", "end"),
            ("leave",),
            ("check", "over-returned"),
        ],
    ),
    "muncher": dict(
        id="mn",
        api="__muncher",
        seed=26,
        script=[
            ("check", "rest"),
            ("shot", "rest"),
            ("press", START_KEY),
            ("run", 300),
            ("check", "started"),
            ("press", "ArrowLeft"),
            ("run", 700),
            ("press", "ArrowDown"),
            ("run", 700),
            ("pad", "right", True),
            ("pad", "right", False),
            ("run", 700),
            ("press", "ArrowUp"),
            ("run", 700),
            ("check", "keys"),
            ("shot", "mid"),
            ("press", "Escape"),
            ("check", "escape"),
            ("run", 500),
            ("check", "held"),
            ("press", "p"),
            ("run", 500),
            ("check", "resumed"),
            ("hide",),
            ("check", "hidden"),
            ("click", "#mn-pause"),
            ("run", 400),
            ("check", "menu-resume"),
            ("run", 1500),
            ("leave",),
            ("check", "returned"),
            ("click", "#mn-pause"),
            ("run", 600),
            ("check", "returned-and-playing"),
            ("over",),
            ("check", "over"),
            ("shot", "end"),
            ("leave",),
            ("check", "over-returned"),
        ],
    ),
    "quest": dict(
        id="qs",
        api="__quest",
        seed=27,
        script=[
            ("check", "rest"),
            ("shot", "rest"),
            ("press", START_KEY),
            ("run", 300),
            ("check", "started"),
            ("down", "ArrowRight"),
            ("run", 700),
            ("up", "ArrowRight"),
            ("down", "ArrowDown"),
            ("run", 500),
            ("up", "ArrowDown"),
            ("pad", "left", True),
            ("run", 400),
            ("pad", "left", False),
            ("press", "z"),
            ("run", 300),
            ("pad", "act", True),
            ("pad", "act", False),
            ("run", 300),
            ("check", "keys"),
            ("shot", "mid"),
            ("press", "Escape"),
            ("check", "escape"),
            ("run", 500),
            ("check", "held"),
            ("press", "p"),
            ("run", 500),
            ("check", "resumed"),
            ("hide",),
            ("check", "hidden"),
            ("click", "#qs-pause"),
            ("run", 400),
            ("check", "menu-resume"),
            ("down", "ArrowUp"),
            ("run", 300),
            ("leave",),
            ("check", "returned"),
            ("click", "#qs-pause"),
            ("run", 600),
            ("check", "returned-and-playing"),
            ("force", "__quest.st.events.push({ name: 'won' })"),
            ("run", 300),
            ("check", "over"),
            ("shot", "end"),
            ("leave",),
            ("check", "over-returned"),
        ],
    ),
}

FNV = "const fnv = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; };"

# The canvas is recorded as a coarse picture, not a hash of its pixels: the browser's rasteriser rounds a few edge pixels by one level
# differently from run to run under load (13 pixels of 400,000 on the Lander's hull), and a hash calls that a different game.
# THUMB_COLS x THUMB_ROWS cells of mean brightness, two hex digits each: a sprite one pixel off moves a cell by several levels, a
# rounding difference by a hundredth.
THUMB_COLS, THUMB_ROWS, THUMB_TOLERANCE = 24, 18, 1
THUMB = """const thumb = (c) => {
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    const x = t.getContext('2d'); x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data, cols = %d, rows = %d, sum = new Float64Array(cols * rows), n = new Float64Array(cols * rows);
    for (let y = 0; y < c.height; y++) for (let px = 0; px < c.width; px++) {
      const k = Math.min(rows - 1, Math.floor(y * rows / c.height)) * cols + Math.min(cols - 1, Math.floor(px * cols / c.width)), i = (y * c.width + px) * 4;
      sum[k] += (d[i] + d[i + 1] + d[i + 2]) / 3; n[k] += 1;
    }
    return Array.from(sum, (v, k) => Math.round(v / n[k]).toString(16).padStart(2, '0')).join('');
  };""" % (THUMB_COLS, THUMB_ROWS)


def same_picture(got, want):
    """Two thumbnails agree when no cell's mean brightness differs by more than the rounding the rasteriser is allowed."""
    if got is None or want is None:
        return got == want
    return len(got) == len(want) and all(abs(int(got[i:i + 2], 16) - int(want[i:i + 2], 16)) <= THUMB_TOLERANCE for i in range(0, len(got), 2))


CHECK = """
(g) => {
  %s
  %s
  const x = window[g.api], st = x.st, txt = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
  const p = document.querySelector('#' + g.id + '-pause'), nb = document.querySelector('#' + g.id + '-new'), sheet = document.querySelector('.ar-sheet:not([hidden])');
  return { mode: x.mode, score: st.score === undefined ? null : st.score, lives: st.lives === undefined ? null : st.lives, state: fnv(JSON.stringify(st)).toString(16),
    canvas: (() => { const c = document.querySelector('canvas'); return c ? thumb(c) : null; })(),
    hud: txt('.pl-hud'), msg: txt('#' + g.id + '-msg'), pause: p ? [p.textContent.trim(), p.disabled] : null, newHidden: nb ? nb.hidden : null, sheet: sheet ? sheet.textContent.trim() : null };
}
""" % (FNV, THUMB)

KEY = """
([type, key]) => { document.body.dispatchEvent(new KeyboardEvent(type, { key: key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true })); }
"""

PAD = """
([name, down]) => {
  const b = document.querySelector('[data-pad="' + name + '"]');
  const o = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', button: 0, clientX: 1, clientY: 1 };
  b.dispatchEvent(new PointerEvent(down ? 'pointerdown' : 'pointerup', o));
}
"""

HIDE = """
() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  delete document.hidden;
}
"""


@pytest.fixture(scope="module")
def served():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture()
def browser():   # (one browser per game: a canvas digest follows what the browser drew before it)
    with sync_playwright() as p:
        for kind in (p.webkit, p.chromium):
            try:
                b = kind.launch()
            except Exception:
                continue
            yield b
            b.close()
            return
        pytest.skip("no browser installed")


T0 = 1_700_000_000_000
PAUSE_AT = T0 + 60_000   # the clock stands still from here: only run_for moves it, so a run is the same every time


UP = "(api) => document.documentElement.classList.contains('gs-ready') && !!(window[api] && window[api].st)"


def open_page(page, url, api, first=False):
    page.goto(url)
    if first:
        page.wait_for_function(UP, arg=api)   # (the clock still runs: the page finishes loading before it is held)
        page.clock.pause_at(PAUSE_AT)   # (the clock stays paused across the reload that a leave makes)
    wait_up(page, api)
    page.clock.run_for(100)


def step_ms(step):
    return step[1] if step[0] == "run" else 0


POLL_MS = 48   # whole animation frames (16 ms): however many looks it takes for the page to come up, the frames after it fall the same


def wait_up(page, api):
    for _ in range(400):
        if page.evaluate(UP, api):
            return
        page.clock.run_for(POLL_MS)
    raise AssertionError("%s never came up" % api)


def play_out(browser, served, name, spec):
    ctx = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, device_scale_factor=2
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.clock.install(time=T0)
    page.add_init_script(INIT % {"seed": spec["seed"], "t0": T0})
    url = "%s/%s.html" % (served, name)
    open_page(page, url, spec["api"], first=True)
    cfg = dict(id=spec["id"], api=spec["api"])
    shots = os.environ.get("ZIMI_ARCADE_SHOTS")
    out = []

    def check(label):
        got = page.evaluate(CHECK, cfg)
        got["label"] = label
        if os.environ.get("ZIMI_ARCADE_DEBUG"):   # the whole state at each checkpoint, to diff two runs that differ
            os.makedirs(os.environ["ZIMI_ARCADE_DEBUG"], exist_ok=True)
            with open(os.path.join(os.environ["ZIMI_ARCADE_DEBUG"], "%s-%02d-%s.json" % (name, len(out), label)), "w") as f:
                f.write(page.evaluate("(api) => JSON.stringify(window[api].st)", spec["api"]))
        out.append(got)

    def execute(step):
        kind = step[0]
        if kind == "press":
            page.evaluate(KEY, ["keydown", step[1]])
            page.evaluate(KEY, ["keyup", step[1]])
        elif kind == "down":
            page.evaluate(KEY, ["keydown", step[1]])
        elif kind == "up":
            page.evaluate(KEY, ["keyup", step[1]])
        elif kind == "pad":
            page.evaluate(PAD, [step[1], step[2]])
        elif kind == "run":
            page.clock.run_for(step[1])
        elif kind == "hide":
            page.evaluate(HIDE)
        elif kind == "click":
            page.evaluate("(s) => document.querySelector(s).click()", step[1])
        elif kind == "force":
            page.evaluate("() => { " + step[1] + " }")
        elif kind == "check":
            check(step[1])
        elif kind == "shot":
            page.clock.run_for(1200)   # (with or without the picture: the same run either way)
            if shots:
                os.makedirs(shots, exist_ok=True)
                page.screenshot(
                    path=os.path.join(shots, "%s-%s.png" % (name, step[1])),
                    animations="disabled",
                )
        elif kind == "leave":
            before = page.evaluate("(api) => JSON.stringify(window[api].st)", spec["api"])
            was = page.evaluate("(api) => window[api].mode", spec["api"])   # (an end sheet and the next lander come back rebuilt, not as they were)
            page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
            open_page(page, url, spec["api"])
            after = page.evaluate("(api) => JSON.stringify(window[api].st)", spec["api"])
            assert was in ("over", "between") or after == before, "%s came back changed: %s" % (name, [k for k, v in json.loads(before).items() if json.loads(after).get(k) != v])
        elif kind in ("over", "until"):
            target = "over" if kind == "over" else step[1]
            body = step[-1] if isinstance(step[-1], list) else []
            waited = 0
            while page.evaluate("(api) => window[api].mode", spec["api"]) != target:
                for s in body:
                    execute(s)
                    waited += step_ms(s)
                page.clock.run_for(STEP_MS)
                waited += STEP_MS
                assert waited < MAX_WAIT_MS, "%s never reached %s" % (name, target)
            page.clock.run_for(1000)
        else:
            raise AssertionError(step)

    for step in spec["script"]:
        execute(step)
    assert not errors, errors
    ctx.close()
    return out


@pytest.mark.parametrize("name", sorted(SCRIPTS))
def test_the_game_plays_out_as_recorded(served, browser, name):
    got = play_out(browser, served, name, SCRIPTS[name])
    path = os.path.join(FIXTURES, name + ".json")
    if os.environ.get("ZIMI_RECORD_ARCADE"):
        os.makedirs(FIXTURES, exist_ok=True)
        with open(path, "w") as f:
            json.dump(got, f, indent=1, sort_keys=True)
            f.write("\n")
        return
    with open(path) as f:
        want = json.load(f)
    assert len(got) == len(want)
    for g, w in zip(got, want):
        assert same_picture(g.pop("canvas"), w.pop("canvas")), "checkpoint %r: the canvas differs" % w["label"]
        assert g == w, "checkpoint %r differs" % w["label"]
