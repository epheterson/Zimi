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
# Usage:
#   ./scripts/release-gate.sh                 # every feature
#   ./scripts/release-gate.sh -k cross_zim    # one feature, while fixing it
#
# Exit status is non-zero if any feature fails.

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

"$PYTHON" -m pytest tests_release/ \
  -p no:cacheprovider \
  --tb=short \
  -q \
  "$@"
status=$?

echo
if [ $status -eq 0 ]; then
  echo "Release gate PASSED — every feature above works end to end."
else
  echo "Release gate FAILED — do not tag. See the scoreboard above for which"
  echo "feature broke, then re-run just that one with -k <name>."
fi
exit $status
