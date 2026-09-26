# Runtime: Docker Compose only (PM2 retired)

The **only** supported way to keep the backend running on the server is
Docker Compose. PM2 was removed as a runtime option because it conflicted
with the `mchs-api` container over port 3001, crash-looped with
`EADDRINUSE`, and broke native modules (`better-sqlite3`) when its bundled
Node didn't match the host's — exactly the class of "SSH window holding it
up" pain you had.

## What runs where

| Piece | Runs as | Managed by |
|---|---|---|
| API (`api/index.js`, port 3001) | container `mchs-api` | `docker compose up -d api` |
| Frontend (static `dist/` + `/api` proxy) | container `mchs-web` (nginx) | part of the same compose file |
| SSH dev server, Java compiler, dev container | containers | same compose file |
| Reboot survival | `restart: unless-stopped` on every service | Docker daemon itself |

No SSH session needs to stay open for anything. `deploy.sh` runs in the
background via CI (`.github/workflows/deploy.yml`) or one manual command;
after that the containers are owned by the Docker daemon (`systemd`-managed),
not by your shell.

## Deploy / update

```bash
scripts/deploy.sh            # backup → build → rollout → healthcheck → auto-rollback
scripts/deploy.sh --pull     # same, but git pull first
```

## Day-to-day operations

```bash
docker compose ps                        # status + health of everything
docker compose logs -f api               # tail API logs (replaces `pm2 logs`)
docker compose restart api               # after changing api/.env
docker compose up -d                     # apply any compose changes
./scripts/healthcheck.sh                 # curl /health + SPA shell checks
docker stats --no-stream                 # memory/CPU (replaces max_memory_restart)
```

SQLite lives in the named volume `api_data` (`/app/data/mchs.db` inside the
container), so rebuilding images never touches your database. Backups:
`scripts/backup.sh` / `restore.sh` (compose-aware).

## One-time migration off PM2 (run on the server)

```bash
pm2 delete mchs-api mchs-api-test 2>/dev/null || true   # stop PM2 claiming :3001
pm2 unstartup systemd 2>/dev/null || true               # remove pm2-resurrect on boot
rm -f /etc/systemd/system/pm2-root.service              # if present
npm uninstall -g pm2                                    # optional cleanup
docker compose up -d --force-recreate api web           # Docker now owns the app
```

Also check for stray non-compose copies of the app (`docker ps -a` should show
exactly the compose services; `robot-api.service` from the old Jarvis setup
should be disabled: `systemctl disable --now robot-api`).

## Legacy files

- `ecosystem.config.cjs` — kept only as a reference for emergency bare-metal
  recovery (e.g. Docker unavailable). Do not run it alongside compose; that is
  precisely the conflict that caused the crash loops. See header comments.
- `DEPRECATED-PM2.md` — former PM2 guide, historical only.
- `scripts/pm2-deploy.sh`, `pm2-test.sh`, `pm2-reset.sh` and the
  `npm run deploy` / `test:pm2` aliases still point at this deprecated path;
  prefer `scripts/deploy.sh` and `docker compose exec`.
