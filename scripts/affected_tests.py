"""Run only the tests that touch what changed: the check before a NAS deploy.

    python3 scripts/affected_tests.py            # changed since the last deploy (deploy.sh's stamp)
    python3 scripts/affected_tests.py main       # changed since a git ref
    python3 scripts/affected_tests.py --list     # say which, run nothing

A test is affected when its source names a changed file (its stem, e.g.
"almanac-earth" or "mapplaces"). Python tests run in parallel, quick tier and
browser tier together; node checks run through run_node_tests.py's own list.
CI still runs everything.
"""

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STAMP = os.path.join(ROOT, ".git", "zimi-last-deploy")
SOURCES = ("zimi/", "scripts/", "docker/")
# What deploy.sh ships besides those folders, and the tests themselves.
SHIPPED_FILES = ("requirements.txt", "Dockerfile", "docker-compose.nas.yml")
TESTS = "tests/"
# Names too common to say which tests a change touches (app.js is named by a hundred of them: matching it would
# make every deploy a full run). They are said out loud below, so a change to one is never silently untested.
VAGUE = {"__init__", "index", "app", "server", "shell", "text", "README", "zimi"}


def changed(since):
    if since:
        out = subprocess.run(
            ["git", "diff", "--name-only", since, "--"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return [p for p in out.split() if p.startswith(SOURCES + (TESTS,) + SHIPPED_FILES)]
    if not os.path.exists(STAMP):
        sys.exit("No deploy stamp yet: name a git ref, e.g. main")
    stamp = os.path.getmtime(STAMP)
    found = []
    for top in SOURCES + (TESTS,):
        for d, dirs, files in os.walk(os.path.join(ROOT, top)):
            dirs[:] = [x for x in dirs if x != "__pycache__"]
            for f in files:
                p = os.path.join(d, f)
                if os.path.getmtime(p) > stamp and not f.endswith(".pyc"):
                    found.append(os.path.relpath(p, ROOT))
    found += [f for f in SHIPPED_FILES if os.path.getmtime(os.path.join(ROOT, f)) > stamp]
    return found


def stems(paths):
    """What a test would name to touch each file: a module's name, any other file's own name."""
    out = set()
    for p in paths:
        base = os.path.basename(p)
        stem, ext = os.path.splitext(base)
        if re.match(r"zimi_\w+_\d{4}-\d{2}", stem) or stem in VAGUE:
            print("  not mapped to tests (too common a name): " + p)
            continue
        out.add(stem if ext == ".py" else base)
    return out


def affected(names):
    tests = os.path.join(ROOT, "tests")
    py, node = [], []
    pat = re.compile("|".join(re.escape(n) for n in sorted(names))) if names else None
    for f in sorted(os.listdir(tests)):
        if not f.startswith("test_") or not f.endswith((".py", ".cjs")):
            continue
        with open(os.path.join(tests, f), encoding="utf-8", errors="replace") as fh:
            if pat and pat.search(fh.read()):
                (py if f.endswith(".py") else node).append("tests/" + f)
    return py, node


def main(argv):
    listing = "--list" in argv
    args = [a for a in argv if a != "--list"]
    paths = changed(args[0] if args else None)
    py, node = affected(stems(paths))
    # A changed test file is run itself, whatever it names.
    for p in paths:
        if p.startswith(TESTS + "test_") and p.endswith((".py", ".cjs")):
            (py if p.endswith(".py") else node).append(p)
    py, node = sorted(set(py)), sorted(set(node))
    print(
        f"{len(paths)} changed files -> {len(py)} pytest files, {len(node)} node checks"
    )
    for t in py + node:
        print("  " + t)
    if listing or not (py or node):
        return 0
    rc = 0
    for t in node:
        rc |= subprocess.run(
            ["node", t], cwd=ROOT, stdout=subprocess.DEVNULL
        ).returncode and (print("FAIL " + t) or 1)
    if py:
        rc |= subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-q",
                "-n",
                "4",
                "--dist",
                "loadgroup",
                *py,
            ],
            cwd=ROOT,
        ).returncode
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
