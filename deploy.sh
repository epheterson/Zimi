#!/bin/bash
# Deploy Zimi — NAS + local app build
set -e

echo "=== Deploying to NAS ==="
ssh nas "mkdir -p /volume1/docker/kiwix/zimi/templates /volume1/docker/kiwix/zimi/assets /volume1/docker/kiwix/zimi/static"
cat zimi/server.py | ssh nas "cat > /volume1/docker/kiwix/zimi/server.py"
cat zimi/__init__.py | ssh nas "cat > /volume1/docker/kiwix/zimi/__init__.py"
cat zimi/__main__.py | ssh nas "cat > /volume1/docker/kiwix/zimi/__main__.py"
cat zimi/mcp_server.py | ssh nas "cat > /volume1/docker/kiwix/zimi/mcp_server.py"
cat zimi/templates/index.html | ssh nas "cat > /volume1/docker/kiwix/zimi/templates/index.html"
cat zimi/assets/icon.png | ssh nas "cat > /volume1/docker/kiwix/zimi/assets/icon.png"
cat zimi/assets/favicon.png | ssh nas "cat > /volume1/docker/kiwix/zimi/assets/favicon.png"
cat zimi/assets/favicon-64.png | ssh nas "cat > /volume1/docker/kiwix/zimi/assets/favicon-64.png"
cat zimi/assets/apple-touch-icon.png | ssh nas "cat > /volume1/docker/kiwix/zimi/assets/apple-touch-icon.png"
tar cf - zimi/static/ | ssh nas "cd /volume1/docker/kiwix && tar xf -"
cat requirements.txt | ssh nas "cat > /volume1/docker/kiwix/requirements.txt"
cat Dockerfile | ssh nas "cat > /volume1/docker/kiwix/Dockerfile"
echo "  Files copied"

ssh nas "cd /volume1/docker/kiwix && /usr/local/bin/docker-compose build --no-cache" 2>&1 | tail -3
ssh nas "cd /volume1/docker/kiwix && /usr/local/bin/docker-compose down && /usr/local/bin/docker-compose up -d" 2>&1 | tail -3
echo "  NAS deployed"

echo ""
echo "=== Purging Cloudflare cache ==="
CF_ZONE=$(yq '.config.cf_zone_id' ~/vault/secrets/services.yml)
CF_TOKEN=$(yq '.config.cf_token' ~/vault/secrets/services.yml)
if [ -n "$CF_ZONE" ] && [ "$CF_ZONE" != "null" ] && [ -n "$CF_TOKEN" ] && [ "$CF_TOKEN" != "null" ]; then
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/purge_cache" \
    -H "Authorization: Bearer ${CF_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"files":["https://knowledge.zosia.io/","https://knowledge.zosia.io/static/almanac.js"]}' \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print('  Purged' if r.get('success') else f'  Failed: {r}')"
else
  echo "  Skipped (no Cloudflare credentials)"
fi

echo ""
echo "=== Syncing vault ==="
mkdir -p ~/vault/infra/zim-reader/zimi/templates
cp zimi/server.py ~/vault/infra/zim-reader/zimi/server.py
cp zimi/__init__.py ~/vault/infra/zim-reader/zimi/__init__.py
cp zimi/templates/index.html ~/vault/infra/zim-reader/zimi/templates/index.html
echo "  Vault synced"

echo ""
echo "=== Building desktop app ==="
pkill -9 -f "dist/Zimi" 2>/dev/null || true
sleep 1
pyinstaller zimi_desktop.spec --noconfirm 2>&1 | tail -5
echo "  App built"

echo ""
echo "=== Launching app ==="
open dist/Zimi.app
echo "  Done!"
