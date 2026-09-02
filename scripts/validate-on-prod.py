#!/usr/bin/env python3
"""The phone-path gate: what Eric sees, checked in a real browser against the
RUNNING prod server, on a capture made the way he makes them (the manage API,
Fast engine). Born from his 2026-08-31 gate run, which found three defects in
ten minutes that a suite, a release gate and a container-side paint gate had
all missed: no favicon on the captured page, a second header, slow loading.

Runs INSIDE the zim-reader container, where Playwright, the token and the
real library are:

  docker cp scripts/validate-on-prod.py zim-reader:/tmp/v.py
  docker exec -e PYTHONPATH=/app -w /app zim-reader python3 /tmp/v.py
  # reuse the last capture instead of making one:
  docker exec -e PYTHONPATH=/app -w /app -e REUSE_CAPTURE=www_cnn_com-2 zim-reader python3 /tmp/v.py

Prints one PASS/FAIL line per complaint plus the numbers behind it. Run it
after every deploy, once the container is warm (title indexes take ~80 s
after a restart, and a cold shell reads as 20 s)."""

import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8899"
PHONE = {"width": 390, "height": 844}
TOKEN = open("/data/api_token").read().strip()
HDR = {"Authorization": "Bearer " + TOKEN}

STANDALONE_SHIM = """
  const orig = window.matchMedia.bind(window);
  window.matchMedia = q => (q.includes('display-mode') && q.includes('standalone'))
    ? {matches:true, media:q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}}
    : orig(q);
  Object.defineProperty(navigator, 'standalone', {get: () => true});
"""

results = []


def verdict(name, ok, detail):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + " — " + detail, flush=True)


def api(path, data=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={**HDR, "Content-Type": "application/json"},
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def capture_cnn():
    """A fresh cnn.com page capture through the real job path."""
    started = api(
        "/manage/create",
        {
            "mode": "page",
            "source": "https://cnn.com",
            "title": "CNN — 1.9 complaints check",
            "engine": "builtin",
        },
    )
    print("job", started, flush=True)
    t0 = time.time()
    while True:
        st = api("/manage/create/status")
        if st.get("done") or not st.get("active"):
            if st.get("done") or st.get("phase") == "done":
                break
        if time.time() - t0 > 600:
            raise SystemExit("capture did not finish in 10 minutes")
        time.sleep(2)
    took = time.time() - t0
    lst = api("/list")
    items = lst if isinstance(lst, list) else lst.get("zims", [])
    cnn = sorted(
        [z for z in items if z.get("folder") == "created" and "cnn" in z["name"]],
        key=lambda z: z.get("first_seen") or 0,
    )
    if not cnn:
        raise SystemExit("no cnn capture in the library after the job")
    return cnn[-1]["name"], took, st


def look(page, name):
    wire = []

    def on_resp(r):
        try:
            n = int(r.headers.get("content-length") or 0)
            if not n:
                try:
                    n = len(r.body())
                except Exception:
                    n = 0
            wire.append((r.url, n, r.headers.get("content-type", "")))
        except Exception:
            pass

    page.on("response", on_resp)
    t0 = time.time()
    page.goto(BASE + "/w/" + name, wait_until="load", timeout=120000)
    t_load = time.time() - t0
    page.wait_for_timeout(1500)
    h = page.evaluate(
        "document.querySelector('iframe').contentDocument.documentElement.scrollHeight"
    )
    for y in range(0, int(h), 700):
        page.evaluate(
            "y => document.querySelector('iframe').contentWindow.scrollTo(0, y)", y
        )
        page.wait_for_timeout(100)
    page.wait_for_timeout(2500)
    t_all = time.time() - t0
    facts = page.evaluate("""async () => {
      const vis = e => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0; };
      const fr = document.querySelector('iframe'); const d = fr.contentDocument; const w = fr.contentWindow;
      const topbars = [...document.querySelectorAll('.topbar')].filter(vis).length;
      const under = d.elementFromPoint(200, 20);
      const ucs = w.getComputedStyle(under);
      const icons = [];
      for (const l of d.querySelectorAll('link[rel*=icon]')) {
        const r = await fetch(l.href); icons.push([l.href.replace(location.origin, ''), r.status]);
      }
      const slots = [...d.querySelectorAll('[class^="ad-slot"],[class*=" ad-slot"]')];
      return {
        topbars,
        under: {tag: under.tagName, cls: (under.className || '').toString().slice(0, 50), bg: ucs.backgroundColor,
                h: Math.round(under.getBoundingClientRect().height)},
        icons,
        adSlots: slots.length, visibleSlots: slots.filter(vis).length,
        imgs: d.images.length, painted: [...d.images].filter(i => i.naturalWidth > 0).length,
        text: (d.body.innerText || '').length,
        innerTitle: d.title,
      };
    }""")
    page.remove_listener("response", on_resp)
    total = sum(n for _, n, _ in wire)
    return facts, t_load, t_all, len(wire), total


def main():
    health = api("/health")
    sw = urllib.request.urlopen(BASE + "/static/sw.js", timeout=30).read().decode()
    cache_version = sw.split("const CACHE_VERSION = '")[1].split("'")[0]
    verdict(
        "PWA caching: served sw.js is pinned to this deploy",
        health.get("asset_version") == cache_version,
        f"health.asset_version={health.get('asset_version')} sw.CACHE_VERSION={cache_version} version={health.get('version')}",
    )

    if os.environ.get("REUSE_CAPTURE"):
        name = os.environ["REUSE_CAPTURE"]
        print("reusing capture", name, flush=True)
    else:
        name, took, st = capture_cnn()
        verdict(
            "capture the way Eric does it (+, cnn.com, Fast)",
            bool(st.get("ok")),
            f"{name} in {took:.0f}s, phase={st.get('phase')}",
        )

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport=PHONE, extra_http_headers=HDR, device_scale_factor=2
        )
        ctx.add_init_script(STANDALONE_SHIM)

        # Shell load, phone width, standalone.
        page = ctx.new_page()
        t0 = time.time()
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        dcl_ms = int((time.time() - t0) * 1000)
        try:
            page.wait_for_load_state("networkidle", timeout=45000)
            idle_ms = int((time.time() - t0) * 1000)
        except Exception:
            idle_ms = -1
        fcp = page.evaluate(
            "(()=>{const e=performance.getEntriesByType('paint').find(x=>x.name==='first-contentful-paint'); return e? Math.round(e.startTime):null})()"
        )
        shell_bars = page.evaluate(
            "[...document.querySelectorAll('.topbar')].filter(e=>e.getBoundingClientRect().height>0).length"
        )
        # What a person feels is the first paint and the moment the shell is
        # usable; the last discover card and the 65 source icons trail behind
        # under the ZIM lock, and that tail is reported, not judged.
        verdict(
            "loading was slow (shell)",
            (fcp or 9999) < 1000 and dcl_ms < 2000 and shell_bars == 1,
            f"first paint {fcp} ms, usable {dcl_ms} ms, every card and icon in {idle_ms} ms, {shell_bars} topbar",
        )
        page.close()

        page = ctx.new_page()
        facts, t_load, t_all, nreq, total = look(page, name)
        page.screenshot(path="/tmp/validate-cnn.png")
        verdict(
            "CNN has no favicon",
            bool(facts["icons"]) and all(s == 200 for _, s in facts["icons"]),
            f"page icons {facts['icons']}",
        )
        dark = facts["under"]["bg"] in ("rgb(12, 12, 12)", "rgb(0, 0, 0)")
        verdict(
            "two headers (PWA, standalone forced)",
            facts["topbars"] == 1 and facts["visibleSlots"] == 0 and not dark,
            f"{facts['topbars']} topbar; under it: <{facts['under']['tag']} class='{facts['under']['cls']}'> bg={facts['under']['bg']} h={facts['under']['h']}; "
            f"ad slots {facts['adSlots']}, visible {facts['visibleSlots']}",
        )
        verdict(
            "CNN loading slow",
            t_load < 8 and facts["painted"] == facts["imgs"],
            f"load {t_load:.1f}s, everything scrolled and painted {t_all:.1f}s, {nreq} requests, {total/1e6:.1f} MB, "
            f"images {facts['painted']}/{facts['imgs']}, text {facts['text']} chars",
        )
        page.close()

        # Eric's own capture from yesterday still opens (no regression on old ZIMs).
        page = ctx.new_page()
        page.goto(BASE + "/w/www_cnn_com", wait_until="load", timeout=120000)
        page.wait_for_timeout(1500)
        old = page.evaluate(
            "(() => { const d=document.querySelector('iframe').contentDocument; return {title:d.title, imgs:d.images.length}; })()"
        )
        verdict(
            "yesterday's capture still opens", "CNN" in old["title"], json.dumps(old)
        )
        page.close()
        browser.close()

    bad = [n for n, ok, _ in results if not ok]
    print("\n" + ("ALL PASS" if not bad else "FAILED: " + "; ".join(bad)), flush=True)
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
