#!/bin/bash
# Deploy Zimi to the NAS: send what differs from what the NAS holds, build the image
# (cached), stop the container, bring up the new one, wait until it answers.
#
#   ./deploy.sh             deploy this checkout
#   ./deploy.sh --dry-run   print the plan (send / remove / unchanged, from-ref, to-ref); change nothing
#   ./deploy.sh --help      this text
#
# Nothing about the last deploy is remembered here. The NAS keeps a manifest of the files the last
# deploy put there (hash and path, plus the git ref and commit they came from), so any checkout or
# clone of any branch computes the same plan: a changed file is sent, a file the manifest lists and
# this tree lacks is removed. Switching the NAS between release lines (docs/release-lines.md) is
# the same operation as any other deploy. scripts/nas-line wraps it with names for the lines.
#
# The desktop app is a release check: desktop/build_local.sh.
# Environment (tests set these; the defaults are the real NAS):
#   ZIMI_DEPLOY_SRC   the tree to deploy (default: the checkout this script is in)
#   ZIMI_DEPLOY_REF   the ref to record (default: the tree's branch)
#   ZIMI_NAS_HOST     ssh host (default nas)
#   ZIMI_NAS_DIR      the deploy folder on the NAS (default /volume1/docker/kiwix)
#   ZIMI_NAS_BIN      where docker and docker-compose live on the NAS (default /usr/local/bin)
#   ZIMI_DEPLOY_NO_CF=1  skip the Cloudflare purge
set -euo pipefail

SELF=$(cd "$(dirname "$0")" && pwd)
HOST=${ZIMI_NAS_HOST:-nas}
NAS_DIR=${ZIMI_NAS_DIR:-/volume1/docker/kiwix}
BIN=${ZIMI_NAS_BIN:-/usr/local/bin}
STATE_DIR=$NAS_DIR/.zimi-deploy
MANIFEST=$STATE_DIR/manifest
TAB=$(printf '\t')
SRC=(zimi docker requirements.txt Dockerfile docker-compose.nas.yml)

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

dry=0
case "${1:-}" in
  "") ;;
  --dry-run) dry=1 ;;
  -h|--help) usage; exit 0 ;;
  *) echo "deploy.sh: unknown argument '$1' (nothing deployed). Try --help." >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then echo "deploy.sh: too many arguments (nothing deployed). Try --help." >&2; exit 2; fi

cd "${ZIMI_DEPLOY_SRC:-$SELF}"
for p in "${SRC[@]}"; do
  [ -e "$p" ] || { echo "deploy.sh: $p is missing from $(pwd); this is not a Zimi tree" >&2; exit 2; }
done

# One SSH connection for every step (a Synology handshake is ~1 s each).
SOCK="${TMPDIR:-/tmp}/zimi-deploy-ssh-%r@%h"
SSH=(ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=60)
nas() { "${SSH[@]}" "$HOST" "$@"; }
t0=$(date +%s)
step() { echo "  $1 ($(( $(date +%s) - t0 ))s)"; }
lines_in() { grep -c . "$1" || true; }

work=$(mktemp -d "${TMPDIR:-/tmp}/zimi-deploy.XXXXXX")
locked=0
cleanup() {
  [ "$locked" = 1 ] && { nas "rmdir $NAS_DIR/.deploy.lock" 2>/dev/null || true; }
  rm -rf "$work"
  "${SSH[@]}" -O exit "$HOST" 2>/dev/null || true
}
trap cleanup EXIT

to_ref=${ZIMI_DEPLOY_REF:-$(git symbolic-ref --short -q HEAD 2>/dev/null || echo detached)}
to_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then to_commit="$to_commit+dirty"; fi

# What this tree is, and what the NAS holds.
python3 "$SELF/scripts/deploy_plan.py" local . "${SRC[@]}" > "$work/local"
nas "cat $MANIFEST 2>/dev/null || true" > "$work/remote"
from_ref=$(python3 "$SELF/scripts/deploy_plan.py" header "$work/remote" ref)
from_commit=$(python3 "$SELF/scripts/deploy_plan.py" header "$work/remote" commit)
python3 "$SELF/scripts/deploy_plan.py" plan "$work/local" "$work/remote" "$work"
read -r n_send n_remove n_same < "$work/counts"
if [ ! -s "$work/remote" ]; then
  echo "  note: the NAS has no manifest yet, so every file is sent and nothing can be removed." >&2
  echo "        Deploy first from the line the NAS runs now; a switch removes leftovers only after that." >&2
fi
summary="${from_ref:-none}@${from_commit:--} -> ${to_ref}@${to_commit}: send $n_send, remove $n_remove, unchanged $n_same"

if [ "$dry" = 1 ]; then
  echo "=== Deploy plan (dry run, nothing changed) ==="
  echo "$summary"
  head -n 10 "$work/send" | sed 's/^/  send    /'
  [ "$n_send" -gt 10 ] && echo "  ... and $((n_send - 10)) more to send"
  head -n 10 "$work/remove" | sed 's/^/  remove  /'
  [ "$n_remove" -gt 10 ] && echo "  ... and $((n_remove - 10)) more to remove"
  exit 0
fi

echo "=== Deploying to NAS ==="
echo "  $summary"
# One deploy at a time: two would interleave their extractions and build a mix of revisions.
# mkdir is atomic; cleanup lets go on every exit. A killed deploy leaves the lock: rmdir it by hand.
nas "mkdir $NAS_DIR/.deploy.lock" 2>/dev/null || { echo "another deploy holds $NAS_DIR/.deploy.lock on the NAS (rmdir it if that deploy died)" >&2; exit 1; }
locked=1
nas "mkdir -p $NAS_DIR/zimi-data $STATE_DIR"

# Write a manifest atomically. $1 = state, $2 = an ERE of paths to leave out (none by default).
put_manifest() {
  { printf '# ref\t%s\n# commit\t%s\n# state\t%s\n# time\t%s\n' "$to_ref" "$to_commit" "$1" "$(date -u +%FT%TZ)"
    grep -v '^#' "$work/local" | { if [ -n "${2:-}" ]; then grep -Ev "${TAB}($2)\$" || true; else cat; fi; }
  } | nas "cat > $MANIFEST.tmp && mv $MANIFEST.tmp $MANIFEST"
}

# Before anything moves, the manifest stops vouching for the files about to change: a deploy cut
# short is then redone from where it stopped, never trusted.
python3 "$SELF/scripts/deploy_plan.py" pending "$work/remote" "$work/send" | nas "cat > $MANIFEST.tmp && mv $MANIFEST.tmp $MANIFEST"

if [ "$n_send" -gt 0 ]; then
  tar cf - -T "$work/send" | nas "cd $NAS_DIR && tar xf -"
fi
if [ "$n_remove" -gt 0 ]; then
  tr '\n' '\0' < "$work/remove" | nas "cd $NAS_DIR && xargs -0 rm -f --"
  step "removed $n_remove files this tree does not have"
fi
step "sent $n_send changed files"
put_manifest sent
# kiwix-serve reads our own ZIMs from zimi/builtin only when it starts.
own_zims=$(grep -c '^zimi/builtin/.*\.zim$' "$work/send" || true)

# BUILD FIRST, then swap: the running container serves the old image the whole
# build, and a failed build (set -e, pipefail) changes nothing. Cached: `COPY
# zimi/` is the second-to-last layer, so a code change rebuilds only it; never
# --no-cache for a source edit (over ten minutes, it re-downloads Chromium).
# The compose shipped is ours, never whatever sits in the NAS dir (a stale one
# once started the wrong image); the previous one is kept as .prev.
# The container is stopped (SIGTERM, then a grace period) before it is recreated:
# up -d alone kills it, and the NAS mails "stopped unexpectedly" for that.
nas "set -eo pipefail; cd $NAS_DIR
  [ -f docker-compose.yml ] && cp -p docker-compose.yml docker-compose.yml.prev || true
  cp docker-compose.nas.yml docker-compose.yml
  $BIN/docker-compose build 2>&1 | tail -2
  $BIN/docker-compose stop -t 30 zimi 2>&1 | tail -2
  $BIN/docker-compose up -d --remove-orphans 2>&1 | tail -2
  for i in \$(seq 1 240); do
    curl -sf -o /dev/null http://localhost:8899/health && exit 0
    sleep 1
  done
  echo 'no answer from /health after 240 s' >&2; exit 1"
step "NAS deployed, /health answers"

# The manifest says "deployed" only when kiwix-serve has the new own ZIMs; a failed restart leaves
# those ZIMs out of it, so the next deploy sends them again and retries.
if [ "$own_zims" -gt 0 ]; then
  if nas "if $BIN/docker ps --filter name=^kiwix\$ -q | grep -q .; then timeout 60 $BIN/docker restart kiwix >/dev/null; fi"; then
    step "kiwix-serve restarted for the new own ZIMs"
    put_manifest deployed
  else
    echo "  kiwix-serve restart failed: the next deploy sends these ZIMs again and retries" >&2
    put_manifest deployed "zimi/builtin/[^${TAB}]*\\.zim"
  fi
else
  put_manifest deployed
fi

# Cloudflare keeps pages of the public host at its edge: drop only that host's
# copy (purge_everything would drop every host in the zone). The host, zone and
# a narrow Zone > Cache Purge token come from the operator's own secrets;
# without them the deploy is still
# complete and the service worker's content-hashed cache still updates.
if [ -z "${ZIMI_DEPLOY_NO_CF:-}" ]; then
  CF_HOST=$(yq '.config.zimi_public_host' ~/vault/secrets/services.yml 2>/dev/null || true)
  CF_ZONE=$(yq '.config.cf_zone_id_zimi' ~/vault/secrets/services.yml 2>/dev/null || true)
  CF_TOKEN=$(yq '.config.cf_purge_token' ~/vault/secrets/services.yml 2>/dev/null || true)
  if [ -n "$CF_HOST" ] && [ "$CF_HOST" != "null" ] && [ -n "$CF_ZONE" ] && [ "$CF_ZONE" != "null" ] && [ -n "$CF_TOKEN" ] && [ "$CF_TOKEN" != "null" ]; then
    curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/purge_cache" \
      -H "Authorization: Bearer ${CF_TOKEN}" -H "Content-Type: application/json" \
      --data "{\"hosts\":[\"${CF_HOST}\"]}" \
      | python3 -c "import sys,json; r=json.load(sys.stdin); print('  Cloudflare cache purged for the public host' if r.get('success') else '  Cloudflare purge refused: ' + '; '.join(e.get('message','') for e in r.get('errors',[])))"
  fi
fi
echo "Done in $(( $(date +%s) - t0 ))s"
