#!/bin/bash
# Roll every pushed topic/* branch into the bake branch, rebuild Zimi's own ZIMs once,
# and deploy the result to the NAS: the whole release as it stands, in one command.
#   scripts/bake.sh            merge, rebuild, deploy
#   scripts/bake.sh --no-deploy
# The bake branch is rebuilt from its base every run (never pushed, never a PR). rerere
# replays conflict resolutions made by hand once; CHANGELOG lines merge as a union;
# the built ZIMs are taken from either side and rebuilt after.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=${BAKE_BASE:-origin/v1.16}
BAKE=${BAKE_BRANCH:-bake/1.16}
BUILT='^zimi/builtin/[^/]+\.(zim|source)$'
export ZIMI_COMMIT_OWN_ZIMS=1  # the bake commits the ZIMs it builds; topic branches may not

[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit or stash first" >&2; exit 1; }
git fetch -q --prune origin
git config rerere.enabled true
git config rerere.autoupdate true
grep -qs '^CHANGELOG.md merge=union' .git/info/attributes || echo 'CHANGELOG.md merge=union' >> .git/info/attributes

git checkout -q -B "$BAKE" "$BASE"
for b in $(git for-each-ref --format='%(refname:short)' 'refs/remotes/origin/topic/*'); do
  if git merge -q --no-edit "$b" >/dev/null 2>&1; then echo "  merged $b"; continue; fi
  left=$(git diff --name-only --diff-filter=U)
  for f in $left; do
    [[ $f =~ $BUILT ]] && git checkout -q --theirs -- "$f" && git add -- "$f"
  done
  left=$(git diff --name-only --diff-filter=U)
  if [ -n "$left" ]; then
    echo "conflict merging $b (resolve, git commit, run again; rerere remembers):" >&2
    printf '  %s\n' $left >&2
    exit 1
  fi
  git commit -q --no-edit
  echo "  merged $b (resolved)"
done

python3 -m zimi.ownzims
git add -A zimi/builtin
git diff --cached --quiet || git commit -q -m "Own ZIMs rebuilt for the bake"
git log --oneline -1
[ "${1:-}" = "--no-deploy" ] || ./deploy.sh
