#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# create-admin.sh — bootstrap an admin ACCOUNT (username + password) directly
# in the database.
#
# When to use:
#   * The site's users table is empty (fresh install, or mchs.db was wiped /
#     restored from a stale backup / deleted without its -wal sidecar). In that
#     state EVERY login fails with "Invalid username or password" because there
#     are simply no accounts to match against.
#   * You need an admin before the Admin panel exists (chicken-and-egg).
#
# If accounts DO exist and you just want to grant admin to one of them,
# use scripts/set-admin.sh <username> instead.
#
# Usage:
#   scripts/create-admin.sh carterherrault            # prompts for password
#   scripts/create-admin.sh carterherrault 'pw'       # (avoid: leaks into ps/sh history)
#
# Targets the same database as the API: $DATABASE_PATH if set, else
# ~/JarvisData/database/mchs.db (override with DATA_DIR=/path/to/dir).
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
DATA_DIR="${DATA_DIR:-$HOME/JarvisData/database}"
DB_FILE="${DATABASE_PATH:-$DATA_DIR/mchs.db}"

USERNAME="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')"
[[ -n "$USERNAME" ]] || { echo "usage: scripts/create-admin.sh <username> [password]" >&2; exit 1; }
if [[ ! "$USERNAME" =~ ^[a-z0-9._-]{2,30}$ ]]; then
    echo "ERROR: Invalid username format (2-30 chars: lowercase letters, numbers, . _ -)." >&2
    exit 1
fi

if [[ -n "${2:-}" ]]; then
  PASSWORD="$2"
else
  read -rsp "Password for @$USERNAME (min 6 chars): " PASSWORD; echo >&2
fi
if (( ${#PASSWORD} < 6 )); then
  echo "ERROR: Password must be at least 6 characters." >&2
  exit 1
fi

[[ -d api/node_modules/better-sqlite3 ]] || { echo "ERROR: run 'npm install' inside api/ first." >&2; exit 1; }

( cd api && DATABASE_PATH="$DB_FILE" node -e '
  // db.js resolves + migrates DATABASE_PATH (and loads api/.env) for us.
  const { db } = require("./db");
  const { hashPassword } = require("./auth");
  const [username, password] = process.argv.slice(1);
  const existing = db.prepare("SELECT id, admin FROM users WHERE username = ?").get(username);
  let id;
  if (existing) {
    // Idempotent: reset the password and re-grant admin instead of failing.
    db.prepare("UPDATE users SET password_hash = ?, admin = 1, verified = 1, must_change_password = 0, timeout_until = NULL WHERE id = ?")
      .run(hashPassword(password), existing.id);
    id = existing.id;
    console.log(`updated @${username} (password reset + admin re-granted)`);
  } else {
    const info = db.prepare(
      `INSERT INTO users (username, password_hash, full_name, verified, admin) VALUES (?, ?, ?, 1, 1)`
    ).run(username, hashPassword(password), username);
    id = Number(info.lastInsertRowid);
    console.log(`created admin @${username} (id ${id})`);
  }
  db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, \x27admin\x27)").run(id);
  db.close();
' "$USERNAME" "$PASSWORD")

echo "Done. Sign in at the site as @$USERNAME, then use scripts/set-admin.sh to manage other admins."
