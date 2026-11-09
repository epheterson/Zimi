#!/usr/bin/env python3
"""The release day's checklist, run as one command (scripts/release-gate.sh calls it first).

    python3 scripts/release_checks.py              # every check, one line each, exit 1 if any failed
    python3 scripts/release_checks.py --no-network # skip the checks that need the internet
    python3 scripts/release_checks.py --fix        # first rebuild what a command can (own ZIMs, whatsnew.json)

Each check is the same rule the suite or CI already holds, run on its own so the last day shows every
red thing at once instead of one per CI round trip:

  own ZIMs          python -m zimi.ownzims --check         (the committed ZIMs are built from the source)
  whatsnew          scripts/whatsnew.py --check            (zimi/assets/whatsnew.json matches the CHANGELOG)
  changelog         tests/test_release_notes.py            (Highlights rules, the notes build)
  satellites        tests/test_almanac_satellites.py       (the shipped snapshot is whole and recent)
  horizons fixture  the reference values' fetch date       (older than HORIZONS_WARN_DAYS: a warning)
  Q-IDs             scripts/verify_almanac_qids.py         (network; every curated link against Wikipedia)
"""

import datetime
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
OK, WARN, FAIL, SKIP = "ok", "WARN", "FAIL", "skip"

#: The Almanac's ephemeris tests hold JPL Horizons values fetched on one day (named in the file's header). Nothing
#: about them goes wrong with age, but an instant "today" in them drifts away from the present: a release more
#: than this many days after the fetch is told, never blocked.
HORIZONS_WARN_DAYS = 120
HORIZONS_FILES = (
    "tests/test_moon_sun_horizons.cjs",
    "tests/test_almanac_reference.cjs",
)
_FETCHED = re.compile(r"fetched\s+(\d{4}-\d{2}-\d{2})")


def run(*cmd, env=None):
    """(exit status, the last lines of its output)."""
    done = subprocess.run(
        cmd,
        cwd=ROOT,
        capture_output=True,
        text=True,
        env=dict(os.environ, **(env or {})),
        timeout=1800,
    )
    tail = (done.stdout + done.stderr).strip().splitlines()[-6:]
    return done.returncode, "\n".join("      " + line for line in tail)


def check_status(code, tail):
    return (OK, "") if code == 0 else (FAIL, tail)


def own_zims():
    return check_status(*run(PY, "-m", "zimi.ownzims", "--check"))


def whatsnew():
    return check_status(*run(PY, "scripts/whatsnew.py", "--check"))


def changelog():
    return check_status(
        *run(
            PY,
            "-m",
            "pytest",
            "tests/test_release_notes.py",
            "-q",
            "-p",
            "no:cacheprovider",
        )
    )


def satellites():
    return check_status(
        *run(
            PY,
            "-m",
            "pytest",
            "-q",
            "-p",
            "no:cacheprovider",
            "tests/test_almanac_satellites.py::test_the_shipped_snapshot_is_whole_and_recent",
            "tests/test_almanac_satellites.py::test_the_release_gate_leaves_an_offline_install_months_of_satellites",
        )
    )


def horizons(today=None):
    today = today or datetime.date.today()
    seen = []
    for rel in HORIZONS_FILES:
        with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
            head = "".join(next(f, "") for _ in range(60))
        seen += [datetime.date.fromisoformat(d) for d in _FETCHED.findall(head)]
    if not seen:
        return (
            FAIL,
            "      no 'fetched YYYY-MM-DD' in %s: the check cannot tell the fixtures' age"
            % ", ".join(HORIZONS_FILES),
        )
    age = (today - min(seen)).days
    note = "      the oldest Horizons reference was fetched %s (%d days ago)" % (
        min(seen),
        age,
    )
    return (
        (WARN, note + "; refetch for 'today' to stay near the present")
        if age > HORIZONS_WARN_DAYS
        else (OK, "")
    )


def qids():
    return check_status(*run(PY, "scripts/verify_almanac_qids.py"))


CHECKS = (
    ("own ZIMs current", own_zims, False),
    ("whatsnew.json matches the CHANGELOG", whatsnew, False),
    ("CHANGELOG highlights and release notes", changelog, False),
    ("satellite snapshot recent", satellites, False),
    ("Horizons reference fixtures", horizons, False),
    ("Almanac Q-IDs against Wikipedia", qids, True),
)


def fix():
    """What one command can bring up to date: the ZIMs built from the source, whatsnew.json from the CHANGELOG."""
    for label, cmd in (
        ("own ZIMs", (PY, "-m", "zimi.ownzims")),
        ("whatsnew.json", (PY, "scripts/whatsnew.py")),
    ):
        code, tail = run(*cmd)
        print("  %-22s %s" % (label, "rebuilt" if code == 0 else "FAILED\n" + tail))
        if code:
            return False
    print(
        "  commit what changed (the ZIMs take ZIMI_COMMIT_OWN_ZIMS=1; see .githooks/pre-commit)\n"
    )
    return True


def main(argv):
    if "--fix" in argv and not fix():
        return 1
    offline = "--no-network" in argv
    failed = 0
    print("Release checklist")
    for label, check, needs_network in CHECKS:
        if needs_network and offline:
            status, detail = SKIP, ""
        else:
            status, detail = check()
        failed += status == FAIL
        print("  %-4s  %s" % (status, label))
        if detail:
            print(detail)
    print()
    print(
        "%s"
        % (
            "Checklist FAILED: %d of %d" % (failed, len(CHECKS))
            if failed
            else "Checklist passed."
        )
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
