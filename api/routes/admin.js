'use strict';
// ── admin routes: member management ──────────────────────────────────────────
// Powers the Admin panel: list members, create accounts, edit profile info &
// photos, manage role tags, hand out timeouts, and force password resets.
// Mounted by index.js at '/api/admin' — paths here are relative ('/users').
// Cross-module logic goes through the shared modules only (tags, users,
// applications) — never into another route file.

const express = require('express');
const { db, ADMIN_USERNAMES } = require('../db');
const { hashPassword, requireAuth, requireAdmin } = require('../auth');
const { normalizeTags, replaceTags } = require('../modules/tags');
const { USERNAME_RE, decodePhoto, ADMIN_USER_SELECT, adminUserRow, getUserOr404 } = require('../modules/users');
const { sqlUtc } = require('../modules/util');
const { approveApplication } = require('./applications');

const router = express.Router();

// GET /api/admin/users?search=  (admin) — every member, newest info first
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  let rows = db.prepare(`${ADMIN_USER_SELECT} ORDER BY u.username COLLATE NOCASE ASC`).all();
  const q = String(req.query.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter(r =>
      r.username.toLowerCase().includes(q) ||
      (r.full_name || '').toLowerCase().includes(q) ||
      (r.tags || '').toLowerCase().includes(q));
  }
  res.json(rows.map(adminUserRow));
});

// POST /api/admin/users  (admin) — create an account directly (no application).
// { username, password, fullName?, photo?: {mime,data}, tags?: [], verified?, mustChangePassword? }
router.post('/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, fullName, photo, tags, verified, mustChangePassword } = req.body || {};

  const cleaned = String(username || '').toLowerCase().trim();
  if (!cleaned) return res.status(400).json({ error: 'username is required' });
  if (!USERNAME_RE.test(cleaned))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, and . _ - characters (max 32)' });
  if (!password || String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(cleaned))
    return res.status(409).json({ error: `Username '${cleaned}' is already taken` });

  let photoMime = null, photoBuf = null;
  if (photo && (photo.mime || photo.data)) {
    const p = decodePhoto(photo);
    if (p.error) return res.status(400).json({ error: p.error });
    photoMime = p.mime; photoBuf = p.buf;
  }

  const normalized = normalizeTags(tags || []);
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, full_name, photo_mime, photo, verified, admin, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cleaned,
      hashPassword(String(password)),
      String(fullName || '').trim().slice(0, 80),
      photoMime, photoBuf,
      verified === undefined ? 1 : (verified ? 1 : 0), // admin-created accounts are trusted by default
      normalized.tags.includes('admin') ? 1 : 0,
      mustChangePassword ? 1 : 0
    );
  replaceTags(info.lastInsertRowid, normalized.tags);

  // A pending application for the same username can no longer be approved —
  // flag it so the Applications page doesn't confuse anyone later.
  db.prepare(
    `UPDATE applications SET status = 'denied', decided_by = ?, decided_at = datetime('now')
     WHERE username = ? AND status = 'pending'`
  ).run(req.user.id, cleaned);

  console.log(`Account @${cleaned} created by ${req.user.username}${mustChangePassword ? ' (must change password at first login)' : ''}`);
  const u = getUserOr404(info.lastInsertRowid, res);
  if (u) res.json(adminUserRow(u));
});

// PATCH /api/admin/users/:id  (admin) — update account info.
// Any subset of: { username?, fullName?, verified?, password?,
//                  mustChangePassword?, photo?: {mime,data} | null }
// photo: null removes the picture; omitting it leaves it untouched.
router.patch('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Member not found' });

  const body = req.body || {};
  const sets = [], params = [];
  const notes = [];

  if (body.username !== undefined) {
    const cleaned = String(body.username).toLowerCase().trim();
    if (!USERNAME_RE.test(cleaned))
      return res.status(400).json({ error: 'Username may only contain letters, numbers, and . _ - characters (max 32)' });
    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(cleaned, id);
    if (clash) return res.status(409).json({ error: `Username '${cleaned}' is already taken` });
    if (cleaned !== existing.username) {
      sets.push('username = ?'); params.push(cleaned);
      notes.push(`username ${existing.username} → ${cleaned}`);
    }
  }

  if (body.fullName !== undefined) {
    sets.push('full_name = ?');
    params.push(String(body.fullName).trim().slice(0, 80));
  }

  if (body.verified !== undefined) {
    sets.push('verified = ?'); params.push(body.verified ? 1 : 0);
    notes.push(body.verified ? 'verified ✓ on' : 'verified ✓ off');
  }

  if (body.password !== undefined) {
    if (String(body.password).length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    sets.push('password_hash = ?'); params.push(hashPassword(String(body.password)));
    notes.push('password set by admin');
  }

  if (body.mustChangePassword !== undefined) {
    sets.push('must_change_password = ?'); params.push(body.mustChangePassword ? 1 : 0);
    notes.push(body.mustChangePassword ? 'must change password at next login' : 'forced password reset cleared');
  }

  if (body.photo !== undefined) {
    if (body.photo === null) {
      sets.push('photo = NULL', 'photo_mime = NULL');
      notes.push('photo removed');
    } else {
      const p = decodePhoto(body.photo);
      if (p.error) return res.status(400).json({ error: p.error });
      sets.push('photo = ?', 'photo_mime = ?'); params.push(p.buf, p.mime);
      notes.push('photo updated');
    }
  }

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  console.log(`Admin ${req.user.username} updated @${existing.username}${notes.length ? ` (${notes.join(', ')})` : ''}`);

  const u = getUserOr404(id, res);
  if (u) res.json(adminUserRow(u));
});

// PUT /api/admin/users/:id/tags  { tags: [...] }  (admin) — replace the full
// tag set. The 'admin' tag drives the users.admin flag; you cannot remove
// your own (that would lock you out of the panel mid-session).
router.put('/users/:id/tags', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, username, admin FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Member not found' });

  const normalized = normalizeTags((req.body || {}).tags);
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  if (id === req.user.id && !normalized.tags.includes('admin'))
    return res.status(400).json({ error: 'You cannot remove your own admin tag' });

  replaceTags(id, normalized.tags);

  if (normalized.tags.includes('admin') && !existing.admin)
    console.log(`@${existing.username} promoted to admin by ${req.user.username}`);
  if (!normalized.tags.includes('admin') && existing.admin && id !== req.user.id)
    console.log(`@${existing.username} demoted from admin by ${req.user.username}`);
  if (ADMIN_USERNAMES.includes(existing.username) && !normalized.tags.includes('admin'))
    console.log(`Note: @${existing.username} is in ADMIN_USERNAMES and will be re-promoted on the next server restart`);

  const u = getUserOr404(id, res);
  if (u) res.json(adminUserRow(u));
});

// POST /api/admin/users/:id/timeout  (admin)
//   { minutes: n }        → timed out for n minutes from now
//   { until: <ISO date> } → timed out until that moment
//   { clear: true }       → lift the timeout
// Timed-out members can still sign in and read; posting is blocked.
router.post('/users/:id/timeout', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Member not found' });

  if (id === req.user.id)
    return res.status(400).json({ error: 'You cannot time yourself out' });

  const { minutes, until, clear } = req.body || {};
  let value = null;

  if (!clear) {
    let when = null;
    if (minutes !== undefined && minutes !== null) {
      const mins = Number(minutes);
      if (!Number.isFinite(mins) || mins < 1 || mins > 60 * 24 * 366)
        return res.status(400).json({ error: 'minutes must be between 1 and 527040 (1 year)' });
      when = new Date(Date.now() + mins * 60 * 1000);
    } else if (until) {
      when = new Date(String(until));
      if (isNaN(when.getTime()))
        return res.status(400).json({ error: 'until must be a valid date/time' });
    } else {
      return res.status(400).json({ error: 'Provide minutes, until, or clear: true' });
    }
    if (when.getTime() <= Date.now())
      return res.status(400).json({ error: 'Timeout end must be in the future (use clear to lift it)' });
    value = sqlUtc(when);
  }

  db.prepare('UPDATE users SET timeout_until = ? WHERE id = ?').run(value, id);

  if (value) {
    // Kick live sessions' write access immediately is handled by the guard on
    // every write endpoint — but also note it in the log.
    console.log(`@${existing.username} timed out until ${value} UTC by ${req.user.username}`);
  } else {
    console.log(`Timeout for @${existing.username} lifted by ${req.user.username}`);
  }

  const u = getUserOr404(id, res);
  if (u) res.json(adminUserRow(u));
});

module.exports = router;
