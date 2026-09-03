#!/usr/bin/env python3
"""Run the creation survey: every site in scripts/survey_sites.py through every
engine, via the real manage API of a local `zimi serve`, then open each result
in a phone-width Chromium and measure what painted. Resumable: a job already
in results.json is skipped, so a crash or Ctrl-C loses nothing.

  ZIMI_SURVEY_TOKEN_FILE=scratchpad/survey-token \\
    python3 scripts/creation-survey.py [--only KEY] [--engine E] [--mode M] [--compare]

Environment:
  ZIMI_SURVEY_BASE      the server (default http://127.0.0.1:8901)
  ZIMI_SURVEY_TOKEN_FILE file holding the Bearer credential (required)
  ZIMI_SURVEY_OUT       results.json + screenshots (default scratchpad/survey)
  ZIMI_SURVEY_ZIM_DIR   where the server writes captures (default scratchpad/zims/created)
  ZIMI_SURVEY_RELEASED  where released ZIMs are downloaded (default scratchpad/zims/released)

Writes docs/plans/2026-09-03-creation-survey.md after every job; the report is
regenerated, never edited by hand.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.survey_measure import flow_facts, page_facts, zim_facts  # noqa: E402
from scripts.survey_sites import SITES, matrix  # noqa: E402

BASE = os.environ.get("ZIMI_SURVEY_BASE", "http://127.0.0.1:8901")
OUT = os.environ.get("ZIMI_SURVEY_OUT", "scratchpad/survey")
ZIM_DIR = os.environ.get("ZIMI_SURVEY_ZIM_DIR", "scratchpad/zims/created")
RELEASED_DIR = os.environ.get("ZIMI_SURVEY_RELEASED", "scratchpad/zims/released")
REPORT = "docs/plans/2026-09-03-creation-survey.md"
JOB_CAP_S = 1800
RELEASED_CAP_BYTES = 2_000_000_000
PHONE = {"width": 390, "height": 844}

_token = open(os.environ["ZIMI_SURVEY_TOKEN_FILE"]).read().strip()
HDR = {"Authorization": "Bearer " + _token}


def api(path, data=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={**HDR, "Content-Type": "application/json"},
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def library():
    items = api("/list")
    return items if isinstance(items, list) else items.get("zims", [])


def newest_created():
    created = sorted(
        (z for z in library() if z.get("folder") == "created"),
        key=lambda z: z.get("first_seen") or 0,
    )
    return created[-1]["name"] if created else None


def run_job(job):
    payload = {
        "mode": job.mode,
        "source": job.site.url,
        "title": f"survey {job.site.key} {job.engine}",
        **job.extra,
    }
    if job.mode in ("page", "site"):
        payload["engine"] = job.engine
    started = time.time()
    before = newest_created()
    api("/manage/create", payload)
    events, seen, cursor = [], set(), 0
    st = {}
    while True:
        st = api(f"/manage/create/status?since={cursor}")
        for line in st.get("lines", []):
            if line not in seen:
                seen.add(line)
                events.append({"ts": time.time(), "line": line})
        cursor = st.get("cursor", cursor)
        if st.get("done") or st.get("phase") == "done":
            break
        if time.time() - started > JOB_CAP_S:
            try:
                api("/manage/create/cancel", {})
            except Exception:
                pass
            st = {"ok": False, "error": f"survey: {JOB_CAP_S // 60} min cap"}
            break
        time.sleep(1.5)
    took = round(time.time() - started, 1)
    rec = {
        "job": {
            "site": job.site._asdict(),
            "mode": job.mode,
            "engine": job.engine,
            "extra": job.extra,
        },
        "ok": bool(st.get("ok")),
        "error": st.get("error", "") or "",
        "took_s": took,
        "flow": flow_facts(events, started),
        "lines": [e["line"] for e in events],
    }
    if rec["ok"]:
        name = newest_created()
        if not name or name == before:
            rec["ok"] = False
            rec["error"] = "job said ok but nothing new is in the library"
        else:
            rec["name"] = name
            rec["zim"] = zim_facts(os.path.join(ZIM_DIR, name + ".zim"))
    return rec


def released_name(catalog_name):
    for z in library():
        if (z.get("file") or "").endswith(catalog_name + ".zim"):
            return z["name"]
    return None


# How each released ZIM is found in the Kiwix catalog: its search is by title
# words, and a site's hostname is not always among them.
CATALOG_QUERY = {
    "lowtech": "solar-powered",
    "peps": "PEPs",
    "planetmath": "Planet Math",
    "cheatography": "Cheatography",
    "fosscooking": "FOSS cooking",
    "sh1": "sh1",
}


def catalog_item(site):
    """The catalog record for ``site.released``, or None."""
    q = urllib.parse.quote(CATALOG_QUERY.get(site.key, site.released))
    try:
        got = api(f"/manage/catalog?count=50&q={q}")
    except Exception as e:
        print("catalog lookup failed", site.key, e, flush=True)
        return None
    for item in got.get("items") or []:
        if item.get("name") == site.released:
            return item
    return None


def compare(ctx, results):
    for s in [s for s in SITES if s.released]:
        key = "released/" + s.key
        if key in results:
            continue
        item = catalog_item(s)
        if not item:
            results[key] = {"ok": False, "error": "not in catalog"}
            save(results)
            continue
        size = item.get("size_bytes") or 0
        if size > RELEASED_CAP_BYTES:
            results[key] = {"ok": False, "error": f"skipped: {size / 1e9:.1f} GB"}
            save(results)
            continue
        # The catalog hands out a metalink; the file is the same address
        # without the .meta4 suffix.
        url = (item.get("download_url") or "").removesuffix(".meta4")
        dest = os.path.join(RELEASED_DIR, s.released + ".zim")
        if not os.path.exists(dest):
            os.makedirs(RELEASED_DIR, exist_ok=True)
            print("downloading", url, f"({size / 1e6:.0f} MB)", flush=True)
            urllib.request.urlretrieve(url, dest + ".part")
            os.replace(dest + ".part", dest)
        # Tell the library a file arrived; then wait for it to be listed.
        try:
            api("/manage/refresh", {})
        except Exception as e:
            print("refresh failed", e, flush=True)
        name = None
        for _ in range(40):
            name = released_name(s.released)
            if name:
                break
            time.sleep(3)
        if not name:
            results[key] = {
                "ok": False,
                "error": "downloaded but the library never listed it",
            }
            save(results)
            continue
        page = ctx.new_page()
        try:
            rec = {
                "ok": True,
                "took_s": 0,
                "name": name,
                "zim": zim_facts(dest),
                "page": page_facts(
                    page, BASE, name, os.path.join(OUT, s.key, "released")
                ),
            }
        finally:
            page.close()
        results[key] = rec
        save(results)


def save(results):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    write_report(results)


def write_report(results):
    rows = [
        "# Creation survey — " + time.strftime("%Y-%m-%d %H:%M"),
        "",
        "Regenerated by `scripts/creation-survey.py`; do not edit. `back` counts progress lines whose counter went down; `under topbar` is the element a phone shows first under Zimi's own bar and its background.",
        "",
        "| job | ok | took | first line | longest gap | back | MB | entries | imgs painted | text | leaked | under topbar | load | note |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for key, r in results.items():
        f, z, pg = r.get("flow", {}), r.get("zim", {}), r.get("page", {})
        under = pg.get("under_topbar") or {}
        rows.append(
            "| %s | %s | %ss | %s | %s | %s | %.1f | %s | %s/%s | %s | %s | %s | %ss | %s |"
            % (
                key,
                "✅" if r.get("ok") else "❌",
                r.get("took_s", ""),
                f.get("first_line_s", ""),
                f.get("longest_gap_s", ""),
                len(f.get("backwards", [])),
                (z.get("bytes") or 0) / 1e6,
                z.get("entries", ""),
                pg.get("painted", ""),
                pg.get("images", ""),
                pg.get("text_chars", ""),
                ",".join(pg.get("leaked", [])),
                f"{under.get('tag', '')}.{under.get('cls', '')[:20]} {under.get('bg', '')}",
                pg.get("load_s", ""),
                (r.get("error") or "")[:80].replace("|", "/"),
            )
        )
    with open(REPORT, "w") as f:
        f.write("\n".join(rows) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--engine")
    ap.add_argument("--mode")
    ap.add_argument("--compare", action="store_true")
    a = ap.parse_args()
    results_path = os.path.join(OUT, "results.json")
    results = json.load(open(results_path)) if os.path.exists(results_path) else {}
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport=PHONE, extra_http_headers=HDR)
        if a.compare:
            compare(ctx, results)
        else:
            for job in matrix():
                key = f"{job.site.key}/{job.mode}/{job.engine}"
                if a.only and job.site.key != a.only:
                    continue
                if a.engine and job.engine != a.engine:
                    continue
                if a.mode and job.mode != a.mode:
                    continue
                if key in results:
                    continue
                print("==", key, flush=True)
                rec = {}
                try:
                    rec = run_job(job)
                    if rec["ok"]:
                        page = ctx.new_page()
                        try:
                            rec["page"] = page_facts(
                                page,
                                BASE,
                                rec["name"],
                                os.path.join(
                                    OUT, job.site.key, job.mode + "-" + job.engine
                                ),
                            )
                        finally:
                            page.close()
                except Exception as e:  # the survey itself must never stop on one job
                    # Keep whatever the job already told us; the crash is one more fact.
                    rec = {**rec, "ok": False, "error": f"survey crashed: {e!r}"[:200]}
                results[key] = rec
                save(results)
                print(
                    "   ",
                    "ok" if rec.get("ok") else "FAIL",
                    rec.get("error", ""),
                    flush=True,
                )
        browser.close()


if __name__ == "__main__":
    main()
