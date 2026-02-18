#!/bin/bash
# Deploy Zimi to NAS
set -e

echo "=== Deploying to NAS ==="
cat zimi.py | ssh nas "cat > /volume1/docker/kiwix/zimi.py"
cat templates/index.html | ssh nas "cat > /volume1/docker/kiwix/templates/index.html"
cat Dockerfile | ssh nas "cat > /volume1/docker/kiwix/Dockerfile"
ssh nas "mkdir -p /volume1/docker/kiwix/assets"
cat assets/icon.png | ssh nas "cat > /volume1/docker/kiwix/assets/icon.png"
cat assets/apple-touch-icon.png | ssh nas "cat > /volume1/docker/kiwix/assets/apple-touch-icon.png"
echo "  Files copied"

ssh nas "cd /volume1/docker/kiwix && /usr/local/bin/docker compose build --no-cache" 2>&1 | tail -3
ssh nas "cd /volume1/docker/kiwix && /usr/local/bin/docker compose down && /usr/local/bin/docker compose up -d" 2>&1 | tail -3
echo "  NAS deployed"
