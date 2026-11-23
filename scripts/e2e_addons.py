#!/usr/bin/env python3
"""End to end, on this machine: fetch every add-on from its pinned archive into a scratch data folder, then make a ZIM with
each Create mode that needs one (rendered, SingleFile, video, WARC import, alive) from a page this script serves itself.

Downloads the real archives (about 450 MB) and removes everything it made. Not part of the test suite.

    python3 scripts/e2e_addons.py [--keep]
"""

import argparse
import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

PAGE = (
    "<!doctype html><html><head><meta charset=utf-8><title>Local Test Page</title></head><body><h1>Static head</h1>"
    "<div id=app></div><p><a href=two.html>two</a></p><script>document.getElementById('app').innerHTML="
    "'<h2>Built by JavaScript</h2><p>This paragraph only exists after scripts run, with enough words to count as a "
    "real page for the capture engine.</p>';</script></body></html>"
)
TWO = "<!doctype html><html><head><meta charset=utf-8><title>Two</title></head><body><h1>Second page</h1><p>More words on the second page so that it has text worth keeping.</p></body></html>"


def say(*a):
    print(*a, flush=True)


def has_text(zim, needle):
    from libzim.reader import Archive

    from zimi.libzimcompat import entry_by_id

    a = Archive(zim)
    for i in range(a.all_entry_count):
        e = entry_by_id(a, i)
        if not e.is_redirect and needle.encode() in bytes(e.get_item().content):
            return True
    return False


def run(env, *args, timeout=420):
    p = subprocess.run([sys.executable, "-m", "zimi", *args], env=env, cwd=REPO, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr)[-600:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="leave the scratch folder")
    keep = ap.parse_args().keep
    tmp = tempfile.mkdtemp(prefix="zimi-e2e-")
    data, zims, site = (os.path.join(tmp, n) for n in ("data", "zims", "site"))
    for d in (data, zims, site):
        os.makedirs(d)
    os.environ.pop("ZIMI_OFFLINE", None)
    os.environ.update(ZIMI_DATA_DIR=data, ZIM_DIR=zims, ZIMI_TORRENT="0")
    from zimi import addons, server

    server.ZIMI_DATA_DIR, server.ZIM_DIR = data, zims
    addons.POLICY.set("ask")
    say("target", addons.target(), "supported", addons.supported())
    results = {}
    ok = True
    for key in ("browser", "video", "singlefile", "warc2zim", "reddit"):
        t0 = time.time()
        try:
            addons._install(key)
            results[key] = "installed in %ds" % (time.time() - t0)
        except Exception as e:
            results[key] = "FAILED %s: %s" % (type(e).__name__, e)
            ok = False
        say(key, results[key])
    # What the captures are made from.
    with open(os.path.join(site, "index.html"), "w") as f:
        f.write(PAGE)
    with open(os.path.join(site, "two.html"), "w") as f:
        f.write(TWO)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        subprocess.run([ffmpeg, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10", "-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-pix_fmt", "yuv420p", os.path.join(site, "clip.mp4")], check=False)
    from zimi.warc import WarcWriter

    warc = os.path.join(zims, "site.warc.gz")
    with WarcWriter(warc) as w:
        w.write_exchange("http://example.test/", status=200, response_headers={"Content-Type": "text/html"},
                         body=b"<!doctype html><html><head><meta charset=utf-8><title>Imported WARC</title></head><body><h1>Imported WARC page</h1><p>Hello from a WARC file with enough words to be a page.</p></body></html>")
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=site, **k)  # noqa: E731
    handler.log_message = lambda *a: None
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    env = dict(os.environ)
    common = ["--zim-dir", zims, "--data-dir", data]
    jobs = [
        ("rendered", ["create", "--engine", "rendered", "--title", "R", "--out", os.path.join(zims, "r.zim"), *common, base + "/index.html"], "r.zim", "Built by JavaScript"),
        ("singlefile", ["create", "--engine", "singlefile", "--title", "S", "--out", os.path.join(zims, "s.zim"), *common, base + "/index.html"], "s.zim", "Built by JavaScript"),
        ("video", ["create", "--limit", "1", "--title", "V", "--out", os.path.join(zims, "v.zim"), *common, base + "/clip.mp4"], "v.zim", ""),
        ("import", ["import", "--name", "w", "--title", "W", "--out", os.path.join(zims, "w.zim"), *common, warc], "w.zim", "Imported WARC page"),
        ("alive", ["create", "--engine", "alive", "--title", "A", "--out", os.path.join(zims, "a.zim"), *common, base + "/index.html"], "a.zim", "Built by JavaScript"),
    ]
    diag = subprocess.run([sys.executable, "-c", "import sys, os; from zimi import addons, server; print('data', server.ZIMI_DATA_DIR, 'installed', addons.installed('browser'), 'on path', any('addons' in p for p in sys.path), 'env', os.environ.get('ZIMI_DATA_DIR'))"], env=env, cwd=REPO, capture_output=True, text=True)
    say("child:", (diag.stdout + diag.stderr).strip()[-300:])
    for name, args, out, needle in jobs:
        path = os.path.join(zims, out)
        try:
            rc, tail = run(env, *args)
            good = rc == 0 and os.path.exists(path) and (not needle or has_text(path, needle))
        except Exception as e:  # a timeout, a crash
            good, tail = False, "%s: %s" % (type(e).__name__, e)
        results[name] = "ok" if good else "FAILED: " + tail.replace("\n", " | ")[-300:]
        ok = ok and good
        say(name, results[name])
    httpd.shutdown()
    if keep:
        say("kept", tmp)
    else:
        shutil.rmtree(tmp, ignore_errors=True)
    say("ALL OK" if ok else "SOME FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
