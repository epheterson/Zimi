#!/usr/bin/env bash
# Smoke test the portable headless build as a person would use it from a USB stick:
#   ci/smoke_portable.sh <unpacked-folder> [path-to-a-test.zim]
# Copies the folder to a fresh "stick" with a zimi-data and a zims folder beside the executable, then:
# `serve -d` answers /health with the ZIM, leaves zimi.pid and zimi.log in zimi-data, writes its state there
# and nowhere else, `doctor --check` passes, `service print` points at this executable, and stopping it
# removes the pid file.
set -euo pipefail

SRC="$(cd "$1" && pwd)"
TESTZIM="${2:-}"
PORT="${SMOKE_PORT:-18899}"
STICK=$(mktemp -d)
DATA="$STICK/zimi/zimi-data"
trap 'if [ -f "$DATA/zimi.pid" ]; then kill "$(cat "$DATA/zimi.pid")" 2>/dev/null || true; fi; rm -rf "$STICK"' EXIT

cp -R "$SRC" "$STICK/zimi"
mkdir "$DATA" "$STICK/zimi/zims"
if [ -n "$TESTZIM" ]; then cp "$TESTZIM" "$STICK/zimi/zims/"; fi
Z="$STICK/zimi/zimi"
export ZIMI_TORRENT=0 ZIMI_OFFLINE=1 HOME="$STICK/home"
mkdir "$HOME"

echo "zimi config (the portable folder decides the paths)..."
"$Z" config | tee "$STICK/config.txt"
grep -q "portable" "$STICK/config.txt" || { echo "FAIL: config does not show the portable folder"; exit 1; }

echo "zimi doctor --check..."
"$Z" doctor --check

echo "zimi service print (ExecStart must be this executable)..."
"$Z" service print | tee "$STICK/unit.txt"
grep -q "^ExecStart=$STICK/zimi/zimi serve" "$STICK/unit.txt" || { echo "FAIL: ExecStart is not the executable"; exit 1; }

echo "zimi serve -d on port $PORT..."
"$Z" serve -d --host 127.0.0.1 --port "$PORT"
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/health" > "$STICK/health.json"; then break; fi
  sleep 1
done
cat "$STICK/health.json"; echo
grep -q '"status": *"ok"' "$STICK/health.json" || { echo "FAIL: /health not ok"; cat "$DATA/zimi.log"; exit 1; }
if [ -n "$TESTZIM" ]; then
  curl -sf "http://127.0.0.1:$PORT/list" | grep -q "smoke" || { echo "FAIL: the test ZIM is not listed"; exit 1; }
fi
test -s "$DATA/zimi.pid" || { echo "FAIL: no zimi.pid in zimi-data"; exit 1; }
test -e "$DATA/zimi.log" || { echo "FAIL: no zimi.log in zimi-data"; exit 1; }
ls -la "$DATA"
# Settings live on the stick: nothing of Zimi's in the home directory.
if [ -n "$(find "$HOME" -mindepth 1 -print -quit)" ]; then echo "FAIL: state written outside the stick:"; find "$HOME"; exit 1; fi

PID=$(cat "$DATA/zimi.pid")
kill "$PID"
for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then echo "FAIL: pid $PID did not stop"; exit 1; fi
test ! -e "$DATA/zimi.pid" || { echo "FAIL: pid file left behind"; exit 1; }
echo "Portable smoke passed."
