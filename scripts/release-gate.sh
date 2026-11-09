#!/usr/bin/env bash
#
# Release gate — run before tagging a release.
#
# Unit tests prove functions behave. This proves FEATURES work: it boots real
# zimi servers on ephemeral ports against real ZIM files and drives them over
# HTTP exactly as a browser does. That is the only thing that catches a feature
# wired up correctly in every module and still dead end to end — which is how
# cross-ZIM link resolution shipped serving an empty domain map.
#
# It is deliberately NOT part of `pytest tests/`: it costs minutes and boots
# subprocesses, so it runs before a release rather than on every save.
#
# It also runs the release checklist first (scripts/release_checks.py): own ZIMs current, whatsnew.json,
# CHANGELOG highlights, satellite snapshot age, Horizons fixture age, and the Almanac Q-IDs against
# Wikipedia. Release day is this one command; --fix does what a command can for the red ones.
#
# Usage:
#   ./scripts/release-gate.sh                 # the checklist, then every feature
#   ./scripts/release-gate.sh --fix           # rebuild the own ZIMs and whatsnew.json first, then as above
#   ./scripts/release-gate.sh --checks        # the checklist alone (seconds, not minutes)
#   ./scripts/release-gate.sh --no-network    # skip the Q-ID audit (offline)
#   ./scripts/release-gate.sh -k cross_zim    # one feature, while fixing it (skips the checklist)
#
# Exit status is non-zero if any check or feature fails.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON="${PYTHON:-python3}"

echo "Zimi release gate"
echo "  repo:       $REPO_ROOT"
echo "  version:    $("$PYTHON" -c 'import zimi.server as s; print(s.ZIMI_VERSION)' 2>/dev/null || echo '?')"
echo "  python:     $("$PYTHON" --version 2>&1)"
echo

# A gate that silently skips is worse than no gate — it reports PASS for
# checks that never ran. libzim's writer is what builds every fixture ZIM.
if ! "$PYTHON" -c 'import libzim.writer' 2>/dev/null; then
  echo "FATAL: libzim.writer is not importable, so no fixture ZIM can be built." >&2
  echo "       Install it (pip install libzim) — do not ship on a skipped gate." >&2
  exit 2
fi

# Our own flags, then whatever is left goes to pytest. A -k (one feature, while fixing it) skips the checklist.
checks_args=()
checks_only=0
run_checks=1
pytest_args=()
for arg in "$@"; do
  case "$arg" in
    --fix|--no-network) checks_args+=("$arg") ;;
    --checks) checks_only=1 ;;
    *) pytest_args+=("$arg") ;;
  esac
done
[ ${#pytest_args[@]} -gt 0 ] && run_checks=0

checks_status=0
if [ "$run_checks" = 1 ] || [ "$checks_only" = 1 ]; then
  "$PYTHON" scripts/release_checks.py ${checks_args[@]+"${checks_args[@]}"}
  checks_status=$?
  echo
fi
if [ "$checks_only" = 1 ]; then exit $checks_status; fi

"$PYTHON" -m pytest tests_release/ \
  -p no:cacheprovider \
  --tb=short \
  -q \
  ${pytest_args[@]+"${pytest_args[@]}"}
status=$?
if [ $checks_status -ne 0 ]; then status=$checks_status; fi

echo
if [ $status -eq 0 ]; then
  echo "Release gate PASSED — the checklist is green and every feature above works end to end."
else
  echo "Release gate FAILED — do not tag. See the scoreboard above for which"
  echo "feature broke, then re-run just that one with -k <name>."
fi
exit $status
