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

SCREENS = 4

_SCROLLER_JS = """() => { const d = document.querySelector('iframe').contentDocument; const w = document.querySelector('iframe').contentWindow;
  let best = {el: null, h: d.documentElement.scrollHeight};
  for (const e of d.querySelectorAll('*')) { const cs = w.getComputedStyle(e);
    if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 50 && e.scrollHeight > best.h) best = {el: e, h: e.scrollHeight}; }
  window.__scroller = best.el; return best.h; }"""


def scroll_strip(page, prefix, screens):
    """``screens`` screenshots down the opened page, stitched side by side into
    ``<prefix>.png``. Scrolls whichever element actually scrolls: the document,
    or an inner container when the document does not (Wikipedia's skin)."""
    from PIL import Image

    height = page.evaluate(_SCROLLER_JS) or 0
    step = max(1, (height - 844) // max(1, screens - 1)) if height > 844 else 844
    shots = []
    for i in range(screens):
        y = min(i * step, max(0, height - 844))
        page.evaluate(
            "y => { const f = document.querySelector('iframe'); if (window.__scroller) window.__scroller.scrollTop = y; else f.contentWindow.scrollTo(0, y); }",
            y,
        )
        page.wait_for_timeout(900)
        path = f"{prefix}-{i}.png"
        page.screenshot(path=path)
        shots.append(path)
        if height <= 844:
            break
    page.evaluate(
        "() => { const f = document.querySelector('iframe'); if (window.__scroller) window.__scroller.scrollTop = 0; else f.contentWindow.scrollTo(0, 0); }"
    )
    ims = [Image.open(x).convert("RGB") for x in shots]
    strip = Image.new("RGB", (sum(i.width for i in ims), ims[0].height), "white")
    x = 0
    for im in ims:
        strip.paste(im, (x, 0))
        x += im.width
    strip.save(prefix + ".png")
    return {"height": height, "screens": len(shots), "path": prefix + ".png"}


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
    strip = scroll_strip(page, os.path.join(shots, "3-open"), SCREENS)
    reader = page.evaluate(_READER_JS) or {}
    rec.update(open_s=round(time.time() - t2, 1), reader=reader, strip=strip)
    return rec


def compare(browser, base, token_file, out, rows):
    """For every site with a released Kiwix ZIM already in the survey server's
    library, open that ZIM's main page the same way and take the same strip,
    then put ours above theirs in one image per site."""
    import json as _json
    import urllib.request

    from PIL import Image, ImageDraw

    tok = open(token_file).read().strip()
    req = urllib.request.Request(base + "/list", headers={"Authorization": "Bearer " + tok})
    items = _json.loads(urllib.request.urlopen(req, timeout=60).read())
    items = items if isinstance(items, list) else items.get("zims", [])
    for site in SITES:
        if not site.released:
            continue
        theirs = next((z for z in items if (z.get("file") or "").endswith(site.released + ".zim")), None)
        ours = next((r for r in rows if r["site"] == site.key and r["mode"] == "page" and r.get("strip")), None)
        if not theirs or not ours:
            print("compare: skipping", site.key, "(no released ZIM)" if not theirs else "(no strip of ours)", flush=True)
            continue
        page = browser.new_page(viewport=PHONE, extra_http_headers={"Authorization": "Bearer " + tok})
        try:
            page.goto(base + "/w/" + theirs["name"], wait_until="load", timeout=120000)
            page.wait_for_timeout(2500)
            shots = os.path.join(out, f"{site.key}-released")
            os.makedirs(shots, exist_ok=True)
            their_strip = scroll_strip(page, os.path.join(shots, "3-open"), SCREENS)
            reader = page.evaluate(_READER_JS) or {}
        finally:
            page.close()
        a = Image.open(ours["strip"]["path"]).convert("RGB")
        b = Image.open(their_strip["path"]).convert("RGB")
        w = max(a.width, b.width)
        sheet = Image.new("RGB", (w, a.height + b.height + 44), "white")
        d = ImageDraw.Draw(sheet)
        rd = ours.get("reader") or {}
        d.text((4, 4), f"OURS {site.key} (page): {ours.get('card_facts', '')} | imgs {rd.get('painted')}/{rd.get('images')} | text {rd.get('text')}", fill="black")
        sheet.paste(a, (0, 22))
        d.text((4, a.height + 26), f"THEIRS {site.released}: {(theirs.get('size_bytes') or 0) / 1e6:.1f} MB | {theirs.get('article_count', '?')} articles | imgs {reader.get('painted')}/{reader.get('images')} | text {reader.get('text')}", fill="black")
        sheet.paste(b, (0, a.height + 44))
        path = os.path.join(out, f"compare-{site.key}.png")
        sheet.save(path)
        print("compare:", path, flush=True)


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
        label = f"{r['site']}/{r['mode']} {r.get('engine','')} {rd.get('painted','-')}/{rd.get('images','-')} {r.get('job_s','-')}s"
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
    ap.add_argument("--compare-base", help="the survey server holding the released ZIMs")
    ap.add_argument("--compare-token", help="its Bearer credential file")
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
        if a.compare_base and a.compare_token:
            compare(browser, a.compare_base, a.compare_token, a.out, rows)
        browser.close()
    sheet = contact_sheet(a.out, rows)
    print("contact sheet:", sheet)


if __name__ == "__main__":
    main()
