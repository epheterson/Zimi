#!/usr/bin/env python3
"""Capture every reported site, open it the way a reader does, and check it.

Eric, 2026-09-06: "I want all sites users report to look great like go into a
test suite and we do somehow compare live to captured screenshots."

Each entry in tests/sites/reported.json is captured with the engine named, the
ZIM is served, and the page is opened through Zimi's reader — the article in a
frame, exactly as a person reads it, because a direct hit on /w/ bounced into
the app shell once and nearly produced a false failure. Two things are then
checked:

  * the pictures. Every capture stores the live page and the packaged page as
    metadata (-/shot-live, -/shot-zim), taken under the same treatment, so the
    only thing between them is what packaging lost. zimwriter.shot_verdict says
    whether the packaged one collapsed.
  * the interaction. The reason the site was reported: a button that should
    change the page, a search that should find something. Exercised for real.

Run:  python3 scripts/site_suite.py [--out DIR] [--only substring]
Needs the network, a browser, and the warc2zim sidecar for alive captures.
Writes DIR/report.json and the pictures beside it.
"""

import argparse
import contextlib
import json
import os
import re
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

REGISTRY = ROOT / "tests" / "sites" / "reported.json"
READY_TIMEOUT = 60


def load_registry():
    data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    return data["sites"]


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def capture(site, out_dir, data_dir):
    """Build the ZIM. Returns its path, or raises with the engine's own words."""
    stem = urllib.parse.urlsplit(site["url"]).netloc.replace(".", "-")
    out = out_dir / f"{stem}.zim"
    env = dict(os.environ, ZIM_DIR=str(out_dir), ZIMI_DATA_DIR=str(data_dir))
    cmd = [
        sys.executable,
        "-m",
        "zimi",
        "create",
        site["url"],
        "--engine",
        site.get("engine", "rendered"),
        "--out",
        str(out),
    ]
    done = subprocess.run(
        cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=1200
    )
    if done.returncode != 0 or not out.exists():
        tail = (done.stdout + done.stderr).strip().splitlines()[-6:]
        raise RuntimeError("capture failed:\n  " + "\n  ".join(tail))
    return out


@contextlib.contextmanager
def served(zim_dir, data_dir):
    """A Zimi serving `zim_dir`, torn down afterwards. Yields the base URL."""
    port = _free_port()
    env = dict(
        os.environ,
        ZIM_DIR=str(zim_dir),
        ZIMI_DATA_DIR=str(data_dir),
        ZIMI_AUTO_UPDATE="0",
        ZIMI_TORRENT="0",
        ZIMI_PEER_DISCOVERY="0",
        ZIMI_MANAGE_OPEN="1",
        PYTHONUNBUFFERED="1",
    )
    log = open(zim_dir / "serve.log", "w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "zimi", "serve", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + READY_TIMEOUT
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(base + "/health", timeout=2) as r:
                    if r.status == 200:
                        break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError("server never answered /health")
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


def _json(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read())


def _bytes(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.read()
    except Exception:
        return b""


def zim_name_and_main(base, zim_path):
    stem = zim_path.stem
    for z in _json(base + "/list"):
        if z.get("name") == stem or z.get("file") == zim_path.name:
            return z["name"], z.get("main_path") or ""
    raise RuntimeError(f"{zim_path.name} is not in the library")


def interact(page_or_frame, spec):
    """Run the site's own interaction. Returns (ok, detail)."""
    if not spec:
        return True, "no interaction specified"
    target = page_or_frame
    before = target.inner_text("body")
    if "click" in spec:
        el = target.query_selector(spec["click"])
        if el is None:
            return False, f"nothing matches {spec['click']!r}"
        el.click()
    if "click_text" in spec:
        # By its visible words, the way a person finds a control.
        el = target.get_by_role("button", name=spec["click_text"], exact=True).first
        try:
            el.click(timeout=8000)
        except Exception as e:
            return False, f"could not click {spec['click_text']!r}: {str(e)[:60]}"
    if "type_into" in spec:
        box = target.query_selector(spec["type_into"])
        if box is None:
            return False, f"nothing matches {spec['type_into']!r}"
        box.click()
        box.type(spec.get("text", ""), delay=50)
    # A Frame waits through its page; a Page waits on itself.
    getattr(target, "page", target).wait_for_timeout(2500)
    after = target.inner_text("body")
    if spec.get("expect_text_change") and before == after:
        return False, "the page did not change"
    want = spec.get("expect_visible")
    if want and want.lower() not in after.lower():
        return False, f"{want!r} never appeared"
    return True, "as expected"


def run_also_check(frame, spec):
    """A second interaction on the same page, which may be a known failure.

    A site can be broken in one way and fine in another, and the broken half
    must stay visible rather than being dropped from the list. A check marked
    ``known_broken`` does not fail the run while it fails — but it DOES fail
    the run the day it starts passing, because that is the day we can go and
    tell the person who reported it."""
    if not spec:
        return None
    ok, detail = interact(frame, spec)
    known = spec.get("known_broken")
    return {
        "why": spec.get("why", ""),
        "ok": ok,
        "detail": detail,
        "known_broken": bool(known),
        "reason": known or "",
        # The one that fails the suite: a known failure that healed.
        "now_passing": bool(known) and ok,
    }


def check_site(site, base, zim_path, out_dir):
    """Open the capture the way a reader does and check it. Returns a record."""
    from playwright.sync_api import sync_playwright

    from zimi.zimwriter import shot_verdict

    name, main = zim_name_and_main(base, zim_path)
    info = _json(base + "/zim-info?zim=" + urllib.parse.quote(name))
    live = _bytes(base + info["shot"]) if info.get("shot") else b""
    packaged = _bytes(base + info["shot_zim"]) if info.get("shot_zim") else b""
    stem = zim_path.stem
    if live:
        (out_dir / f"{stem}-live.jpg").write_bytes(live)
    if packaged:
        (out_dir / f"{stem}-zim.jpg").write_bytes(packaged)
    dims, collapsed = shot_verdict(live, packaged)

    reader = f"{base}/?a=" + urllib.parse.quote(f"{name}/{main}", safe="")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(reader, wait_until="load", timeout=90000)
        page.wait_for_timeout(6000)
        frame = next(
            (f for f in page.frames if f != page.main_frame and name in f.url), None
        )
        also = None
        if frame is None:
            ok, detail = False, "the reader never framed the article"
        else:
            ok, detail = interact(frame, site.get("interact"))
            also = run_also_check(frame, site.get("also_check"))
        page.screenshot(
            path=str(out_dir / f"{stem}-reader.jpg"), type="jpeg", quality=60
        )
        browser.close()

    return {
        "url": site["url"],
        "issue": site.get("issue"),
        "engine": site.get("engine", "rendered"),
        "zim": zim_path.name,
        "size": zim_path.stat().st_size,
        "shots": {
            "live": bool(live),
            "packaged": bool(packaged),
            "dims": dims,
            "collapsed": collapsed,
        },
        "interaction": {"ok": ok, "detail": detail},
        "also": also,
        # An alive ZIM is written by warc2zim, not by Zimi's Creator, so it
        # cannot carry Zimi's screenshot metadata yet. Say so rather than fail
        # a site whose whole point is that it needed the alive engine.
        "shots_unavailable": (
            "alive writes through warc2zim; no Zimi metadata"
            if site.get("engine") == "alive" and not (live or packaged)
            else ""
        ),
        "pass": ok
        and not collapsed
        and (bool(live) and bool(packaged) or site.get("engine") == "alive")
        # A known-broken check that started passing is a failure here on
        # purpose: it means the entry is stale and somebody is owed news.
        and not (also or {}).get("now_passing", False),
    }


# A whole-site entry ("mode": "site") is checked by where the crawl went: it
# passes when at least min_pages pages were captured and every one came from
# under expect_under (#93: a gov.uk section without the rest of gov.uk). The
# crawl logs each page as "[n/max] <address>".
_PAGE_LINE = re.compile(r"^\s*\[\d+/[^\]]+\]\s+(\S+)")


def capture_site(site, out_dir, data_dir):
    """A --site capture; returns the addresses of the pages it captured."""
    stem = urllib.parse.urlsplit(site["url"]).netloc.replace(".", "-")
    out = out_dir / f"{stem}-site.zim"
    env = dict(os.environ, ZIM_DIR=str(out_dir), ZIMI_DATA_DIR=str(data_dir))
    cmd = [sys.executable, "-m", "zimi", "create", site["url"], "--site",
           "--engine", site.get("engine", "builtin"), "--max-pages", str(site.get("max_pages", 30)),
           "--delay", "0.5", "--out", str(out)]
    done = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=1800)
    if done.returncode != 0 or not out.exists():
        tail = (done.stdout + done.stderr).strip().splitlines()[-6:]
        raise RuntimeError("capture failed:\n  " + "\n  ".join(tail))
    lines = (done.stdout + done.stderr).replace("\r", "\n").splitlines()
    return [m.group(1) for m in map(_PAGE_LINE.match, lines) if m]


def check_scope(site, urls):
    prefix = site["expect_under"]
    outside = [u for u in urls if not (urllib.parse.urlsplit(u).path.startswith(prefix)
                                       or urllib.parse.urlsplit(u).path == prefix.rstrip("/"))]
    ok = len(urls) >= site.get("min_pages", 2) and not outside
    return {"url": site["url"], "issue": site.get("issue"), "pass": ok,
            "pages": len(urls), "outside": outside[:10],
            "interaction": {"detail": f"{len(urls)} pages, {len(outside)} outside {prefix}"}}


def run(sites, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix="zimi-sites-"))
    data_dir = os.environ.get("ZIMI_DATA_DIR") or str(ROOT / "zims" / ".zimi")
    records = []
    for site in sites:
        print(f"== {site['url']} ({site.get('engine', 'rendered')})", flush=True)
        try:
            if site.get("mode") == "site":
                rec = check_scope(site, capture_site(site, work, data_dir))
            else:
                zim = capture(site, work, data_dir)
                with served(work, data_dir) as base:
                    rec = check_site(site, base, zim, out_dir)
        except Exception as e:
            rec = {
                "url": site["url"],
                "issue": site.get("issue"),
                "pass": False,
                "error": str(e)[:400],
            }
        records.append(rec)
        print(
            "   PASS" if rec.get("pass") else "   FAIL",
            rec.get("error") or rec.get("interaction", {}).get("detail", ""),
            flush=True,
        )
    (out_dir / "report.json").write_text(
        json.dumps(records, indent=2), encoding="utf-8"
    )
    return records


def main():
    ap = argparse.ArgumentParser(
        description="capture, open and check every reported site"
    )
    ap.add_argument("--out", default=str(ROOT / "survey" / "sites"))
    ap.add_argument("--only", default="", help="run sites whose URL contains this")
    ap.add_argument(
        "--engine",
        default="",
        help=(
            "capture every site with this engine instead of the one it was "
            "reported with — for sweeping the matrix before a release. Read "
            "the interactions with that in mind: a site reported because it "
            "needed a running page cannot pass its own check under an engine "
            "that freezes one, and that is the engine being honest."
        ),
    )
    args = ap.parse_args()
    sites = [s for s in load_registry() if args.only in s["url"]]
    if args.engine:
        sites = [dict(s, engine=args.engine) for s in sites]
    records = run(sites, pathlib.Path(args.out))
    failed = [r for r in records if not r.get("pass")]
    print(
        f"\n{len(records) - len(failed)} of {len(records)} passed; report in {args.out}/report.json"
    )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
