"""The solitaire family plays out the same, move for move.

Klondike, FreeCell (the Microsoft deal numbers), Spider, Pyramid, Golf and TriPeaks are each dealt from a seeded
Math.random (ZimiUtil.mulberry32) and played by a scripted person on a fake clock: taps on cards, drags to piles, the stock,
Undo, the Menu and its options, a state forced to be one move (or one auto-move chain) from a win, and play on to the stuck
sheet or the win. At each step the table's digest (state, stat strip, fact line, sheet, every card's class and place, every
pile's mark) rolls into one trace; at each checkpoint the fixture also keeps the words on screen. Refactoring the page wiring
the games share (cards.js solitairePage) must leave the fixtures as they are.

Record (only for a change of rules or wording): ZIMI_RECORD_SOLITAIRE=1 pytest tests/test_games_solitaire_fixtures.py
Look at what the table showed: ZIMI_SOLITAIRE_DEBUG=<dir> writes each game's steps and checkpoints there.
Screenshots at 390 px in WebKit, one at each checkpoint, for a before/after compare of the pixels (nothing is asserted):
ZIMI_SOLITAIRE_SHOTS=<dir> pytest tests/test_games_solitaire_fixtures.py   (then cmp the two directories)
Run: pytest tests/test_games_solitaire_fixtures.py -v
"""

import json
import os
import sys
import time

import pytest

pytest.importorskip("playwright")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright  # noqa: E402
from test_games_trick_fixtures import GAMES, INIT, VIEW, served  # noqa: E402,F401

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures", "games_solitaire")
STEP_MS = 100  # the fake clock moves this far between two looks at the table
MAX_STEPS = int(os.environ.get("ZIMI_SOLITAIRE_STEPS", 3000))  # a stretch of play that has not reached its end after this is stuck

# CSS transitions and animations run on real time, not on the fake clock: with them off, where a card is when a drag starts and
# which class it still carries (animationend never comes) is the same on every run.
NO_MOTION = """
(() => {
  const s = document.createElement('style');
  s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  const put = () => (document.head || document.documentElement).appendChild(s);
  if (document.documentElement) put(); else document.addEventListener('DOMContentLoaded', put);
})();
"""

# Steps: ("play", n) n looks, one thing done at each; ("until", js, max) play until the expression (api, st, session, doc) is
# true; ("force", js) run js (api, st, session) to set the table; ("click", css, nth); ("tap", card id); ("text", word, nth) press the button with
# that text in the open sheet; ("run", ms); ("check", label) keeps the words and a digest of the table.
WIN_NEAR = [("force", "session.reset(api.almostWon())"), ("run", 300)]
STUCK = "doc.querySelector('.ar-sheet:not([hidden])') && api.isStuck && api.isStuck(st)"
END = "doc.querySelector('.ar-sheet:not([hidden]) .gs-primary') && session.won"
TAP_STOCK = "var e = document.querySelector('[data-pile=stock]'), o = { bubbles: true, pointerId: 1, pointerType: 'touch', button: 0, clientX: 1, clientY: 1 }; e.dispatchEvent(new PointerEvent('pointerdown', o)); e.dispatchEvent(new PointerEvent('pointerup', o))"
# FreeCell, one deal from the end: Q and J of spades are out of the foundation (J in a column, Q in a cell), the K alone.
FC_CHAIN = "var s = api.almostWon(), p = s.piles; p.c1.push(p.fd3.pop(), p.fd3.pop()); p.fr0.push(p.c1.shift()); session.reset(s)"

SHOTS = os.environ.get("ZIMI_SOLITAIRE_SHOTS")


@pytest.fixture(scope="function" if SHOTS else "module")   # (a browser per game for the shots: what an earlier game left it warm with shows in the pixels)
def browser():
    with sync_playwright() as p:
        for kind in [p.webkit] if SHOTS else [p.chromium, p.webkit]:
            try:
                b = kind.launch()
            except Exception:
                continue
            yield b
            b.close()
            return
        pytest.skip("no browser installed")


SCRIPTS = {
    "solitaire": dict(
        api="ZimiSolitaire",
        url="solitaire.html",
        seed=31,
        hseed=41,
        script=[
            ("check", "dealt"),
            ("play", 140),
            ("check", "played"),
            ("click", "#zc-undo", 0),
            ("click", "#zc-undo", 0),
            ("play", 60),
            ("check", "undone and on"),
            ("click", "#zc-menu", 0),
            ("check", "menu"),
            ("text", "Draw 3", 0),
            ("text", "New game", 0),
            ("check", "draw 3 dealt"),
            ("play", 200),
            ("check", "draw 3 played"),
            ("click", "#zc-new", 0),
            ("play", 30),
            # the last three clubs on a column, everything face up: the first of them home starts the auto-finish
            ("force", "var s = api.almostWon(1), k = s.piles.f0.splice(10, 3); s.piles.t1 = k; session.reset(s)"),
            ("run", 300),
            ("check", "auto-finish ready"),
            ("tap", 10),
            ("run", 1500),
            ("until", END, 400),
            ("check", "won, auto-finished"),
            ("text", "New game", 0),
            ("play", 20),
            ("check", "after the win"),
            # the shell's own menu: the game's options are taken from its Menu sheet into the New game pane
            ("click", ".gs-menu-btn", 0),
            ("check", "shell menu"),
            ("text", "New game", 0),
            ("check", "shell new game"),
            ("force", "ZimiShell.closeMenu()"),
            # Watch and learn: the computer plays the hand, a sentence before each step, until the person takes over
            ("click", ".gs-menu-btn", 0),
            ("text", "Watch and learn", 0),
            ("text", "Start watching", 0, "() => ZimiShell.isWatching()"),
            ("run", 400),
            ("check", "watching begins"),
            ("run", 30000),
            ("check", "watching, 30 s on"),
            ("run", 30000),
            ("check", "watching, 60 s on"),
            ("click", ".gs-watch-ctl button", 3),
            ("check", "taken over"),
            ("play", 30),
            ("check", "played on"),
        ],
    ),
    "freecell": dict(
        api="ZimiFreeCell",
        url="freecell.html?deal=1",
        seed=32,
        hseed=42,
        script=[
            ("check", "deal 1"),
            ("play", 160),
            ("check", "played"),
            ("click", "#zc-undo", 0),
            ("play", 40),
            ("click", "#zc-menu", 0),
            ("check", "menu"),
            (
                "force",
                "var i = document.querySelector('.ar-sheet input'); i.value = '617'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))",
            ),
            ("run", 300),
            ("check", "deal 617"),
            ("play", 160),
            ("check", "deal 617 played"),
            ("click", "#zc-new", 0),
            ("play", 60),
            ("check", "random deal"),
            ("force", FC_CHAIN),
            ("run", 300),
            ("check", "auto chain ready"),
            ("tap", 49),
            ("run", 1500),
            ("until", END, 400),
            ("check", "won, auto-moved"),
            ("text", "New game", 0),
            ("click", "#zc-menu", 0),
            ("text", "Off", 0),
            ("text", "Close", 0),
            ("force", FC_CHAIN),
            ("run", 300),
            ("tap", 49),
            ("run", 600),
            ("check", "auto off, one home"),
            ("tap", 50),
            ("tap", 51),
            ("run", 600),
            ("check", "auto off, played by hand"),
            ("until", END, 400),
            ("check", "won by hand"),
            ("click", ".gs-menu-btn", 0),
            ("check", "shell menu"),
            ("text", "New game", 0),
            ("check", "shell new game"),
            ("force", "ZimiShell.closeMenu()"),
        ],
    ),
    "spider": dict(
        api="ZimiSpider",
        url="spider.html",
        seed=33,
        hseed=43,
        script=[
            ("check", "dealt"),
            ("play", 160),
            ("check", "played"),
            ("click", "#zc-undo", 0),
            ("play", 40),
            ("click", "#zc-menu", 0),
            ("text", "2 suits", 0),
            ("text", "Close", 0),
            ("click", "#zc-new", 0),
            ("play", 160),
            ("check", "two suits played"),
            ("force", "var s = JSON.parse(JSON.stringify(st)); s.piles.c9 = []; s.piles.stock.length || s.piles.stock.push(s.piles.c0.pop()); session.follow(s)"),
            ("run", 100),
            ("force", TAP_STOCK),
            ("check", "stock refused"),
            ("run", 2600),
            ("check", "refusal gone"),
            *WIN_NEAR,
            ("check", "one move from a win"),
            ("play", 6),
            ("until", END, 600),
            ("check", "won"),
            ("text", "New game", 0),
            ("play", 10),
            ("check", "after the win"),
            ("click", ".gs-menu-btn", 0),
            ("check", "shell menu"),
            ("text", "New game", 0),
            ("check", "shell new game"),
            ("force", "ZimiShell.closeMenu()"),
        ],
    ),
    "pyramid": dict(
        api="ZimiPyramid",
        url="pyramid.html",
        seed=34,
        hseed=44,
        script=[
            ("check", "dealt"),
            ("play", 40),
            ("check", "played"),
            ("click", "#zc-undo", 0),
            ("play", 10),
            ("click", "#zc-menu", 0),
            ("check", "menu"),
            ("text", "Close", 0),
            ("until", STUCK, MAX_STEPS),
            ("check", "stuck"),
            ("text", "Undo", 0),
            ("check", "stuck, undone"),
            ("play", 6),
            ("until", STUCK, MAX_STEPS),
            ("check", "stuck again"),
            ("text", "New game", 0),
            ("play", 30),
            ("check", "next game"),
            *WIN_NEAR,
            ("check", "one pair from a win"),
            ("play", 6),
            ("until", END, 600),
            ("check", "won"),
            ("click", ".gs-menu-btn", 0),
            ("check", "shell menu"),
            ("text", "New game", 0),
            ("check", "shell new game"),
            ("force", "ZimiShell.closeMenu()"),
        ],
    ),
    "golf": dict(
        api="ZimiGolf",
        url="golf.html",
        seed=35,
        hseed=45,
        script=[
            ("check", "dealt"),
            ("play", 12),
            ("check", "played"),
            ("click", "#zc-undo", 0),
            ("play", 6),
            ("click", "#zc-menu", 0),
            ("check", "menu"),
            ("text", "Close", 0),
            ("until", STUCK, MAX_STEPS),
            ("check", "out of moves"),
            ("text", "Undo", 0),
            ("check", "out of moves, undone"),
            ("play", 4),
            ("until", STUCK, MAX_STEPS),
            ("check", "out of moves again"),
            ("text", "New game", 0),
            ("play", 20),
            ("check", "next game"),
            *WIN_NEAR,
            ("check", "one card from a win"),
            ("play", 4),
            ("until", END, 600),
            ("check", "won"),
            ("click", ".gs-menu-btn", 0),
            ("check", "shell menu"),
            ("text", "New game", 0),
            ("check", "shell new game"),
            ("force", "ZimiShell.closeMenu()"),
        ],
    ),
    "tripeaks": dict(
        api="ZimiTriPeaks",
        url="tripeaks.html",
        seed=36,
        hseed=47,
        script=[
            ("check", "dealt"),
            ("play", 30),
            ("check", "played"),
            ("click", "#zc-undo", 0),
            ("play", 8),
            ("click", "#zc-menu", 0),
            ("check", "menu"),
            ("text", "Close", 0),
            ("until", STUCK, MAX_STEPS),
            ("check", "stuck"),
            ("text", "Undo", 0),
            ("check", "stuck, undone"),
            ("play", 4),
            ("until", STUCK, MAX_STEPS),
            ("check", "stuck again"),
            ("text", "New game", 0),
            ("play", 20),
            ("check", "next game"),
            *WIN_NEAR,
            ("check", "one card from a win"),
            ("play", 4),
            ("until", END, 600),
            ("check", "won"),
            ("click", ".gs-menu-btn", 0),
            ("check", "shell menu"),
            ("text", "New game", 0),
            ("check", "shell new game"),
            ("force", "ZimiShell.closeMenu()"),
        ],
    ),
}

# One look at the table, then (in mode 'act') at most one thing done by the scripted person; returns what it did.
DRIVER = """
(cfg) => {
  const w = window, api = w[cfg.api], doc = document, session = api.session;
  if (!w.__h) w.__h = { rng: w.ZimiUtil.mulberry32(cfg.hseed), trace: [], snaps: [], plays: [], digest: 2166136261, lastSnap: '' };
  const h = w.__h, st = session.state;
  const fnv = (s, d) => { let x = d >>> 0; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; };
  const text = (sel) => { const e = doc.querySelector(sel); return e ? e.textContent : ''; };
  const idOf = (c) => (c && typeof c === 'object') ? c.id : c;
  // (zc-instant marks a resize's re-render, which the browser's observer reports when it likes: not part of the table)
  const table = [...doc.querySelectorAll('.zc-card')].map((e) => e.getAttribute('data-id') + ':' + e.className.replace(' zc-instant', '') + ':' + (e.style.transform || '').replace(/-?\\d+\\.\\d+/g, (n) => Math.round(+n)) + ':' + e.style.zIndex).join('|')
    + '#' + [...doc.querySelectorAll('.zc-slot')].map((e) => e.getAttribute('data-pile') + ':' + (e.getAttribute('data-mark') || '') + ':' + e.getAttribute('aria-label')).join('|');
  const undo = doc.getElementById('zc-undo');
  const snap = JSON.stringify([fnv(JSON.stringify(st), 0), st.moves, text('#zc-stat'), text('.zc-fact'), text('#zc-sub'), undo && undo.disabled, text('.ar-sheet:not([hidden])'), !!doc.querySelector('.zc-cascade'), text('.zc-live'), text('.gs-watch-text'), fnv(table, 0)]);
  if (snap !== h.lastSnap) { h.lastSnap = snap; h.digest = fnv(snap, h.digest); h.trace.push(h.digest.toString(16).padStart(8, '0')); h.snaps.push(snap); }
  if (cfg.mode === 'look') return null;
  if (cfg.mode === 'check') {
    return { label: cfg.label, state: fnv(JSON.stringify(st), 0).toString(16), moves: st.moves, stat: text('#zc-stat'), fact: text('.zc-fact'), sub: text('#zc-sub'),
      sheet: text('.ar-sheet:not([hidden])'), watch: text('.gs-watch-text'), undoOff: !!(undo && undo.disabled), won: session.won, table: fnv(table, 0).toString(16), raw: cfg.raw ? table : undefined, html: cfg.raw ? doc.documentElement.outerHTML : undefined };
  }
  // (nothing is drawn from the person's rng while the table is not theirs: how long a cascade takes depends on the browser)
  if (doc.querySelector('.ar-sheet:not([hidden])') || doc.querySelector('.zc-cascade') || doc.querySelector('.zc-dealing') || session.won) return null;
  const r = h.rng();
  const pick = (list) => list[Math.floor(h.rng() * list.length)];
  const tap = (el) => {
    const o = { bubbles: true, pointerId: 1, pointerType: 'touch', button: 0, clientX: 1, clientY: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o));
  };
  const cardEl = (id) => doc.querySelector('.zc-card[data-id="' + id + '"]');
  const centre = (el) => { const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
  // A drag, in small steps as a finger goes (the page's own pointer events: a real mouse's moves wait for a frame the fake clock never draws).
  const drag = (el, to) => {
    const a = centre(el), t = doc.getElementById('zc-table');
    const ev = (type, x, y) => new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y });
    el.dispatchEvent(ev('pointerdown', a[0], a[1]));
    for (let k = 1; k <= 5; k++) t.dispatchEvent(ev('pointermove', a[0] + (to[0] - a[0]) * k / 5, a[1] + (to[1] - a[1]) * k / 5));
    t.dispatchEvent(ev('pointerup', to[0], to[1]));
  };
  const topOf = (pile) => idOf(st.piles[pile][st.piles[pile].length - 1]);
  const moves = [];
  if (api.findMove) {
    const m = api.findMove(st);
    if (m) moves.push({ from: m.from, to: m.to, pair: true, id: topOf(m.from) });
  } else {
    Object.keys(st.piles).forEach((pile) => {
      if (pile === 'stock' || pile === 'out') return;
      const p = st.piles[pile];
      for (let idx = 0; idx < p.length; idx++) {
        if (!api.canPick(st, pile, idx)) continue;
        const to = api.bestMove(st, pile, idx);
        if (to) moves.push({ from: pile, idx: idx, to: to, id: idOf(p[idx]) });
      }
    });
  }
  const stock = st.piles.stock || [];
  const stockTry = stock.length > 0 || !!(api.drawStock && api.drawStock(st)) || !!(api.dealRow && api.dealRow(st));
  const tapStock = () => {
    const el = stock.length ? cardEl(idOf(stock[stock.length - 1])) : doc.querySelector('.zc-slot[data-pile="stock"]');
    if (!el) return null;
    tap(el); h.plays.push('stock'); return 'stock';
  };
  if (r < 0.08) {
    const seen = [...doc.querySelectorAll('.zc-card:not(.zc-off)')];
    if (!seen.length) return null;
    const el = pick(seen); tap(el); h.plays.push('stray:' + el.getAttribute('data-id')); return 'stray';
  }
  if (!moves.length) return stockTry ? tapStock() : null;
  const m = pick(moves);
  if (r < 0.2 && stockTry) return tapStock();
  if (r < 0.4 && !m.pair) {
    const from = cardEl(m.id), to = doc.querySelector('.zc-slot[data-pile="' + m.to + '"]');
    if (from && to) { h.plays.push('drag:' + m.id + '>' + m.to); drag(from, centre(to)); return 'drag'; }
  }
  if (m.pair) {
    // a pair: tap the first card, then (it shows picked) the second; a king is taken by one tap
    const picked = doc.querySelector('.zc-card.zc-sel');
    const el = cardEl(picked && m.to !== 'out' ? topOf(m.to) : m.id);
    if (!el) return null;
    tap(el); h.plays.push('pair:' + m.from + '>' + m.to); return 'pair';
  }
  const el = cardEl(m.id);
  if (!el) return null;
  tap(el); h.plays.push('tap:' + m.id + '>' + m.to); return 'tap';
}
"""

# A position with no move left (FreeCell's dead end) opens a sheet; the scripted person takes the Undo it offers, wherever
# in the script that happens.
DEAD_END = """
(name) => {
  const api = window[name], sheet = document.querySelector('.ar-sheet:not([hidden])');
  if (!api.hasMove || !sheet || api.session.won || api.hasMove(api.session.state)) return false;
  const undo = [...sheet.querySelectorAll('button')].filter((x) => x.textContent.trim() === 'Undo')[0];
  if (!undo) return false;
  undo.click(); window.__h.plays.push('dead-end');
  return true;
}
"""

SHEET_BUTTON = """
([text, nth]) => {
  const sheet = document.querySelector('.ar-sheet:not([hidden])');
  if (!sheet) throw new Error('no sheet is open for ' + text);
  const b = [...sheet.querySelectorAll('button')].filter((x) => x.textContent.trim().toLowerCase() === text.toLowerCase())[nth];
  if (!b) throw new Error('no button "' + text + '" in the sheet: ' + sheet.textContent);
  b.click();
}
"""


def in_page(body):
    """A js function of the game's name that runs `body` with api, st, session, doc in hand."""
    return "(name) => { const api = window[name], session = api.session, st = session.state, doc = document; %s }" % body


def dump(name, snaps, checks, plays=()):
    debug = os.environ.get("ZIMI_SOLITAIRE_DEBUG")
    if not debug:
        return
    os.makedirs(debug, exist_ok=True)
    with open(os.path.join(debug, name + ".txt"), "w") as f:
        f.write("\n".join(snaps) + "\n")
    with open(os.path.join(debug, name + ".plays.txt"), "w") as f:
        f.write("\n".join(plays) + "\n")
    with open(os.path.join(debug, name + ".checks.json"), "w") as f:
        json.dump(checks, f, indent=1)


def wait_for(page, js, name):
    for _ in range(400):
        if page.evaluate(js):
            return
        time.sleep(0.025)
    raise AssertionError("%s: %r never became true" % (name, js))


def play_out(browser, served, name, spec):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e) + " " + str(getattr(e, "stack", "") or "")[:600]))
    page.clock.install(time=1_700_000_000_000)
    page.clock.pause_at(1_700_000_001_000)  # installed alone, the clock keeps real time: now it moves only when the script says so
    page.add_init_script(path=os.path.join(GAMES, "util.js"))
    page.add_init_script(INIT % {"seed": spec["seed"]})
    page.add_init_script(NO_MOTION)
    page.goto("%s/%s" % (served, spec["url"]))
    api = spec["api"]
    up = "() => !!(window.%s && %s.session && %s.session.state)" % ((api,) * 3)
    for _ in range(200):
        if page.evaluate(up):
            break
        page.clock.run_for(STEP_MS)
    cfg = dict(api=api, hseed=spec["hseed"], raw=bool(os.environ.get("ZIMI_SOLITAIRE_DEBUG")))

    def look(mode="look", **more):
        return page.evaluate(DRIVER, dict(cfg, mode=mode, **more))

    def act():
        if not page.evaluate(DEAD_END, api):
            look("act")
        page.clock.run_for(STEP_MS)

    checks = []
    for step in spec["script"]:
        kind = step[0]
        if kind not in ("play", "until"):
            page.evaluate(DEAD_END, api)
        if kind == "play":
            for _ in range(step[1]):
                act()
        elif kind == "until":
            cond = in_page("return !!(%s);" % step[1])
            for _ in range(step[2]):
                if page.evaluate(cond, api):
                    break
                act()
            else:
                dump(name, page.evaluate("() => window.__h.snaps"), checks)
                raise AssertionError("%s never reached %r (%d steps); the page said %s" % (name, step[1], step[2], errors[:3]))
        elif kind == "force":
            page.evaluate(in_page(step[1]), api)
            page.clock.run_for(STEP_MS)
        elif kind == "click":
            page.evaluate("([sel, n]) => document.querySelectorAll(sel)[n].click()", [step[1], step[2]])
            page.clock.run_for(STEP_MS)
        elif kind == "text":  # a button of the open sheet; a fourth item is what a script it brings in makes true (waited for in real time)
            page.evaluate(SHEET_BUTTON, [step[1], step[2]])
            if len(step) > 3:
                wait_for(page, step[3], name)
            page.clock.run_for(STEP_MS)
        elif kind == "tap":  # one card, by id
            page.evaluate("(id) => { const e = document.querySelector('.zc-card[data-id=\"' + id + '\"]'), o = { bubbles: true, pointerId: 1, pointerType: 'touch', button: 0, clientX: 1, clientY: 1 }; e.dispatchEvent(new PointerEvent('pointerdown', o)); e.dispatchEvent(new PointerEvent('pointerup', o)); }", step[1])
            page.clock.run_for(STEP_MS)
        elif kind == "ready":  # a script the page fetches on demand has arrived (real time: the fake clock cannot wait for a network)
            wait_for(page, step[1], name)
        elif kind == "run":
            page.clock.run_for(step[1])
        elif kind == "check":
            checks.append({k: v for k, v in look("check", label=step[1]).items() if v is not None})  # (raw and html are for debugging)
            if SHOTS:
                os.makedirs(SHOTS, exist_ok=True)
                time.sleep(0.4)  # the browser rasterises card faces on its own time: let it finish
                page.screenshot(path=os.path.join(SHOTS, "%s-%02d.png" % (name, len(checks))))
        else:
            raise AssertionError("unknown step %r" % (step,))
        look()
    out = page.evaluate("() => ({ trace: window.__h.trace, snaps: window.__h.snaps, plays: window.__h.plays })")
    assert not errors, errors
    ctx.close()
    dump(name, out["snaps"], checks, out["plays"])
    return {
        "seed": spec["seed"],
        "hseed": spec["hseed"],
        "plays": " ".join(out["plays"]),
        "checks": checks,
        "events": len(out["trace"]),
        "trace": "".join(out["trace"]),
    }


@pytest.mark.parametrize("name", sorted(SCRIPTS))
def test_the_game_plays_out_as_recorded(served, browser, name):
    got = play_out(browser, served, name, SCRIPTS[name])
    if SHOTS:
        return
    path = os.path.join(FIXTURES, name + ".json")
    if os.environ.get("ZIMI_RECORD_SOLITAIRE"):
        os.makedirs(FIXTURES, exist_ok=True)
        with open(path, "w") as f:
            json.dump(got, f, indent=1, sort_keys=True)
            f.write("\n")
        return
    with open(path) as f:
        want = json.load(f)
    assert got["plays"] == want["plays"], "the cards were played differently"
    assert len(got["checks"]) == len(want["checks"]), "a different number of checkpoints"
    for g, w in zip(got["checks"], want["checks"]):
        assert g == w, "the table at %r differed" % w["label"]
    assert got["events"] == want["events"], "the table changed a different number of times"
    first = next(
        (
            i
            for i in range(0, min(len(got["trace"]), len(want["trace"])), 8)
            if got["trace"][i : i + 8] != want["trace"][i : i + 8]
        ),
        None,
    )
    assert first is None, "the table showed something different at change %d" % (first // 8)
