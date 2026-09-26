#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pm2-deploy.sh — one-command deploy for the PM2 (bare-metal) runtime.
# The Docker path is scripts/deploy.sh; pick ONE runtime, never both.
#
#   1. preflight     node + pm2 present, api/.env exists, ecosystem file found
#   2. pull          git pull --ff-only            (--pull flag only)
#   3. backup        hot DB backup via scripts/backup.sh (pre-deploy label)
#   4. install       npm ci (root + api) when package files changed
#   5. build         vite production build → dist/ (nginx serves it)
#   6. reload        pm2 reload mchs-api (graceful; zero-downtime restart)
#   7. verify        scripts/healthcheck.sh --wait 60 (API :3001/health)
#   8. on failure    pm2 logs tail + exit non-zero (rollback: see below)
#
# Usage:
#   scripts/pm2-deploy.sh            # deploy current checkout
#   scripts/pm2-deploy.sh --pull     # git pull first
#   SKIP_BACKUP=1 scripts/pm2-deploy.sh          # emergency redeploy
#   SKIP_BUILD=1  scripts/pm2-deploy.sh          # backend-only change
#
# Rollback: `pm2 reload` keeps the previous process alive until the new one
# passes its startup listen() — if a bad version crash-loops, fix forward or:
#   git checkout <good-ref> && scripts/pm2-deploy.sh --skip-backup
# DB restore point: newest backups/mchs-*-pre-deploy.db.gz → scripts/restore.sh
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PULL=0
[[ "${1:-}" == "--pull" ]] && PULL=1

ts()   { date -u +%H:%M:%S; }
log()  { echo -e "\033[1;34m[deploy $(ts)]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[deploy $(ts)]\033[0m $*"; }
warn() { echo -e "\033[1;33m[deploy $(ts)]\033[0m $*"; }
die()  { echo -e "\033[1;31m[deploy $(ts)]\033[0m $*" >&2; exit 1; }

# ── 1. preflight ─────────────────────────────────────────────────────────────
log "preflight…"
command -v node >/dev/null 2>&1 || die "node not found — install Node 22 LTS"
command -v pm2  >/dev/null 2>&1 || die "pm2 not found — run: npm install -g pm2"
[[ -f api/.env ]] || die "api/.env missing — copy api/.env.example, fill secrets, chmod 600"
[[ -f ecosystem.config.cjs ]] || die "ecosystem.config.cjs not found in $APP_DIR"
mkdir -p api/logs
ok "node $(node -v), pm2 $(pm2 -v)"

# ── 2. optional git pull ─────────────────────────────────────────────────────
if [[ "$PULL" == 1 ]]; then
  log "git pull --ff-only…"
  git pull --ff-only || die "git pull failed (local changes? resolve first)"
fi
GIT_REF="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "deploying ref: $GIT_REF"

# ── 3. backup ────────────────────────────────────────────────────────────────
if [[ "${SKIP_BACKUP:-0}" == 1 ]]; then
  warn "SKIP_BACKUP=1 — no pre-deploy backup taken"
elif [[ -x ./scripts/backup.sh ]]; then
  log "pre-deploy DB backup…"
  ./scripts/backup.sh pre-deploy || die "backup failed — refusing to deploy without a restore point"
else
  warn "scripts/backup.sh not executable — skipping backup (chmod +x scripts/*.sh)"
fi

# ── 4. install deps (only when lockfiles/package.json changed) ───────────────
NEED_INSTALL=0
[[ -d node_modules || -d api/node_modules ]] || NEED_INSTALL=1
if git rev-parse HEAD@{1} >/dev/null 2>&1; then
  CHANGED="$(git diff --name-only HEAD@{1} HEAD 2>/dev/null || true)"
  echo "$CHANGED" | grep -qE 'package(-lock)?\.json$' && NEED_INSTALL=1
fi
if [[ "$NEED_INSTALL" == 1 ]]; then
  log "npm ci (root)…"        ; npm ci --no-audit --no-fund
  log "npm ci (api)…"         ; (cd api && npm ci --omit=dev --no-audit --no-fund)
else
  ok "dependencies unchanged — skipping install"
fi

# ── 5. build frontend ────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD:-0}" == 1 ]]; then
  warn "SKIP_BUILD=1 — not rebuilding dist/ (backend-only deploy)"
else
  log "building frontend (vite)…"
  npm run build
  [[ -f dist/index.html ]] || die "dist/index.html missing after build"
  ok "frontend built: $(du -sh dist | cut -f1)"
fi

# ── 6. pm2 reload (graceful) ─────────────────────────────────────────────────
if pm2 describe mchs-api >/dev/null 2>&1; then
  log "pm2 reload mchs-api…"
  pm2 reload mchs-api --update-env
else
  log "mchs-api not registered — pm2 start ecosystem.config.cjs…"
  pm2 start ecosystem.config.cjs
fi
sleep 2

# ── 7. verify ────────────────────────────────────────────────────────────────
log "verifying (healthcheck, up to 60 s)…"
if WEB_URL="$WEB_URL" ./scripts/healthcheck.sh --wait 60; then
  ok "deployment verified ✅"
else
  warn "healthcheck FAILED — last 30 log lines:"
  pm2 logs mchs-api --lines 30 --nostream || true
  die "deploy aborted — fix forward (git revert) then re-run; DB restore: scripts/restore.sh"
fi

# ── 8. housekeeping ──────────────────────────────────────────────────────────
pm2 save --force >/dev/null 2>&1 || warn "pm2 save failed (permissions?)"

echo
ok "deployed $GIT_REF via PM2"
echo "  status:    pm2 list"
echo "  logs:      pm2 logs mchs-api"
echo "  api:       http://localhost:${PORT:-3001}/health"
echo "  backups:   ls backups/   (restore: scripts/restore.sh <file>)"
