#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup.sh — production backup protocol.
#
# Takes a crash-consistent HOT backup of the SQLite database (no downtime —
# uses better-sqlite3's online backup API inside the running api container),
# plus a bundle of the deployment config (.env, compose, nginx).
#
# Usage:
#   scripts/backup.sh              # label "manual"
#   scripts/backup.sh nightly      # label used by cron / CI
#   scripts/backup.sh pre-deploy   # called automatically by deploy.sh
#
# Env:
#   BACKUP_DIR   where backups land           (default: <repo>/backups)
#   KEEP_DB      how many DB backups to keep  (default: 14)
#   KEEP_CFG     how many config bundles      (default: 7)
#   OFFSITE_DIR  if set, copies are pushed here too (e.g. a mounted rclone/
#                Backblaze path) — the offsite leg never fails the backup.
#
# Cron (nightly at 00:30 server time):
#   30 0 * * *  /opt/mchs/Website12/scripts/backup.sh nightly >> /var/log/mchs-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

LABEL="${1:-manual}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DB="${KEEP_DB:-14}"
KEEP_CFG="${KEEP_CFG:-7}"
mkdir -p "$BACKUP_DIR"

DB_NAME="mchs-$STAMP-$LABEL.db"
log() { echo "[backup $(date -u +%H:%M:%S)] $*"; }

# ── 1. database ──────────────────────────────────────────────────────────────
api_container_running() {
  command -v docker >/dev/null 2>&1 &&
    docker inspect -f '{{.State.Running}}' mchs-api 2>/dev/null | grep -q true
}

if api_container_running; then
  log "hot backup via api container (better-sqlite3 online backup)"
  docker compose exec -T api node -e '
    const Database = require("better-sqlite3");
    const dest = process.argv[1];
    const db = new Database(process.env.DATABASE_PATH);
    db.backup(dest)
      .then(() => { db.close(); console.log("wrote", dest); })
      .catch((e) => { console.error("backup failed:", e.message); process.exit(1); });
  ' "/app/data/backups/$DB_NAME"
  docker compose cp "api:/app/data/backups/$DB_NAME" "$BACKUP_DIR/$DB_NAME"
  docker compose exec -T api rm -f "/app/data/backups/$DB_NAME"
elif [[ -f api/mchs.db ]] && [[ -d api/node_modules/better-sqlite3 ]]; then
  # Bare-metal / dev fallback: back up the local database file directly.
  log "container not running — backing up api/mchs.db directly"
  ( cd api && node -e '
    const Database = require("better-sqlite3");
    const dest = process.argv[1];
    const db = new Database(process.env.DATABASE_PATH || "./mchs.db");
    db.backup(dest)
      .then(() => { db.close(); console.log("wrote", dest); })
      .catch((e) => { console.error("backup failed:", e.message); process.exit(1); });
  ' "mchs-$STAMP-$LABEL.db" )
  mv "api/mchs-$STAMP-$LABEL.db" "$BACKUP_DIR/$DB_NAME"
else
  if [[ ! -f api/mchs.db ]]; then
    log "ERROR: no running api container and no local api/mchs.db — nothing to back up"
  else
    log "ERROR: api container not running and api/node_modules missing — cannot back up api/mchs.db safely (run 'cd api && npm install', or start the stack: docker compose up -d api)"
  fi
  exit 1
fi

gzip -f "$BACKUP_DIR/$DB_NAME"
gzip -t "$BACKUP_DIR/$DB_NAME.gz"
log "db backup ok: backups/$DB_NAME.gz ($(du -h "$BACKUP_DIR/$DB_NAME.gz" | cut -f1))"

# ── 2. config bundle (secrets + infra files needed to rebuild the stack) ─────
CFG_NAME="config-$STAMP-$LABEL.tar.gz"
tar -czf "$BACKUP_DIR/$CFG_NAME" \
  --ignore-failed-read \
  api/.env docker-compose.yml nginx.conf Caddyfile 2>/dev/null || true
chmod 600 "$BACKUP_DIR/$CFG_NAME"   # contains api/.env secrets
log "config bundle ok: backups/$CFG_NAME"

# ── 3. rotation ──────────────────────────────────────────────────────────────
ls -1t "$BACKUP_DIR"/mchs-*.db.gz 2>/dev/null | tail -n +"$((KEEP_DB + 1))" | while read -r f; do
  rm -f "$f"; log "rotated out $(basename "$f")"
done
ls -1t "$BACKUP_DIR"/config-*.tar.gz 2>/dev/null | tail -n +"$((KEEP_CFG + 1))" | while read -r f; do
  rm -f "$f"; log "rotated out $(basename "$f")"
done

# ── 4. optional offsite copy ─────────────────────────────────────────────────
if [[ -n "${OFFSITE_DIR:-}" ]]; then
  if mkdir -p "$OFFSITE_DIR" 2>/dev/null; then
    cp -f "$BACKUP_DIR/$DB_NAME.gz" "$BACKUP_DIR/$CFG_NAME" "$OFFSITE_DIR/" \
      && log "offsite copy → $OFFSITE_DIR" \
      || log "WARN: offsite copy failed (backup itself is safe)"
  else
    log "WARN: OFFSITE_DIR=$OFFSITE_DIR not writable (backup itself is safe)"
  fi
fi

log "done ✅"
