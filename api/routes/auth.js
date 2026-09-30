'use strict';
// ── auth routes ───────────────────────────────────────────────────────────────
// Sign-in / sign-out / session state, Google Sign-In (primary), the legacy
// team-key & password paths, forced password resets, notification settings.
//
// Shared building blocks exported for sibling modules:
//   sessionPayload(user) — standard login-success JSON (also used by the
//   join route and admin flows). Presence helpers live in modules/presence.js.

const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const {
  hashPassword, verifyPassword, maybeUpgradePasswordHash,
  createSession, destroySession, requireAuth, requireAdmin,
  getJoinKeyInfo, setJoinKey, clearJoinKey, joinWithKey, SESSION_TTL_DAYS,
} = require('../auth');
const {
  isConfigured: isGoogleConfigured, loginWithGoogle,
  listDeniedEmails, markDeniedReviewed,
} = require('../googleAuth');
const { authLimiter } = require('../modules/limits');
const {
  validate, LoginSchema, JoinLoginSchema, PasswordResetSchema,
  NotificationSettingsSchema, JoinKeySetSchema,
} = require('../modules/schemas');
const { isoOrNull } = require('../modules/util');
const { updateUserPresence } = require('../modules/presence');

const router = express.Router();

// HttpOnly cookie that lets returning Google users re-sign-in with one click
// (POST /api/auth/google/quick). Contains only their verified email.
const GOOGLE_COOKIE = 'mchs_gsid';
const isProd = process.env.NODE_ENV === 'production';

// Build the standard login-success payload for a user row (shared by
// /api/login and /api/login/code).
function sessionPayload(user) {
  const tags = db
    .prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag ASC')
    .all(user.id)
    .map(t => t.tag);
  return {
    userId: user.id,
    username: user.username,
    token: createSession(user.id),
    verified: !!user.verified,
    admin: !!user.admin,
    fullName: user.full_name || '',
    tags,
    hasPhoto: user.photo != null,
    timeoutUntil: isoOrNull(user.timeout_until),
  };
}

// ── Google Sign-In ───────────────────────────────────────────────────────────
// Primary method: Google Sign-In (api/googleAuth.js). The browser gets an ID
// token from Google Identity Services and posts it here; we verify it
// server-side, gate by school domain (GOOGLE_ALLOWED_DOMAINS), create/link the
// account, and hand back a session. No passwords, no team key, nothing to
// forget on Chromebooks.
//
// Legacy paths kept for recovery/automation accounts and old scripts:
//   POST /api/login        { username, password }  — bcrypt fallback
//   POST /api/login/join   { username, key }       — old shared team key
//   POST /api/password/reset                       — forced password change

// GET /api/auth/config — what the sign-in screen needs to know (public).
router.get('/config', (_, res) => {
  const configured = isGoogleConfigured();
  res.json({
    googleEnabled: configured,
    // Only expose the client ID when Google sign-in actually works, so the
    // frontend never renders a button that can only fail.
    googleClientId: configured ? process.env.GOOGLE_CLIENT_ID : null,
  });
});

// POST /api/auth/google  { credential }  (credential = Google ID token)
// On success responds with the standard session payload AND sets an HttpOnly
// cookie (mchs_gsid=<email>) so a returning user can complete sign-in with one
// click — no popup, no interaction, safe for kiosk-style Chromebooks.
router.post('/google', authLimiter, async (req, res) => {
  if (!isGoogleConfigured())
    return res.status(503).json({ error: 'Google Sign-In is not configured on this server yet.' });

  const credential = String((req.body || {}).credential || '');
  const result = await loginWithGoogle(credential);

  if (result.error && !result.denied && !result.pending)
    return res.status(401).json({ error: result.error });
  if (result.denied)
    return res.status(403).json({ code: 'denied', email: result.email, error: result.error });
  if (result.pending)
    return res.status(403).json({ code: 'pending', error: result.error });

  console.log(`@${result.user.username} signed in with Google <${result.user.email}>`);
  res.cookie(GOOGLE_COOKIE, result.user.email, {
    httpOnly: true, sameSite: 'lax', secure: isProd,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000, path: '/',
  });
  res.json(sessionPayload(result.user));
});

// POST /api/auth/google/quick  {} — silent re-auth for users who signed in
// with Google before: the browser still has our HttpOnly cookie, so we mint a
// fresh session without touching Google at all. Rate-limited + requires the
// cookie to match an existing verified account.
router.post('/google/quick', authLimiter, (req, res) => {
  const email = String(req.cookies?.[GOOGLE_COOKIE] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not signed in' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Account not found — please sign in again.' });
  if (!user.verified)
    return res.status(403).json({ code: 'pending', error: 'Your account is still pending admin approval.' });

  res.json(sessionPayload(user));
});

// GET /api/auth/google/status — does this browser carry the quick-sign-in
// cookie? Lets the landing page show a one-click "Continue as …" button.
router.get('/google/status', (req, res) => {
  const email = String(req.cookies?.[GOOGLE_COOKIE] || '').toLowerCase().trim();
  if (!email) return res.json({ remembered: false });
  const user = db.prepare('SELECT username, full_name, verified FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ remembered: false });
  res.json({ remembered: true, username: user.username, fullName: user.full_name || '', verified: !!user.verified });
});

// (The quick-sign-in cookie is cleared in POST /logout below.)

// ── Google sign-in: admin review of blocked accounts ─────────────────────────
// When someone signs in with a non-approved domain, googleAuth.js records them
// in `google_denied` so an admin can see the attempt here (and then either add
// the school's domain to GOOGLE_ALLOWED_DOMAINS or approve that exact address
// via GOOGLE_ALLOWLIST + re-check).

// GET /api/admin/google-denied — recent blocked sign-in attempts (admin)
router.get('/google-denied', requireAuth, requireAdmin, (_, res) => {
  res.json({ requests: listDeniedEmails() });
});

// POST /api/admin/google-denied/:id/review — mark an attempt as handled
router.post('/google-denied/:id/review', requireAuth, requireAdmin, (req, res) => {
  markDeniedReviewed(req.params.id);
  res.json({ ok: true });
});

// ── team key (LEGACY admin-managed) ──────────────────────────────────────────

// GET /api/admin/join-key — status only; the key itself is stored hashed
router.get('/join-key', requireAuth, requireAdmin, (_, res) => {
  const info = getJoinKeyInfo();
  if (!info) return res.json({ set: false });
  res.json({
    set: true,
    label: info.label,
    createdAt: info.createdAt,
    expiresAt: info.expiresAt,
    expired: new Date(info.expiresAt.replace(' ', 'T') + 'Z').getTime() < Date.now(),
  });
});

// POST /api/admin/join-key  { key, label?, days? } — set or rotate the key.
// Existing sessions stay valid; only NEW sign-ins need the new key.
router.post('/join-key', requireAuth, requireAdmin, (req, res) => {
  const [body,] = validate(JoinKeySetSchema, req, res);
  if (!body) return;
  const ttl = body.days || KEY_TTL_DAYS_LOCAL;
  const r = setJoinKey(body.key, req.user.id, body.label, ttl);
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`Team key rotated by ${req.user.username} (label "${r.label}", valid ${ttl}d)`);
  res.json({ ok: true, label: r.label, createdAt: r.createdAt, expiresAt: r.expiresAt });
});

// DELETE /api/admin/join-key — close self-service sign-in (applications still work)
router.delete('/join-key', requireAuth, requireAdmin, (req, res) => {
  clearJoinKey();
  console.log(`Team key removed by ${req.user.username}`);
  res.json({ ok: true });
});

// KEY_TTL_DAYS lives in auth.js; import lazily via require to avoid listing it
// twice (kept as a constant here mirrors the original index.js behavior).
const { KEY_TTL_DAYS: KEY_TTL_DAYS_LOCAL } = require('../auth');

// Legacy fallback: POST /login/join  { username, key } — the old shared
// "team key" sign-in. Superseded by Google Sign-In; kept only so recovery/
// automation scripts and old databases keep working. Not offered in the UI.
router.post('/join', authLimiter, (req, res) => {
  const [data,] = validate(JoinLoginSchema, req, res);
  if (!data) return;
  const result = joinWithKey(data.username, data.key);

  if (result.pending)
    return res.status(403).json({
      code: 'pending',
      error: 'Your application is still pending review — you can sign in once an admin approves it.',
    });

  if (result.apply) {
    const uname = String(data.username || '').toLowerCase().trim();
    // Raise (or reuse) a pending application so an admin sees them in the queue.
    let appId = db
      .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'pending'`)
      .get(uname)?.id;
    if (!appId && /^[a-z0-9_]{3,20}$/.test(uname)) {
      appId = Number(
        db
          .prepare(
            `INSERT INTO applications (username, full_name, password_hash, token)
             VALUES (?, ?, '', ?)`
          )
          .run(
            uname,
            `${uname} (join request from sign-in screen)`,
            crypto.randomBytes(32).toString('hex')
          ).lastInsertRowid
      );
    }
    return res.status(403).json({
      code: 'apply',
      applicationId: appId ?? null,
      error: appId
        ? `That team key doesn't match. We've opened a join request for @${uname} — an admin will review it, then you'll get the current key.`
        : "That team key doesn't match, and that username isn't valid. Ask a teammate for the current key.",
    });
  }

  if (result.error) return res.status(401).json({ error: result.error });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId);
  console.log(`@${user.username} signed in with the legacy team key`);
  res.json(sessionPayload(user));
});

// POST /login  { username, password } — legacy bcrypt sign-in kept for
// recovery/automation accounts (and the E2E test suite). Regular members use
// Google Sign-In above.
router.post('/', authLimiter, (req, res) => {
  const [data,] = validate(LoginSchema, req, res);
  if (!data) return;

  const uname = data.username;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);

  if (!user) {
    // Account doesn't exist — maybe they applied and are waiting on review
    const pending = db
      .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'pending'`)
      .get(uname);
    if (pending)
      return res.status(403).json({
        code: 'pending',
        error: 'Your application is still pending review — you can sign in once an admin approves it.',
      });

    const denied = db
      .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'denied' ORDER BY id DESC`)
      .get(uname);
    if (denied)
      return res.status(403).json({
        code: 'denied',
        error: 'Your application was not approved. Talk to a team lead if you think this is a mistake.',
      });

    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // bcrypt verify; legacy scrypt hashes are upgraded transparently on success.
  if (!maybeUpgradePasswordHash(user, data.password))
    return res.status(401).json({ error: 'Invalid username or password' });

  // An admin flagged this account for a forced password change — no session
  // until they pick a new one (the client shows the reset form).
  if (user.must_change_password) {
    console.log(`Login for @${user.username} blocked pending forced password change`);
    return res.json({
      mustChangePassword: true,
      userId: user.id,
      username: user.username,
      message: 'An admin requires you to choose a new password before signing in.',
    });
  }

  const token = createSession(user.id);
  const tags = db
    .prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag ASC')
    .all(user.id)
    .map(t => t.tag);
  res.json({
    userId: user.id,
    username: user.username,
    token,
    verified: !!user.verified,
    admin: !!user.admin,
    fullName: user.full_name || '',
    tags,
    hasPhoto: user.photo != null,
    timeoutUntil: isoOrNull(user.timeout_until),
  });
});

// POST /password/reset  { username, currentPassword, newPassword }
// Completes a forced password change (users.must_change_password = 1) and
// returns a fresh session, exactly like /login.
router.post('/password/reset', authLimiter, (req, res) => {
  const [data,] = validate(PasswordResetSchema, req, res);
  if (!data) return;

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(data.username);
  if (!user || !user.must_change_password)
    return res.status(403).json({ error: 'This account does not need a password reset — sign in normally' });

  if (!maybeUpgradePasswordHash(user, data.currentPassword))
    return res.status(401).json({ error: 'Current password is incorrect' });

  if (verifyPassword(data.newPassword, user.password_hash))
    return res.status(400).json({ error: 'New password must be different from the current one' });

  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`
  ).run(hashPassword(data.newPassword), user.id);
  // The forced reset also invalidates any older lingering sessions.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

  const token = createSession(user.id);
  const tags = db
    .prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag ASC')
    .all(user.id)
    .map(t => t.tag);
  console.log(`@${user.username} completed a forced password change`);
  res.json({
    userId: user.id,
    username: user.username,
    token,
    verified: !!user.verified,
    admin: !!user.admin,
    fullName: user.full_name || '',
    tags,
    hasPhoto: user.photo != null,
    timeoutUntil: isoOrNull(user.timeout_until),
  });
});

// POST /logout — destroys the session and clears the Google quick-sign-in
// cookie so "Sign out" really means signed out everywhere on this browser.
router.post('/logout', requireAuth, (req, res) => {
  destroySession(req.user.token);
  updateUserPresence(req.user.id, false); // Mark user as offline
  res.clearCookie(GOOGLE_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// PUT /me/notification-settings — update notification preferences
router.put('/me/notification-settings', requireAuth, (req, res) => {
  const [data,] = validate(NotificationSettingsSchema, req, res);
  if (!data) return;

  db.prepare('UPDATE users SET notification_settings = ? WHERE id = ?').run(data.settings, req.user.id);
  res.json({ ok: true, notificationSettings: data.settings });
});

// POST /verify — grants the ✓ verified badge (admin only; the badge is
// managed from the Admin panel — legacy self-verify was a free-for-all)
router.post('/verify', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true, verified: true });
});

// GET /me — current session state, so clients can pick up admin changes
// (tags, badges, timeouts, demotions) without waiting for the next sign-in.
router.get('/me', requireAuth, (req, res) => {
  const u = db
    .prepare(
      `SELECT id, username, full_name, verified, admin, timeout_until, must_change_password, notification_settings,
              (photo IS NOT NULL) AS has_photo
       FROM users WHERE id = ?`
    )
    .get(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found' });

  // Update presence as online when user checks their session
  updateUserPresence(req.user.id, true);

  res.json({
    userId: u.id,
    username: u.username,
    fullName: u.full_name || '',
    verified: !!u.verified,
    admin: !!u.admin,
    tags: req.user.tags,
    hasPhoto: !!u.has_photo,
    timeoutUntil: isoOrNull(u.timeout_until),
    mustChangePassword: !!u.must_change_password,
    notificationSettings: u.notification_settings || 'all',
  });
});

module.exports = router;
module.exports.sessionPayload = sessionPayload;
module.exports.GOOGLE_COOKIE = GOOGLE_COOKIE;
