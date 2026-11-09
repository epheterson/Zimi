#!/bin/bash
# Roll every pushed topic/* branch into the bake branch, rebuild Zimi's own ZIMs once,
# and deploy the result to the NAS: the whole release as it stands, in one command.
#   scripts/bake.sh            merge, rebuild, deploy
#   scripts/bake.sh --no-deploy
#   BAKE_SKIP='stand models' scripts/bake.sh   leave out lanes still mid-build
# The bake branch is rebuilt from its base every run (never pushed, never a PR). rerere
# replays conflict resolutions made by hand once; CHANGELOG lines merge as a union;
# the built ZIMs are taken from either side and rebuilt after.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=${BAKE_BASE:-origin/v1.16}
BAKE=${BAKE_BRANCH:-bake/1.16}
BUILT='^zimi/builtin/[^/]+\.(zim|source)$'
export ZIMI_COMMIT_OWN_ZIMS=1  # the bake commits the ZIMs it builds; topic branches may not

# Editors and status lines leave .git/index.lock behind now and then: wait for a live one, clear one a minute old.
LOCKF="$(git rev-parse --git-dir)/index.lock"
for _ in $(seq 30); do [ -e "$LOCKF" ] || break; sleep 1; done
[ -e "$LOCKF" ] && [ -n "$(find "$LOCKF" -mmin +1)" ] && rm -f "$LOCKF"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit or stash first" >&2; exit 1; }
git fetch -q --prune origin
git config rerere.enabled true
git config rerere.autoupdate true
GITDIR=$(git rev-parse --git-common-dir)
mkdir -p "$GITDIR/info"
grep -qs '^CHANGELOG.md merge=union' "$GITDIR/info/attributes" || echo 'CHANGELOG.md merge=union' >> "$GITDIR/info/attributes"
# The string tables merge key by key (every lane adds keys at the same end of the same ten files).
git show origin/topic/faster-releases:scripts/json_merge3.py > "$GITDIR/json_merge3.py" 2>/dev/null \
  || git show "$BASE:scripts/json_merge3.py" > "$GITDIR/json_merge3.py"
git config merge.jsonkeys.driver "python3 '$GITDIR/json_merge3.py' %O %A %B"
grep -qs 'merge=jsonkeys' "$GITDIR/info/attributes" || echo 'zimi/static/i18n/*.json merge=jsonkeys' >> "$GITDIR/info/attributes"

git checkout -q -B "$BAKE" "$BASE"
for b in $(git for-each-ref --format='%(refname:short)' 'refs/remotes/origin/topic/*'); do
  case " ${BAKE_SKIP:-} " in *" ${b#origin/topic/} "*) echo "  skipped $b"; continue;; esac
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
