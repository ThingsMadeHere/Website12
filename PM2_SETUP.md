# PM2 Setup Guide

This guide explains how to use PM2 (Process Manager 2) to keep your meeting application running 24/7, ensuring it "never goes dark" even if it crashes or the server restarts.

## Prerequisites

Ensure you have Node.js and npm installed on your server.

## Step 1: Install PM2 Globally

Run the following command to install PM2 globally on your system:

```bash
npm install -g pm2
```

## Step 2: Create Logs Directory

The configuration file expects a `logs` directory. Create it if it doesn't exist:

```bash
mkdir -p logs
```

## Step 3: Start the Application with PM2

You can start the application using the provided `ecosystem.config.js` file:

```bash
pm2 start ecosystem.config.js
```

This will:
- Start your app in the background
- Name the process "meeting-app"
- Automatically restart it if it crashes
- Restart it if it uses too much memory (>500MB)
- Log output to the `logs/` directory

## Step 4: Save the PM2 Process List

To ensure PM2 remembers your app configuration and restarts it automatically when the server reboots:

```bash
pm2 save
```

## Step 5: Setup PM2 Startup Script

Generate the startup script so PM2 launches automatically when the server boots up:

```bash
pm2 startup
```

**Important:** After running this command, it will output a specific command tailored to your system (usually involving `sudo env PATH...`). **You must copy and run that specific command** to complete the setup.

## Useful PM2 Commands

| Command | Description |
| :--- | :--- |
| `pm2 list` | Show status of all running apps |
| `pm2 logs meeting-app` | View real-time logs for your app |
| `pm2 monit` | Open a live dashboard monitoring CPU/Memory |
| `pm2 restart meeting-app` | Restart the application |
| `pm2 stop meeting-app` | Stop the application |
| `pm2 delete meeting-app` | Delete the process from PM2 list |
| `pm2 flush` | Clear all logs |

## How It Keeps Your App Running

1. **Auto-Restart on Crash**: If your Node.js process encounters an error and dies, PM2 immediately spawns a new one.
2. **Memory Protection**: If the app leaks memory and exceeds 500MB, PM2 restarts it cleanly.
3. **Server Reboot Survival**: The `pm2 startup` and `pm2 save` commands ensure the app launches automatically if the entire server is restarted.
4. **Zero Downtime Reloads**: (Optional) You can use `pm2 reload meeting-app` to update the code without dropping connections.
