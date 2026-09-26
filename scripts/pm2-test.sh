#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pm2-test.sh — spin up a fully isolated TEST instance of the API under PM2
# on its own port and its OWN throwaway database, run the E2E suite against
# it, then tear it down. Never touches the production DB or port.
#
#   scripts/pm2-test.sh              # start → seed → e2e → stop (default)
#   scripts/pm2-test.sh --keep       # leave mchs-api-test running for poking
#   scripts/pm2-test.sh --stop       # just kill the test instance
#
# What it does:
#   1. fresh DB     deletes /tmp/mchs-test.db, lets db.js rebuild schema+seed
#   2. pm2 start    api/index.js as "mchs-api-test", PORT=3101 (override: PORT=…)
#                   NODE_ENV=test so any test-mode guards in the app apply
#   3. wait         polls http://localhost:$PORT/health until { ok: true }
#   4. seed admin   DATABASE_PATH=… npm run test:seed (in api/)
#   5. e2e          TEST_BASE_URL=http://localhost:$PORT npm run test:e2e
#   6. teardown     pm2 delete mchs-api-test (unless --keep)
# Exit code = e2e exit code (CI-friendly).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

TEST_NAME="mchs-api-test"
PORT="${PORT:-3101}"
DB_PATH="${DB_PATH:-/tmp/mchs-test.db}"
KEEP=0
MODE=run

case "${1:-}" in
  --keep) KEEP=1 ;;
  --stop) MODE=stop ;;
esac

ts()   { date -u +%H:%M:%S; }
log()  { echo -e "\033[1;34m[test $(ts)]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[test $(ts)]\033[0m $*"; }
die()  { echo -e "\033[1;31m[test $(ts)]\033[0m $*" >&2; exit 1; }

pm2 describe "$TEST_NAME" >/dev/null 2>&1 && pm2 delete "$TEST_NAME" >/dev/null 2>&1 || true
if [[ "$MODE" == stop ]]; then ok "test instance stopped"; exit 0; fi

command -v pm2 >/dev/null 2>&1 || die "pm2 not found — npm install -g pm2"
[[ -d api/node_modules ]] || die "api deps missing — cd api && npm install"

# 1. throwaway database — schema + default channels are rebuilt on boot
log "fresh test DB at $DB_PATH"
rm -f "$DB_PATH" "$DB_PATH"-wal "$DB_PATH"-shm

# env for the test server: api/.env is loaded by dotenv, but explicit
# DATABASE_PATH/PORT take precedence. TEAM_KEY lets seed-admin open the
# self-service join flow so the E2E suite can exercise it too.
TEST_ENV_FILE="$(mktemp)"
cat >"$TEST_ENV_FILE" <<EOF
DATABASE_PATH=$DB_PATH
PORT=$PORT
NODE_ENV=test
TEAM_KEY=${TEAM_KEY:-ROBO-KEY-TEST}
EOF

# 2. start under pm2 (same interpreter path resolution rules as production)
log "starting $TEST_NAME on :$PORT (db: $DB_PATH)…"
pm2 delete "$TEST_NAME" >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs --only "$TEST_NAME" \
  --env DATABASE_PATH="$DB_PATH" --env PORT="$PORT" --env TEAM_KEY="${TEAM_KEY:-ROBO-KEY-TEST}" >/dev/null \
  || die "pm2 start failed"

# 3. wait for health
BASE="http://localhost:$PORT"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "$BASE/health" 2>/dev/null | grep -q '"ok":true'; then break; fi
  sleep 1
  [[ $i == 30 ]] && { pm2 logs "$TEST_NAME" --lines 20 --nostream; die "test API never became healthy on :$PORT"; }
done
ok "test API healthy ($BASE/health)"

# 4. seed admin + 5. run e2e
log "seeding test admin…"
(cd api && DATABASE_PATH="$DB_PATH" npm run --silent test:seed) || { pm2 delete "$TEST_NAME"; die "seed failed"; }
log "running E2E suite against $BASE…"
(cd api && TEST_BASE_URL="$BASE" npm run --silent test:e2e)
RC=$?

# 6. teardown
if [[ "$KEEP" == 1 ]]; then
  warn_note="left running (--keep): pm2 logs $TEST_NAME | stop: scripts/pm2-test.sh --stop"
else
  pm2 delete "$TEST_NAME" >/dev/null 2>&1
fi

echo
if [[ $RC == 0 ]]; then ok "ALL TESTS PASSED ✅  ($warn_note)"; else die "TESTS FAILED ❌ exit=$RC  ($warn_note)"; fi
exit $RC
