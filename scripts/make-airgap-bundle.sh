#!/usr/bin/env bash
#
# Build a sneakernet bundle: everything needed to install and run Zimi on a
# machine that will never touch the internet. Run this on a connected box,
# carry the result across on a USB drive, run install.sh on the other side.
#
# What lands in the bundle:
#   wheels/     Zimi plus every dependency, as wheels — no PyPI at install time
#   docker/     optionally `docker save` of the image, for container hosts
#   deploy/     the compose and Kubernetes manifests, unmodified
#   zims/       optionally the ZIM files themselves
#   install.sh  the target-side script (pip install --no-index, docker load)
#   INSTALL.md  what to run over there, including the offline env vars
#   SHA256SUMS  checksums for every file above
#
# The wheels are platform-specific. By default this bundles for the machine
# you run it on; use --target/--python-version to build for a different
# machine (see --help). Getting this wrong is the one failure mode that only
# shows up after the drive is already in the vault — so the script refuses to
# write a bundle whose dependencies didn't all resolve to wheels.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OUT_DIR=""
SOURCE="local"          # local (this tree) | pypi
VERSION=""              # pypi mode: which release; local mode: read from pyproject
EXTRAS="pdf,mcp"        # extras to include, or "none" for the base install
PLATFORMS=()
TARGET=""               # shorthand for a set of --platform tags
PYTHON_VERSION=""
DOCKER_IMAGE=""
ZIM_PATHS=()
MAKE_TAR=1
ALLOW_SDIST=0
PYTHON_BIN="${PYTHON:-python3}"

usage() {
    cat <<'EOF'
Usage: scripts/make-airgap-bundle.sh [OUTPUT_DIR] [options]

  OUTPUT_DIR            Where to build (default: ./dist/zimi-airgap-<version>)

  --source local|pypi   Build the Zimi wheel from this tree (default) or fetch
                        a published release from PyPI.
  --version X.Y.Z       PyPI mode: which release. Ignored for --source local.
  --extras LIST         Extras to bundle (default "pdf,mcp"), or "none" for
                        the base install. Avoid "all": it hard-requires
                        libtorrent, which has no wheel on Python 3.14+, and
                        BitTorrent is useless air-gapped anyway.
  --target NAME         Where the bundle will be installed:
                        linux-x86_64, linux-arm64, macos-arm64, macos-x86_64,
                        windows-x86_64. Expands to the platform tags those
                        wheels are actually published under. Default: this
                        machine, which is only right if it matches the target.
  --platform TAG        A raw platform tag, repeatable, for a target the
                        presets don't cover.
  --python-version X.Y  Target Python (default: this interpreter's).
  --docker [IMAGE]      Also `docker save` an image into docker/
                        (default image: epheterson/zimi:latest).
  --zim PATH            Include a .zim file (repeatable) or every .zim in a
                        directory. Off by default — ZIMs are big.
  --no-tar              Leave the bundle as a directory, don't roll a tarball.
  --allow-sdist         Don't fail when a dependency resolves to a source
                        distribution. Such a bundle cannot install offline
                        without a toolchain — you are on your own.
  -h, --help            This.

Examples:
  scripts/make-airgap-bundle.sh
  scripts/make-airgap-bundle.sh /media/usb/zimi --docker --zim /srv/zims
  scripts/make-airgap-bundle.sh --source pypi --version 1.8.2 \
      --target linux-x86_64 --python-version 3.11
EOF
}

die() { echo "make-airgap-bundle: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --source)         SOURCE="${2:-}"; shift 2 ;;
        --version)        VERSION="${2:-}"; shift 2 ;;
        --extras)         EXTRAS="${2:-}"; shift 2 ;;
        --target)         TARGET="${2:-}"; shift 2 ;;
        --platform)       PLATFORMS+=("${2:-}"); shift 2 ;;
        --python-version) PYTHON_VERSION="${2:-}"; shift 2 ;;
        --zim)            ZIM_PATHS+=("${2:-}"); shift 2 ;;
        --no-tar)         MAKE_TAR=0; shift ;;
        --allow-sdist)    ALLOW_SDIST=1; shift ;;
        --docker)
            # Optional value: --docker, or --docker myrepo/zimi:1.9.0
            if [ $# -ge 2 ] && [ "${2#-}" = "$2" ] && [ -n "${2:-}" ]; then
                DOCKER_IMAGE="$2"; shift 2
            else
                DOCKER_IMAGE="epheterson/zimi:latest"; shift
            fi
            ;;
        -h|--help)        usage; exit 0 ;;
        -*)               die "unknown option $1 (try --help)" ;;
        *)                [ -n "$OUT_DIR" ] && die "two output dirs given"
                          OUT_DIR="$1"; shift ;;
    esac
done

case "$SOURCE" in local|pypi) ;; *) die "--source must be local or pypi" ;; esac
command -v "$PYTHON_BIN" >/dev/null || die "no $PYTHON_BIN on PATH"

# ---------------------------------------------------------------------------
# Version + paths
# ---------------------------------------------------------------------------
if [ "$SOURCE" = "local" ]; then
    VERSION="$("$PYTHON_BIN" - "$REPO_ROOT/pyproject.toml" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
print(m.group(1) if m else "0.0.0")
PY
)"
else
    [ -n "$VERSION" ] || die "--source pypi needs --version"
fi

BUNDLE_NAME="zimi-airgap-${VERSION}"
[ -n "$OUT_DIR" ] || OUT_DIR="$REPO_ROOT/dist/$BUNDLE_NAME"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WHEELS="$OUT_DIR/wheels"
# Distributions from an earlier build are stale by definition — a different
# --target, or the sdists that made the last run refuse to finish. Leaving
# them would poison this bundle with wheels for the wrong machine. Only the
# distribution files go; anything else in the directory is left alone.
if [ -d "$WHEELS" ]; then
    find "$WHEELS" -maxdepth 1 \
        \( -name '*.whl' -o -name '*.tar.gz' -o -name '*.zip' \) -delete
fi
mkdir -p "$WHEELS" "$OUT_DIR/deploy"

# Extras suffix for the requirement spec: zimi[all]==1.8.2
EXTRA_SUFFIX=""
if [ "$EXTRAS" != "none" ] && [ -n "$EXTRAS" ]; then
    EXTRA_SUFFIX="[$EXTRAS]"
fi

# --target expands to the platform tags that project actually publishes. pip
# matches wheel tags literally, so one tag is never enough: libzim ships
# manylinux_2_28, most of the rest still ship manylinux2014 (= manylinux_2_17),
# and a bundle missing either is a bundle that won't install. Pure-Python
# wheels (py3-none-any) match regardless.
case "$TARGET" in
    "") ;;
    linux-x86_64)
        PLATFORMS+=(manylinux2014_x86_64 manylinux_2_17_x86_64 manylinux_2_28_x86_64) ;;
    linux-arm64)
        PLATFORMS+=(manylinux2014_aarch64 manylinux_2_17_aarch64 manylinux_2_28_aarch64) ;;
    macos-arm64)
        PLATFORMS+=(macosx_11_0_arm64 macosx_12_0_arm64 macosx_13_0_arm64 macosx_14_0_arm64) ;;
    macos-x86_64)
        PLATFORMS+=(macosx_10_9_x86_64 macosx_10_12_x86_64 macosx_10_15_x86_64 macosx_11_0_x86_64 macosx_13_0_x86_64) ;;
    windows-x86_64)
        PLATFORMS+=(win_amd64) ;;
    *)
        die "unknown --target $TARGET (linux-x86_64, linux-arm64, macos-arm64, macos-x86_64, windows-x86_64)" ;;
esac

# Wheels only, always. A source distribution in the bundle is unusable on the
# other side, and binary-only makes pip back off to an older release that does
# publish a wheel for the target instead of silently handing us one. (It is
# also mandatory for --platform: pip refuses cross-target resolution without
# it, since it cannot build for a machine it isn't running on.)
PIP_TARGET_ARGS=()
if [ "$ALLOW_SDIST" != "1" ]; then
    PIP_TARGET_ARGS+=(--only-binary=:all:)
fi
for p in ${PLATFORMS[@]+"${PLATFORMS[@]}"}; do
    PIP_TARGET_ARGS+=(--platform "$p")
done
if [ -n "$PYTHON_VERSION" ]; then
    PIP_TARGET_ARGS+=(--python-version "$PYTHON_VERSION")
fi

echo "==> Zimi $VERSION → $OUT_DIR"

# ---------------------------------------------------------------------------
# Wheels
# ---------------------------------------------------------------------------
if [ "$SOURCE" = "local" ]; then
    echo "==> Building the Zimi wheel from $REPO_ROOT"
    BUILD_DIR="$(mktemp -d)"
    trap 'rm -rf "$BUILD_DIR"' EXIT
    # setuptools scratches in the source tree (build/, *.egg-info) whatever
    # --wheel-dir says. Remember what was already there so a build for the
    # sneakernet drive doesn't leave the repo dirtier than it found it.
    HAD_BUILD_DIR=0; [ -e "$REPO_ROOT/build" ] && HAD_BUILD_DIR=1
    HAD_EGG_INFO=0; [ -e "$REPO_ROOT/zimi.egg-info" ] && HAD_EGG_INFO=1
    "$PYTHON_BIN" -m pip wheel --no-deps --wheel-dir "$BUILD_DIR" "$REPO_ROOT" >/dev/null
    [ "$HAD_BUILD_DIR" = "1" ] || rm -rf "$REPO_ROOT/build"
    [ "$HAD_EGG_INFO" = "1" ] || rm -rf "$REPO_ROOT/zimi.egg-info"
    LOCAL_WHEEL="$(find "$BUILD_DIR" -name 'zimi-*.whl' | head -1)"
    [ -n "$LOCAL_WHEEL" ] || die "the wheel build produced nothing"
    # Resolve dependencies from the built wheel's own metadata rather than
    # requirements.txt, so extras and environment markers are honored exactly
    # as a real `pip install zimi[...]` would honor them. pip copies the
    # local wheel into the destination alongside what it fetches.
    echo "==> Downloading dependency wheels for zimi${EXTRA_SUFFIX}"
    "$PYTHON_BIN" -m pip download --dest "$WHEELS" \
        ${PIP_TARGET_ARGS[@]+"${PIP_TARGET_ARGS[@]}"} "${LOCAL_WHEEL}${EXTRA_SUFFIX}" >/dev/null
else
    echo "==> Downloading zimi${EXTRA_SUFFIX}==$VERSION and dependencies from PyPI"
    "$PYTHON_BIN" -m pip download --dest "$WHEELS" \
        ${PIP_TARGET_ARGS[@]+"${PIP_TARGET_ARGS[@]}"} "zimi${EXTRA_SUFFIX}==$VERSION" >/dev/null
fi

# pip falls back to a source distribution when no wheel matches the target.
# In a bundle that is a latent failure, not a warning: building an sdist needs
# a compiler AND its own build dependencies (setuptools, Cython, …), which are
# not in here and cannot be fetched on the other side. Fail now, where it is
# cheap, rather than at 2am next to the air-gapped rack.
SDISTS="$(find "$WHEELS" \( -name '*.tar.gz' -o -name '*.zip' \) -print)"
if [ -n "$SDISTS" ]; then
    echo "" >&2
    echo "These dependencies have no wheel for the target:" >&2
    echo "$SDISTS" | sed 's|.*/|  |' >&2
    cat >&2 <<'WHY'

They arrived as source distributions, which cannot be installed offline —
building them needs a toolchain and build dependencies this bundle has no way
to carry. Pick a target that has wheels, e.g.

  --target linux-x86_64 --python-version 3.12

or, if the target really does have a full build environment and network-free
build deps, re-run with --allow-sdist.
WHY
    if [ "$ALLOW_SDIST" != "1" ]; then
        rm -f "$OUT_DIR/SHA256SUMS"
        die "refusing to write a bundle that cannot install offline"
    fi
    echo "    --allow-sdist given: continuing anyway" >&2
fi

# ---------------------------------------------------------------------------
# Docker image (optional)
# ---------------------------------------------------------------------------
if [ -n "$DOCKER_IMAGE" ]; then
    command -v docker >/dev/null || die "--docker given but docker is not on PATH"
    mkdir -p "$OUT_DIR/docker"
    echo "==> Saving image $DOCKER_IMAGE"
    docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1 || docker pull "$DOCKER_IMAGE"
    docker save "$DOCKER_IMAGE" -o "$OUT_DIR/docker/zimi-image.tar"
    echo "$DOCKER_IMAGE" > "$OUT_DIR/docker/IMAGE"
fi

# ---------------------------------------------------------------------------
# Deployment manifests + ZIMs
# ---------------------------------------------------------------------------
cp "$REPO_ROOT/deploy/docker-compose.yml" "$REPO_ROOT/deploy/kubernetes.yaml" "$OUT_DIR/deploy/"

ZIM_COUNT=0
if [ ${#ZIM_PATHS[@]} -gt 0 ]; then
    mkdir -p "$OUT_DIR/zims"
    for path in ${ZIM_PATHS[@]+"${ZIM_PATHS[@]}"}; do
        if [ -d "$path" ]; then
            for f in "$path"/*.zim; do
                [ -e "$f" ] || continue
                echo "==> Copying $(basename "$f")"
                cp "$f" "$OUT_DIR/zims/"
                ZIM_COUNT=$((ZIM_COUNT + 1))
            done
        elif [ -f "$path" ]; then
            echo "==> Copying $(basename "$path")"
            cp "$path" "$OUT_DIR/zims/"
            ZIM_COUNT=$((ZIM_COUNT + 1))
        else
            die "--zim path not found: $path"
        fi
    done
fi

# ---------------------------------------------------------------------------
# Target-side installer
# ---------------------------------------------------------------------------
{
# The spec is stamped in at build time so the installer asks for exactly the
# extras this bundle carries wheels for.
cat <<STAMP
#!/usr/bin/env bash
ZIMI_SPEC="zimi${EXTRA_SUFFIX}"
STAMP
cat <<'INSTALL'
#
# Install Zimi from this bundle. No network access is used or needed.
#
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON:-python3}"

if [ -f "$DIR/SHA256SUMS" ] && command -v shasum >/dev/null; then
    echo "==> Verifying checksums"
    (cd "$DIR" && shasum -a 256 -c SHA256SUMS --quiet) || {
        echo "checksum mismatch — the bundle is damaged, do not install it" >&2
        exit 1
    }
fi

if [ -d "$DIR/wheels" ]; then
    echo "==> Installing $ZIMI_SPEC from bundled wheels"
    "$PYTHON_BIN" -m pip install --no-index --find-links "$DIR/wheels" "$ZIMI_SPEC"
    # Importing is the real proof the install works. Optional dependencies are
    # chatty on import, so keep only the last line — the version.
    echo "==> Installed Zimi $("$PYTHON_BIN" -c 'import zimi; print(zimi.ZIMI_VERSION)' 2>/dev/null | tail -1)"
fi

if [ -f "$DIR/docker/zimi-image.tar" ]; then
    if command -v docker >/dev/null; then
        echo "==> Loading the container image"
        docker load -i "$DIR/docker/zimi-image.tar"
    else
        echo "    docker not found — skipping the image (the pip install is enough)"
    fi
fi

cat <<'NEXT'

Done. Next:
  ZIM_DIR=/path/to/zims ZIMI_OFFLINE=1 python3 -m zimi serve --port 8899
See INSTALL.md for the container path and the offline settings.
NEXT
INSTALL
} > "$OUT_DIR/install.sh"
chmod +x "$OUT_DIR/install.sh"

# ---------------------------------------------------------------------------
# Instructions
# ---------------------------------------------------------------------------
cat > "$OUT_DIR/INSTALL.md" <<EOF
# Zimi $VERSION — air-gapped install bundle

Built $(date -u '+%Y-%m-%d %H:%M UTC') from \`$SOURCE\`. Nothing in here needs the internet.

## Install

\`\`\`bash
./install.sh
\`\`\`

That verifies the checksums, installs Zimi and its dependencies from \`wheels/\` with \`--no-index\` (pip never looks anything up), and loads the container image if one is bundled.

## Run

\`\`\`bash
ZIM_DIR=/path/to/zims ZIMI_OFFLINE=1 python3 -m zimi serve --port 8899
\`\`\`

\`ZIMI_OFFLINE=1\` is the single air-gap switch: no BitTorrent, no NAT probe, no catalog fetch, no update check of any kind. Set it and Zimi makes no outbound internet connection, whatever else is configured.

Container hosts instead:

\`\`\`bash
docker load -i docker/zimi-image.tar   # if this bundle carries an image
docker compose -f deploy/docker-compose.yml up -d
\`\`\`

## What is in here

| Path | |
|---|---|
| \`wheels/\` | Zimi and every dependency as wheels |
| \`deploy/\` | docker-compose and Kubernetes manifests |
| \`docker/\` | \`docker load\`-able image (only if built with \`--docker\`) |
| \`zims/\` | ZIM files ($ZIM_COUNT bundled) |
| \`SHA256SUMS\` | checksums for everything above |

## Verify by hand

\`\`\`bash
shasum -a 256 -c SHA256SUMS
\`\`\`

## Updates

An air-gapped instance never sees a new release on its own, and \`ZIMI_OFFLINE=1\` disables the check entirely. To upgrade, build a new bundle on the connected machine and run its \`install.sh\` over here. On a connected machine, \`ZIMI_UPDATE_CHANNEL\` picks which releases the check considers: \`stable\` (default, final releases only) or \`latest\` (also betas and release candidates).
EOF

# ---------------------------------------------------------------------------
# Checksums + tarball
# ---------------------------------------------------------------------------
echo "==> Writing SHA256SUMS"
(
    cd "$OUT_DIR"
    find . -type f ! -name SHA256SUMS -print0 \
        | LC_ALL=C sort -z \
        | xargs -0 shasum -a 256 \
        | sed 's|\./||' > SHA256SUMS
)

if [ "$MAKE_TAR" = "1" ]; then
    PARENT="$(dirname "$OUT_DIR")"
    BASE="$(basename "$OUT_DIR")"
    if [ "$ZIM_COUNT" -gt 0 ]; then
        # ZIMs are already compressed — gzip would burn minutes for nothing.
        TARBALL="$PARENT/$BASE.tar"
        tar -cf "$TARBALL" -C "$PARENT" "$BASE"
    else
        TARBALL="$PARENT/$BASE.tar.gz"
        tar -czf "$TARBALL" -C "$PARENT" "$BASE"
    fi
    echo "==> $TARBALL"
fi

WHEEL_COUNT="$(find "$WHEELS" -type f | wc -l | tr -d ' ')"
echo "==> Done: $WHEEL_COUNT wheels, $ZIM_COUNT ZIMs, $(du -sh "$OUT_DIR" | cut -f1) total"
echo "    $OUT_DIR"
