#!/bin/bash
# Build and open the macOS desktop app from this checkout: a release check, not part of a NAS deploy.
set -e
cd "$(dirname "$0")/.."
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
