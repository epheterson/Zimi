"""Bake gate: every card game on the built shelf at 390x844: opens, deals, takes one tap, nothing overflows the table, no page error,
every card fully on screen. Contact sheet of the 13 new games to CARDS_SHOT_DIR/new13.png; problems are listed, not asserted away.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_daily_browser import browser, site  # noqa: F401,E402
from test_games_persist_browser import GAMES  # noqa: E402

ROWS = json.load(open(os.path.join(GAMES, "games.json"), encoding="utf-8"))
CARD_GAMES = [r["path"] for r in ROWS if r.get("kind") == "cards"]
NEW = [r["path"] for r in ROWS if r.get("kind") == "cards" and r.get("added") == "1.16"]
SHOTS = os.environ.get("CARDS_SHOT_DIR", "/tmp/bake-cards")
MEASURE = """() => { const t = document.querySelector('.zc-table'); if (!t) return { table: false };
  const tr = t.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
  const cards = [...document.querySelectorAll('.zc-card')].filter(c => { const r = c.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(c).display !== 'none' && getComputedStyle(c).visibility !== 'hidden'; });
  const out = cards.filter(c => { const r = c.getBoundingClientRect(); return r.left < tr.left - 1.5 || r.right > tr.right + 1.5 || r.bottom > Math.min(tr.bottom, vh) + 1.5 || r.top < tr.top - 1.5; }).map(c => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; });
  return { table: true, n: cards.length, outside: out.slice(0, 4), outsideCount: out.length, vw: vw, vh: vh, tr: [Math.round(tr.left), Math.round(tr.top), Math.round(tr.right), Math.round(tr.bottom)] }; }"""
PROBLEMS = []


@pytest.mark.parametrize("path", CARD_GAMES)
def test_a_card_game_deals_and_fits_the_phone(site, browser, path):
    os.makedirs(SHOTS, exist_ok=True)
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
    )
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:160]))
    page.goto(site + path)
    page.wait_for_timeout(2500)
    m = page.evaluate(MEASURE)
    if not m.get("table") or not m.get("n"):
        # a sheet or a bet may be waiting: press the first enabled button that says deal / start / bet / play, a few times
        for _ in range(3):
            clicked = page.evaluate("""() => { const b = [...document.querySelectorAll('button')].find(x => !x.disabled && x.getBoundingClientRect().width > 0 && /deal|start|bet|play|ok|new game|let/i.test(x.innerText || x.getAttribute('aria-label') || '')); if (b) { b.click(); return (b.innerText || '').trim().slice(0, 20); } return null; }""")
            page.wait_for_timeout(1500)
            m = page.evaluate(MEASURE)
            if m.get("n") or not clicked:
                break
    # one tap where one can land: the topmost face-up card
    page.evaluate(
        """() => { const c = [...document.querySelectorAll('.zc-card:not(.zc-down)')].filter(e => e.getBoundingClientRect().width > 4).pop(); if (c) { const r = c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1 })); c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1 })); c.click(); } }"""
    )
    page.wait_for_timeout(800)
    m2 = page.evaluate(MEASURE)
    if path in NEW:
        page.screenshot(
            path=os.path.join(SHOTS, "g-%s.png" % path.replace(".html", ""))
        )
    ctx.close()
    issues = []
    if errs:
        issues.append("page errors: %s" % errs[:2])
    if not m.get("table") or not m.get("n"):
        issues.append("no cards on the table after load (n=%s)" % m.get("n"))
    for tag, mm in (("dealt", m), ("after a tap", m2)):
        if mm.get("outsideCount"):
            issues.append(
                "%s: %d card(s) outside the table/screen e.g. %s (table %s, viewport %sx%s)"
                % (
                    tag,
                    mm["outsideCount"],
                    mm["outside"][:2],
                    mm["tr"],
                    mm["vw"],
                    mm["vh"],
                )
            )
    if issues:
        PROBLEMS.append((path, issues))
    assert not [
        i for i in issues if i.startswith("page errors") or i.startswith("no cards")
    ], "%s: %s" % (path, issues)


def test_zz_contact_sheet_of_the_new_games_and_the_layout_problems():
    from PIL import Image

    shots = [os.path.join(SHOTS, "g-%s.png" % p.replace(".html", "")) for p in NEW]
    shots = [s for s in shots if os.path.exists(s)]
    if shots:
        ims = [Image.open(s).convert("RGB") for s in shots]
        w, h = ims[0].size
        sc = 0.32
        tw, th = int(w * sc), int(h * sc)
        cols = 7
        rows = (len(ims) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * tw, rows * th), (30, 30, 30))
        for i, im in enumerate(ims):
            sheet.paste(im.resize((tw, th)), ((i % cols) * tw, (i // cols) * th))
        sheet.save(os.path.join(SHOTS, "new13.png"))
    with open(os.path.join(SHOTS, "problems.json"), "w") as f:
        json.dump(PROBLEMS, f, indent=1)
    print("\nLAYOUT PROBLEMS:", json.dumps(PROBLEMS))
