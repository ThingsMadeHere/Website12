# Deployment Protocol — MCHS Robotics Team Portal

How this site goes to production, stays healthy, and recovers when it doesn't.
Everything here is executable: the scripts in `scripts/` **are** the protocol —
this document explains when and why to run each one.

```
                    ┌──────────────────────────────────────────────┐
 visitor ──HTTPS──► │ Cloudflare (proxy, DNS, TLS)                 │
                    └──────────────┬───────────────────────────────┘
                                   │  A record → server IP (or cloudflared tunnel)
                    ┌──────────────▼───────────────────────────────┐
                    │ VPS  ·  docker compose                       │
                    │                                              │
                    │  mchs-web (nginx :80)                        │
                    │   ├─ /          → dist/  (React SPA)         │
                    │   └─ /api/*     → mchs-api:3001              │
                    │                                              │
                    │  mchs-api (node:22, Express)                 │
                    │   └─ SQLite WAL → volume  api_data           │
                    │        /app/data/mchs.db                     │
                    └──────────────────────────────────────────────┘
```

---

## 1. Prerequisites

- A Linux server (any $5 VPS is plenty; Docker needs ~1 GB RAM).
- Docker Engine + the compose plugin.
- The domain `mchsrobotics.dev` pointed at the server — see
  `DNS_CONFIGURATION.md` and `CLOUDFLARE_SETUP.md`.
- A GitHub checkout of this repo at `/opt/mchs/Website12` (convention used
  below; anything works as long as CI/CD variables match).

## 2. First-time server setup (once, ~15 minutes)

```bash
# 1. Docker (official convenience script)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER          # re-login afterwards

# 2. Firewall — only SSH and HTTP(S) are ever needed
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable

# 3. Code
sudo mkdir -p /opt/mchs && sudo chown $USER /opt/mchs
git clone https://github.com/ThingsMadeHere/Website12.git /opt/mchs/Website12
cd /opt/mchs/Website12

# 4. Secrets (NEVER committed; compose reads api/.env at runtime)
cp api/.env.example api/.env
nano api/.env                          # RESEND_API_KEY or SMTP_* etc.
chmod 600 api/.env

# 5. First deploy (builds frontend + api image, starts containers, verifies)
./scripts/deploy.sh

# 6. Bootstrap the first admin (chicken-and-egg: the Admin panel needs an
#    admin). Either approve your membership application via the email link,
#    or promote an existing account directly:
./scripts/set-admin.sh yourusername

# 7. Nightly backups (belt; the GitHub Actions job is the suspenders)
crontab -e
#   30 0 * * *  /opt/mchs/Website12/scripts/backup.sh nightly >> /var/log/mchs-backup.log 2>&1

# 8. Verify from the outside world
curl -fsS https://mchsrobotics.dev/api/users/count
```

Optional edge — **Cloudflare Tunnel** (no inbound ports at all): create a
tunnel in Zero Trust → Networks → Tunnels, hostname `mchsrobotics.dev` →
`http://mchs-web:80`, put `TUNNEL_TOKEN=…` into `api/.env`, and uncomment the
`cloudflared` service in `docker-compose.yml`. Then `docker compose up -d
cloudflared` and port 80 no longer needs to be public.

## 3. Routine deploys

**Normal path (automatic):** push to `main` → GitHub Actions runs CI (lint +
production build + the full API E2E suite) → on green, SSHes to the server and
runs `scripts/deploy.sh`. See §7 for the one-time secrets setup.

**Manual path:**

```bash
ssh deploy@server
cd /opt/mchs/Website12
./scripts/deploy.sh --pull        # git pull --ff-only, then deploy
```

**What `deploy.sh` does — in this exact order:**

| Step | Action | On failure |
|---|---|---|
| 1 | Preflight: docker reachable, `api/.env` present | abort (nothing touched) |
| 2 | `scripts/backup.sh pre-deploy` — hot DB backup + config bundle | **abort** (never deploy without a restore point) |
| 3 | Snapshot current `dist/` + api image id | — |
| 4 | Build frontend (`npm ci` + vite in node:22-alpine) and api image (`npm ci --omit=dev`) | rollback |
| 5 | `docker compose up -d api web` (web waits for api **healthy**) | rollback |
| 6 | `scripts/healthcheck.sh --wait 120` (API health, SPA shell, `/api` proxy chain, container health) | rollback |
| 7 | Prune dangling images, print summary | — |

Rollback restores the previous `dist/` and api image, re-verifies health, and
points you at the pre-deploy DB backup. Schema migrations are additive and
run automatically at API startup (old columns are never dropped), so a code
rollback does not require a DB rollback in practice — but the restore point
is there if it ever does (§6).

## 4. Production build (what "production" actually compiles)

**With Docker (the protocol — reproducible, lockfile-pinned):**

```bash
docker compose run --rm build-frontend   # npm ci && vite build  → ./dist
docker compose build api                 # npm ci --omit=dev     → mchs-api image
docker compose up -d api web
```

**Bare metal (no Docker)** — e.g. serving `dist/` from an existing nginx:

```bash
npm ci && npm run build          # → dist/ (copy to your web root)
cd api && npm ci --omit=dev
DATABASE_PATH=/var/lib/mchs/mchs.db PORT=3001 node index.js
```

Systemd unit for the bare-metal API (`/etc/systemd/system/mchs-api.service`):

```ini
[Unit]
Description=MCHS Robotics API
After=network.target

[Service]
WorkingDirectory=/opt/mchs/Website12/api
Environment=DATABASE_PATH=/var/lib/mchs/mchs.db
Environment=PORT=3001
EnvironmentFile=/opt/mchs/Website12/api/.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

The server port (3001) and container names (`mchs-api`, `mchs-web`) are what
`scripts/healthcheck.sh` expects; override with `API_URL` / `WEB_URL` if your
layout differs.

## 5. Configuration & secrets

| Item | Where | Notes |
|---|---|---|
| Email provider keys | `api/.env` | git-ignored, `chmod 600`; backed up in the config bundle (§6) |
| Admin email / public URL | `docker-compose.yml` → api environment | `PUBLIC_URL` must stay `https://mchsrobotics.dev` (approve/deny links) |
| Auto-promoted admins | `api/db.js` → `ADMIN_USERNAMES` | promoted at every startup — keep in sync with reality |
| DB location | volume `api_data` → `/app/data/mchs.db` | the sibling `../JarvisData/database/mchs.db` (outside the repo) is only a dev seed |

## 6. Backup & restore protocol

**Backups (`scripts/backup.sh`)** — hot, no downtime (SQLite online-backup API
inside the running container), gzip-compressed into `backups/`, plus a config
bundle (`api/.env`, compose, nginx). Rotation: last 14 DB + 7 config. Set
`OFFSITE_DIR=/mnt/backblaze/mchs` (rclone/S3 mount) to push copies offsite —
**offsite is strongly recommended**; a VPS disk failure takes the DB and its
local backups together.

```bash
./scripts/backup.sh                       # manual
./scripts/backup.sh nightly               # cron / CI label
KEEP_DB=30 ./scripts/backup.sh            # keep a month
```

Scheduled twice on purpose: server cron (§2.7) **and** `.github/workflows/
backup.yml` (nightly over SSH, manual trigger available).

**Restore (`scripts/restore.sh`)** — takes a safety backup of the current DB
first, then restores online and restarts the api:

```bash
./scripts/restore.sh backups/mchs-20260914-003001-nightly.db.gz
```

**Drill:** once a term, restore the newest backup into a scratch copy and
check it (`gunzip -c backups/mchs-*.db.gz | head -c 16` should print
`SQLite format 3`; better: run the app against it). A backup nobody has
restored is a hypothesis, not a backup.

## 7. CI/CD setup (once)

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | server IP/hostname |
| `DEPLOY_USER` | ssh user (a dedicated `deploy` user with docker-group access is ideal) |
| `DEPLOY_SSH_KEY` | private ed25519 key (`ssh-keygen -t ed25519`); public key → server `authorized_keys` |
| `DEPLOY_PORT` *(optional)* | ssh port if not 22 |
| `DEPLOY_PASSPHRASE` *(optional)* | key passphrase |
| `DEPLOY_PATH` *(variable, optional)* | repo path if not `/opt/mchs/Website12` |

Then every push to `main`: **CI** (oxlint → vite production build → API E2E
suite on a throwaway DB) must pass before **Deploy** SSHes in and runs
`scripts/deploy.sh`, finishing with a public healthcheck against
`https://mchsrobotics.dev`. Deploys are serialized (`concurrency:
production`) so two pushes can't interleave.

No secrets configured? CI still runs on every push; the deploy job skips
gracefully and you deploy manually (§3).

## 8. Versioning & releases

- `main` is always deployable (CI-gated).
- Tag releases so rollback has named targets:
  `git tag -a v2.1.0 -m "admin panel + deployment protocol" && git push origin v2.1.0`
- Deploy a specific tag manually:
  `git fetch --tags && git checkout v2.1.0 && ./scripts/deploy.sh`

## 9. Monitoring & logs

```bash
./scripts/healthcheck.sh                  # api + SPA + proxy chain + containers
docker compose logs -f api                # application log (JSON-file, 3×10 MB rotation)
docker compose ps                         # health column
docker system df                          # disk usage; prune with: docker image prune -f
```

External uptime: point any free monitor (Cloudflare Health Checks, Uptime
Robot) at `https://mchsrobotics.dev/api/users/count` — it returns JSON `200`
without auth and exercises Cloudflare → nginx → api → DB.

## 10. Security checklist

- [ ] `api/.env` is `chmod 600`, git-ignored, and only in backups you trust
- [ ] UFW (or equivalent) allows only 22/80/443 — **3001 is internal**; if
      you don't use a cloudflared tunnel, consider binding it to localhost in
      compose (`"127.0.0.1:3001:3001"`)
- [ ] Cloudflare SSL mode = **Full** (orange-cloud proxied)
- [ ] Admins: only who should be — audit tags in the Admin panel;
      `ADMIN_USERNAMES` in `api/db.js` matches reality
- [ ] SSH keys only (no passwords): `PasswordAuthentication no`
- [ ] Backups leave the machine (OFFSITE_DIR or the Actions job)
- [ ] Dependencies: `npm audit` occasionally; Dependabot optional

## 11. Troubleshooting

| Symptom | First move |
|---|---|
| Site down, `docker compose ps` shows api restarting | `docker compose logs api --tail 100` — usually `.env` missing/corrupt or volume permissions |
| 502/blank page after deploy | `./scripts/healthcheck.sh` to isolate (api vs nginx vs proxy); `./scripts/deploy.sh` already auto-rolled-back if it failed mid-way |
| `database is locked` in logs | a stray second process on the DB file (e.g. someone ran `node index.js` on the server) — kill it; WAL allows one writer |
| Forgot admin access | `./scripts/set-admin.sh yourusername` from the server console |
| Disk full | `docker system prune -f` (old build images), check `backups/` rotation, `docker compose logs --tail` sizes |
| Email approvals not arriving | api log line `[applications] … email NOT sent` → check `RESEND_API_KEY`/SMTP in `api/.env`; the Applications page works regardless |
| Need to roll back manually | `git checkout <last-good-tag> && ./scripts/deploy.sh`; DB: `./scripts/restore.sh backups/<file>.db.gz` |

---

*Protocol summary — push to `main` → CI green → `deploy.sh` (backup → build →
health-gated rollout → verify, auto-rollback) → nightly hot backups on cron +
Actions → `restore.sh` when fate intervenes.*
