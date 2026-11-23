#!/bin/sh
# Run before every push: no merge-conflict markers in the sources, and every static JS file parses.
#   sh scripts/prepush_check.sh
cd "$(git rev-parse --show-toplevel)" || exit 1
if git grep -nE '^(<<<<<<<|>>>>>>>) ' -- zimi/*.py zimi/static/*.js zimi/static/*.css zimi/static/i18n tests scripts | head -5 | grep .; then
  echo "conflict markers found: do not push" >&2
  exit 1
fi
bad=0
for f in zimi/static/*.js; do
  node --check "$f" 2>/dev/null || { echo "does not parse: $f" >&2; bad=1; }
done
exit $bad
