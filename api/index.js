// ── API composition root ─────────────────────────────────────────────────────
// This file intentionally contains NO feature logic. Every backend feature
// lives in its own module:
//
//   api/routes/*     thin HTTP layer per feature (auth, users, chat, events…)
//   api/modules/*    shared domain logic used BY the routes (and by each other)
//   api/db.js        SQLite schema & connection
//   api/auth.js      sessions / JWT middleware (used by every route)
//   api/robot.js     robot telemetry service client
//   api/remoteDev.js SSH remote-dev router factory
//
// Modules talk to each other through their exported functions only — a route
// never reaches into another route's file (the one exception: admin reuses
// applications' approveApplication(), which is an explicitly shared export).
//
// Load api/.env (RESEND_API_KEY, SMTP_*, ADMIN_EMAIL, PUBLIC_URL, …) before
// anything reads process.env. The file is git-ignored — see README.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const { db, initDb, ensureRecurringMeetings } = require('./db');
const { createRemoteDevRouter } = require('./remoteDev');
const robot = require('./robot');
const gcal = require('./googleCalendar');
const { attachDb } = require('./modules/push');
const { generalLimiter } = require('./modules/limits');
const { scheduleMeetingReminders } = require('./modules/events');

const app = express();
// Standard production flag (also used for the Secure cookie flag below).
const isProd = process.env.NODE_ENV === 'production';
// parseInt: a string PORT (e.g. from PM2's env or the shell) makes
// server.listen() treat it as a pipe/path and fail in confusing ways.
const PORT = parseInt(process.env.PORT, 10) || 3001;

// Push subscriptions are stored in SQLite — hand the handle to the push module.
attachDb(db);

// Behind ONE reverse proxy (nginx/Caddy in front of PM2). `true` (= hop count
// ∞) lets any client spoof X-Forwarded-* and breaks the rate limiter's IP
// keying; 1 is the correct setting for a single trusted proxy.
app.set('trust proxy', 1);
// Standard security headers on API responses. contentSecurityPolicy is left
// off: this origin also serves the Vite-built frontend, whose CSP belongs to
// the static host (nginx/Caddy), not the API.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser()); // required by the Google quick-sign-in cookie routes
app.use(express.json({ limit: '15mb' })); // applications carry base64 photos

// Global request budget for every /api route (stricter auth/chat limits are
// applied inside the individual routers — see modules/limits.js).
app.use('/api', generalLimiter);

// ── health check (unversioned, sits at /health outside the /api tree) ───────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── feature routers, mounted under /api ──────────────────────────────────────
// Router paths inside each file match the ORIGINAL monolith URLs exactly, so
// the frontend keeps working with zero changes. The auth router owns both the
// '/auth/*' and '/admin/google-denied|join-key' namespaces in addition to its
// own routes, which is why it mounts at the bare '/api'.
const authRoutes = require('./routes/auth');
app.use('/api',                    authRoutes);                      // login, logout, /me, password/reset, /auth/*, admin key routes
app.use('/api/admin',              require('./routes/admin'));       // member management
app.use('/api/applications',       require('./routes/applications')); // membership applications
app.use('/api',                    require('./routes/users'));       // profile, availability, /users/*
app.use('/api',                    require('./routes/chat'));        // channels & messages
app.use('/api',                    require('./routes/events'));      // calendar events & voting
app.use('/api',                    require('./routes/gcal'));        // Google Calendar mirror
app.use('/api',                    require('./routes/mail'));        // team mailbox hook & inbox
app.use('/api',                    require('./routes/push'));        // web-push subscriptions
app.use('/api/robot',              require('./routes/robot'));       // telemetry, deploy, compile
app.use('/api/remote-dev',         createRemoteDevRouter({ requireAuth: require('./auth').requireAuth }));

// ── start ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));

  // Keep the recurring weekly meetings seeded on long-running processes
  // (initDb seeds startup; this extends the horizon as days roll by).
  const reseed = setInterval(() => {
    try { ensureRecurringMeetings(); }
    catch (err) { console.error('Recurring meeting seeding failed:', err); }
  }, 6 * 60 * 60 * 1000);
  reseed.unref?.();

  // Google Calendar: retry any approved events that missed their mirror write
  // (server restarted mid-push, transient API errors, pre-sync backlog).
  if (gcal.isConfigured()) {
    gcal.syncPending(db).catch(() => {});
    const gcalSync = setInterval(() => {
      gcal.syncPending(db).catch(err => console.error('[gcal] background sync failed:', err.message));
    }, 15 * 60 * 1000);
    gcalSync.unref?.();
  }

  // Meeting reminder scheduler (lives with the event domain logic).
  scheduleMeetingReminders();

  // Robot connectivity check on startup
  robot.checkRobotConnection().then(connected => {
    console.log(`[Robot] Connection to ${robot.ROBOT_IP}: ${connected ? 'OK' : 'OFFLINE'}`);
  }).catch(err => {
    console.error('[Robot] Connection check failed:', err.message);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
