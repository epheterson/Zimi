# The warc2zim SIDECAR (the alive engine's conversion step) requires Python
# >=3.14,<3.15 while the app itself must stay on 3.11 — libtorrent's wheels
# stop at cp313. Two interpreters, one image: 3.14 rides along in /opt/py314
# via a stage copy (same debian/glibc base, ABI-compatible), and the importer
# finds it as python3.14 on PATH. It exists ONLY for the sidecar venv.
FROM python:3.14-slim AS py314

FROM python:3.11-slim
COPY --from=py314 /usr/local /opt/py314
RUN ln -s /opt/py314/bin/python3.14 /usr/local/bin/python3.14 && \
    /usr/local/bin/python3.14 --version

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
