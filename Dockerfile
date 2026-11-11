# Zimi's image is the lean part: search, reading, the Almanac, Games, MCP and the library. Everything
# bigger and optional is an ADD-ON (zimi/addons.py) fetched once into the /config volume, under the
# Ask first / Automatically / Never setting, with its checksum checked: the browser for Create
# (Playwright + Chromium), SingleFile (Node), video (yt-dlp + ffmpeg) and warc2zim (uv + Python 3.14).
# The Dictionary's Piper and Kokoro voices install themselves into /config on the first voice download
# (zimi/voices.py). The 1.15.4 image was ~2.3 GB; CI fails this one over 1 GB compressed.
# Pinned to trixie: the Chromium libraries below are named for it (the t64 names).
FROM python:3.11-slim-trixie

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
# --only-shell: Chromium's headless build, which is all capture ever runs (no window is
# shown); the full browser was half the image.
#
# libatomic1 first: Playwright 1.65's bundled node driver links it, the slim base lacks it, and without it
# `playwright install` dies before --with-deps can add anything (exit 127, CI 2026-11-10).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
 && apt-get install -y --no-install-recommends libatomic1 \
 && pip install --no-cache-dir "playwright>=1.49" \
 && playwright install --with-deps --only-shell chromium \
 && chmod -R a+rx /ms-playwright \
 && rm -rf /var/lib/apt/lists/*

# Node, and the SingleFile CLI that needs it (AGPL, so installed here as a
# separate program Zimi calls as a subprocess, exactly as warc2zim and zimit
# already are).
#
#   single-file-cli  the reference "save this page as one file". Its output is
#                    the sturdiest capture Zimi can make: every asset a data:
#                    URI, so nothing can lazy-load, re-fetch, or fail to
#                    resolve.
#
# browsertrix-behaviors is not installed here: Zimi ships its unmodified 0.15.0
# in zimi/assets/browsertrix-behaviors/ (see THIRD_PARTY_NOTICES.md).
#
# Its own layer, before the source copy, so editing Zimi does not reinstall
# Node. Chromium comes from the Playwright layer above.
#
# From the official tarball at a pinned version, verified against the checksum
# Node publishes. The version is not arbitrary and both bounds were learned the
# hard way: Debian's own package is 20.19.2 and the SingleFile CLI refuses to
# import below 22.4.0 ("WebSocket is not available"); at 22.20.0 it imports and
# then dies mid-capture on "CloseEvent is not defined", which is a global that
# arrives in 24. 24.19.0 is the current LTS and the floor that actually works.
# Pinning also means a rebuild lands on the version that was tested rather than
# whatever is current.
ARG NODE_VERSION=24.19.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libmagic1 espeak-ng \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      fonts-liberation fonts-noto-color-emoji fonts-wqy-zenhei \
 && rm -rf /var/lib/apt/lists/*

# The user that runs the server; /config is its data folder, where the add-ons live.
RUN useradd -m -u 1000 zimi

WORKDIR /app
# Owned by zimi as it lands: a chown -R afterwards wrote the whole package again as a second layer.
COPY --chown=zimi:zimi zimi/ ./zimi/

RUN mkdir -p /config && chown zimi:zimi /app /config

# No `USER zimi`: the entrypoint starts as root for one chown of the DATA folder
# (a bind mount Docker just created is root-owned, which stopped Zimi on the
# first run under Project NOMAD, Portainer and Unraid), then drops to zimi
# before any Zimi code runs. It never touches the ZIM folder or an extra
# library folder, and `--user N` skips it entirely (nothing runs as root).
COPY docker/entrypoint.py /usr/local/bin/zimi-entrypoint
RUN chmod 755 /usr/local/bin/zimi-entrypoint
ENTRYPOINT ["python3", "/usr/local/bin/zimi-entrypoint"]

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
# The port is the one the entrypoint chose (docker/entrypoint.py PORT_FILE):
# NOMAD's command runs Zimi on kiwix-serve's 8080, not 8899.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD python3 -c "import os, urllib.request; f = '/tmp/zimi-port'; p = open(f).read().strip() if os.path.exists(f) else os.environ.get('ZIMI_PORT', '8899'); urllib.request.urlopen('http://localhost:%s/health' % p)"

CMD ["python3", "-m", "zimi", "serve", "--port", "8899"]
