#!/usr/bin/env bash
# Fetch the pinned kiwix-serve for the browser shards and export KIWIX_SERVE.
#
# download.kiwix.org redirects to whichever mirror it picks, and some picks serve
# 13 KB/s: the 21 MB tarball took 11-18 minutes in all four shards of the 1.15.4
# runs, longer than the tests themselves. The tarball is pinned by checksum, so
# where it comes from does not matter: try the fast university mirrors first,
# with a time limit each, and the redirecting origin last.
set -euo pipefail

VERSION=3.8.2
SHA256=b0ae98dd344aa0469a15ab42feff6d5aafb79541a82fb4e2647c74b073123815
NAME="kiwix-tools_linux-x86_64-$VERSION"
CACHE="${KIWIX_CACHE_DIR:-$PWD/.kiwix-cache}"
MIRRORS=(
  "https://ftp.fau.de/kiwix"
  "https://mirrors.dotsrc.org/kiwix"
  "https://ftp.nluug.nl/pub/kiwix"
  "https://download.kiwix.org"
)

mkdir -p "$CACHE"
tgz="$CACHE/$NAME.tgz"
valid() { [ -f "$tgz" ] && echo "$SHA256  $tgz" | sha256sum -c - >/dev/null 2>&1; }

if valid; then
  echo "kiwix-serve $VERSION: cached"
else
  for base in "${MIRRORS[@]}"; do
    echo "kiwix-serve $VERSION: trying $base"
    if curl -fsSL --retry 2 --max-time 90 -o "$tgz" "$base/release/kiwix-tools/$NAME.tar.gz" && valid; then
      break
    fi
    rm -f "$tgz"
  done
  valid || { echo "::error::no mirror served kiwix-tools $VERSION with the pinned checksum" >&2; exit 1; }
fi

tar xzf "$tgz" -C "$CACHE"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "KIWIX_SERVE=$CACHE/$NAME/kiwix-serve" >> "$GITHUB_ENV"
  echo "ZIMI_REQUIRE_KIWIX_SERVE=1" >> "$GITHUB_ENV"
else
  echo "KIWIX_SERVE=$CACHE/$NAME/kiwix-serve"
fi
