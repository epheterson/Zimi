#!/usr/bin/env python3
"""Run the standalone node tests (tests/*.cjs) once, in parallel.

Each file is its own process and its own pass/fail (exit 0 = pass). A failing
file's whole output is printed after the run, so the reason is in the log
without a second run. Usage:

    python3 scripts/run_node_tests.py              # every tests/*.cjs
    python3 scripts/run_node_tests.py games shell  # only files whose name has one of these words
    python3 scripts/run_node_tests.py -j 2         # fewer workers (default: every core)

CI runs this as its one node step; pytest does not run these files.
"""

import argparse
import concurrent.futures
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE_TIMEOUT = 180  # seconds; the slowest file takes a few


def run_one(node, script):
    t0 = time.monotonic()
    try:
        # encoding, not the platform default: the tests print names and marks
        # that cp1252 cannot decode.
        done = subprocess.run(
            [node, str(script)], capture_output=True, text=True, encoding="utf-8",
            errors="replace", cwd=ROOT, timeout=FILE_TIMEOUT,
        )
        code, out = done.returncode, done.stdout + done.stderr
    except subprocess.TimeoutExpired as e:
        # TimeoutExpired keeps what was captured as bytes even under text=True.
        def said(b):
            return b.decode("utf-8", "replace") if isinstance(b, bytes) else (b or "")

        code, out = 124, f"timed out after {FILE_TIMEOUT}s\n{said(e.stdout)}{said(e.stderr)}"
    return script.name, code, out, time.monotonic() - t0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("words", nargs="*", help="run only files whose name contains one of these")
    ap.add_argument("-j", "--jobs", type=int, default=os.cpu_count() or 2)
    args = ap.parse_args(argv)

    node = shutil.which("node")
    if not node:
        print("node is not installed", file=sys.stderr)
        return 2
    scripts = sorted((ROOT / "tests").glob("*.cjs"))
    if args.words:
        scripts = [s for s in scripts if any(w in s.name for w in args.words)]
    if not scripts:
        print("no .cjs tests matched", file=sys.stderr)
        return 2

    t0 = time.monotonic()
    failed = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for name, code, out, secs in pool.map(lambda s: run_one(node, s), scripts):
            if code != 0:
                failed.append(name)
                print(f"--- FAIL {name} (exit {code}, {secs:.1f}s)\n{out.rstrip()}\n", flush=True)
    wall = time.monotonic() - t0
    if failed:
        print(f"{len(failed)} of {len(scripts)} node test files failed in {wall:.1f}s: {', '.join(failed)}")
        return 1
    print(f"all {len(scripts)} node test files passed in {wall:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
