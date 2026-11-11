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

# What the add-ons need from the system, which cannot be apt-installed at runtime (the server runs as
# the unprivileged `zimi`): the shared libraries and fonts of Playwright's headless Chromium (its
# `--with-deps` list for debian13, minus xvfb and the fonts a headless shell never draws), libmagic1
# (warc2zim's python-magic), espeak-ng (the Dictionary's voice with no download), ca-certificates
# (add-on downloads over https). About 120 MB unpacked; the browser itself (285 MB) is the add-on.
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
