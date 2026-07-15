FROM python:3.11-slim

# aria2c bundled for the optional BT/torrent download path (ZIMI_TORRENT=1).
# Off by default — HTTP downloads work without it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      aria2 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

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
