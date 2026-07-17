#!/usr/bin/env bash
# Smoke test a built Zimi binary: launch it, wait for READY, hit the core
# endpoints. Usage: ci/smoke_binary.sh <path-to-binary>
#
# The LAUNCH is retried (3 attempts x 60s): fresh CI runner images sometimes
# take a long time to cold-start a PyInstaller bundle — a 30s single-shot
# wait failed the v1.7.1 Apple Silicon release build on a healthy binary.
# Endpoint checks are NOT retried: once the server answers READY, a failing
# endpoint is a real bug, not runner weather.
set -euo pipefail

BINARY="$1"
ATTEMPTS="${SMOKE_ATTEMPTS:-3}"
READY_TIMEOUT="${SMOKE_READY_TIMEOUT:-60}"
LOG=$(mktemp)
PID=""

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
}
trap cleanup EXIT

PORT=""
for attempt in $(seq 1 "$ATTEMPTS"); do
  TMPZIM=$(mktemp -d)
  : > "$LOG"
  echo "Attempt $attempt/$ATTEMPTS: starting $BINARY --serve --port 0 ..."
  "$BINARY" --serve --port 0 --zim-dir "$TMPZIM" > "$LOG" 2>&1 &
  PID=$!

  deadline=$(( SECONDS + READY_TIMEOUT ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if PORT=$(awk '/^READY /{print $2; exit}' "$LOG") && [ -n "$PORT" ]; then
      break 2
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "Binary exited before READY (attempt $attempt)."
      break
    fi
    sleep 0.5
  done

  echo "No READY within ${READY_TIMEOUT}s (attempt $attempt). Log:"
  cat "$LOG"
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  PID=""
  rm -rf "$TMPZIM"
done

if [ -z "$PORT" ]; then
  echo "ERROR: Server did not start after $ATTEMPTS attempts"
  exit 1
fi

echo "Server ready on port $PORT"
BASE="http://127.0.0.1:$PORT"
# setup-python exposes `python` on CI; bare macOS/Linux boxes may only have python3
PY=$(command -v python || command -v python3)

echo "Testing /health..."
curl -sf "$BASE/health" | "$PY" -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok', f'Bad health: {d}'; print(f'  OK: v{d[\"version\"]}, {d[\"zim_count\"]} ZIMs')"

echo "Testing /list..."
curl -sf "$BASE/list" | "$PY" -c "import sys,json; d=json.load(sys.stdin); print(f'  OK: {len(d)} sources')"

echo "Testing /search..."
curl -sf "$BASE/search?q=test&limit=1&fast=1" | "$PY" -c "import sys,json; d=json.load(sys.stdin); assert 'results' in d; print(f'  OK: {d[\"total\"]} results')"

echo "Testing /static/pdfjs/web/viewer.html..."
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/static/pdfjs/web/viewer.html")
[ "$STATUS" = "200" ] && echo "  OK: pdf.js viewer" || { echo "FAIL: got $STATUS"; exit 1; }

echo "Testing /manage/status..."
curl -sf -H "Sec-Fetch-Site: same-origin" "$BASE/manage/status" | "$PY" -c "import sys,json; d=json.load(sys.stdin); assert 'zim_count' in d; print(f'  OK: {d[\"zim_count\"]} ZIMs, manage={d[\"manage_enabled\"]}')"

echo "Testing / (web UI)..."
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
[ "$STATUS" = "200" ] && echo "  OK: web UI" || { echo "FAIL: got $STATUS"; exit 1; }

if [ "${SMOKE_EXPECT_BT:-}" = "1" ]; then
  # The sidecar starts on a background thread after READY. "status":"ready"
  # alone is optimistic (binary present counts) — demand PROOF the spawn
  # happened: sidecar_running is true only when the process is up and
  # answered RPC. This caught a bundled aria2c that died instantly on
  # OpenSSL provider loading. (An idle aria2 doesn't open its BT listen
  # socket, so nat.listening can't be the gate.)
  echo "Testing /manage/bt-status (bundled aria2 must actually spawn)..."
  BT_OK=""
  for i in $(seq 1 45); do
    body=$(curl -sf -H "Sec-Fetch-Site: same-origin" "$BASE/manage/bt-status")
    if echo "$body" | grep -q '"sidecar_running": *true'; then
      BT_OK=1; break
    fi
    sleep 1
  done
  if [ -n "$BT_OK" ]; then
    echo "  OK: bundled aria2c is alive and listening on the BT port"
  else
    echo "FAIL: aria2c never came up (status below). Sidecar stderr is in the server log above."
    curl -s -H "Sec-Fetch-Site: same-origin" "$BASE/manage/bt-status"
    echo
    cat "$LOG"
    exit 1
  fi
fi

echo "All smoke tests passed!"
