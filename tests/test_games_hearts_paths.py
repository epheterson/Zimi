"""Hearts' two paths the trick fixtures leave out: Watch and learn, and the hot-seat table.

Watch and learn: from the shell's menu the computer plays South as well, a sentence before each step (the driver's pace runs
on the fake clock), the pass and the tricks included, until the person takes over and plays the hand out. Hot-seat: two people
at one device (seats 0 and 1, the other two computers), every hand behind the "Pass to <name>" screen, the pass picked in turn,
the tricks played, one hand to the game's end. Both are dealt from a seeded Math.random and played by a scripted person on a
fake clock; the fixture holds every card played, the words of each checkpoint and a rolling digest of everything the table
showed (status line, score chips, sheets, the handoff, the watch strip, the state). Refactoring the trick mechanics
(cardtable.js trickGame) or the page must leave them as they are.

Record (only for a change of rules or wording): ZIMI_RECORD_TRICKS=1 pytest tests/test_games_hearts_paths.py
Look at what the table showed: ZIMI_TRICK_DEBUG=<dir> writes each path's changes there, one line each.
Run: pytest tests/test_games_hearts_paths.py -v
"""

import json
import os
import sys
import time

import pytest

pytest.importorskip("playwright")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_trick_fixtures import FIXTURES, GAMES, INIT, STEP_MS, VIEW, browser, served  # noqa: E402,F401

SHEET = ".ar-sheet:not([hidden])"
MAX_STEPS = int(os.environ.get("ZIMI_TRICK_STEPS", 12000))
PEOPLE_KEYS = (
    "(() => { localStorage.setItem('zimi.games.hearts.seats', JSON.stringify({ kinds: %s })); "
    "localStorage.setItem('zimi.games.players', JSON.stringify(['Ava', 'Bo', 'Cy', 'Di'])); })();"
)
NO_MOTION = """
(() => {
  const s = document.createElement('style');
  s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  const put = () => (document.head || document.documentElement).appendChild(s);
  if (document.documentElement) put(); else document.addEventListener('DOMContentLoaded', put);
})();
"""

PATHS = {
    "hearts_hotseat": dict(
        seed=17,
        hseed=11,
        kinds=["person", "person", "cpu", "cpu"],
        people=[0, 1],
        script=[
            ("check", "dealt behind a handoff"),
            ("play", 30),
            ("check", "pass picked"),
            ("until", "st.handNo >= 1", 3000),
            ("check", "a hand played"),
            ("force", "var s = JSON.parse(JSON.stringify(st)); s.scores = [60, 99, 99, 99]; api.session.follow(s)"),
            ("until", "st.phase === 'over'", 6000),
            ("run", 400),
            ("check", "game over"),
        ],
    ),
    "hearts_watch": dict(
        seed=18,
        hseed=12,
        kinds=None,
        people=[0],
        script=[
            ("check", "dealt"),
            ("click", ".gs-menu-btn", 0),
            ("text", "Watch and learn", 0),
            ("text", "Start watching", 0, "() => ZimiShell.isWatching()"),
            ("run", 600),
            ("check", "watching begins"),
            ("watch", 40),
            ("check", "watching, first tricks"),
            ("watch", 120),
            ("check", "watching, a hand on"),
            ("click", ".gs-watch-ctl button", 0),
            ("run", 600),
            ("check", "paused"),
            ("click", ".gs-watch-ctl button", 0),
            ("watch", 20),
            ("click", ".gs-watch-ctl button", 3),
            ("run", 600),
            ("check", "taken over"),
            ("until", "st.handNo >= 1", 3000),
            ("check", "played out"),
        ],
    ),
}

DRIVER = """
(cfg) => {
  const w = window, api = w.ZimiHearts, doc = document, session = api.session;
  if (!w.__h) w.__h = { rng: w.ZimiUtil.mulberry32(cfg.hseed), sel: [], selKey: '', pending: null, trace: [], snaps: [], plays: [], digest: 2166136261, lastSnap: '', lastKey: '', lastTrick: null };
  const h = w.__h, st = session.state;
  const fnv = (s, d) => { let x = d >>> 0; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; };
  const text = (sel) => { const e = doc.querySelector(sel); return e ? e.textContent : ''; };
  const pick = (list) => list[Math.floor(h.rng() * list.length)];
  const sheetText = text('.ar-sheet:not([hidden])');
  const snap = JSON.stringify([fnv(JSON.stringify(st), 0), st.moves, st.phase, st.turn, text('.ct-status-text'), text('.ct-scores'), sheetText, text('.zs-cover'), text('.gs-watch-text'), text('.ct-panel')]);
  if (snap !== h.lastSnap) { h.lastSnap = snap; h.digest = fnv(snap, h.digest); h.trace.push(h.digest.toString(16).padStart(8, '0')); h.snaps.push(snap); }
  const key = JSON.stringify([st.moves, st.phase]);
  if (key !== h.lastKey) {
    h.lastKey = key;
    const t = st.trick || [];
    if (t.length && (!h.lastTrick || t.length > h.lastTrick.length || t[0].id !== h.lastTrick[0].id)) h.plays.push(t[t.length - 1].seat + ':' + t[t.length - 1].id);
    h.lastTrick = t.map((x) => ({ seat: x.seat, id: x.id }));
  }
  if (cfg.mode === 'look') return null;
  if (cfg.mode === 'check') return { label: cfg.label, state: fnv(JSON.stringify(st), 0).toString(16), moves: st.moves, phase: st.phase, scores: st.scores, status: text('.ct-status-text'), chips: text('.ct-scores'), sheet: sheetText, cover: text('.zs-cover'), watch: text('.gs-watch-text'), watchCtl: [...doc.querySelectorAll('.gs-watch-ctl button')].map((b) => b.textContent).join('/') };
  const cover = doc.querySelector('.zs-cover .gs-primary');
  if (cover) { cover.click(); return 'cover'; }
  const done = doc.querySelector('.ar-sheet:not([hidden]) .gs-primary');
  if (done) { done.click(); return 'sheet'; }
  if (doc.querySelector('.ar-sheet:not([hidden])') || doc.querySelector('.zc-dealing') || doc.querySelector('.zc-cascade')) return null;
  const tap = (id) => {
    const el = doc.querySelector('.zc-card[data-id="' + id + '"]');
    if (!el) return false;
    const o = { bubbles: true, pointerId: 1, pointerType: 'touch', button: 0, clientX: 1, clientY: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o));
    return true;
  };
  // who is looking: the person whose cards are face up
  const up = new Set([...doc.querySelectorAll('.zc-card:not(.zc-down):not(.zc-off)')].map((e) => +e.getAttribute('data-id')));
  const viewer = cfg.people.find((p) => (st.hands[p] || []).some((c) => up.has(c)));
  if (viewer === undefined) return null;
  if (st.phase === 'pass') {
    const sk = viewer + ':' + st.handNo + ':' + st.moves;
    if (h.selKey !== sk) { h.selKey = sk; h.sel = []; }
    if (h.sel.length < 3) {
      const id = pick(st.hands[viewer].filter((c) => h.sel.indexOf(c) < 0));
      if (tap(id)) { h.sel.push(id); return 'select'; }
      return null;
    }
    const status = doc.querySelector('.ct-status .ar-btn');
    if (status && !status.hidden && !status.disabled) { status.click(); return 'pass'; }
    return null;
  }
  if (st.phase !== 'play' || st.turn !== viewer || st.trick.length === 4) return null;
  const legal = st.hands[viewer].filter((c) => api.isLegal(st, viewer, c));
  if (!legal.length) return null;
  if (h.pending && h.pending.moves === st.moves && legal.indexOf(h.pending.id) >= 0) { tap(h.pending.id); return 'again'; }
  const id = pick(legal);
  h.pending = { id: id, moves: st.moves };
  tap(id);
  return 'play';
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
    return "() => { const api = window.ZimiHearts, session = api.session, st = session.state, doc = document; %s }" % body


def dump(name, snaps):
    debug = os.environ.get("ZIMI_TRICK_DEBUG")
    if debug:
        os.makedirs(debug, exist_ok=True)
        with open(os.path.join(debug, name + ".txt"), "w") as f:
            f.write("\n".join(snaps) + "\n")


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
    page.clock.pause_at(1_700_000_001_000)
    page.add_init_script(path=os.path.join(GAMES, "util.js"))
    page.add_init_script(INIT % {"seed": spec["seed"]})
    page.add_init_script(NO_MOTION)
    if spec["kinds"]:
        page.add_init_script(PEOPLE_KEYS % json.dumps(spec["kinds"]))
    page.goto("%s/hearts.html" % served)
    for _ in range(200):
        if page.evaluate("() => !!(window.ZimiHearts && ZimiHearts.session && ZimiHearts.session.state)"):
            break
        page.clock.run_for(STEP_MS)
    cfg = dict(hseed=spec["hseed"], people=spec["people"])
    look = lambda mode="look", **more: page.evaluate(DRIVER, dict(cfg, mode=mode, **more))
    checks = []

    def act():
        look("act")
        page.clock.run_for(STEP_MS)

    for step in spec["script"]:
        kind = step[0]
        if kind == "play":
            for _ in range(step[1]):
                act()
        elif kind == "until":
            for _ in range(min(step[2], MAX_STEPS)):
                if page.evaluate(in_page("return !!(%s);" % step[1])):
                    break
                act()
            else:
                dump(name, page.evaluate("() => window.__h.snaps"))
                raise AssertionError("%s never reached %r; the page said %s" % (name, step[1], errors[:3]))
        elif kind == "watch":  # the computer plays: look every half second, as many seconds as asked
            for _ in range(step[1] * 2):
                look()
                page.clock.run_for(500)
        elif kind == "force":
            page.evaluate(in_page(step[1]))
            page.clock.run_for(STEP_MS)
        elif kind == "click":
            page.evaluate("([sel, n]) => document.querySelectorAll(sel)[n].click()", [step[1], step[2]])
            page.clock.run_for(STEP_MS)
        elif kind == "text":  # a button of the open sheet; a fourth item is what a script it brings in makes true (waited for in real time)
            page.evaluate(SHEET_BUTTON, [step[1], step[2]])
            if len(step) > 3:
                wait_for(page, step[3], name)
            page.clock.run_for(STEP_MS)
        elif kind == "ready":  # a script the page fetches on demand has arrived (real time: the fake clock cannot wait for a network)
            wait_for(page, step[1], name)
        elif kind == "run":
            page.clock.run_for(step[1])
        elif kind == "check":
            checks.append(look("check", label=step[1]))
        else:
            raise AssertionError("unknown step %r" % (step,))
        look()
    out = page.evaluate("() => ({ trace: window.__h.trace, snaps: window.__h.snaps, plays: window.__h.plays })")
    assert not errors, errors
    ctx.close()
    dump(name, out["snaps"])
    return {
        "seed": spec["seed"],
        "hseed": spec["hseed"],
        "plays": " ".join(out["plays"]),
        "checks": checks,
        "events": len(out["trace"]),
        "trace": "".join(out["trace"]),
    }


@pytest.mark.parametrize("name", sorted(PATHS))
def test_the_path_plays_out_as_recorded(served, browser, name):
    got = play_out(browser, served, name, PATHS[name])
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
    assert len(got["checks"]) == len(want["checks"]), "a different number of checkpoints"
    for g, w in zip(got["checks"], want["checks"]):
        assert g == w, "the table at %r differed" % w["label"]
    assert got["events"] == want["events"], "the table changed a different number of times"
    first = next((i for i in range(0, min(len(got["trace"]), len(want["trace"])), 8) if got["trace"][i : i + 8] != want["trace"][i : i + 8]), None)
    assert first is None, "the table showed something different at change %d" % (first // 8)
