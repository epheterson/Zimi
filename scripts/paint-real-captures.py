#!/usr/bin/env python3
"""Capture real pages, then look at them the way a person does.

`tests/test_reader_paints.py` proves the reader paints a ZIM we built
ourselves out of known-good PNGs. That catches a serving or rewriting
regression, but it cannot catch a *capture* regression, because the fixture
never went through an engine. Every embarrassment this release came from
exactly that gap: a capture whose structure checked out and whose page looked
wrong.

So this runs the real engines against real URLs, serves the results through the
real handler, and asks a real browser two questions per capture:

    did every image decode after a full scroll?
    is any of the raw markup showing up as visible text?

The second question exists because of the cnn.com attribute-soup bug (#87),
which no count, no href check and no viewport screenshot noticed — it was
visible only as prose that read `data-fave-thumbnails="{"big":...`.

Run it where a browser and the network both work; on a Mac with a Gatekeeper-
rejected Chromium that means inside the container:

    docker exec zim-reader python3 /app/scripts/paint-real-captures.py
"""

import http.server
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time

# Chosen to span what people actually capture, not just what is easy:
#   - a modern news homepage, which is the hardest thing we do (lazy images,
#     srcset variants, serialized HTML parked in data-* attributes, a CDN that
#     drops response bodies once the page settles);
#   - an image-dense encyclopedia article, the single most likely real use;
#   - a plain documentation page, the case that must never be anything but
#     perfect because there is nothing clever about it.
PAGES = [
    ("cnn_home", "https://www.cnn.com/"),
    ("wikipedia_article", "https://en.wikipedia.org/wiki/Water_purification"),
    ("docs_page", "https://www.sqlite.org/lang_select.html"),
]
SITE = ("sqlite_site", "https://www.sqlite.org/", 15)

# Markers of our own rewriting leaking into the rendered text. Anything here
# appearing in document.body.innerText means a value escaped its attribute.
SOUP = [
    "data-fave-thumbnails",
    "data-source-html",
    'href="&quot;',
    "&quot;https://",
]
SCROLL_STEP = 400
SCROLL_PAUSE_MS = 40
PAINT_BUDGET_SECONDS = 40


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _capture(url, out, site_pages=None):
    """Run the real CLI, exactly as a person would."""
    cmd = [sys.executable, "-m", "zimi", "create", url, "--out", out]
    if site_pages:
        cmd += ["--site", "--max-pages", str(site_pages)]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    return {
        "ok": p.returncode == 0 and os.path.exists(out),
        "seconds": round(time.time() - t0, 1),
        "bytes": os.path.getsize(out) if os.path.exists(out) else 0,
        "tail": (p.stderr or p.stdout or "").strip().splitlines()[-3:],
    }


def _serve(zim_dir, port):
    import zimi.server as srv
    from zimi.http import ZimHandler

    srv.ZIM_DIR = str(zim_dir)
    srv.ZIMI_DATA_DIR = str(zim_dir)
    srv._cache_generation += 1
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def _look(page, url):
    """Open it, scroll all of it, then ask what actually rendered."""
    page.goto(url, wait_until="domcontentloaded", timeout=90000)
    page.evaluate(
        """async ([step, pause]) => {
          const H = () => document.body.scrollHeight;
          for (let y = 0; y < H(); y += step) {
            window.scrollTo(0, y);
            await new Promise(r => setTimeout(r, pause));
          }
          window.scrollTo(0, 0);
        }""",
        [SCROLL_STEP, SCROLL_PAUSE_MS],
    )
    deadline = time.time() + PAINT_BUDGET_SECONDS
    while time.time() < deadline:
        pending = page.evaluate(
            "() => Array.from(document.images)"
            ".filter(i => !(i.complete && i.naturalWidth > 0)).length"
        )
        if not pending:
            break
        time.sleep(0.5)
    return page.evaluate(
        """(soup) => {
          const imgs = Array.from(document.images);
          const bad = imgs.filter(i => !(i.complete && i.naturalWidth > 0));
          const text = (document.body.innerText || '');
          return {
            images: imgs.length,
            painted: imgs.length - bad.length,
            unpainted: bad.slice(0, 6).map(i => i.getAttribute('src')),
            soup: soup.filter(m => text.includes(m)),
            text_len: text.length,
            title: document.title,
          };
        }""",
        SOUP,
    )


def main():
    work = tempfile.mkdtemp(prefix="paint-real-")
    results = {}

    jobs = [(n, u, None) for n, u in PAGES] + [(SITE[0], SITE[1], SITE[2])]
    for name, url, pages in jobs:
        out = os.path.join(work, f"{name}.zim")
        print(f"[capture] {name} <- {url}", flush=True)
        results[name] = {"url": url, "capture": _capture(url, out, pages)}
        print(f"          {results[name]['capture']}", flush=True)

    port = _free_port()
    _serve(work, port)
    time.sleep(2)

    from libzim.reader import Archive
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        for name in results:
            if not results[name]["capture"]["ok"]:
                continue
            zim = os.path.join(work, f"{name}.zim")
            a = Archive(pathlib.Path(zim))
            main_path = a.main_entry.get_item().path
            results[name]["entries"] = a.all_entry_count
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            url = f"http://127.0.0.1:{port}/w/{name}/{main_path}?raw=1"
            print(f"[look] {name} {main_path}", flush=True)
            try:
                results[name]["render"] = _look(page, url)
            except Exception as e:  # a page that will not open is a result
                results[name]["render"] = {"error": f"{type(e).__name__}: {e}"}
            page.close()
            print(f"       {results[name]['render']}", flush=True)
        browser.close()

    print("\n=== VERDICT ===")
    bad = 0
    for name, r in results.items():
        c, d = r["capture"], r.get("render", {})
        if not c["ok"]:
            print(f"FAIL {name}: capture failed — {c['tail']}")
            bad += 1
            continue
        imgs, painted = d.get("images", 0), d.get("painted", 0)
        soup = d.get("soup", [])
        problems = []
        if d.get("error"):
            problems.append(d["error"])
        if imgs and painted < imgs:
            problems.append(f"{imgs - painted}/{imgs} images never painted")
        if soup:
            problems.append(f"markup visible as text: {soup}")
        if d.get("text_len", 0) < 200:
            problems.append(f"page rendered almost no text ({d.get('text_len')})")
        status = "FAIL" if problems else "PASS"
        bad += bool(problems)
        print(
            f"{status} {name}: {r.get('entries')} entries, "
            f"{c['bytes']:,} bytes, {c['seconds']}s, {painted}/{imgs} images"
            + (f" — {'; '.join(problems)}" if problems else "")
        )

    print(json.dumps(results, indent=2, default=str)[:400])
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
