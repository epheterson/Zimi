#!/usr/bin/env python3
"""Every survey site through the create page the way a person does it.

For each site: open the page cold, pick the mode, type the address, wait for
the probe, record which engine it picked and what the preview said, tap
Create, wait for the finish, tap Open, and look at what opened: images
painted after one screen of scrolling, text length, and a screenshot. One
row per site in a JSON file and a contact sheet of the opened results, so a
person can look at all of them at once.

  python3 scripts/survey_ui_pass.py --base http://127.0.0.1:8902 --out scratchpad/survey/ui-pass [--only KEY] [--modes page,site]

Against a PASSWORDLESS local server on loopback (that is the admin).
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from playwright.sync_api import sync_playwright  # noqa: E402

from scripts.survey_sites import SITES  # noqa: E402

PHONE = {"width": 390, "height": 844}
CHIP = {"page": "Web page", "site": "Whole site", "video": "Video or playlist"}

_FORM_JS = """() => ({
  engine: (document.querySelector('#create-engine input:checked') || {}).value,
  pick: (document.getElementById('create-engine-pick') || {}).textContent,
  probing: !!window._createProbing,
  preview: ((document.querySelector('.create-preview-box') || {}).innerText || '').replace(/\\s+/g, ' ').trim(),
})"""

_DONE_JS = """() => {
  const card = document.querySelector('.create-done');
  const fail = document.querySelector('#create-fail-slot .create-status');
  const v = document.getElementById('create-view');
  const txt = (v.innerText || '').replace(/\\s+/g, ' ');
  return {done: !!card, failed: !!fail, name: card ? (card.querySelector('.create-done-name') || {}).textContent : null,
          facts: card ? (card.querySelector('.create-done-facts') || {}).innerText : null,
          error: fail ? ((document.querySelector('#create-fail-slot .create-error') || {}).innerText || '') : '',
          steps: [...document.querySelectorAll('.create-step')].map(e => e.dataset.state)};
}"""

_READER_JS = """() => {
  const fr = document.querySelector('iframe'); if (!fr || !fr.contentDocument) return null;
  const d = fr.contentDocument;
  return {title: d.title, images: d.images.length, painted: [...d.images].filter(i => i.naturalWidth > 0).length,
          text: (d.body ? d.body.innerText : '').length, topbars: document.querySelectorAll('.topbar').length};
}"""


def one(page, base, site, mode, out, cap_s):
    rec = {"site": site.key, "url": site.url, "mode": mode}
    shots = os.path.join(out, f"{site.key}-{mode}")
    os.makedirs(shots, exist_ok=True)
    page.goto(base + "/#create", wait_until="load", timeout=60000)
    page.wait_for_timeout(1500)
    page.click(f'button.create-chip:has-text("{CHIP[mode]}")')
    page.wait_for_timeout(300)
    page.fill("#create-source", site.url)
    if mode == "site":
        page.fill("#create-max-pages", "25")
    page.locator("#create-source").blur()
    t0 = time.time()
    form = None
    while time.time() - t0 < 60:
        page.wait_for_timeout(500)
        form = page.evaluate(_FORM_JS)
        if form["preview"] and not form["probing"] and "Looking" not in form["preview"]:
            break
    page.wait_for_timeout(1500)
    form = page.evaluate(_FORM_JS)
    rec.update(
        engine=form["engine"] or "builtin",
        engine_label=form["pick"],
        preview=form["preview"][:300],
        probe_s=round(time.time() - t0, 1),
    )
    page.screenshot(path=os.path.join(shots, "1-form.png"))
    t1 = time.time()
    page.click("#create-start")
    st = {"done": False, "failed": False}
    while time.time() - t1 < cap_s:
        page.wait_for_timeout(1000)
        st = page.evaluate(_DONE_JS)
        if st["done"] or st["failed"]:
            break
    rec.update(
        job_s=round(time.time() - t1, 1),
        done=st["done"],
        failed=st["failed"],
        card_name=st.get("name"),
        card_facts=(st.get("facts") or "").replace("\n", " · "),
        error=(st.get("error") or "")[:200],
        steps=st.get("steps"),
    )
    page.wait_for_timeout(600)
    page.screenshot(path=os.path.join(shots, "2-done.png"))
    if not st["done"]:
        return rec
    page.click(".create-done-open")
    t2 = time.time()
    reader = None
    while time.time() - t2 < 60:
        page.wait_for_timeout(800)
        reader = page.evaluate(_READER_JS)
        if reader and reader["text"] > 0:
            break
    page.wait_for_timeout(1500)
    page.evaluate(
        "() => { const f = document.querySelector('iframe'); if (f && f.contentWindow) f.contentWindow.scrollTo(0, 700); }"
    )
    page.wait_for_timeout(1200)
    page.evaluate(
        "() => { const f = document.querySelector('iframe'); if (f && f.contentWindow) f.contentWindow.scrollTo(0, 0); }"
    )
    page.wait_for_timeout(600)
    reader = page.evaluate(_READER_JS) or {}
    rec.update(open_s=round(time.time() - t2, 1), reader=reader)
    page.screenshot(path=os.path.join(shots, "3-open.png"))
    return rec


def contact_sheet(out, rows):
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return None
    tiles = []
    for r in rows:
        p = os.path.join(
            out,
            f"{r['site']}-{r['mode']}",
            "3-open.png" if r.get("done") else "2-done.png",
        )
        if os.path.exists(p):
            tiles.append((r, p))
    if not tiles:
        return None
    w, h = 195, 422  # half of 390x844
    cols = 5
    rows_n = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w, rows_n * (h + 18)), "white")
    draw = ImageDraw.Draw(sheet)
    for i, (r, p) in enumerate(tiles):
        im = Image.open(p).convert("RGB").resize((w, h))
        x, y = (i % cols) * w, (i // cols) * (h + 18)
        sheet.paste(im, (x, y + 18))
        rd = r.get("reader") or {}
        label = f"{r['site']}/{r['mode']} {r['engine']} {rd.get('painted','-')}/{rd.get('images','-')} {r['job_s']}s"
        draw.text((x + 3, y + 3), label[:34], fill="black")
    path = os.path.join(out, "contact-sheet.png")
    sheet.save(path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8902")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only")
    ap.add_argument("--modes", default="page")
    ap.add_argument("--cap", type=int, default=600)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "results.json")
    rows = json.load(open(path)) if os.path.exists(path) else []
    have = {(r["site"], r["mode"]) for r in rows}
    modes = a.modes.split(",")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for mode in modes:
            for site in SITES:
                if a.only and site.key != a.only:
                    continue
                if mode == "site" and not site.released:
                    continue
                if (site.key, mode) in have:
                    continue
                page = browser.new_page(viewport=PHONE)
                try:
                    rec = one(page, a.base, site, mode, a.out, a.cap)
                except Exception as e:  # never stop the pass on one site
                    rec = {
                        "site": site.key,
                        "url": site.url,
                        "mode": mode,
                        "crashed": repr(e)[:200],
                    }
                finally:
                    page.close()
                rows.append(rec)
                json.dump(rows, open(path, "w"), indent=1)
                print(
                    json.dumps({k: v for k, v in rec.items() if k not in ("preview",)}),
                    flush=True,
                )
        browser.close()
    sheet = contact_sheet(a.out, rows)
    print("contact sheet:", sheet)


if __name__ == "__main__":
    main()
