# PM2 Setup Guide

This guide explains how to use PM2 (Process Manager 2) to keep the MCHS Robotics
backend running 24/7, ensuring it "never goes dark" even if it crashes or the
server restarts.

## What PM2 runs here

Only the **API** (`api/index.js`, port **3001**) needs PM2. The frontend is a
static Vite build that nginx serves from `dist/` — after pulling frontend
changes just run `npm run build`; no process to manage.

The process definitions live in **`ecosystem.config.cjs`** (the `.cjs`
extension is required because the root `package.json` sets `"type": "module"`
and PM2 configs are CommonJS).

## Step 1: Install PM2 Globally

```bash
npm install -g pm2
```

## Step 2: Start the Application with PM2

```bash
pm2 start ecosystem.config.cjs
```

This will:
- Start the API as a process named **`mchs-api`**
- Run `node index.js` directly from `api/` (not via `npm start`, which
  leaves orphaned child processes on restart)
- Load `api/.env` automatically (dotenv) — including VAPID keys for push
- Auto-restart on crash, with a 1s delay and a 500MB memory cap
- Write logs to `api/logs/pm2-api-*.log`

If an old `meeting-app` entry exists from a previous setup, remove it:

```bash
pm2 delete meeting-app
```

## Step 3: Verify It's Healthy

```bash
pm2 list                          # mchs-api should be "online", restarts ↺ stable
pm2 logs mchs-api --lines 20      # look for "✅ VAPID keys configured" + "API listening on :3001"
curl -s http://localhost:3001/api/events | head -c 200   # should return JSON
```

## Step 4: Save the PM2 Process List

To ensure PM2 remembers your app configuration and restarts it automatically
when the server reboots:

```bash
pm2 save
```

## Step 5: Setup PM2 Startup Script

Generate the startup script so PM2 launches automatically when the server boots:

```bash
pm2 startup
```

**Important:** This command outputs a specific `sudo env PATH=...` command
tailored to your system. **Copy and run that command** to complete boot setup.

## Deploying Updates (the daily workflow)

```bash
git pull                          # get new code
cd api && npm install && cd ..    # only if backend deps changed
pm2 restart mchs-api              # apply backend changes
npm run build                     # only if frontend changed; nginx picks up dist/ instantly
```

## Useful PM2 Commands

| Command | Description |
| :--- | :--- |
| `pm2 list` | Show status of all running apps |
| `pm2 logs mchs-api` | View real-time logs for the API |
| `pm2 monit` | Open a live dashboard monitoring CPU/Memory |
| `pm2 restart mchs-api` | Restart the application |
| `pm2 stop mchs-api` | Stop the application |
| `pm2 delete mchs-api` | Delete the process from PM2 list |
| `pm2 flush` | Clear all logs |

## Push Notifications / VAPID Keys

Push requires keys in `api/.env` (gitignored):

```bash
npx web-push generate-vapid-keys
# paste into api/.env as VAPID_PUBLIC_KEY=... and VAPID_PRIVATE_KEY=...
pm2 restart mchs-api
```

Regenerating keys invalidates existing browser subscriptions; users simply
re-enable notifications on their devices afterwards.

## How It Keeps Your App Running

1. **Auto-Restart on Crash**: If the Node process dies, PM2 spawns a new one.
2. **Memory Protection**: Above 500MB RSS, PM2 restarts the app cleanly.
3. **Server Reboot Survival**: `pm2 startup` + `pm2 save` relaunch everything at boot.
4. **Port Conflicts**: If you previously ran `node index.js` by hand, kill it
   first (`pkill -f "node index.js"`) or PM2's child will crash-loop with
   `EADDRINUSE`.
