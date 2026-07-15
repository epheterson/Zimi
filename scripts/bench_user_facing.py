"""User-facing timing: server start → library visible → can read a ZIM.

Spawns the actual zimi server as a subprocess, polls /health, then
times /list (library page data) and /w/<zim>/<path> (open a ZIM)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ZIM_SOURCES = [
    "/Users/elp/Zimi/gutenberg_en_lcc-k_2025-12.zim",
    "/Users/elp/Zimi/zimgit-medicine_en_2024-08.zim",
    "/Users/elp/Zimi/zimgit-water_en_2024-08.zim",
]


def _wait_for(url, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return time.time()
        except Exception:
            pass
        time.sleep(0.05)
    return None


def _http_get(url):
    t0 = time.time()
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            body = r.read()
        return time.time() - t0, body
    except Exception as e:
        return time.time() - t0, f"ERR: {e}".encode()


def run(label, zim_dir, data_dir, port):
    env = dict(os.environ)
    env["ZIM_DIR"] = zim_dir
    env["ZIMI_DATA_DIR"] = data_dir
    env["ZIMI_TORRENT"] = "0"
    env["ZIMI_PEER_DISCOVERY"] = "0"
    env["ZIMI_AUTO_UPDATE"] = "0"

    t0 = time.time()
    proc = subprocess.Popen(
        [sys.executable, "-m", "zimi", "serve", "--port", str(port)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    try:
        t_health = _wait_for(f"http://127.0.0.1:{port}/health")
        if t_health is None:
            print(f"{label}: TIMEOUT waiting for /health")
            return
        t_to_health = t_health - t0

        # /list — what the library page fetches
        dt_list, body_list = _http_get(f"http://127.0.0.1:{port}/list")

        # / — the SPA HTML shell
        dt_html, body_html = _http_get(f"http://127.0.0.1:{port}/")

        # /w/<zim>/ — open a ZIM (root entry; serves first article)
        import json

        zim_name = None
        try:
            data = json.loads(body_list)
            if isinstance(data, list) and data and isinstance(data[0], dict):
                zim_name = data[0].get("name")
        except Exception:
            pass
        if zim_name:
            dt_open, _ = _http_get(f"http://127.0.0.1:{port}/w/{zim_name}/")
            open_repr = f"{dt_open * 1000:.0f} ms"
        else:
            open_repr = "(no zim from /list)"

        list_size = len(body_list) if isinstance(body_list, bytes) else "ERR"
        html_size = len(body_html) if isinstance(body_html, bytes) else "ERR"
        print(
            f"{label}:\n"
            f"  start → /health 200    : {t_to_health * 1000:.0f} ms\n"
            f"  /list (library data)   : {dt_list * 1000:.0f} ms ({list_size} bytes)\n"
            f"  / (SPA HTML)           : {dt_html * 1000:.0f} ms ({html_size} bytes)\n"
            f"  /w/<zim>/ (open ZIM)   : {open_repr}"
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    if any(not os.path.exists(s) for s in ZIM_SOURCES):
        print("Missing source ZIMs")
        return

    zim_dir = tempfile.mkdtemp(prefix="zimi-bench-zims-")
    for src in ZIM_SOURCES:
        shutil.copy(src, os.path.join(zim_dir, os.path.basename(src)))

    print(
        f"# user-facing bench — {len(ZIM_SOURCES)} ZIMs, "
        f"{sum(os.path.getsize(s) for s in ZIM_SOURCES) / 1e9:.2f} GB total"
    )
    print()

    print("[COLD START — fresh data dir, no indexes]")
    cold_data = tempfile.mkdtemp(prefix="zimi-bench-cold-")
    run("  cold", zim_dir, cold_data, 38901)

    print()
    print("[CACHED LAUNCH — same data dir, indexes built]")
    run("  cached", zim_dir, cold_data, 38902)

    shutil.rmtree(zim_dir, ignore_errors=True)
    shutil.rmtree(cold_data, ignore_errors=True)


if __name__ == "__main__":
    main()
