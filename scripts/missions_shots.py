#!/usr/bin/env python3
"""Fly a mission in a real browser and photograph it: portrait and landscape phone, at the times asked for.

    python scripts/missions_shots.py apollo11 OUTDIR [--times -10,60,170,...] [--gpu metal|swiftshader] [--landscape]

Starts a throw-away Zimi on a free port (no ZIMs, offline, no torrents), opens the Almanac's 3D view and the mission, jumps to
each mission time (seconds from the mission's zero), waits for the frame and saves a screenshot. Prints the page's own readings.
"""

import argparse
import json
import os
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("ZIMI_TORRENT", "0")
os.environ.setdefault("ZIMI_OFFLINE", "1")


def serve():
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tempfile.mkdtemp(prefix="missions-")
    os.makedirs(os.path.join(tmp, "zims"))
    os.makedirs(os.path.join(tmp, "data"))
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = os.path.join(tmp, "zims"), os.path.join(
        tmp, "data"
    )
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, "http://127.0.0.1:%d" % httpd.server_address[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mission")
    ap.add_argument("out")
    ap.add_argument("--times", default="")
    ap.add_argument("--gpu", default="metal")
    ap.add_argument("--landscape", action="store_true")
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--wait", type=float, default=2.0)
    ap.add_argument("--light", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    from playwright.sync_api import sync_playwright

    httpd, base = serve()
    gl = (
        ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
        if args.gpu == "metal"
        else [
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ]
    )
    w, h = (844, 390) if args.landscape else (390, 844)
    if args.width:
        w = args.width
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=gl, headless=True)
        ctx = br.new_context(
            viewport={"width": w, "height": h},
            device_scale_factor=2,
            has_touch=True,
            is_mobile=True,
            service_workers="block",
            color_scheme="light" if args.light else "dark",
        )
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on(
            "console",
            lambda m: errors.append("console:" + m.text) if m.type == "error" else None,
        )
        pg.goto(base + "/#almanac", wait_until="load")
        pg.wait_for_function(
            "() => typeof openAlmanacEarth === 'function' && typeof _aeLoadThree === 'function'",
            timeout=240000,
        )
        pg.evaluate("() => openAlmanacEarth({ target: 'earth' })")
        pg.wait_for_function(
            "() => typeof _aeReady === 'function' && _aeReady() && _aeIsOpen",
            timeout=300000,
            polling=200,
        )
        pg.evaluate("(id) => _aeMissionStart(id)", args.mission)
        pg.wait_for_function("() => !!(_ae.mission)", timeout=120000, polling=200)
        times = [float(v) for v in args.times.split(",") if v] or [None]
        for t in times:
            if t is not None:
                pg.evaluate(
                    "(t) => { const m = _amMission(); _ae.mission.paused = true; _amJump(m, t); _almClockSetRate(0); }",
                    t,
                )
            time.sleep(args.wait)
            # let the models load and a few frames draw
            pg.wait_for_function("() => !_ae.fly", timeout=60000, polling=250)
            info = pg.evaluate(
                "() => { const s = _ae.mission, st = s.follow; return { t: s.t, phase: s.phaseIdx, pos: st ? st.pos : null, parts: Object.keys(s.parts).length }; }"
            )
            name = "%s-%s-%s.png" % (
                args.mission,
                "land" if args.landscape else "port",
                ("t%+d" % t) if t is not None else "open",
            )
            pg.screenshot(path=os.path.join(args.out, name))
            print(name, json.dumps(info), flush=True)
        # a frame time, on this GPU, with the shot the phase gives
        ft = pg.evaluate(
            """async () => { const n = 90; const t0 = performance.now(); for (let i = 0; i < n; i++) { _ae.dirty = true; _aeDraw(performance.now(), true); }
            return (performance.now() - t0) / n; }"""
        )
        print("draw ms per frame (CPU side):", round(ft, 2))
        if errors:
            print("ERRORS:", errors[:8])
        br.close()
    httpd.shutdown()


if __name__ == "__main__":
    main()
