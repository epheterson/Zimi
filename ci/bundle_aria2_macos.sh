#!/usr/bin/env bash
# Prepare a self-contained aria2c for bundling into the macOS .app.
#
# Homebrew's aria2c links against Homebrew dylibs that won't exist on the
# user's machine. Copy the binary plus its whole non-system dependency
# closure into one directory and rewrite every install name to
# @loader_path, so the set works from anywhere (PyInstaller drops it all
# into Contents/Frameworks next to the other binaries).
#
# Usage: ci/bundle_aria2_macos.sh <output-dir>
set -euo pipefail

OUT="$1"
mkdir -p "$OUT"

SRC=$(command -v aria2c || true)
[ -z "$SRC" ] && for c in /opt/homebrew/bin/aria2c /usr/local/bin/aria2c; do
  [ -x "$c" ] && SRC="$c" && break
done
[ -z "$SRC" ] && { echo "ERROR: aria2c not found (brew install aria2 first)"; exit 1; }
echo "Bundling $SRC"
cp -f "$SRC" "$OUT/aria2c"
chmod u+w,+x "$OUT/aria2c"

is_system() {
  case "$1" in
    /usr/lib/*|/System/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Non-system dependencies of a Mach-O file (skips the self/id line)
deps_of() {
  otool -L "$1" | tail -n +2 | awk '{print $1}' | while read -r dep; do
    is_system "$dep" || echo "$dep"
  done
}

# Breadth-first copy of the dependency closure
queue=("$OUT/aria2c")
while [ ${#queue[@]} -gt 0 ]; do
  bin="${queue[0]}"; queue=("${queue[@]:1}")
  for dep in $(deps_of "$bin"); do
    name=$(basename "$dep")
    # Resolve @loader_path/@rpath deps relative to the original brew tree
    real="$dep"
    case "$dep" in
      @loader_path/*|@rpath/*)
        for prefix in /opt/homebrew/lib /usr/local/lib; do
          [ -f "$prefix/$name" ] && real="$prefix/$name" && break
        done ;;
    esac
    if [ ! -f "$OUT/$name" ]; then
      if [ ! -f "$real" ]; then
        echo "ERROR: cannot resolve dependency $dep of $bin"; exit 1
      fi
      cp -f "$real" "$OUT/$name"
      chmod u+w "$OUT/$name"
      queue+=("$OUT/$name")
    fi
    install_name_tool -change "$dep" "@loader_path/$name" "$bin" 2>/dev/null
  done
  # Fix the library's own install name too
  if [[ "$bin" != *"/aria2c" ]]; then
    install_name_tool -id "@loader_path/$(basename "$bin")" "$bin" 2>/dev/null
  fi
done

echo "Bundle contents:"
ls -la "$OUT"
echo "Verifying no non-system, non-loader-path references remain..."
bad=0
for f in "$OUT"/*; do
  while read -r dep; do
    case "$dep" in
      /usr/lib/*|/System/*|@loader_path/*) ;;
      *) echo "  BAD: $f -> $dep"; bad=1 ;;
    esac
  done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
done
[ "$bad" = 0 ] && echo "  clean" || exit 1

# Smoke: the relocated binary must actually run
"$OUT/aria2c" --version | head -1
echo "aria2c bundle ready in $OUT"
