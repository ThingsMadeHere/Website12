#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# set-admin.sh — grant/revoke admin directly in the database.
#
# Bootstrap helper: on a fresh production server there is no admin yet and the
# Admin panel requires one (chicken-and-egg). Run this once on the server:
#
#   scripts/set-admin.sh carterherrault        # grant admin
#   scripts/set-admin.sh carterherrault off    # revoke admin
#
# Keeps users.admin and the 'admin' role tag in sync (same invariant the API
# enforces). Works against the docker container, or bare-metal api/mchs.db.
# Note: usernames listed in api/db.js ADMIN_USERNAMES are re-promoted on every
# server start — remove them there if a revocation should stick.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

USERNAME="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')"
MODE="${2:-on}"
[[ -n "$USERNAME" ]] || { echo "usage: scripts/set-admin.sh <username> [on|off]" >&2; exit 1; }
[[ "$MODE" == "on" || "$MODE" == "off" ]] || { echo "mode must be 'on' or 'off'" >&2; exit 1; }

SCRIPT='
  const Database = require("better-sqlite3");
  const [username, mode] = process.argv.slice(1);
  const db = new Database(process.env.DATABASE_PATH || "./mchs.db");
  const user = db.prepare("SELECT id, username FROM users WHERE username = ?").get(username);
  if (!user) {
    console.error("no such user: " + username);
    console.error("existing users: " + db.prepare("SELECT username FROM users").all().map(u => u.username).join(", "));
    process.exit(2);
  }
  if (mode === "on") {
    db.prepare("UPDATE users SET admin = 1 WHERE id = ?").run(user.id);
    db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, \x27admin\x27)").run(user.id);
  } else {
    db.prepare("UPDATE users SET admin = 0 WHERE id = ?").run(user.id);
    db.prepare("DELETE FROM user_tags WHERE user_id = ? AND tag = \x27admin\x27").run(user.id);
  }
  console.log(`@${user.username} admin=${mode}`);
  db.close();
'

if command -v docker >/dev/null 2>&1 && docker inspect -f '{{.State.Running}}' mchs-api 2>/dev/null | grep -q true; then
  docker compose exec -T api node -e "$SCRIPT" "$USERNAME" "$MODE"
elif [[ -d api/node_modules/better-sqlite3 ]]; then
  ( cd api && node -e "$SCRIPT" "$USERNAME" "$MODE" )
else
  echo "ERROR: no running mchs-api container and no api/node_modules — deploy first (scripts/deploy.sh)" >&2
  exit 1
fi
