#!/usr/bin/env bash
# Build the portable headless Linux tarball and prove it runs from a "stick":
#   ci/build_portable.sh [version]      (from the repo root; the version defaults to pyproject's)
# Writes dist/zimi-<version>-linux-<x64|arm64>.tar.gz. Used by desktop-release.yml (the asset) and ci.yml (the gate).
set -euo pipefail

V="${1:-$(sed -n 's/^version *= *"\(.*\)"/\1/p' pyproject.toml | head -1)}"
case "$(uname -m)" in
  x86_64) A=x64 ;;
  aarch64|arm64) A=arm64 ;;
  *) echo "unsupported machine $(uname -m)"; exit 1 ;;
esac
NAME="zimi-$V-linux-$A"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pip install -r desktop/requirements-portable.txt
python ci/make_test_zim.py "$WORK/smoke_en_all.zim"

pyinstaller --noconfirm --distpath "$WORK/dist" --workpath "$WORK/build" desktop/zimi_portable.spec
mv "$WORK/dist/zimi" "$WORK/dist/$NAME"
mkdir -p dist
tar -C "$WORK/dist" -czf "dist/$NAME.tar.gz" "$NAME"
ls -la "dist/$NAME.tar.gz"

# The tarball itself, unpacked, with no Python on PATH: what a person gets.
mkdir "$WORK/unpacked"
tar -C "$WORK/unpacked" -xzf "dist/$NAME.tar.gz"
env -i PATH=/usr/bin:/bin bash ci/smoke_portable.sh "$WORK/unpacked/$NAME" "$WORK/smoke_en_all.zim"
