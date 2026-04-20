#!/usr/bin/env bash
# Alchemy one-click: build → kill old → start dashboard + webhook + tunnel
# Dashboard and webhook auto-restart on crash (max 50 restarts, 3s backoff).
set -e

cd "$(dirname "$0")"

echo "==> Building..."
npm run build
cp -f src/dashboard/public/* dist/dashboard/public/

echo "==> Stopping old processes..."
pkill -f "node dist/cli/index.js dashboard" 2>/dev/null || true
pkill -f "node dist/cli/index.js webhook"   2>/dev/null || true
pkill -f "alchemy-watchdog"                 2>/dev/null || true
pkill -f "cloudflared tunnel run"           2>/dev/null || true
sleep 2

# Read config values
TUNNEL_TOKEN=$(node -e "
const fs = require('fs');
const yaml = require('yaml');
const cfg = yaml.parse(fs.readFileSync('alchemy.config.yaml','utf8'));
process.stdout.write(cfg.tunnel?.token || '');
")

DASH_PORT=$(node -e "
const fs = require('fs');
const yaml = require('yaml');
const cfg = yaml.parse(fs.readFileSync('alchemy.config.yaml','utf8'));
process.stdout.write(String(cfg.dashboard?.port || 3456));
")

WEBHOOK_PORT=$(node -e "
const fs = require('fs');
const yaml = require('yaml');
const cfg = yaml.parse(fs.readFileSync('alchemy.config.yaml','utf8'));
process.stdout.write(String(cfg.webhook?.port || 3457));
")

PROJECT_DIR="$(pwd)"

# ── Watchdog wrapper: restarts a command on crash ──
# Usage: watchdog <name> <logfile> <command...>
# Runs in background, restarts up to MAX_RESTARTS times with BACKOFF_SEC delay.
watchdog() {
  local name="$1" logfile="$2"; shift 2
  local max_restarts=50 backoff=3 count=0

  while true; do
    echo "[$(date -Iseconds)] watchdog($name): starting (restart #$count)" >> "$logfile"
    cd "$PROJECT_DIR"
    "$@" >> "$logfile" 2>&1
    exit_code=$?
    echo "[$(date -Iseconds)] watchdog($name): exited with code $exit_code" >> "$logfile"

    count=$((count + 1))
    if [ "$count" -ge "$max_restarts" ]; then
      echo "[$(date -Iseconds)] watchdog($name): max restarts ($max_restarts) reached, giving up" >> "$logfile"
      break
    fi
    sleep "$backoff"
  done
}

echo "==> Starting dashboard on :${DASH_PORT} (with watchdog)..."
watchdog alchemy-dashboard /tmp/alchemy-dashboard.log \
  node dist/cli/index.js dashboard --port "$DASH_PORT" &
disown

echo "==> Starting webhook on :${WEBHOOK_PORT} (with watchdog)..."
watchdog alchemy-webhook /tmp/alchemy-webhook.log \
  node dist/cli/index.js webhook --port "$WEBHOOK_PORT" &
disown

if [ -n "$TUNNEL_TOKEN" ]; then
  echo "==> Starting Cloudflare tunnel..."
  cloudflared tunnel run --token "$TUNNEL_TOKEN" >> /tmp/cloudflared-tunnel.log 2>&1 &
  disown
  echo "    Tunnel started."
else
  echo "    No tunnel token in config, skipping."
fi

sleep 4

# Verify
DASH_PID=$(pgrep -f "dashboard.*${DASH_PORT}" | head -1 || true)
WEBHOOK_PID=$(pgrep -f "webhook.*${WEBHOOK_PORT}" | head -1 || true)
TUNNEL_PID=$(pgrep -f "cloudflared tunnel run" || true)

echo ""
echo "==> Status:"
[ -n "$DASH_PID" ]    && echo "    ✓ Dashboard  pid=${DASH_PID}" || echo "    ✗ Dashboard failed"
[ -n "$WEBHOOK_PID" ] && echo "    ✓ Webhook    pid=${WEBHOOK_PID}" || echo "    ✗ Webhook failed"
[ -n "$TUNNEL_PID" ]  && echo "    ✓ Tunnel     pid=${TUNNEL_PID}" || echo "    ✗ Tunnel not running"
echo ""
echo "Done. Processes auto-restart on crash (max 50 restarts, 3s backoff)."
