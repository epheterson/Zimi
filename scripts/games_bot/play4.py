"""play4.py game...: reloads each game from its finished state (bot3 wrote SHOTS_DIR/<game>-final.json), with the scores arranged for a win and for a
lose, so the page's own gameOver builds the sheet. Shots: light, Hebrew, dark; landscape for the win.
"""

import sys, os, json, time, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from play import shot, check, note, sheet_up, SHEET, FINDINGS
from lib import *
import play as P

IN = os.environ.get("FINAL_DIR", SHOTS)


def arranged(state, win):
    s = json.loads(json.dumps(state))
    sc = s.get("scores")
    if isinstance(sc, list) and sc:
        top = max(range(len(sc)), key=lambda i: sc[i])
        low = min(range(len(sc)), key=lambda i: sc[i])
        k = top if win else low
        if sc[top] == sc[low]:
            sc[0] = sc[0] + (10 if win else -10)
        else:
            sc[0], sc[k] = sc[k], sc[0]
    f = s.get("final")
    if (
        isinstance(f, dict)
        and isinstance(f.get("totals"), list)
        and len(f["totals"]) == 2
    ):
        t = f["totals"]
        hi, lo = max(t), min(t)
        f["totals"] = [hi, lo] if win else [lo, hi]
        if isinstance(s.get("boxes"), list) and len(s["boxes"]) == 2:
            b = sorted(s["boxes"])
            s["boxes"] = [b[1], b[0]] if win else [b[0], b[1]]
        if "winner" in f:
            f["winner"] = 0 if win else 1
    r = s.get("result")
    if (
        isinstance(r, dict)
        and "winner" in r
        and isinstance(r["winner"], int)
        and r["winner"] in (0, 1)
    ):
        r["winner"] = 0 if win else 1
    return s


def one(r, game):
    state = json.load(open("%s/%s-final.json" % (IN, game)))
    for tag, kw, outcomes in (
        ("light", {}, ("win", "lose")),
        ("he", dict(locale="he-IL"), ("win", "lose")),
        ("dark", dict(dark=True), ("lose",)),
        ("land", dict(w=844, h=390), ("win",)),
    ):
        for kind in outcomes:
            st = arranged(state, kind == "win")
            save = json.dumps(
                {
                    "v": 1,
                    "at": int(time.time() * 1000),
                    "data": {
                        "id": game,
                        "state": st,
                        "history": [],
                        "ms": 90000,
                        "ending": None,
                    },
                }
            )
            c, pg = r.ctx(**kw)
            pg.add_init_script(
                "try { localStorage.setItem('zimi.games.save.%s', %s); } catch (e) {}"
                % (game, json.dumps(save))
            )
            try:
                pg.goto(r.site + game + ".html")
                pg.wait_for_timeout(int(os.environ.get("WAIT_MS", 6000)))
                if not sheet_up(pg):
                    note(
                        game,
                        "[%s-%s] no end sheet from the finished state" % (kind, tag),
                    )
                txt = pg.evaluate(
                    "() => (document.querySelector('%s') || {}).innerText"
                    % SHEET.replace("'", "")
                )
                if tag == "light":
                    print(
                        game,
                        kind,
                        "SHEET:",
                        (txt or "").replace("\n", " | ")[:230],
                        flush=True,
                    )
                shot(pg, game, "fin-%s-%s" % (kind, tag))
                check(pg, game, "fin-%s-%s" % (kind, tag))
            except Exception as e:
                note(game, "[%s-%s] %s" % (kind, tag, str(e)[:140]))
            c.close()


if __name__ == "__main__":
    r = Run()
    try:
        for g in sys.argv[1:]:
            try:
                one(r, g)
            except Exception:
                note(g, "crashed: " + traceback.format_exc()[-300:])
    finally:
        r.close()
        print("DONE findings:", len(FINDINGS))
        for f in FINDINGS:
            print(" -", f[0], f[1])
