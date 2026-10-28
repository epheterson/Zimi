"""The trick-taking card games play out the same, move for move.

Each game is dealt from a seeded Math.random (ZimiUtil.mulberry32) and played by a scripted person (seat 0, its own
seeded choices) against its computers, on a fake clock, for two whole hands and then the hand that ends the game. The
fixture holds what came of it: every play in order, the state at the end of each hand, the text of every result
sheet, and a rolling digest of everything the table showed (status line, score chips, sheets, the state itself) at
each change. Refactoring the shared mechanics (cardtable.js trickGame) must leave the fixtures as they are.

Record (only for a change of rules or wording): ZIMI_RECORD_TRICKS=1 pytest tests/test_games_trick_fixtures.py
Look at what the table showed: ZIMI_TRICK_DEBUG=<dir> writes each game's changes there, one line each.
Run: pytest tests/test_games_trick_fixtures.py -v
"""

import functools
import http.server
import json
import os
import sys
import threading

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import shell_ready  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
GAMES = os.environ.get("ZIMI_GAMES_DIR") or os.path.join(os.path.dirname(HERE), "zimi", "builtin", "games")  # (a copy with a deliberate change proves the fixtures notice)
FIXTURES = os.path.join(HERE, "fixtures", "games_tricks")
VIEW = {"width": 390, "height": 844}
STEP_MS = 100  # the fake clock moves this far between two looks at the table
MAX_STEPS = int(os.environ.get("ZIMI_TRICK_STEPS", 12000))  # a game that has not finished after this much fake time is stuck
TAIL_STEPS = 120  # after the game is over: let the end sheet and the cascade come up
HANDS_BEFORE_END = 2  # whole hands played before the last one is made to end the game

# The game's exported rules, the seed of the deal, the seed of the person, the phase a hand ends in, how the third hand is
# brought one hand from the end of the game, and (where the person puts cards away first) when and how many.
GAMES_UNDER_TEST = {
    "spades": dict(
        api="ZimiSpades",
        seed=11,
        hseed=5,
        hand_end="handEnd",
        near="s.scores = [900, 100]",
    ),
    "euchre": dict(
        api="ZimiEuchre",
        seed=12,
        hseed=6,
        hand_end="handEnd",
        near="s.scores = [9, 9]",
        select=dict(when="st.phase === 'discard' && st.dealer === 0", n=1),
    ),
    "belote": dict(
        api="ZimiBelote",
        seed=13,
        hseed=7,
        hand_end="handEnd",
        near="s.scores = [495, 495]",
    ),
    "skat": dict(
        api="ZimiSkat",
        seed=14,
        hseed=8,
        hand_end="handEnd",
        near="s.round = s.rounds - 1",
        select=dict(when="st.phase === 'discard' && st.declarer === 0", n=2),
    ),
    "bridge": dict(
        api="ZimiBridge", seed=15, hseed=9, hand_end="dealEnd", near="s.dealNo = 3"
    ),
    "hearts": dict(
        api="ZimiHearts",
        seed=16,
        hseed=10,
        hand_end="handEnd",
        near="s.scores = [60, 99, 99, 99]",
        select=dict(when="st.phase === 'pass'", n=3),
    ),
}

INIT = """
(() => {
  let rng = null;
  const seed = %(seed)d;
  Math.random = function () {
    if (!rng) { if (!window.ZimiUtil) throw new Error('util.js is not loaded'); rng = window.ZimiUtil.mulberry32(seed); }
    return rng();
  };
})();
"""

# The scripted person. One look at the table, at most one thing done; returns a word for what it did, or null.
DRIVER = """
(cfg) => {
  const w = window, api = w[cfg.api], doc = document;
  if (!w.__h) w.__h = { rng: w.ZimiUtil.mulberry32(cfg.hseed), sel: [], selKey: '', pending: null, trace: [], snaps: [], plays: [], digest: 2166136261, hands: [], lastSnap: '', handsDone: 0, over: 0, nearDone: false };
  const h = w.__h, st = api.session.state;
  const fnv = (s, d) => { let x = d >>> 0; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; };
  const text = (sel) => { const e = doc.querySelector(sel); return e ? e.textContent : ''; };
  const pick = (list) => list[Math.floor(h.rng() * list.length)];
  const snap = JSON.stringify([fnv(JSON.stringify(st), 0), st.moves, st.phase, st.turn, text('.ct-status-text'), text('.ct-scores'), text('.ar-sheet'), text('.br-auction'), text('.ct-panel')]);
  if (snap !== h.lastSnap) {
    h.lastSnap = snap; h.digest = fnv(snap, h.digest);
    h.trace.push(h.digest.toString(16).padStart(8, '0')); h.snaps.push(snap);
  }
  // Every card played, in order (a new play is a longer trick, or the trick starting over).
  const key = JSON.stringify([st.moves, st.phase]);
  if (key !== h.lastKey) {
    h.lastKey = key;
    const t = st.trick || [];
    if (t.length && (!h.lastTrick || t.length > h.lastTrick.length || t[0].id !== h.lastTrick[0].id)) h.plays.push(t[t.length - 1].seat + ':' + t[t.length - 1].id);
    h.lastTrick = t.map((x) => ({ seat: x.seat, id: x.id }));
  }
  const ended = st.phase === cfg.handEnd;
  if (ended && !h.wasEnded) {
    h.handsDone++;
    h.hands.push({ state: fnv(JSON.stringify(st), 0).toString(16), scores: st.scores || st.totals, sheet: text('.ar-sheet'), plays: h.plays.length });
  }
  h.wasEnded = ended;
  if (st.phase === 'over') {
    h.over++;
    return h.over > cfg.tail ? 'done' : null;
  }
  // The third hand has just been dealt: bring it one hand from the end of the game.
  if (h.handsDone >= cfg.hands && !h.nearDone && st.moves === 0) {
    h.nearDone = true;
    const s = JSON.parse(JSON.stringify(st));
    new Function('s', cfg.near)(s);
    api.session.follow(s);
    return 'near';
  }
  const sheet = doc.querySelector('.ar-sheet-actions .gs-primary');
  if (sheet) { sheet.click(); return 'sheet'; }
  const status = doc.querySelector('.ct-status .ar-btn');
  if (status && !status.hidden && !status.disabled) { status.click(); return 'status'; }
  const choices = [...doc.querySelectorAll('.ct-choice:not([disabled]), .br-bid:not([disabled])')];
  if (choices.length) { pick(choices).click(); return 'choice'; }
  const tap = (id) => {
    const el = doc.querySelector('.zc-card[data-id="' + id + '"]');
    if (!el || doc.querySelector('.zc-dealing')) return false;   // a tap while the cards are still coming out is ignored
    const o = { bubbles: true, pointerId: 1, pointerType: 'touch', button: 0, clientX: 1, clientY: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o));
    return true;
  };
  if (cfg.select && new Function('st', 'return ' + cfg.select.when)(st)) {
    const sk = st.phase + ':' + st.moves + ':' + h.handsDone;
    if (h.selKey !== sk) { h.selKey = sk; h.sel = []; }
    if (h.sel.length < cfg.select.n) {
      const id = pick(st.hands[0].filter((c) => h.sel.indexOf(c) < 0));
      if (tap(id)) { h.sel.push(id); return 'select'; }
    }
    return null;
  }
  if (st.phase !== 'play') return null;
  const seat = api.controller ? st.turn : 0;
  if (api.controller && api.controller(st, st.turn) !== 0) return null;
  const legal = (st.hands[seat] || []).filter((c) => api.isLegal(st, seat, c));
  if (!legal.length) return null;
  // A card that waits for its second tap is tapped again until the table moves.
  if (h.pending && h.pending.moves === st.moves && legal.indexOf(h.pending.id) >= 0) { tap(h.pending.id); return 'again'; }
  const id = pick(legal);
  h.pending = { id: id, moves: st.moves };
  tap(id);
  return 'play';
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


def play_out(browser, served, name, spec):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.clock.install(time=1_700_000_000_000)
    page.clock.pause_at(1_700_000_001_000)  # installed, the clock still runs with the wall; paused, only run_for moves it
    page.add_init_script(path=os.path.join(GAMES, "util.js"))  # ZimiUtil.mulberry32: the pages that do not load it get it
    page.add_init_script(INIT % {"seed": spec["seed"]})
    page.goto("%s/%s.html" % (served, name))
    shell_ready(page)  # the page's own loading takes real time, which the paused clock does not count
    up = "() => !!(window.%s && %s.session && %s.session.state)" % ((spec["api"],) * 3)
    for _ in range(200):  # the page is up when the game has a table (its own timers run on the fake clock)
        if page.evaluate(up):
            break
        page.clock.run_for(STEP_MS)
    cfg = dict(
        api=spec["api"],
        hseed=spec["hseed"],
        handEnd=spec["hand_end"],
        hands=HANDS_BEFORE_END,
        near=spec["near"],
        tail=TAIL_STEPS,
        select=spec.get("select"),
    )
    for step in range(MAX_STEPS):
        if page.evaluate(DRIVER, cfg) == "done":
            break
        page.clock.run_for(STEP_MS)
    else:
        if os.environ.get("ZIMI_TRICK_DEBUG"):
            os.makedirs(os.environ["ZIMI_TRICK_DEBUG"], exist_ok=True)
            with open(os.path.join(os.environ["ZIMI_TRICK_DEBUG"], name + ".txt"), "w") as f:
                f.write("\n".join(page.evaluate("() => window.__h.snaps")) + "\n")
        raise AssertionError("%s never finished (%d steps); the page said %s" % (name, MAX_STEPS, errors[:3]))
    out = page.evaluate(
        """(cfg) => { const h = window.__h, st = window[cfg.api].session.state;
        return { trace: h.trace, snaps: h.snaps, plays: h.plays, hands: h.hands, final: { phase: st.phase, scores: st.scores || st.totals, size: JSON.stringify(st).length, sheet: (document.querySelector('.ar-sheet') || {}).textContent || '' } }; }""",
        cfg,
    )
    assert not errors, errors
    ctx.close()
    debug = os.environ.get("ZIMI_TRICK_DEBUG")
    if debug:
        os.makedirs(debug, exist_ok=True)
        with open(os.path.join(debug, name + ".txt"), "w") as f:
            f.write("\n".join(out["snaps"]) + "\n")
    return {
        "seed": spec["seed"],
        "hseed": spec["hseed"],
        "plays": " ".join(out["plays"]),
        "hands": out["hands"],
        "final": out["final"],
        "events": len(out["trace"]),
        "trace": "".join(out["trace"]),
    }


@pytest.mark.parametrize("name", sorted(GAMES_UNDER_TEST))
def test_the_game_plays_out_as_recorded(served, browser, name):
    got = play_out(browser, served, name, GAMES_UNDER_TEST[name])
    path = os.path.join(FIXTURES, name + ".json")
    if os.environ.get("ZIMI_RECORD_TRICKS"):
        os.makedirs(FIXTURES, exist_ok=True)
        with open(path, "w") as f:
            json.dump(got, f, indent=1, sort_keys=True)
            f.write("\n")
        return
    with open(path) as f:
        want = json.load(f)
    assert got["plays"] == want["plays"], "the cards were played differently"
    assert got["hands"] == want["hands"], "a hand ended differently"
    assert got["final"] == want["final"], "the game ended differently"
    assert (
        got["events"] == want["events"]
    ), "the table changed a different number of times"
    first = next(
        (
            i
            for i in range(0, min(len(got["trace"]), len(want["trace"])), 8)
            if got["trace"][i : i + 8] != want["trace"][i : i + 8]
        ),
        None,
    )
    assert first is None, "the table showed something different at change %d" % (
        first // 8
    )
