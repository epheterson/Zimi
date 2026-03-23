FROM python:3.11-slim

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8899/health')"

CMD ["python3", "-m", "zimi", "serve", "--port", "8899"]
