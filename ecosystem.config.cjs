// PM2 process definitions for MCHS Robotics site.
//
//   pm2 start ecosystem.config.js     # start everything
//   pm2 restart mchs-api              # after pulling new backend code
//   pm2 logs mchs-api                 # tail logs
//   pm2 save && pm2 startup           # survive server reboots
//
// NOTE: the frontend is a static Vite build served by nginx from dist/,
// so it does NOT need a PM2 process. Rebuild with `npm run build` after
// pulling frontend changes; nginx picks it up immediately.
module.exports = {
  apps: [
    {
      name: 'mchs-api',
      script: 'index.js',
      cwd: './api',
      // Run the real node entrypoint directly (not `npm start`, which
      // leaves orphaned child processes on restart/stop).
      // NOTE: use 'node' (resolved from PATH), NOT a hardcoded path like
      // '/usr/bin/node' — PM2 silently falls back to its own bundled Node
      // when the path is wrong, which breaks native modules
      // (better-sqlite3 ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch).
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        // The Docker Compose "api" service (container_name: mchs-api) also
        // binds host port 3001. If that container is running, it owns 3001
        // and this PM2 process crash-loops with EADDRINUSE. Check with:
        //   docker ps --filter name=mchs-api
        // Pick ONE runtime for the API: either Docker or PM2, never both.
        // Override the port here (and in nginx/Caddy proxy config) if needed.
        PORT: parseInt(process.env.PORT || '3001', 10)
      },
      autorestart: true,
      restart_delay: 1000,
      max_memory_restart: '500M',
      // graceful reload: SIGTERM → wait → SIGKILL (used by pm2-deploy.sh)
      kill_timeout: 5000,
      wait_ready: false,
      error_file: './logs/pm2-api-error.log',
      out_file: './logs/pm2-api-out.log',
      log_file: './logs/pm2-api-combined.log',
      time: true
    },
    {
      // Isolated TEST instance managed by scripts/pm2-test.sh.
      // Never started by `pm2 start ecosystem.config.cjs` — use:
      //   pm2 start ecosystem.config.cjs --only mchs-api-test
      // Own port (3101) and own throwaway DB (/tmp/mchs-test.db), so it can
      // run alongside production without touching real data.
      name: 'mchs-api-test',
      script: 'index.js',
      cwd: './api',
      interpreter: 'node',
      env: {
        NODE_ENV: 'test',
        PORT: parseInt(process.env.PORT || '3101', 10),
        DATABASE_PATH: process.env.DATABASE_PATH || '/tmp/mchs-test.db'
      },
      autorestart: false,   // a broken test build should stop, not crash-loop
      error_file: './logs/pm2-test-error.log',
      out_file: './logs/pm2-test-out.log',
      time: true
    }
  ]
};
