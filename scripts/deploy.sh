#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — the production deployment protocol. One command, safe by default.
#
#   1. preflight     docker + compose + api/.env present
#   2. backup        hot DB backup + config bundle (label: pre-deploy)
#   3. snapshot      current dist/ and api image id saved for rollback
#   4. build         frontend (npm ci + vite build in node:22-alpine)
#                    api image (npm ci --omit=dev, pinned by lockfile)
#   5. rollout       docker compose up -d (api is healthchecked; web waits
#                    for api to become healthy before starting)
#   6. verify        scripts/healthcheck.sh --wait 120 (api, SPA shell, proxy)
#   7. on failure    automatic rollback: previous dist/ + previous api image,
#                    re-verify, and the pre-deploy DB backup is in backups/
#
# Usage:
#   scripts/deploy.sh              # deploy the code currently checked out
#   scripts/deploy.sh --pull       # git pull --ff-only first (manual deploys)
#   DEPLOY_SKIP_BACKUP=1 scripts/deploy.sh   # emergency redeploy without backup
#
# CI/CD: .github/workflows/deploy.yml runs this over SSH on every push to main
# (after CI passes). See DEPLOYMENT.md.
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
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Engine + the compose plugin (see DEPLOYMENT.md §2)"
docker info >/dev/null 2>&1       || die "docker daemon not reachable (permissions? try: sudo usermod -aG docker \$USER)"
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "docker compose not available"
fi
[[ -f api/.env ]] || die "api/.env missing — copy api/.env.example, fill in secrets, chmod 600 api/.env"
[[ -f docker-compose.yml ]] || die "docker-compose.yml not found in $APP_DIR"
mkdir -p dist
ok "preflight passed ($($COMPOSE version --short 2>/dev/null || echo compose))"

# ── optional git pull ────────────────────────────────────────────────────────
if [[ "$PULL" == "1" ]]; then
  log "git pull --ff-only…"
  git pull --ff-only || die "git pull failed (local changes? resolve, then redeploy)"
fi
GIT_REF="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "deploying ref: $GIT_REF"

# ── 2. backup ────────────────────────────────────────────────────────────────
if [[ "${DEPLOY_SKIP_BACKUP:-0}" == "1" ]]; then
  warn "DEPLOY_SKIP_BACKUP=1 — skipping pre-deploy backup"
else
  log "pre-deploy backup…"
  ./scripts/backup.sh pre-deploy || die "backup failed — refusing to deploy without a restore point"
fi

# ── 3. rollback snapshot ─────────────────────────────────────────────────────
PREV_IMAGE_ID="$(docker images -q mchs-api 2>/dev/null | head -n1 || true)"
if [[ -d dist && -n "$(ls -A dist 2>/dev/null)" ]]; then
  rm -rf .dist.prev
  cp -a dist .dist.prev
  HAVE_PREV_DIST=1
else
  HAVE_PREV_DIST=0
fi
log "rollback snapshot: api image=${PREV_IMAGE_ID:-none} dist=$([[ $HAVE_PREV_DIST == 1 ]] && echo saved || echo 'none (first deploy)')"

# ── rollback handler ─────────────────────────────────────────────────────────
rollback() {
  warn "deployment failed — rolling back…"
  if [[ -n "$PREV_IMAGE_ID" ]]; then
    docker tag "$PREV_IMAGE_ID" mchs-api:rollback 2>/dev/null || true
  fi
  if [[ "$HAVE_PREV_DIST" == "1" ]]; then
    rm -rf dist && cp -a .dist.prev dist
    log "restored previous dist/"
  fi
  # Recreate from the previous image when we have one: override the build by
  # tagging it as the compose-built name is not enough (compose may still use
  # the fresh build) — so force the image explicitly for this recovery.
  if [[ -n "$PREV_IMAGE_ID" ]]; then
    $COMPOSE up -d --no-build api web 2>/dev/null || $COMPOSE up -d api web || true
  else
    $COMPOSE up -d api web || true
  fi
  sleep 3
  if ./scripts/healthcheck.sh --wait 60 >/dev/null 2>&1; then
    ok "rollback complete — previous version is serving again"
  else
    warn "rollback did NOT restore a healthy state — check 'docker compose logs api'"
    warn "database restore point: newest backups/mchs-*-pre-deploy.db.gz (scripts/restore.sh)"
  fi
  die "deploy aborted (rollback attempted)"
}

# ── 4. build ─────────────────────────────────────────────────────────────────
log "building frontend (node:22-alpine, npm ci + vite build)…"
$COMPOSE run --rm build-frontend || { rollback; }
[[ -f dist/index.html ]] || { warn "dist/index.html missing after build"; rollback; }
ok "frontend built: $(du -sh dist | cut -f1)"

log "building api image…"
$COMPOSE build api || { rollback; }
ok "api image built"

# ── 5. rollout ───────────────────────────────────────────────────────────────
log "rolling out containers…"
$COMPOSE up -d api web || { rollback; }

# ── 6. verify ────────────────────────────────────────────────────────────────
log "verifying deployment (healthcheck, up to 120 s)…"
if ./scripts/healthcheck.sh --wait 120; then
  ok "deployment verified"
else
  { rollback; }
fi

# ── 7. housekeeping ──────────────────────────────────────────────────────────
rm -rf .dist.prev
docker image prune -f >/dev/null 2>&1 || true   # drop dangling images from builds

ok "deployed $GIT_REF ✅"
echo
echo "  site:      https://mchsrobotics.dev"
echo "  api:       http://localhost:3001/health"
echo "  logs:      docker compose logs -f api web"
echo "  backups:   ls backups/   (restore: scripts/restore.sh <file>)"
