'use strict';
// ── users: profile, availability & member directory routes ──────────────────
// Everything a signed-in member can do about themselves (profile fields,
// photo, availability blocks) plus the public-ish /api/users/* lookups the
// chat client polls. Mounted at /api by index.js.

const express = require('express');
const { db } = require('../db');
const { requireAuth, blockIfTimedOut } = require('../auth');
const { validate, ProfileSchema } = require('../modules/schemas');
const { isoOrNull } = require('../modules/util');
const { PHOTO_MIMES, MAX_PHOTO_BYTES } = require('../modules/users');

const router = express.Router();

// PUT /api/profile — update profile information (full name)
router.put('/profile', requireAuth, blockIfTimedOut, (req, res) => {
  const [data,] = validate(ProfileSchema, req, res);
  if (!data) return;
  db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(data.fullName, req.user.id);
  res.json({ ok: true });
});

// POST /api/profile/photo — upload profile photo { photo: { mime, data } }
router.post('/profile/photo', requireAuth, blockIfTimedOut, (req, res) => {
  const photo = (req.body || {}).photo;
  if (!photo) {
    return res.status(400).json({ error: 'No photo provided' });
  }

  const mime = photo.mime || photo.type;
  const ext = PHOTO_MIMES[mime];
  if (!ext) {
    return res.status(400).json({ error: 'Photo must be JPG, PNG, WebP, or GIF' });
  }

  let buf;
  try {
    // Handle both base64 string and FormData
    const dataStr = photo.data || photo;
    buf = Buffer.from(String(dataStr), 'base64');
  } catch {
    return res.status(400).json({ error: 'Photo data is invalid' });
  }

  if (buf.length < 64) {
    return res.status(400).json({ error: 'Photo data is invalid' });
  }
  if (buf.length > MAX_PHOTO_BYTES) {
    return res.status(400).json({ error: 'Photo is too large (max 6 MB)' });
  }

  db.prepare('UPDATE users SET photo = ?, photo_mime = ? WHERE id = ?').run(buf, mime, req.user.id);
  res.json({ ok: true });
});

// GET /api/availability — get user's availability blocks
router.get('/availability', requireAuth, (_, res) => {
  const rows = db
    .prepare('SELECT * FROM user_availability WHERE user_id = ? ORDER BY date ASC, start_time ASC')
    .all(req.user.id);
  res.json(rows);
});

// POST /api/availability — create availability block
router.post('/availability', requireAuth, blockIfTimedOut, (req, res) => {
  const { title, date, startTime, endTime, location, repeatType } = req.body || {};

  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }

  const insert = db.prepare(`
    INSERT INTO user_availability (user_id, title, date, start_time, end_time, location, repeat_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const info = insert.run(
    req.user.id,
    title || null,
    date,
    startTime || null,
    endTime || null,
    location || null,
    repeatType || 'none'
  );

  res.json({ id: info.lastInsertRowid, ok: true });
});

// DELETE /api/availability/:id — delete availability block
router.delete('/availability/:id', requireAuth, blockIfTimedOut, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT user_id FROM user_availability WHERE id = ?').get(id);

  if (!row) {
    return res.status(404).json({ error: 'Availability block not found' });
  }

  if (!req.user.admin && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('DELETE FROM user_availability WHERE id = ?').run(id);
  res.json({ ok: true });
});

// GET /api/users/:id/photo — profile picture (admins, or the member themself)
router.get('/users/:id/photo', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!req.user.admin && req.user.id !== id)
    return res.status(403).json({ error: 'Forbidden' });
  const row = db.prepare('SELECT photo, photo_mime FROM users WHERE id = ?').get(id);
  if (!row || !row.photo) return res.status(404).json({ error: 'No photo' });
  res.set('Cache-Control', 'private, max-age=300');
  res.type(row.photo_mime || 'application/octet-stream').send(row.photo);
});

// GET /api/users/mentionable — usernames for the @-mention autocomplete.
// Authenticated so guests can't enumerate the roster; verified members only.
router.get('/users/mentionable', requireAuth, (_, res) => {
  const rows = db
    .prepare(
      `SELECT u.username, u.full_name, u.admin,
              COALESCE(group_concat(t.tag, ','), '') AS tags
       FROM users u
       LEFT JOIN user_tags t ON t.user_id = u.id AND t.tag != 'admin'
       WHERE u.verified = 1
       GROUP BY u.id
       ORDER BY u.username`
    )
    .all();
  res.json(rows.map(r => ({
    username: r.username,
    name: r.full_name || r.username,
    admin: !!r.admin,
    tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
  })));
});

// GET /api/users/verified — map of userId → verified (for chat badges)
router.get('/users/verified', (_, res) => {
  const rows = db.prepare('SELECT id, verified FROM users').all();
  const map = {};
  rows.forEach(r => { map[r.id] = !!r.verified; });
  res.json(map);
});

// GET /api/users/count — total registered members
router.get('/users/count', (_, res) => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  res.json({ count: row.n });
});

module.exports = router;
module.exports.isoOrNull = isoOrNull; // re-export convenience for sibling routers
