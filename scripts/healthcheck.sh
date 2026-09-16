#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# healthcheck.sh — verify the production stack is actually serving.
#
# Checks, in order:
#   1. API container responds on :3001/health
#   2. nginx (web) serves the SPA shell on :80
#   3. the full proxy chain works: GET /api/users/count through nginx
#   4. (docker only) both containers are up; api reports "healthy"
#
# Usage:
#   scripts/healthcheck.sh              # one shot
#   scripts/healthcheck.sh --wait 90    # retry for up to 90 s (used by deploy)
#
# Env overrides: API_URL (default http://localhost:3001), WEB_URL (default http://localhost)
# Exit code 0 = all checks passed.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

API_URL="${API_URL:-http://localhost:3001}"
WEB_URL="${WEB_URL:-http://localhost}"
WAIT_SECS=0
[[ "${1:-}" == "--wait" ]] && WAIT_SECS="${2:-60}"

# curl if present, wget next, python3 urllib as the last resort
http_get() { # url → body on stdout, non-zero exit on HTTP error
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 8 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=8 "$1"
  else
    python3 - "$1" <<'PYEOF'
import sys, urllib.request
r = urllib.request.urlopen(sys.argv[1], timeout=8)
sys.stdout.write(r.read().decode('utf-8', 'replace'))
PYEOF
  fi
}

check_once() {
  local body

  # 1. API health
  body="$(http_get "$API_URL/health" 2>/dev/null)" || { echo "FAIL  api /health unreachable ($API_URL)"; return 1; }
  echo "$body" | grep -q '"ok":true' || { echo "FAIL  api /health bad body: $body"; return 1; }
  echo "ok    api /health"

  # 2. Frontend shell
  body="$(http_get "$WEB_URL/" 2>/dev/null)" || { echo "FAIL  web root unreachable ($WEB_URL)"; return 1; }
  echo "$body" | grep -q 'id="root"' || { echo "FAIL  web root is not the SPA shell"; return 1; }
  echo "ok    web / (SPA shell)"

  # 3. Proxy chain nginx → api
  body="$(http_get "$WEB_URL/api/users/count" 2>/dev/null)" || { echo "FAIL  /api proxy through nginx failed"; return 1; }
  echo "$body" | grep -q '"count"' || { echo "FAIL  /api/users/count bad body: $body"; return 1; }
  echo "ok    web → api proxy (/api/users/count)"

  # 4. Container state (skipped when docker is unavailable, e.g. bare metal)
  if command -v docker >/dev/null 2>&1 && docker compose ps >/dev/null 2>&1; then
    local state health
    state="$(docker compose ps --format '{{.Name}} {{.State}} {{.Health}}' 2>/dev/null)"
    if echo "$state" | grep -q "mchs-api"; then
      echo "$state" | grep "mchs-api" | grep -q "healthy" || { echo "FAIL  mchs-api container not healthy:"; echo "$state" | grep mchs-api; return 1; }
      echo "$state" | grep "mchs-web" | grep -q "running" || { echo "FAIL  mchs-web container not running:"; echo "$state" | grep mchs-web; return 1; }
      echo "ok    containers healthy"
    fi
  fi

  return 0
}

deadline=$(( $(date +%s) + WAIT_SECS ))
attempt=1
while true; do
  echo "── healthcheck attempt $attempt ──"
  if check_once; then
    echo "HEALTHY ✅"
    exit 0
  fi
  if (( $(date +%s) >= deadline )); then
    echo "UNHEALTHY ❌ (gave up after ${WAIT_SECS}s)"
    exit 1
  fi
  sleep 3
  attempt=$((attempt + 1))
done
