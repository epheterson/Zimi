#!/bin/bash
# Deploy Zimi — NAS + local app build
set -e

echo "=== Deploying to NAS ==="
ssh nas "mkdir -p /volume1/docker/kiwix/zimi /volume1/docker/kiwix/zimi-data"
# Ship the whole package as a tar so new modules deploy automatically.
# Excludes pycache + tests so the image stays slim.
tar cf - --exclude='__pycache__' --exclude='*.pyc' zimi/ | ssh nas "cd /volume1/docker/kiwix && tar xf -"
cat requirements.txt | ssh nas "cat > /volume1/docker/kiwix/requirements.txt"
cat Dockerfile | ssh nas "cat > /volume1/docker/kiwix/Dockerfile"
# Ship our own compose so the deploy is deterministic — never trust whatever
# compose happens to be sitting in the NAS dir. A stale stock-kiwix compose left
# there once hijacked a deploy (down --remove-orphans killed the live Zimi
# container, up -d started the wrong image at 256m and crash-looped). Back up any
# existing compose to .prev before overwriting, for a one-step manual rollback.
ssh nas "cd /volume1/docker/kiwix && [ -f docker-compose.yml ] && cp -p docker-compose.yml docker-compose.yml.prev || true"
cat docker-compose.nas.yml | ssh nas "cat > /volume1/docker/kiwix/docker-compose.yml"
echo "  Files copied (incl. canonical NAS compose)"

# BUILD FIRST, then swap. The order used to be down → build → up, which meant
# the site was off for the entire --no-cache build (>10 minutes with Node and
# Playwright in the image) and that ANY build failure left the NAS with no
# container at all — not the old one, none. A dropped SSH did exactly that.
#
# Built first, the running container keeps serving the old image the whole time
# and a failed build changes nothing: `set -e` stops here and prod is still up.
#
# `| tail -3` makes the PIPELINE's status tail's, which is always 0 — so a
# failed build reported success and left the previous image running. That is
# how a Dockerfile that exited 127 still printed "NAS deployed", and how a
# whole evening of "deploy=0" meant nothing. pipefail makes the build's own
# status the one that counts, and `set -e` above then stops the script.
set -o pipefail
ssh nas "cd /volume1/docker/kiwix && /usr/local/bin/docker-compose build --no-cache" 2>&1 | tail -3

# Only now, with a good image in hand, is it safe to take the site down. `down`
# immediately before `up` also keeps the reason it was there in the first place:
# no name-conflict against a still-shutting-down container.
ssh nas "cd /volume1/docker/kiwix && /usr/local/bin/docker-compose down --remove-orphans --timeout 30" 2>&1 | tail -3
ssh nas "cd /volume1/docker/kiwix && /usr/local/bin/docker-compose up -d" 2>&1 | tail -3

# Say it only when it is true. A container that exited on boot is not a deploy.
sleep 10
if ssh nas "/usr/local/bin/docker ps --filter name=zim-reader --format '{{.Names}}'" | grep -q zim-reader; then
  echo "  NAS deployed"
else
  echo "  NAS DEPLOY FAILED — container is not running" >&2
  exit 1
fi

echo ""
echo "=== Purging Cloudflare cache ==="
CF_ZONE=$(yq '.config.cf_zone_id' ~/vault/secrets/services.yml)
CF_TOKEN=$(yq '.config.cf_token' ~/vault/secrets/services.yml)
if [ -n "$CF_ZONE" ] && [ "$CF_ZONE" != "null" ] && [ -n "$CF_TOKEN" ] && [ "$CF_TOKEN" != "null" ]; then
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/purge_cache" \
    -H "Authorization: Bearer ${CF_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"purge_everything":true}' \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print('  Purged' if r.get('success') else f'  Failed: {r}')"
else
  echo "  Skipped (no Cloudflare credentials)"
fi

echo ""
echo "=== Syncing vault ==="
mkdir -p ~/vault/infra/zim-reader/zimi/templates
# Mirror the package with the same exclusions used for NAS deploy.
rsync -a --delete --exclude='__pycache__' --exclude='*.pyc' \
  zimi/ ~/vault/infra/zim-reader/zimi/
echo "  Vault synced"

echo ""
echo "=== Building desktop app ==="
pkill -9 -f "dist/Zimi" 2>/dev/null || true
sleep 1

# The in-process BitTorrent engine (libtorrent) only lands in the frozen app if
# it's importable in the interpreter PyInstaller runs under. libtorrent 2.0
# ships wheels for CPython <= 3.13 only — building under a newer python (e.g.
# 3.14, the current `python3` default) silently produces an HTTP-only app that
# reports "BT unavailable". CI pins Python 3.12; the local build must match, so
# pick a compatible interpreter and build from a dedicated venv that carries the
# same deps CI installs.
BUILD_PY=""
for cand in python3.13 python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1 && \
     "$cand" -c 'import sys; sys.exit(0 if sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null; then
    BUILD_PY="$cand"
    break
  fi
done
if [ -z "$BUILD_PY" ]; then
  echo "  WARNING: no python <= 3.13 found — no libtorrent wheel, app will be HTTP-only"
  BUILD_PY="python3"
fi
echo "  Build interpreter: $($BUILD_PY --version 2>&1) ($BUILD_PY)"

BUILD_VENV=".build-venv"
if [ ! -x "$BUILD_VENV/bin/python" ] || \
   ! "$BUILD_VENV/bin/python" -c 'import sys; sys.exit(0 if sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null; then
  rm -rf "$BUILD_VENV"
  "$BUILD_PY" -m venv "$BUILD_VENV"
fi
"$BUILD_VENV/bin/pip" install -q --upgrade pip
"$BUILD_VENV/bin/pip" install -q -r desktop/requirements-desktop.txt
# Soft dependency, mirroring CI: no wheel for this interpreter → warn and build
# HTTP-only, never block the build.
if "$BUILD_VENV/bin/pip" install -q "libtorrent==2.0.*" 2>/dev/null; then
  echo "  libtorrent bundled (BitTorrent enabled)"
else
  echo "  WARNING: no libtorrent wheel for $($BUILD_PY --version 2>&1) — app will be HTTP-only"
fi

"$BUILD_VENV/bin/pyinstaller" desktop/zimi_desktop.spec --noconfirm 2>&1 | tail -5
echo "  App built"

echo ""
echo "=== Launching app ==="
open dist/Zimi.app
echo "  Done!"
