#!/bin/bash
# Deploy Zimi to the NAS: send what changed, build the image (cached), swap the
# container, wait until it answers. The desktop app is a release check:
# desktop/build_local.sh.
set -euo pipefail
cd "$(dirname "$0")"

NAS_DIR=/volume1/docker/kiwix
# One SSH connection for every step (a Synology handshake is ~1 s each).
SOCK="${TMPDIR:-/tmp}/zimi-deploy-ssh-%r@%h"
SSH="ssh -o ControlMaster=auto -o ControlPath=$SOCK -o ControlPersist=60"
t0=$(date +%s)
step() { echo "  $1 ($(( $(date +%s) - t0 ))s)"; }

echo "=== Deploying to NAS ==="
# Only what changed since the last deploy crosses the wire (the package is ~100 MB,
# a deploy usually a few files). The stamp lives in .git, so a fresh clone sends
# everything once. (Synology refuses rsync unless its rsync service is on, so tar.)
STAMP=.git/zimi-last-deploy
SRC="zimi docker requirements.txt Dockerfile docker-compose.nas.yml"
if [ -f "$STAMP" ]; then
  files=$(find $SRC -type f -newer "$STAMP" ! -path '*/__pycache__/*' ! -name '*.pyc')
else
  files=$(find $SRC -type f ! -path '*/__pycache__/*' ! -name '*.pyc')
fi
touch "$STAMP.next"
if [ -n "$files" ]; then
  printf '%s\n' "$files" | tar cf - -T - | $SSH nas "cd $NAS_DIR && tar xf -"
fi
step "sent $(printf '%s' "$files" | grep -c . || true) changed files"
# kiwix-serve reads our own ZIMs from zimi/builtin only when it starts.
own_zims=$(printf '%s\n' "$files" | grep -c 'zimi/builtin/.*\.zim$' || true)

# BUILD FIRST, then swap: the running container serves the old image the whole
# build, and a failed build (set -e, pipefail) changes nothing. Cached: `COPY
# zimi/` is the second-to-last layer, so a code change rebuilds only it; never
# --no-cache for a source edit (over ten minutes, it re-downloads Chromium).
# The compose shipped is ours, never whatever sits in the NAS dir (a stale one
# once started the wrong image); the previous one is kept as .prev.
$SSH nas "set -eo pipefail; cd $NAS_DIR
  [ -f docker-compose.yml ] && cp -p docker-compose.yml docker-compose.yml.prev || true
  cp docker-compose.nas.yml docker-compose.yml
  /usr/local/bin/docker-compose build 2>&1 | tail -2
  /usr/local/bin/docker-compose up -d --remove-orphans 2>&1 | tail -2
  for i in \$(seq 1 60); do
    curl -sf -o /dev/null http://localhost:8899/health && exit 0
    sleep 1
  done
  echo 'no answer from /health after 60 s' >&2; exit 1"
mv "$STAMP.next" "$STAMP"
step "NAS deployed, /health answers"

if [ "$own_zims" -gt 0 ]; then
  $SSH nas "/usr/local/bin/docker ps --filter name=^kiwix$ -q | grep -q . && timeout 60 /usr/local/bin/docker restart kiwix >/dev/null" \
    && step "kiwix-serve restarted for the new own ZIMs" || true
fi

# Cloudflare keeps pages of the public host at its edge: drop only that host's
# copy (purge_everything would drop every host in the zone). The host, zone and
# a narrow Zone > Cache Purge token come from the operator's own secrets;
# without them the deploy is still
# complete and the service worker's content-hashed cache still updates.
CF_HOST=$(yq '.config.zimi_public_host' ~/vault/secrets/services.yml 2>/dev/null || true)
CF_ZONE=$(yq '.config.cf_zone_id_zimi' ~/vault/secrets/services.yml 2>/dev/null || true)
CF_TOKEN=$(yq '.config.cf_purge_token' ~/vault/secrets/services.yml 2>/dev/null || true)
if [ -n "$CF_HOST" ] && [ "$CF_HOST" != "null" ] && [ -n "$CF_ZONE" ] && [ "$CF_ZONE" != "null" ] && [ -n "$CF_TOKEN" ] && [ "$CF_TOKEN" != "null" ]; then
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/purge_cache" \
    -H "Authorization: Bearer ${CF_TOKEN}" -H "Content-Type: application/json" \
    --data "{\"hosts\":[\"${CF_HOST}\"]}" \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print('  Cloudflare cache purged for the public host' if r.get('success') else '  Cloudflare purge refused: ' + '; '.join(e.get('message','') for e in r.get('errors',[])))"
fi
$SSH -O exit nas 2>/dev/null || true
echo "Done in $(( $(date +%s) - t0 ))s"
