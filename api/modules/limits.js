'use strict';
// ── rate limits (express-rate-limit) ─────────────────────────────────────────
// Auth endpoints were previously unlimited — trivial to brute-force the team
// key or member passwords. `trust proxy = 1` (set in index.js) makes the client
// IP correct behind nginx/Caddy so these limits actually key on real clients.

const rateLimit = require('express-rate-limit');

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in a few minutes.' },
});
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'You are sending messages too quickly — take a breath.' },
});

module.exports = { generalLimiter, authLimiter, messageLimiter };
