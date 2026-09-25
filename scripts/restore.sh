#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore.sh — restore protocol for the SQLite database.
#
# Restores a backup over the LIVE database using better-sqlite3's online
# backup API (same mechanism as backup.sh, reversed), then restarts the api
# container so every connection/session state is rebuilt from the restored
# data. A safety backup of the current database is taken first, always.
#
# Usage:
#   scripts/restore.sh backups/mchs-20260914-003001-nightly.db.gz
#   scripts/restore.sh /path/to/backup.db            # uncompressed also works
#   scripts/restore.sh <file> --force                # skip the confirmation
#
# Bare metal (no docker): falls back to running node inside api/ against
# JarvisData/database/mchs.db — stop your api process first in that case.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
# JarvisData lives OUTSIDE the repo, as a sibling directory (~/JarvisData).
DATA_DIR="${DATA_DIR:-$APP_DIR/../JarvisData/database}"

SRC="${1:-}"
FORCE="${2:-}"
log() { echo "[restore $(date -u +%H:%M:%S)] $*"; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }

[[ -n "$SRC" ]] || die "usage: scripts/restore.sh <backup.db.gz|backup.db> [--force]"
[[ -f "$SRC" ]] || die "backup file not found: $SRC"

api_running() { command -v docker >/dev/null 2>&1 && docker inspect -f '{{.State.Running}}' mchs-api 2>/dev/null | grep -q true; }

# ── confirm ──────────────────────────────────────────────────────────────────
if [[ "$FORCE" != "--force" ]]; then
  echo "This will OVERWRITE the live database with: $SRC"
  echo "(a safety backup of the current database is taken first)"
  read -r -p "Type 'yes' to continue: " answer
  [[ "$answer" == "yes" ]] || die "aborted"
fi

# ── decompress if needed ─────────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
case "$SRC" in
  *.gz) gunzip -c "$SRC" > "$WORK/restore.db" ;;
  *)    cp "$SRC" "$WORK/restore.db" ;;
esac

# sanity: is it really a SQLite database?
head -c 16 "$WORK/restore.db" | grep -q "SQLite format 3" || die "not a SQLite database file"
log "backup verified ($(du -h "$WORK/restore.db" | cut -f1))"

# ── safety backup of current state ───────────────────────────────────────────
log "taking safety backup of the current database…"
./scripts/backup.sh pre-restore >/dev/null
log "safety backup saved under backups/ (label: pre-restore)"

# ── restore ──────────────────────────────────────────────────────────────────
if api_running; then
  docker compose cp "$WORK/restore.db" api:/app/data/restore-tmp.db
  docker compose exec -T api node -e '
    const Database = require("better-sqlite3");
    const src = new Database("/app/data/restore-tmp.db", { readonly: true });
    src.backup(process.env.DATABASE_PATH)
      .then(() => { src.close(); console.log("restored over", process.env.DATABASE_PATH); })
      .catch((e) => { console.error("restore failed:", e.message); process.exit(1); });
  '
  docker compose exec -T api rm -f /app/data/restore-tmp.db
  log "restarting api so all state comes from the restored database…"
  docker compose restart api
  sleep 2
  ./scripts/healthcheck.sh --wait 60 || die "healthcheck failed after restore — the pre-restore safety backup is in backups/"
else
  [[ -d api/node_modules/better-sqlite3 ]] || die "api container not running and api/node_modules missing — cannot restore"
  log "bare-metal restore into $DATA_DIR/mchs.db (make sure your api process is STOPPED)"
  mkdir -p "$DATA_DIR"
  ( cd api && node -e '
    const Database = require("better-sqlite3");
    const fs = require("fs");
    const src = new Database(fs.realpathSync(process.argv[1]), { readonly: true });
    const dest = process.env.DATABASE_PATH || process.argv[2];
    src.backup(dest)
      .then(() => { src.close(); console.log("restored over", dest); })
      .catch((e) => { console.error("restore failed:", e.message); process.exit(1); });
  ' "$WORK/restore.db" "$DATA_DIR/mchs.db" )
  rm -f "$DATA_DIR"/mchs.db-wal "$DATA_DIR"/mchs.db-shm
fi

log "done ✅ — spot-check the site, then verify the member list in the Admin panel"
