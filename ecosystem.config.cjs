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
      interpreter: '/usr/bin/node',
      env: {
        NODE_ENV: 'production',
        PORT: 3001 // must match the /api/ proxy_pass port in nginx.conf
      },
      autorestart: true,
      restart_delay: 1000,
      max_memory_restart: '500M',
      error_file: './logs/pm2-api-error.log',
      out_file: './logs/pm2-api-out.log',
      log_file: './logs/pm2-api-combined.log',
      time: true
    }
  ]
};
