"""bot3.py game [seconds]: plays a card game to its end through real touches on a fast fake clock, then keeps the finished state.
Writes SHOTS_DIR/<game>-final.json (the finished session state) and a shot of the natural end sheet.
"""

import sys, os, json, time, random, traceback, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from play import shot, check, note, sheet_up, SHEET
from lib import *

APIS = {
    "spades": "ZimiSpades",
    "euchre": "ZimiEuchre",
    "belote": "ZimiBelote",
    "skat": "ZimiSkat",
    "gin": "ZimiGin",
    "crazyeights": "ZimiCrazyEights",
    "scopa": "ZimiScopa",
    "koikoi": "ZimiKoiKoi",
    "tienlen": "ZimiTienLen",
    "bigtwo": "ZimiBigTwo",
    "holdem": "ZimiHoldem",
    "blackjack": "ZimiBlackjack",
}

STEP = """() => {
  const api = window.%s, st = api.session.state, out = { phase: st.phase, turn: st.turn, won: !!api.session.won };
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.hidden; };
  out.sheetPrimary = null;
  const sh = [...document.querySelectorAll('.gs-sheet, .ar-sheet, .zc-sheet')].filter(vis)[0];
  if (sh) { const b = sh.querySelector('.gs-primary, .ar-btn.primary'); if (b) { const r = b.getBoundingClientRect(); out.sheetPrimary = [r.x + r.width / 2, r.y + r.height / 2, b.textContent.trim()]; } out.sheetUp = true; }
  const sb = document.querySelector('.ct-status button'); if (sb && vis(sb) && !sb.disabled) { const r = sb.getBoundingClientRect(); out.statusBtn = [r.x + r.width / 2, r.y + r.height / 2, sb.textContent.trim()]; }
  out.choices = [...document.querySelectorAll('.ct-panel .ct-choice')].filter(e => vis(e) && !e.disabled).map(e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, e.textContent.trim()]; });
  const hand = (st.hands && st.hands[0]) || [];
  out.hand = hand.map(id => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); if (!e) return null; const r = e.getBoundingClientRect(); if (r.width < 10 || r.top > innerHeight) return null;
    const x = r.left + Math.min(12, r.width / 3), y = r.top + r.height * 0.3, top = document.elementFromPoint(x, y); return (top === e || (top && e.contains(top))) ? [x, y, id, e.classList.contains('zc-dim')] : null; }).filter(Boolean);
  return out;
}"""


def play(r, game, limit_s=420, seed=1):
    api = APIS[game]
    random.seed(seed)
    c, pg = r.ctx()
    pg.clock.install()
    pg.goto(r.site + game + ".html")
    pg.clock.run_for(3000)
    pg.wait_for_function(
        "() => window.%s && window.%s.session && window.%s.session.state"
        % (api, api, api),
        timeout=15000,
    )
    t0 = time.time()
    n = 0
    last_sig = None
    stale = 0
    while time.time() - t0 < limit_s:
        pg.clock.run_for(700)
        s = pg.evaluate(STEP % api)
        n += 1
        if (
            s["won"]
            and s.get("sheetUp")
            and s["phase"] in ("over",)
            or (s["won"] and s.get("sheetUp"))
        ):
            break
        sig = json.dumps([s["phase"], s["turn"], len(s["hand"]), len(s["choices"])])
        stale = stale + 1 if sig == last_sig else 0
        last_sig = sig
        if s.get("sheetPrimary") and not s["won"]:
            pg.touchscreen.tap(s["sheetPrimary"][0], s["sheetPrimary"][1])
            continue
        if s.get("statusBtn"):
            pg.touchscreen.tap(s["statusBtn"][0], s["statusBtn"][1])
            continue
        mine = s["turn"] == 0
        if game == "gin" and mine:
            # Gin: a card is chosen with one touch, then Discard (or Knock / Gin) in the panel; the stock is drawn from by touching it.
            if s["choices"]:
                names = [x[2] for x in s["choices"]]
                pick = next((x for x in s["choices"] if re.match(r"(Knock|Gin)", x[2])), None) or next((x for x in s["choices"] if x[2].startswith("Discard")), None) or s["choices"][0]
                pg.touchscreen.tap(pick[0], pick[1])
                continue
            if s["phase"] == "draw":
                box = pg.evaluate("() => { const e = document.querySelector('[data-pile=\"stock\"]'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
                if box:
                    pg.touchscreen.tap(box[0], box[1])
                    continue
            if s["phase"] == "discard" and s["hand"]:
                ok = [h for h in s["hand"] if not h[3]] or s["hand"]
                h = random.choice(ok)
                pg.touchscreen.tap(h[0], h[1])
                continue
        if not mine and not s["choices"]:
            pg.clock.run_for(3000)
            continue
        if s["choices"] and mine:
            ch = [x for x in s["choices"] if x[2] not in ("Hint",)]
            if game == "tienlen":
                hint = [x for x in s["choices"] if x[2] == "Hint"]
                if hint and stale % 2 == 0:
                    pg.touchscreen.tap(hint[0][0], hint[0][1])
                    pg.clock.run_for(300)
                    s = pg.evaluate(STEP % api)
                    ch = [x for x in s["choices"] if x[2] != "Hint"]
                    pass_ = [x for x in ch if x[2] in ("Pass",)]
                    play_ = [x for x in ch if x[2] not in ("Pass", "Hint")]
                    pick = (play_ or pass_ or ch)[0]
                    pg.touchscreen.tap(pick[0], pick[1])
                    continue
            pick = random.choice(ch) if ch else None
            if pick:
                pg.touchscreen.tap(pick[0], pick[1])
                continue
        if mine and s["hand"] and all(h[3] for h in s["hand"]):
            # nothing in the hand can be played: draw from the stock
            box = pg.evaluate("() => { const e = document.querySelector('[data-pile=\"stock\"], [data-pile=\"deck\"]'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
            if box:
                pg.touchscreen.tap(box[0], box[1])
                continue
        if mine and s["hand"]:
            ok = [h for h in s["hand"] if not h[3]] or s["hand"]
            h = random.choice(ok)
            pg.touchscreen.tap(h[0], h[1])
            pg.clock.run_for(250)
            pg.touchscreen.tap(h[0], h[1])
            continue
    pg.clock.run_for(4000)
    st = pg.evaluate("() => window.%s.session.state" % api)
    won = pg.evaluate("() => !!window.%s.session.won" % api)
    print(
        game,
        "after",
        n,
        "steps in %.0fs" % (time.time() - t0),
        "phase",
        st.get("phase"),
        "won-flag",
        won,
        flush=True,
    )
    shot(pg, game, "natural-end")
    with open("%s/%s-final.json" % (SHOTS, game), "w") as f:
        json.dump(st, f)
    c.close()
    return st, won


if __name__ == "__main__":
    r = Run()
    try:
        for g in sys.argv[1].split(","):
            try:
                play(r, g, int(sys.argv[2]) if len(sys.argv) > 2 else 420)
            except Exception:
                print(g, "CRASH", traceback.format_exc()[-500:], flush=True)
    finally:
        r.close()
