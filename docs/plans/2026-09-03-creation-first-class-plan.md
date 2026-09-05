# Creation flow, first class — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the creation flow on 20 real sites against released ZIMs, fix what the measurements show, put the create page through a design review, and only then tag 1.9.0.

**Architecture:** One survey script drives a local `zimi serve` through the real manage API (and the real create page for one job per mode), captures every site with every engine, opens every result in a headless Chromium at phone width, and writes one regenerable Markdown report. Fixes are TDD'd from rows of that report. The design pass runs on the create page after the fixes.

**Tech Stack:** Python 3.12+, Playwright (sync API, local Chromium at `~/Library/Caches/ms-playwright/chromium-1200`), libzim reader, the existing `zimi serve`.

**Spec:** `docs/plans/2026-09-03-creation-first-class-spec.md`

## Global Constraints

- Branch `v1.9`; nothing pushed, tagged, or deployed without Eric's word.
- Port 8899 on this Mac belongs to the desktop app (launched by deploy.sh); the survey server runs on **8901** with `ZIMI_MANAGE_PASSWORD` from `scratchpad/survey-token` and `ZIM_DIR=scratchpad/zims`, `ZIMI_DATA_DIR=scratchpad/data`.
- No NAS load: the whole matrix runs on this Mac.
- Reports are regenerated, never hand-edited: `docs/plans/2026-09-03-creation-survey.md`.
- Every fix: failing test first, one commit per defect, `git commit -- <paths>`.

---

### Task 1: Site list and job matrix

**Files:**
- Create: `scripts/survey_sites.py`
- Test: `tests/test_survey_sites.py`

**Interfaces:**
- Produces: `SITES: list[Site]` where `Site = namedtuple("Site", "key url kind released")`; `released` is the Kiwix catalog name (e.g. `solar.lowtechmagazine.com_mul_all`) or `""`. `JOBS: list[Job]` where `Job = namedtuple("Job", "site mode engine extra")`; `mode` in `page|site|video`, `engine` in `builtin|rendered|alive`, `extra` a dict merged into the create payload (`max_pages` for site mode, `limit` for video).
- `def matrix() -> list[Job]` returns the 76 jobs in run order: every site × page × (builtin, rendered, alive); the six released-set sites × site × (builtin, rendered) with `max_pages=25`; two video jobs with `limit=2`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_survey_sites.py
from scripts.survey_sites import SITES, matrix

def test_twenty_sites_and_six_have_a_released_zim():
    assert len(SITES) == 20
    assert sum(1 for s in SITES if s.released) == 6

def test_the_matrix_covers_every_site_with_every_engine():
    jobs = matrix()
    page = [j for j in jobs if j.mode == "page"]
    assert len(page) == 60
    for s in SITES:
        assert {j.engine for j in page if j.site.key == s.key} == {"builtin", "rendered", "alive"}
    site_jobs = [j for j in jobs if j.mode == "site"]
    assert len(site_jobs) == 12 and all(j.extra["max_pages"] == 25 for j in site_jobs)
    assert len([j for j in jobs if j.mode == "video"]) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_survey_sites.py -q`
Expected: FAIL, `ModuleNotFoundError: scripts.survey_sites`

- [ ] **Step 3: Write the module**

```python
# scripts/survey_sites.py
"""The 20 sites and 76 jobs of the creation survey. Data only."""
from collections import namedtuple

Site = namedtuple("Site", "key url kind released")
Job = namedtuple("Job", "site mode engine extra")

SITES = [
    Site("lowtech", "https://solar.lowtechmagazine.com/", "released", "solar.lowtechmagazine.com_mul_all"),
    Site("peps", "https://peps.python.org/", "released", "peps.python_en_all"),
    Site("planetmath", "https://planetmath.org/", "released", "planetmath.org_en_all"),
    Site("cheatography", "https://cheatography.com/", "released", "cheatography.com_en_all"),
    Site("fosscooking", "https://foss.cooking/", "released", "foss.cooking_en_all"),
    Site("sh1", "https://sh1.org/", "released", "sh1.org_en_all"),
    Site("sqlite", "https://www.sqlite.org/", "static", ""),
    Site("sivers", "https://sive.rs/n", "static", ""),
    Site("pg", "https://paulgraham.com/articles.html", "static", ""),
    Site("dockerdocs", "https://docs.docker.com/get-started/", "static", ""),
    Site("react", "https://react.dev/learn", "static", ""),
    Site("cnn", "https://www.cnn.com/", "js", ""),
    Site("bbc", "https://www.bbc.com/", "js", ""),
    Site("verge", "https://www.theverge.com/", "js", ""),
    Site("apple", "https://www.apple.com/", "js", ""),
    Site("github", "https://github.com/openzim/zimit", "js", ""),
    Site("hn", "https://news.ycombinator.com/", "awkward", ""),
    Site("xkcd", "https://xkcd.com/", "awkward", ""),
    Site("wiki", "https://en.wikipedia.org/wiki/Water_purification", "awkward", ""),
    Site("medium", "https://medium.com/@steve.yegge/the-death-of-the-junior-developer-6c4e3f3ba3a8", "awkward", ""),
]

VIDEOS = [
    "https://www.youtube.com/playlist?list=PLzMcBGfZo4-kCLWnGmK0jUBmGLaJxvi4j",
    "https://www.youtube.com/@Kurzgesagt/videos",
]

ENGINES = ("builtin", "rendered", "alive")


def matrix():
    jobs = []
    for s in SITES:
        for e in ENGINES:
            jobs.append(Job(s, "page", e, {}))
    for s in SITES:
        if s.released:
            for e in ("builtin", "rendered"):
                jobs.append(Job(s, "site", e, {"max_pages": 25}))
    for url in VIDEOS:
        jobs.append(Job(Site("video", url, "video", ""), "video", "builtin", {"limit": 2}))
    return jobs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_survey_sites.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add scripts/survey_sites.py tests/test_survey_sites.py
git commit -m "test: the 20 sites and 76 jobs of the creation survey" -- scripts/survey_sites.py tests/test_survey_sites.py
```

### Task 2: The measurements

**Files:**
- Create: `scripts/survey_measure.py`
- Test: `tests/test_survey_measure.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `def zim_facts(path) -> dict` with keys `bytes, entries, counter (dict mime→count), main_path, title, illustration (bool)`, read with `libzim.reader.Archive`.
  - `def flow_facts(events) -> dict` where `events` is the list of `{"ts": float, "line": str}` the survey collected while polling; keys `first_line_s, longest_gap_s, backwards (list of lines where a counter decreased), lines`.
  - `def page_facts(page, base, name, shots_dir) -> dict` driving a Playwright page at 390×844 to `base + "/w/" + name`, scrolling to the bottom, keys `load_s, images, painted, text_chars, leaked (list), console_errors, requests, wire_bytes, under_topbar (dict tag/cls/bg/h), shots (list of paths)`.
  - `LEAK_MARKERS = ["data-fave-thumbnails", "data-source-html", 'href="&quot;', "&quot;https://", "<div", "</a>"]`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_survey_measure.py
from scripts.survey_measure import flow_facts

def test_flow_facts_reads_gaps_and_backwards_counters():
    ev = [
        {"ts": 10.0, "line": "fetching https://e.com/"},
        {"ts": 10.4, "line": "carried 12 assets, 4000 bytes"},
        {"ts": 25.0, "line": "carried 9 assets, 9000 bytes"},
        {"ts": 26.0, "line": "ZIM written"},
    ]
    f = flow_facts(ev, started=9.5)
    assert f["first_line_s"] == 0.5
    assert f["longest_gap_s"] == 14.6
    assert f["backwards"] == ["carried 9 assets, 9000 bytes"]
    assert f["lines"] == 4
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m pytest tests/test_survey_measure.py -q`
Expected: FAIL, `ModuleNotFoundError`

- [ ] **Step 3: Write the module**

```python
# scripts/survey_measure.py
"""What the creation survey measures. Pure functions where possible."""
import re

LEAK_MARKERS = ["data-fave-thumbnails", "data-source-html", 'href="&quot;', "&quot;https://", "<div", "</a>"]
_COUNT_RE = re.compile(r"(\d[\d,]*)\s+(assets|pages|images|entries|variants)")


def flow_facts(events, started):
    lines = [e for e in events if e.get("line")]
    if not lines:
        return {"first_line_s": None, "longest_gap_s": None, "backwards": [], "lines": 0}
    first = round(lines[0]["ts"] - started, 2)
    gaps = [b["ts"] - a["ts"] for a, b in zip(lines, lines[1:])]
    longest = round(max(gaps), 2) if gaps else 0.0
    seen, backwards = {}, []
    for e in lines:
        for num, what in _COUNT_RE.findall(e["line"]):
            n = int(num.replace(",", ""))
            if what in seen and n < seen[what]:
                backwards.append(e["line"])
            seen[what] = n
    return {"first_line_s": first, "longest_gap_s": longest, "backwards": backwards, "lines": len(lines)}


def zim_facts(path):
    from libzim.reader import Archive
    a = Archive(path)
    counter = {}
    try:
        raw = bytes(a.get_metadata("Counter")).decode()
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                counter[k] = int(v)
    except Exception:
        pass
    main = a.main_entry
    if main.is_redirect:
        main = main.get_redirect_entry()
    try:
        title = bytes(a.get_metadata("Title")).decode("utf-8", "replace")
    except Exception:
        title = ""
    import os
    return {"bytes": os.path.getsize(path), "entries": a.entry_count, "counter": counter,
            "main_path": main.path, "title": title, "illustration": a.has_illustration(48)}


_PAGE_JS = """async () => {
  const vis = e => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0; };
  const fr = document.querySelector('iframe'); const d = fr.contentDocument; const w = fr.contentWindow;
  const under = d.elementFromPoint(200, 20); const cs = under ? w.getComputedStyle(under) : null;
  const text = d.body ? (d.body.innerText || '') : '';
  return {
    images: d.images.length, painted: [...d.images].filter(i => i.naturalWidth > 0).length,
    text_chars: text.length, text_head: text.slice(0, 4000),
    under_topbar: under ? {tag: under.tagName, cls: (under.className || '').toString().slice(0, 60),
                           bg: cs.backgroundColor, h: Math.round(under.getBoundingClientRect().height)} : null,
    scroll_h: d.documentElement.scrollHeight, title: d.title,
  };
}"""


def page_facts(page, base, name, shots_dir):
    import os, time
    os.makedirs(shots_dir, exist_ok=True)
    wire, errors = [], []
    page.on("response", lambda r: wire.append(int(r.headers.get("content-length") or 0)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    t0 = time.time()
    page.goto(base + "/w/" + name, wait_until="load", timeout=120000)
    load_s = round(time.time() - t0, 2)
    page.wait_for_timeout(1200)
    shots = [os.path.join(shots_dir, "top.png")]
    page.screenshot(path=shots[0], timeout=20000)
    h = page.evaluate("document.querySelector('iframe').contentDocument.documentElement.scrollHeight")
    for y in range(0, int(h), 700):
        page.evaluate("y => document.querySelector('iframe').contentWindow.scrollTo(0, y)", y)
        page.wait_for_timeout(80)
        if y == 700:
            shots.append(os.path.join(shots_dir, "one-down.png"))
            page.screenshot(path=shots[-1], timeout=20000)
    page.wait_for_timeout(2000)
    facts = page.evaluate(_PAGE_JS)
    leaked = [m for m in LEAK_MARKERS if m in facts.pop("text_head")]
    facts.update(load_s=load_s, leaked=leaked, console_errors=errors[:5],
                 requests=len(wire), wire_bytes=sum(wire), shots=shots)
    return facts
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -m pytest tests/test_survey_measure.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "test: the creation survey's measurements" -- scripts/survey_measure.py tests/test_survey_measure.py
```

### Task 3: The runner and the report

**Files:**
- Create: `scripts/creation-survey.py`

**Interfaces:**
- Consumes: `matrix()` from Task 1; `zim_facts`, `flow_facts`, `page_facts` from Task 2.
- Produces: `docs/plans/2026-09-03-creation-survey.md` and `scratchpad/survey/results.json` (one record per job: the job, `ok`, `error`, `took_s`, `flow`, `zim`, `page`). Resumable: a job whose record exists in `results.json` is skipped, so a crash or a Ctrl-C loses nothing.

- [ ] **Step 1: Write the runner**

```python
#!/usr/bin/env python3
"""Run the creation survey. Usage:
  ZIMI_SURVEY_BASE=http://127.0.0.1:8901 ZIMI_SURVEY_TOKEN_FILE=scratchpad/survey-token \
    python3 scripts/creation-survey.py [--only KEY] [--engine E] [--mode M]
"""
import argparse, json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.survey_sites import matrix
from scripts.survey_measure import flow_facts, page_facts, zim_facts

BASE = os.environ.get("ZIMI_SURVEY_BASE", "http://127.0.0.1:8901")
TOKEN = open(os.environ["ZIMI_SURVEY_TOKEN_FILE"]).read().strip()
HDR = {"Authorization": "Bearer " + TOKEN}
OUT = os.environ.get("ZIMI_SURVEY_OUT", "scratchpad/survey")
ZIM_DIR = os.environ.get("ZIMI_SURVEY_ZIM_DIR", "scratchpad/zims/created")
REPORT = "docs/plans/2026-09-03-creation-survey.md"


def api(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={**HDR, "Content-Type": "application/json"},
                                 method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def run_job(job):
    payload = {"mode": job.mode, "source": job.site.url, "title": f"survey {job.site.key} {job.engine}", **job.extra}
    if job.mode in ("page", "site"):
        payload["engine"] = job.engine
    started = time.time()
    api("/manage/create", payload)
    events, seen, cursor = [], set(), 0
    while True:
        st = api(f"/manage/create/status?since={cursor}")
        for line in st.get("lines", []):
            if line not in seen:
                seen.add(line); events.append({"ts": time.time(), "line": line})
        cursor = st.get("cursor", cursor)
        if st.get("done") or st.get("phase") == "done":
            break
        if time.time() - started > 1800:
            api("/manage/create/cancel", {}); st = {"ok": False, "error": "survey: 30 min cap"}; break
        time.sleep(1.5)
    took = round(time.time() - started, 1)
    rec = {"job": job._asdict() | {"site": job.site._asdict()}, "ok": bool(st.get("ok")),
           "error": st.get("error", ""), "took_s": took, "flow": flow_facts(events, started)}
    if rec["ok"]:
        name = newest_created()
        rec["name"] = name
        rec["zim"] = zim_facts(os.path.join(ZIM_DIR, name + ".zim"))
    return rec


def newest_created():
    items = api("/list")
    items = items if isinstance(items, list) else items.get("zims", [])
    created = sorted((z for z in items if z.get("folder") == "created"), key=lambda z: z.get("first_seen") or 0)
    return created[-1]["name"]


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--only"); ap.add_argument("--engine"); ap.add_argument("--mode")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    results_path = os.path.join(OUT, "results.json")
    results = json.load(open(results_path)) if os.path.exists(results_path) else {}
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, extra_http_headers=HDR)
        for job in matrix():
            key = f"{job.site.key}/{job.mode}/{job.engine}"
            if a.only and job.site.key != a.only: continue
            if a.engine and job.engine != a.engine: continue
            if a.mode and job.mode != a.mode: continue
            if key in results: continue
            print("==", key, flush=True)
            try:
                rec = run_job(job)
                if rec["ok"]:
                    page = ctx.new_page()
                    rec["page"] = page_facts(page, BASE, rec["name"], os.path.join(OUT, job.site.key, job.mode + "-" + job.engine))
                    page.close()
            except Exception as e:
                rec = {"ok": False, "error": f"survey crashed: {e}"}
            results[key] = rec
            json.dump(results, open(results_path, "w"), indent=1)
            write_report(results)
        browser.close()


def write_report(results):
    rows = ["# Creation survey — " + time.strftime("%Y-%m-%d %H:%M"), "",
            "Regenerated by `scripts/creation-survey.py`; do not edit.", "",
            "| job | ok | took | first line | longest gap | back | MB | entries | imgs painted | text | leaked | under topbar | load | note |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for key, r in results.items():
        f, z, pg = r.get("flow", {}), r.get("zim", {}), r.get("page", {})
        under = pg.get("under_topbar") or {}
        rows.append("| %s | %s | %ss | %s | %s | %s | %.1f | %s | %s/%s | %s | %s | %s | %ss | %s |" % (
            key, "✅" if r.get("ok") else "❌", r.get("took_s", ""), f.get("first_line_s", ""), f.get("longest_gap_s", ""),
            len(f.get("backwards", [])), (z.get("bytes") or 0) / 1e6, z.get("entries", ""),
            pg.get("painted", ""), pg.get("images", ""), pg.get("text_chars", ""), ",".join(pg.get("leaked", [])),
            f"{under.get('tag','')}.{under.get('cls','')[:20]} {under.get('bg','')}", pg.get("load_s", ""),
            (r.get("error") or "")[:80].replace("|", "/")))
    open(REPORT, "w").write("\n".join(rows) + "\n")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke it on one job**

Run: `ZIMI_SURVEY_TOKEN_FILE=scratchpad/survey-token python3 scripts/creation-survey.py --only sivers --engine builtin`
Expected: one row in `docs/plans/2026-09-03-creation-survey.md`, `scratchpad/survey/sivers/page-builtin/top.png` exists.

- [ ] **Step 3: Commit the runner**

```bash
git commit -m "test: the creation survey runner and its report" -- scripts/creation-survey.py
```

### Task 4: The compare set

**Files:**
- Modify: `scripts/creation-survey.py` (add `compare()`)

**Interfaces:**
- Produces: rows `released/<name>` in the same report, measured with `page_facts` on the released ZIM's main page and on three articles from `/random?zim=<name>`; `zim_facts` on the file. The six released ZIMs are downloaded once into `scratchpad/zims/released/` from the catalog `download_url` (skip any over 2 GB, note the skip in the report).

- [ ] **Step 1: Add the download and compare pass**

```python
def compare(ctx, results):
    cat = api("/catalog?count=500")
    items = cat if isinstance(cat, list) else cat.get("items") or cat.get("entries") or []
    for s in [s for s in SITES if s.released]:
        key = "released/" + s.key
        if key in results: continue
        item = next((i for i in items if i.get("name") == s.released), None)
        if not item: results[key] = {"ok": False, "error": "not in catalog"}; continue
        size = item.get("size_bytes") or 0
        if size > 2e9: results[key] = {"ok": False, "error": f"skipped: {size/1e9:.1f} GB"}; continue
        dest = os.path.join("scratchpad/zims/released", s.released + ".zim")
        if not os.path.exists(dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            urllib.request.urlretrieve(item["download_url"], dest)
        name = newest_named(s.released)
        page = ctx.new_page()
        rec = {"ok": True, "took_s": 0, "zim": zim_facts(dest), "page": page_facts(page, BASE, name, os.path.join(OUT, s.key, "released"))}
        page.close(); results[key] = rec
```

(`newest_named` = the library entry whose `file` ends with `s.released + ".zim"`; the server rescans `scratchpad/zims` on its own.)

- [ ] **Step 2: Run compare and commit**

Run: `... python3 scripts/creation-survey.py --compare`
Expected: six `released/*` rows.

```bash
git commit -m "test: the survey compares against the released ZIMs" -- scripts/creation-survey.py
```

### Task 5: Run the matrix

- [ ] Start the survey server (see Global Constraints) and run `scripts/creation-survey.py` under `nohup`; it is resumable, so restart it if it dies.
- [ ] While it runs, drive the create page in a browser for one job per mode (page/site/video) at 390 px and 1200 px, recording a screenshot every 2 s into `scratchpad/survey/ui/<mode>/`, plus console errors and any 4xx/5xx. Note in the report's tail: what the screen showed at 0 s, 5 s, 30 s, done; whether the counters made sense; whether cancel left anything behind.
- [ ] Commit the report when the matrix finishes.

### Task 6: Fix by evidence

- [ ] Sort the report's red and yellow cells by how early a person hits them (job failed → nothing painted → leaked markup → dark band under topbar → slow load → flow gaps).
- [ ] For each defect, write a plan section in this file with the failing test, the fix, and the commit, then execute it. Re-run only the affected rows (`--only`, `--engine`) to prove the row turned green.

### Task 7: The design pass

- [ ] Invoke the `jony-ive-review` skill on the create page (`zimi/static/create.js`, its CSS in `app.css`, `templates/index.html`'s create view) with the UI screenshots from Task 5 as evidence.
- [ ] Apply the cuts and changes in commits small enough to read; each with a browser screenshot before and after in `scratchpad/survey/ui/after/`.

### Task 8: The gate

- [ ] Full suite green. `scripts/release-gate.sh` green.
- [ ] Deploy on Eric's go; `scripts/validate-on-prod.py` ALL PASS once the container is warm.
- [ ] Eric on the phone: sqlite.org whole site, sive.rs one page. Then the tag.
