# The warc2zim SIDECAR (the alive engine's conversion step) requires Python
# >=3.14,<3.15 while the app itself must stay on 3.11 — libtorrent's wheels
# stop at cp313. Two interpreters, one image: 3.14 rides along in /opt/py314
# via a stage copy (same debian/glibc base, ABI-compatible), and the importer
# finds it as python3.14 on PATH. It exists ONLY for the sidecar venv.
FROM python:3.14-slim AS py314

FROM python:3.11-slim
COPY --from=py314 /usr/local /opt/py314
# END of PATH, never a symlink: a venv records its creating interpreter's
# directory as `home`, and a symlink in /usr/local/bin would point that at a
# directory with no 3.14 stdlib — every venv python then dies at 'encodings'.
# Appending keeps python3 = 3.11 (the app) while python3.14 resolves to the
# real binary, whose venvs find their stdlib where it actually is.
ENV PATH="${PATH}:/opt/py314/bin"
RUN python3.14 --version && python3 --version

COPY requirements.txt .
# requirements.txt pins libtorrent 2.0 (the in-process BT engine, ON by
# default). The manylinux wheel — cp311 for both amd64 and aarch64 (Synology
# and other ARM NAS) — resolves cleanly on this python:3.11-slim/glibc base, so
# no apt/dist-packages games and no separate install step.
RUN pip install --no-cache-dir -r requirements.txt

# The rendered capture engine: Playwright plus a real headless Chromium, run as
# a CHILD PROCESS of the server — never a second container, and never through a
# docker socket. It is its own layer, before the source is copied, so editing
# Zimi's code does not re-download a browser; it costs roughly 400MB in the
# image, which is the price of capturing pages that build themselves in
# JavaScript.
#
# PLAYWRIGHT_BROWSERS_PATH matters: the default install location is the
# INSTALLING user's home (root's), and this container runs as `zimi`. A
# world-readable path is what makes the browser findable at runtime.
#
# --with-deps is the apt half — the fonts and shared libraries Chromium needs
# on a slim base. Inside the container Chromium cannot use its own sandbox
# (Docker's seccomp profile blocks the user namespaces it needs); the renderer
# detects that and steps down for exactly that launch, saying so in the log.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pip install --no-cache-dir "playwright>=1.40" \
 && playwright install --with-deps chromium \
 && chmod -R a+rx /ms-playwright \
 && rm -rf /var/lib/apt/lists/*

# Node, and the two capture tools that need it. Both are AGPL and neither is
# vendored: they are installed here as separate programs the image happens to
# carry, exactly as warc2zim (GPL) and zimit (GPL) already are, and Zimi calls
# them as subprocesses or reads a file they left on disk.
#
#   single-file-cli        the reference "save this page as one file". Its
#                          output is the sturdiest capture Zimi can make —
#                          every asset a data: URI, so nothing can lazy-load,
#                          re-fetch, or fail to resolve.
#   browsertrix-behaviors  Webrecorder's catalogue of per-site scroll/expand
#                          behaviour. Zimi reads dist/behaviors.js and injects
#                          it; without it the engines fall back to a plain
#                          scroll, which is why this layer is optional in
#                          principle even though the image carries it.
#
# Its own layer, before the source copy, so editing Zimi does not reinstall
# Node. Chromium comes from the Playwright layer above and serves both.
# Node, and the two capture tools that need it.
#
# From the official tarball at a pinned version, verified against the checksum
# Node publishes. Debian's own package is 20.19.2 and the SingleFile CLI needs
# >= 22.4.0 for WebSocket — it exits at import otherwise, saying so only in a
# stack trace. Pinning also means a rebuild lands on the version that was
# tested rather than whatever is current.
ARG NODE_VERSION=22.20.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    base="https://nodejs.org/dist/v${NODE_VERSION}"; \
    curl -fsSLO "${base}/${tarball}"; \
    curl -fsSL "${base}/SHASUMS256.txt" -o SHASUMS256.txt; \
    grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "${tarball}" -C /usr/local --strip-components=1 \
        --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
    rm -f "${tarball}" SHASUMS256.txt; \
    node --version; \
    npm install -g single-file-cli browsertrix-behaviors; \
    npm cache clean --force

# yt-dlp is the video engine, and in the image it is not optional. It is a soft
# dependency in the package — a laptop install of Zimi that never captures a
# video should not carry it — but the Create page in THIS container offers
# "Video" as a mode, and a mode the server cannot honour is a form that lies.
# Absent, every video capture died with "yt-dlp is not installed"; a few
# megabytes of pure Python is the whole cost of the offer being true. Its own
# layer, and the last of the dependency layers, because it is also the one that
# will be bumped most often: extractors break when sites change.
RUN pip install --no-cache-dir "yt-dlp>=2024.1.1"

# libmagic1 is the warc2zim sidecar's one system dependency (python-magic
# binds it at import). Without it every WARC conversion — the alive engine's
# exit — dies before reading a byte. Its own layer, after the browser layer,
# so it never invalidates the 400MB Chromium download above.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libmagic1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY zimi/ ./zimi/

RUN useradd -m -u 1000 zimi && mkdir -p /config && chown -R zimi:zimi /app /config
USER zimi

ENV ZIM_DIR=/zims
ENV ZIMI_DATA_DIR=/config
ENV ZIMI_MANAGE=1
EXPOSE 8899

# BT inbound port — only used when ZIMI_TORRENT=1. Compose users can map it
# to enable WAN seeding; LAN seeding works either way.
EXPOSE 6881/tcp
EXPOSE 6881/udp

# start-period=10m: first cold start may build SQLite title indexes from scratch
# for every ZIM (Wikipedia EN can take 5+ min on a fragile host). Without a long
# enough grace period the orchestrator marks the container unhealthy and may
# crash-loop, restarting the same expensive build over and over.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8899/health')"

CMD ["python3", "-m", "zimi", "serve", "--port", "8899"]
