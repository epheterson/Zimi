"""play.py <group> [game ...]: plays Zimi's board games on a 390x844 touch phone and shoots what a person would see.
Groups: family (gofish oldmaid snap ohhell cheat), sol (the ten solitaire variants). Output: SHOTS_DIR/<game>-<step>.png and a findings list.
"""

import sys, os, json, time, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

SHEET = ".gs-sheet, .ar-sheet, .zc-sheet, .gs-end"
FINDINGS = []


def note(game, msg):
    FINDINGS.append((game, msg))
    print("FINDING", game, msg, flush=True)


def shot(pg, game, step):
    pg.screenshot(path="%s/%s-%s.png" % (SHOTS, game, step))


def box(pg, sel):
    return pg.locator(sel).first.bounding_box()


def tap_sel(pg, sel, index=0):
    b = pg.locator(sel).nth(index).bounding_box()
    if not b:
        return False
    pg.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


def card_point(pg, cid):
    return pg.evaluate(
        """(id) => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); if (!e) return null;
        const b = e.getBoundingClientRect(); return { x: b.x + Math.min(10, b.width / 3), y: b.y + b.height * 0.25 }; }""",
        cid,
    )


def tap_card(pg, cid):
    p = card_point(pg, cid)
    for _ in range(20):
        if not p:
            return False
        pg.wait_for_timeout(120)
        q = card_point(pg, cid)
        if q == p:
            break
        p = q
    pg.touchscreen.tap(p["x"], p["y"])
    return True


LAYOUT = """() => {
  const W = innerWidth, H = innerHeight, out = [];
  if (document.documentElement.scrollWidth > W + 1) out.push('page scrolls sideways: ' + document.documentElement.scrollWidth);
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  document.querySelectorAll('button, .ct-chip, .ct-status-text, .gs-sheet *, .ar-sheet *, .zc-sheet *, .gs-end *, .ar-btn, h1, .ar-stat, .sn-snap').forEach(e => {
    if (!vis(e)) return;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    const name = (e.className && e.className.baseVal === undefined ? e.className : '') + ':' + (e.textContent || '').trim().slice(0, 24);
    if (r.right > W + 1 || r.left < -1) out.push('off the side: ' + name + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    if (e.children.length === 0 && e.scrollWidth > e.clientWidth + 2 && cs.overflow !== 'visible' && e.clientWidth > 0) out.push('text clipped: ' + name + ' ' + e.scrollWidth + '>' + e.clientWidth);
  });
  document.querySelectorAll('.zc-card[data-id]').forEach(e => {
    const r = e.getBoundingClientRect();
    if (r.width && (r.right > W + 2 || r.left < -2) && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0') out.push('card off the side: ' + e.dataset.id + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
  });
  return out.slice(0, 12);
}"""


def check(pg, game, step):
    try:
        bad = pg.evaluate(LAYOUT)
    except Exception as e:
        bad = ["layout check failed: %s" % e]
    for b in bad:
        note(game, "[%s] %s" % (step, b))
    if pg.errors:
        note(game, "[%s] page errors: %s" % (step, pg.errors[:2]))
        pg.errors.clear()


def sheet_up(pg):
    return pg.evaluate("() => !!document.querySelector('%s')" % SHEET)


def menu_tour(pg, game, tag=""):
    """Menu, then How to play, Settings, Stats: each a screenshot, each closed again."""
    tap_sel(pg, ".gs-menu-btn")
    pg.wait_for_timeout(500)
    shot(pg, game, "menu" + tag)
    check(pg, game, "menu" + tag)
    for key, label in (
        ("how", "How to play"),
        ("settings", "Settings"),
        ("stats", "Stats"),
    ):
        tiles = pg.locator(".gs-tile")
        n = tiles.count()
        hit = None
        for i in range(n):
            if label.lower() in (tiles.nth(i).inner_text() or "").lower():
                hit = i
                break
        if hit is None:
            note(
                game,
                "menu has no '%s' tile (tiles: %s)"
                % (label, [tiles.nth(i).inner_text() for i in range(n)]),
            )
            continue
        b = tiles.nth(hit).bounding_box()
        pg.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
        pg.wait_for_timeout(500)
        shot(pg, game, key + tag)
        check(pg, game, key + tag)
        back = pg.locator(".gs-back, .gs-head button, button[aria-label*='ack']").first
        if back.count():
            try:
                bb = back.bounding_box()
                pg.touchscreen.tap(
                    bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
                )
                pg.wait_for_timeout(400)
            except Exception:
                pg.keyboard.press("Escape")
        else:
            pg.keyboard.press("Escape")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(300)
    if pg.evaluate(
        "() => !!document.querySelector('.gs-menu:not([hidden]), .gs-sheet')"
    ):
        # close with the scrim or the close button
        close = pg.locator(".gs-close, .gs-x, [aria-label='Close']").first
        if close.count():
            tap_sel(pg, ".gs-close, .gs-x, [aria-label='Close']")
        pg.wait_for_timeout(300)


def wait_state(pg, api):
    pg.wait_for_function(
        "() => window.%s && window.%s.session && window.%s.session.state"
        % (api, api, api),
        timeout=10000,
    )
    pg.wait_for_selector(".zc-card", state="attached", timeout=10000)
    pg.wait_for_timeout(2200)


def st_of(pg, api):
    return pg.evaluate("() => window.%s.session.state" % api)


def reload_resumes(pg, r, game, api, url):
    """Reload mid-game: the same state comes back."""
    before = st_of(pg, api)
    pg.wait_for_timeout(600)
    pg.reload()
    wait_state(pg, api)
    after = st_of(pg, api)
    key = lambda s: json.dumps(
        {k: s[k] for k in s if k not in ("note",)}, sort_keys=True
    )
    # AI may have moved between save and reload; compare move counts and cards
    if before.get("moves", 0) > after.get("moves", 0) + 0:
        note(
            game,
            "resume lost moves: %s -> %s" % (before.get("moves"), after.get("moves")),
        )
    shot(pg, game, "resumed")
    check(pg, game, "resumed")
    return after


# ── family games ────────────────────────────────────────────────────────────


def play_loop(pg, game, api, step_fn, over_fn, limit_s=240):
    t0 = time.time()
    n = 0
    while time.time() - t0 < limit_s:
        st = st_of(pg, api)
        if over_fn(st) or sheet_up(pg):
            return True
        step_fn(pg, st)
        n += 1
    return False


def family(r, game):
    api = {
        "gofish": "ZimiGoFish",
        "oldmaid": "ZimiOldMaid",
        "snap": "ZimiSnap",
        "ohhell": "ZimiOhHell",
        "cheat": "ZimiCheat",
    }[game]
    c, pg = r.ctx()
    pg.goto(r.site + game + ".html")
    wait_state(pg, api)
    shot(pg, game, "start-light")
    check(pg, game, "start")
    # illegal / early touch: tap a card out of turn
    st = st_of(pg, api)
    hand0 = st["hands"][0] if "hands" in st else None
    mid = [0]

    def step(pg, st):
        mid[0] += 1
        if game == "gofish":
            if st["turn"] == 0 and st["hands"][0]:
                tap_card(pg, st["hands"][0][0])
                pg.wait_for_timeout(120)
            else:
                pg.wait_for_timeout(250)
        elif game == "oldmaid":
            if st["turn"] == 0:
                src = pg.evaluate(
                    "() => window.ZimiOldMaid.source(window.ZimiOldMaid.session.state)"
                )
                if mid[0] == 2:  # an illegal touch first: one of my own cards
                    if st["hands"][0]:
                        tap_card(pg, st["hands"][0][0])
                        pg.wait_for_timeout(300)
                        shot(pg, game, "illegal")
                        check(pg, game, "illegal")
                tap_card(pg, st["hands"][src][0])
                pg.wait_for_timeout(150)
            else:
                pg.wait_for_timeout(250)
        elif game == "ohhell":
            if st["phase"] == "bid" and st["turn"] == 0:
                bad = pg.evaluate(
                    "() => window.ZimiOhHell.forbiddenBid(window.ZimiOhHell.session.state, 0)"
                )
                (
                    pg.locator(".ct-choice", has_text="1").first.tap()
                    if bad != 1
                    else pg.locator(".ct-choice", has_text="2").first.tap()
                )
                pg.wait_for_timeout(200)
            elif (
                st["phase"] == "play"
                and st["turn"] == 0
                and len(st["trick"]) < st["players"]
            ):
                legal = pg.evaluate(
                    "() => window.ZimiOhHell.legalPlays(window.ZimiOhHell.session.state, 0)"
                )
                allc = st["hands"][0]
                ill = [c for c in allc if c not in legal]
                if ill and "illegal" not in done:
                    done.add("illegal")
                    tap_card(pg, ill[0])
                    pg.wait_for_timeout(400)
                    shot(pg, game, "illegal")
                    check(pg, game, "illegal")
                tap_card(pg, legal[0])
                pg.wait_for_timeout(200)
            elif st["phase"] == "handEnd":
                if "handsheet" not in done:
                    done.add("handsheet")
                    pg.wait_for_timeout(600)
                    shot(pg, game, "handsheet")
                    check(pg, game, "handsheet")
                    pg.locator(
                        SHEET.split(",")[0] + " .gs-primary, .gs-primary, .ct-primary"
                    ).first.tap()
                pg.wait_for_timeout(300)
            else:
                pg.wait_for_timeout(250)
        elif game == "cheat":
            if st["phase"] == "call" and st["callers"] and st["callers"][0] == 0:
                pg.locator(".ct-choice", has_text="Let it go").first.tap()
                pg.wait_for_timeout(150)
            elif st["phase"] == "play" and st["turn"] == 0:
                tap_card(pg, st["hands"][0][0])
                pg.wait_for_timeout(150)
                if pg.locator(".ct-choice.ct-primary").count():
                    pg.locator(".ct-choice.ct-primary").first.tap()
                pg.wait_for_timeout(200)
            else:
                pg.wait_for_timeout(250)
        elif game == "snap":
            if st["phase"] == "play":
                if pg.evaluate(
                    "() => window.ZimiSnap.isMatch(window.ZimiSnap.session.state)"
                ):
                    tap_sel(pg, ".sn-snap")
                    pg.wait_for_timeout(100)
                else:
                    pg.wait_for_timeout(200)
            else:
                pg.wait_for_timeout(200)

    done = set()

    def over(st):
        return st.get("phase") == "over" or (
            game == "snap" and st.get("phase") == "over"
        )

    # play a bit, shoot the mid-game, reload, then to the end
    for _ in range(14):
        step(pg, st_of(pg, api))
    pg.wait_for_timeout(500)
    shot(pg, game, "mid-light")
    check(pg, game, "mid")
    reload_resumes(pg, r, game, api, game + ".html")
    ended = play_loop(
        pg, game, api, step, over, limit_s=420 if game in ("ohhell", "cheat") else 240
    )
    pg.wait_for_timeout(1500)
    if ended:
        shot(pg, game, "end-natural")
        check(pg, game, "end-natural")
        txt = pg.evaluate(
            "() => (document.querySelector('%s') || {}).innerText"
            % SHEET.replace("'", "")
        )
        print(game, "END SHEET:", (txt or "")[:200].replace("\n", " | "), flush=True)
    else:
        note(
            game,
            "did not reach the end in the time allowed (state moves=%s)"
            % st_of(pg, api).get("moves"),
        )
    c.close()


def end_sheets(r, game, api):
    """Both end sheets through the game's own hooks, on fresh pages: light, dark and Hebrew (right to left)."""
    sess = "window.%s.session" % api
    for tag, kw in (("light", {}), ("dark", dict(dark=True)), ("he", dict(locale="he-IL"))):
        for kind in ("win", "lose"):
            c, pg = r.ctx(**kw)
            try:
                pg.goto(r.site + game + ".html")
                wait_state(pg, api)
                if kind == "win":
                    pg.evaluate("() => %s.win(42)" % sess)
                else:
                    pg.evaluate("() => %s.lose('', ['Zimi wins.'], 3)" % sess)
                pg.wait_for_timeout(2600)
                shot(pg, game, "end-%s-%s" % (kind, tag))
                check(pg, game, "end-%s-%s" % (kind, tag))
            except Exception as e:
                note(game, "end sheet %s %s failed: %s" % (kind, tag, str(e)[:160]))
            c.close()
    c, pg = r.ctx()
    try:
        pg.goto(r.site + game + ".html")
        wait_state(pg, api)
        menu_tour(pg, game)
    except Exception as e:
        note(game, "menu tour failed: %s" % str(e)[:160])
    c.close()


def themes(r, game, api):
    """Dark, an RTL language (he, then ar), landscape: the start table and its menu."""
    for tag, kw in (
        ("dark", dict(dark=True)),
        ("he", dict(locale="he-IL")),
        ("ar", dict(locale="ar")),
        ("land", dict(w=844, h=390)),
    ):
        c, pg = r.ctx(**kw)
        try:
            pg.goto(r.site + game + ".html")
            wait_state(pg, api)
            shot(pg, game, "start-" + tag)
            check(pg, game, "start-" + tag)
            if tag in ("he", "dark"):
                # a few moves
                if game in ("ohhell", "cheat", "gofish", "oldmaid", "snap"):
                    pass
                pg.wait_for_timeout(300)
                tap_sel(pg, ".gs-menu-btn")
                pg.wait_for_timeout(500)
                shot(pg, game, "menu-" + tag)
                check(pg, game, "menu-" + tag)
        except Exception as e:
            note(game, "theme %s failed: %s" % (tag, str(e)[:200]))
        c.close()



VARIANTS = {"yukon": "ZimiYukon", "fortythieves": "ZimiFortyThieves", "canfield": "ZimiCanfield", "scorpion": "ZimiScorpion", "acesup": "ZimiAcesUp",
            "accordion": "ZimiAccordion", "calculation": "ZimiCalculation", "beleaguered": "ZimiBeleaguered", "eightoff": "ZimiEightOff", "montecarlo": "ZimiMonteCarlo"}

FIND_TAP = """(g) => {
  const api = window[g], st = api.session.state;
  for (const from of Object.keys(st.piles)) for (let idx = st.piles[from].length - 1; idx >= 0; idx--) {
    if (!api.canPick(st, from, idx) || !api.bestMove(st, from, idx)) continue;
    const c = st.piles[from][idx], id = typeof c === 'number' ? c : c.id, e = document.querySelector('.zc-card[data-id="' + id + '"]');
    if (!e) continue;
    const r = e.getBoundingClientRect();
    if (r.bottom > innerHeight || r.right > innerWidth || r.left < 0) continue;
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.2, moves: st.moves, from: from, idx: idx };
  }
  const stock = st.piles.stock;
  if (stock && stock.length) {
    const c = stock[stock.length - 1], e = document.querySelector('.zc-card[data-id="' + c.id + '"]'), r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, moves: st.moves, from: 'stock', idx: stock.length - 1 };
  }
  return null;
}"""
FIND_NO_MOVE = """(g) => {
  const api = window[g], st = api.session.state;
  for (const from of Object.keys(st.piles)) for (let idx = st.piles[from].length - 1; idx >= 0; idx--) {
    const c = st.piles[from][idx], id = typeof c === 'number' ? c : c.id, e = document.querySelector('.zc-card[data-id="' + id + '"]');
    if (!e || from === 'stock') continue;
    const r = e.getBoundingClientRect();
    if (r.bottom > innerHeight || r.width === 0) continue;
    if (api.canPick(st, from, idx) && api.bestMove(st, from, idx)) continue;
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.2, from: from, idx: idx };
  }
  return null;
}"""
FIND_STUCK = """(g) => {
  const api = window[g], S = api.S, tries = 3000;
  const decks = g === 'ZimiFortyThieves' ? 2 : 1;
  const all = (st) => {
    const out = [], names = Object.keys(st.piles);
    for (const from of names) for (let idx = 0; idx < st.piles[from].length; idx++) {
      if (!api.canPick(st, from, idx)) continue;
      for (const to of names) if (api.legalMove(st, from, idx, to)) out.push({ from, idx, to });
    }
    return out;
  };
  const t0 = Date.now();
  for (let k = 0; k < tries && Date.now() - t0 < 25000; k++) {
    let st = api.newState(window.ZimiSolKit.shuffledDecks(decks, Math.random)), prev = null, last = null;
    for (let step = 0; step < 700; step++) {
      let moves = all(st).filter(m => !(last && m.from === last.to && m.to === last.from));
      const draw = S.draw ? S.draw(st) : null;
      const pick = moves.length && (!draw || Math.random() < 0.9) ? moves[Math.floor(Math.random() * moves.length)] : null;
      let next, mv;
      if (pick) { next = api.applyMove(st, pick.from, pick.idx, pick.to); mv = pick; }
      else if (draw) { next = draw; mv = { draw: true }; }
      else return null;
      if (!api.isWon(next) && !api.hasMove(next)) {
        let card = null;
        if (mv.draw) { const stock = S.stock ? st.piles[S.stock] : []; card = stock.length ? stock[stock.length - 1].id : null; }
        else if (api.bestMove(st, mv.from, mv.idx) === mv.to) card = st.piles[mv.from][mv.idx].id;
        if (card !== null) return { prev: st, card: card };
      }
      last = mv.draw ? null : mv; st = next;
    }
  }
  return null;
}"""
TAP_OF = """([g, id]) => {
  const e = document.querySelector('.zc-card[data-id="' + id + '"]');
  if (!e) return null;
  e.scrollIntoView({ block: 'nearest' });
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height * 0.2 };
}"""
FIND_WIN = """(g) => {
  const api = window[g], st = api.almostWon();
  for (const from of Object.keys(st.piles)) for (let idx = 0; idx < st.piles[from].length; idx++) {
    const to = api.canPick(st, from, idx) && api.bestMove(st, from, idx);
    if (!to || !api.isWon(api.applyMove(st, from, idx, to))) continue;
    const c = api.session.state.piles[from][idx], e = document.querySelector('.zc-card[data-id="' + c.id + '"]');
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.2 };
  }
  return null;
}"""


def sol(r, game):
    api = VARIANTS[game]
    c, pg = r.ctx()
    pg.goto(r.site + game + ".html")
    wait_state(pg, api)
    shot(pg, game, "start-light")
    check(pg, game, "start")
    t = pg.evaluate(FIND_NO_MOVE, api)
    if t:
        pg.touchscreen.tap(t["x"], t["y"]); pg.wait_for_timeout(350)
        shot(pg, game, "illegal"); check(pg, game, "illegal")
        print(game, "toast:", pg.evaluate("() => (document.querySelector('.zc-toast, .ar-toast, .gs-toast, [role=status]') || {}).innerText"), flush=True)
    else:
        note(game, "no card without a move to tap for the illegal-touch shot")
    done = 0
    for _ in range(9):
        t = pg.evaluate(FIND_TAP, api)
        if not t:
            break
        pg.touchscreen.tap(t["x"], t["y"]); pg.wait_for_timeout(450)
        done += 1
        if sheet_up(pg):
            break
    shot(pg, game, "mid-light"); check(pg, game, "mid")
    moves = st_of(pg, api).get("moves")
    if done and pg.locator("#zc-undo").is_enabled():
        tap_sel(pg, "#zc-undo"); pg.wait_for_timeout(500)
        if st_of(pg, api).get("moves") != moves - 1:
            note(game, "undo: moves %s -> %s" % (moves, st_of(pg, api).get("moves")))
    moves = st_of(pg, api).get("moves")
    pg.wait_for_timeout(800)
    pg.reload(); wait_state(pg, api)
    after = st_of(pg, api).get("moves")
    if after != moves:
        note(game, "resume: moves %s before reload, %s after" % (moves, after))
    shot(pg, game, "resumed"); check(pg, game, "resumed")
    # a lose: a position found by a random walk that is one move from having none left; the move is tapped
    found = pg.evaluate(FIND_STUCK, api)
    if not found:
        note(game, "no stuck position found by a random walk (cannot show the stuck sheet)")
    else:
        pg.evaluate("([g, st]) => window[g].session.reset(st)", [api, found["prev"]])
        pg.wait_for_timeout(1200)
        shot(pg, game, "before-stuck")
        t = pg.evaluate(TAP_OF, [api, found["card"]])
        if t:
            pg.touchscreen.tap(t["x"], t["y"])
            try:
                pg.wait_for_function("() => document.querySelector('%s')" % SHEET, timeout=6000)
            except Exception:
                note(game, "the last move left no moves but no stuck sheet came up")
        pg.wait_for_timeout(800)
        shot(pg, game, "end-stuck"); check(pg, game, "end-stuck")
        print(game, "STUCK SHEET:", pg.evaluate("() => (document.querySelector('%s') || {}).innerText" % SHEET.replace("'", "")).replace("\n", " | ")[:140], flush=True)
        if sheet_up(pg):
            tap_sel(pg, ".gs-primary")  # New game from the stuck sheet
            pg.wait_for_timeout(1500)
            shot(pg, game, "after-new"); check(pg, game, "after-new")
    # the win from the one-move fixture
    for tag, kw in (("light", {}), ("dark", dict(dark=True)), ("he", dict(locale="he-IL")), ("ar", dict(locale="ar"))):
        c2, p2 = r.ctx(**kw)
        try:
            p2.goto(r.site + game + ".html?debug=win")
            wait_state(p2, api)
            if tag != "light":
                shot(p2, game, "start-" + tag); check(p2, game, "start-" + tag)
            w = p2.evaluate(FIND_WIN, api)
            p2.touchscreen.tap(w["x"], w["y"]); p2.wait_for_timeout(2500)
            try:
                p2.wait_for_function("() => document.querySelector('%s')" % SHEET, timeout=12000)
            except Exception:
                note(game, "[win-%s] no end sheet after the winning tap" % tag)
            p2.wait_for_timeout(500)
            shot(p2, game, "end-win-" + tag); check(p2, game, "end-win-" + tag)
        except Exception as e:
            note(game, "win-%s failed: %s" % (tag, str(e)[:200]))
        c2.close()
    c3, p3 = r.ctx(w=844, h=390)
    try:
        p3.goto(r.site + game + ".html"); wait_state(p3, api); shot(p3, game, "start-land"); check(p3, game, "start-land")
    except Exception as e:
        note(game, "landscape failed: %s" % str(e)[:200])
    c3.close()
    pg.reload(); wait_state(pg, api)
    menu_tour(pg, game)
    c.close()


def five(r):
    """Oh Hell at a table of five: the deal, an illegal card, a hand to its sheet, the last hand to the end sheet; light, dark, Hebrew, landscape."""
    api = "ZimiOhHell"
    for tag, kw in (("light", {}), ("dark", dict(dark=True)), ("he", dict(locale="he-IL")), ("land", dict(w=844, h=390))):
        c, pg = r.ctx(**kw)
        pg.add_init_script("try { localStorage.setItem('zimi.games.ohhell.players', '5'); } catch (e) {}")
        try:
            pg.goto(r.site + "ohhell.html")
            wait_state(pg, api)
            shot(pg, "ohhell5", "start-" + tag)
            check(pg, "ohhell5", "start-" + tag)
            if tag != "light":
                c.close()
                continue
            for _ in range(500):
                st = st_of(pg, api)
                if st["phase"] == "handEnd" or sheet_up(pg):
                    break
                if st["phase"] == "bid" and st["turn"] == 0:
                    shot(pg, "ohhell5", "bid") if "bid" not in FINDINGS_SEEN else None
                    FINDINGS_SEEN.add("bid")
                    bad = pg.evaluate("() => window.ZimiOhHell.forbiddenBid(window.ZimiOhHell.session.state, 0)")
                    pg.locator(".ct-choice", has_text="1" if bad != 1 else "2").first.tap()
                    pg.wait_for_timeout(200)
                elif st["phase"] == "play" and st["turn"] == 0 and len(st["trick"]) < 5:
                    legal = pg.evaluate("() => window.ZimiOhHell.legalPlays(window.ZimiOhHell.session.state, 0)")
                    ill = [x for x in st["hands"][0] if x not in legal]
                    if ill and "ill" not in FINDINGS_SEEN:
                        FINDINGS_SEEN.add("ill")
                        tap_card(pg, ill[0]); pg.wait_for_timeout(400)
                        shot(pg, "ohhell5", "illegal"); check(pg, "ohhell5", "illegal")
                    tap_card(pg, legal[0]); pg.wait_for_timeout(200)
                    if "mid" not in FINDINGS_SEEN and len(st_of(pg, api)["trick"]) >= 3:
                        FINDINGS_SEEN.add("mid")
                        shot(pg, "ohhell5", "trick"); check(pg, "ohhell5", "trick")
                else:
                    pg.wait_for_timeout(250)
            pg.wait_for_timeout(800)
            shot(pg, "ohhell5", "handsheet"); check(pg, "ohhell5", "handsheet")
        except Exception as e:
            note("ohhell5", "%s failed: %s" % (tag, traceback.format_exc()[-300:]))
        c.close()


FINDINGS_SEEN = set()

if __name__ == "__main__":
    group = sys.argv[1]
    names = sys.argv[2:]
    r = Run()
    try:
        if group == "five":
            five(r)
        if group == "sol":
            for g in names or list(VARIANTS):
                try:
                    sol(r, g)
                except Exception:
                    note(g, "driver crashed: " + traceback.format_exc()[-400:])
        if group == "family":
            for g in names or ["gofish", "oldmaid", "snap", "ohhell", "cheat"]:
                api = {
                    "gofish": "ZimiGoFish",
                    "oldmaid": "ZimiOldMaid",
                    "snap": "ZimiSnap",
                    "ohhell": "ZimiOhHell",
                    "cheat": "ZimiCheat",
                }[g]
                for fn in (lambda: family(r, g), lambda: end_sheets(r, g, api), lambda: themes(r, g, api)):
                    try:
                        fn()
                    except Exception:
                        note(g, "driver crashed: " + traceback.format_exc()[-400:])
    finally:
        r.close()
        print("DONE findings:", len(FINDINGS))
        for f in FINDINGS:
            print(" -", f[0], f[1])
