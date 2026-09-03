#!/usr/bin/env python3
"""Drive the create page the way a person does and record what it showed.

  python3 scripts/survey_ui.py --base http://127.0.0.1:8902 --mode site \\
      --url https://www.sqlite.org/ --max-pages 40 --width 390 --out scratchpad/survey/ui/site-flip

Against a PASSWORDLESS local server on loopback (that is the admin). Every
second it records whether the FORM or the JOB is on screen, the page counter,
and the visible buttons; every change between form and job is a "flip" and
gets a screenshot, as does the finish. In parallel a thread polls the status
API at 0.3 s and logs every change of (active, done, phase, id), so a flip on
screen can be matched to what the server said at that moment.
"""

import argparse
import json
import os
import threading
import time
import urllib.request

from playwright.sync_api import sync_playwright


def watch_api(base, stop, log):
    prev = None
    while not stop.is_set():
        try:
            d = json.loads(
                urllib.request.urlopen(
                    base + "/manage/create/status?since=0", timeout=10
                ).read()
            )
            key = (
                d.get("active"),
                d.get("done"),
                d.get("phase"),
                d.get("id"),
                len(d.get("queue") or []),
            )
        except Exception as e:  # a failed poll is itself an event worth logging
            key = ("ERR", str(e)[:80])
        if key != prev:
            log.append((time.time(), key))
            prev = key
        time.sleep(0.3)


_STATE_JS = """() => {
  const v = document.getElementById('create-view');
  const src = document.getElementById('create-source');
  const form = !!src && src.offsetParent !== null;
  const btns = [...v.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.innerText.trim()).filter(Boolean);
  const txt = (v.innerText || '').replace(/\\s+/g, ' ');
  const m = txt.match(/(\\d+) \\/ (\\d+) pages/);
  return {form, pages: m ? m[1] + '/' + m[2] : '', done: /Added to the library/.test(txt) && !form,
          failed: /failed|could not|gave up/i.test(txt) && !form, head: txt.slice(0, 200), btns: btns.slice(0, 5)};
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8902")
    ap.add_argument("--mode", default="page", choices=["page", "site", "video"])
    ap.add_argument("--url", required=True)
    ap.add_argument("--engine", default="")
    ap.add_argument("--max-pages", type=int)
    ap.add_argument("--width", type=int, default=390)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cap", type=int, default=900, help="seconds")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    api_log, stop = [], threading.Event()
    threading.Thread(
        target=watch_api, args=(a.base, stop, api_log), daemon=True
    ).start()
    chip = {"page": "Web page", "site": "Whole site", "video": "Video or playlist"}[
        a.mode
    ]
    frames, flips, bad, errs = [], [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": a.width, "height": 844 if a.width < 700 else 900}
        )
        page.on(
            "response",
            lambda r: bad.append((r.status, r.url)) if r.status >= 400 else None,
        )
        page.on(
            "console",
            lambda m: errs.append(m.text[:160]) if m.type == "error" else None,
        )
        page.goto(a.base + "/#create", wait_until="load", timeout=60000)
        page.wait_for_timeout(2500)
        page.click(f'button.create-chip:has-text("{chip}")')
        page.wait_for_timeout(400)
        page.fill("#create-source", a.url)
        if a.engine:
            page.click(f'label.create-seg-opt:has(input[value="{a.engine}"])')
        if a.max_pages:
            page.fill("#create-max-pages", str(a.max_pages))
        page.screenshot(path=os.path.join(a.out, "00-form.png"))
        t0 = time.time()
        page.click("#create-start")
        prev_form = None
        while time.time() - t0 < a.cap:
            page.wait_for_timeout(1000)
            s = page.evaluate(_STATE_JS)
            t = round(time.time() - t0, 1)
            if prev_form is not None and s["form"] != prev_form:
                flips.append({"t": t, **s})
                page.screenshot(path=os.path.join(a.out, f"flip-{int(t):03d}s.png"))
            if int(t) % 10 == 0 or prev_form is None:
                frames.append({"t": t, **s})
                page.screenshot(path=os.path.join(a.out, f"{int(t):03d}s.png"))
            prev_form = s["form"]
            # Evidence survives a kill: the report is rewritten every second.
            with open(os.path.join(a.out, "report.json"), "w") as f:
                json.dump({"elapsed_s": t, "flips": flips, "frames": frames[-5:], "state": s,
                           "api_changes": [(round(ts - t0, 1), key) for ts, key in api_log]}, f, indent=1)
            if s["done"] or s["failed"]:
                frames.append({"t": t, **s})
                page.screenshot(path=os.path.join(a.out, f"done-{int(t):03d}s.png"))
                break
        browser.close()
    stop.set()
    report = {
        "elapsed_s": round(time.time() - t0, 1),
        "flips": flips,
        "api_changes": [(round(ts - t0, 1), key) for ts, key in api_log],
        "frames": frames,
        "http_4xx_5xx": bad[:10],
        "console_errors": errs[:10],
    }
    with open(os.path.join(a.out, "report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps({k: v for k, v in report.items() if k != "frames"}, indent=1))
    print("frames:", len(frames), "last:", frames[-1] if frames else None)


if __name__ == "__main__":
    main()
