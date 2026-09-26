#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pm2-reset.sh — recover from a wedged PM2 daemon.
#
# Symptoms this fixes (all caused by stale/corrupt daemon dump state after
# crash-loops or manual `node index.js` runs):
#   • [PM2][ERROR] Process with pid NNNN already exists
#   • TypeError: Cannot read properties of undefined (reading 'pm2_env')
#       at pm2/lib/API.js ... speedList        (crash inside `pm2 save`)
#   • pm2 list / jlist hangs, errors, or shows ghost "online" entries for
#     processes that no longer exist
#
# What it does:
#   1. kills the PM2 daemon (pm2 kill) — stops every PM2-managed app
#   2. wipes ~/.pm2 (dump.pm2 / dump.pm2.bak are where the corrupt state lives;
#      logs under ~/.pm2/logs belong to deleted apps and are safe to drop)
#   3. finds orphaned `api/index.js` node processes NOT started by PM2 and
#      reports them (they survive `pm2 kill` and hold port 3001 → EADDRINUSE
#      crash-loop on the next start). Pass --kill-orphans to terminate them.
#   4. restarts the ecosystem apps fresh and saves the new process list
#
# Usage:
#   scripts/pm2-reset.sh                  # reset + restart + pm2 save
#   scripts/pm2-reset.sh --kill-orphans   # also kill stray api processes
#   SKIP_START=1 scripts/pm2-reset.sh     # only clean the daemon, don't start
#
# NOTE: `pm2 kill` does NOT touch Docker containers. If the compose stack's
# mchs-api container is running, it owns :3001 — pick one runtime (see
# PM2_SETUP.md "EADDRINUSE").
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

KILL_ORPHANS=0
[[ "${1:-}" == "--kill-orphans" ]] && KILL_ORPHANS=1

ok()   { echo -e "\033[1;32m[pm2-reset]\033[0m $*"; }
warn() { echo -e "\033[1;33m[pm2-reset]\033[0m $*"; }
die()  { echo -e "\033[1;31m[pm2-reset]\033[0m $*" >&2; exit 1; }

command -v pm2 >/dev/null 2>&1 || die "pm2 not found — run: npm install -g pm2"
[[ -f ecosystem.config.cjs ]] || die "ecosystem.config.cjs not found in $APP_DIR"

# ── 1. kill the daemon (best-effort; it may be the thing that's broken) ──────
if pgrep -f "PM2" >/dev/null 2>&1 || [[ -d "$HOME/.pm2" ]]; then
  ok "stopping PM2 daemon…"
  # timeout guard: a wedged daemon can make `pm2 kill` hang forever too
  timeout 30 pm2 kill >/dev/null 2>&1 || warn "pm2 kill failed/hung — continuing with manual cleanup"
fi

# ── 2. wipe corrupt daemon state ─────────────────────────────────────────────
if [[ -d "$HOME/.pm2" ]]; then
  ok "removing stale daemon state: $HOME/.pm2"
  rm -rf "$HOME/.pm2"
fi

# ── 3. report (and optionally kill) orphaned API processes ───────────────────
# Anything running our entrypoint that survived `pm2 kill` was NOT started by
# PM2 (manual `node index.js`, nohup, an old systemd unit, …).
ORPHANS=$(pgrep -af "node .*api/index\.js|node index\.js" 2>/dev/null || true)
if [[ -n "$ORPHANS" ]]; then
  warn "orphaned API processes still running (they will hold :3001):"
  echo "$ORPHANS" | sed 's/^/    /'
  if [[ "$KILL_ORPHANS" == 1 ]]; then
    pkill -f "node .*api/index\.js|node index\.js" && ok "orphans killed"
    sleep 1
  else
    warn "re-run with --kill-orphans to terminate them automatically,"
    warn "or kill them by hand before starting (else: EADDRINUSE crash-loop)."
  fi
fi

# ── 4. fresh start + persist ─────────────────────────────────────────────────
if [[ "${SKIP_START:-0}" == 1 ]]; then
  ok "SKIP_START=1 — daemon cleaned. Start later with: pm2 start ecosystem.config.cjs"
  exit 0
fi

mkdir -p api/logs
ok "starting ecosystem apps…"
pm2 start ecosystem.config.cjs
sleep 2
pm2 save
ok "done. Verify with:"
echo "    pm2 list"
echo "    pm2 logs mchs-api --lines 20"
echo "    curl -s http://localhost:${PORT:-3001}/health"
