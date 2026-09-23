module.exports = {
  apps: [
    {
      name: "meeting-app",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },
      // Restart automatically if the app crashes
      autorestart: true,
      // Wait 1000ms before restarting (prevent crash loops)
      restart_delay: 1000,
      // Max memory restart (optional, prevents memory leaks from taking down server)
      max_memory_restart: "500M",
      // Log files locations
      error_file: "./logs/pm2-err.log",
      out_file: "./logs/pm2-out.log",
      log_file: "./logs/pm2-combined.log",
      time: true
    }
  ]
};
