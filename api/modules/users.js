'use strict';
// ── shared photo + user-row helpers ──────────────────────────────────────────
// The photo contract ({ mime, data(base64) }) is used by applications, the
// profile page and the admin panel — one decoder instead of three copies.

const { db } = require('../db');
const { isoOrNull } = require('./util');

const PHOTO_MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const USERNAME_RE = /^[a-z0-9._-]{1,32}$/;

// Returns { mime, buf } or { error }.
function decodePhoto(photo) {
  const ext = PHOTO_MIMES[(photo || {}).mime];
  if (!ext) return { error: 'Photo must be JPG, PNG, WebP, or GIF' };
  let buf;
  try { buf = Buffer.from(String(photo.data || ''), 'base64'); } catch { buf = null; }
  if (!buf || buf.length < 64) return { error: 'Photo data is invalid' };
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'Photo is too large (max 6 MB)' };
  return { mime: photo.mime, buf };
}

// Shared SELECT for admin-style user rows (tags + last activity included).
const ADMIN_USER_SELECT = `
  SELECT u.id, u.username, u.full_name, u.verified, u.admin, u.timeout_until,
         u.must_change_password, u.created_at,
         (u.photo IS NOT NULL) AS has_photo,
         (SELECT GROUP_CONCAT(t.tag, ',') FROM user_tags t WHERE t.user_id = u.id) AS tags,
         (SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
  FROM users u
`;

function adminUserRow(u) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name || '',
    verified: !!u.verified,
    admin: !!u.admin,
    tags: u.tags ? String(u.tags).split(',') : [],
    timeoutUntil: isoOrNull(u.timeout_until),
    mustChangePassword: !!u.must_change_password,
    hasPhoto: !!u.has_photo,
    createdAt: u.created_at,
    lastSeen: u.last_seen || null,
  };
}

// Fetch a user row or send the 404 — returns null when missing.
function getUserOr404(id, res) {
  const u = db.prepare(`${ADMIN_USER_SELECT} WHERE u.id = ?`).get(id);
  if (!u) { res.status(404).json({ error: 'Member not found' }); return null; }
  return u;
}

module.exports = {
  PHOTO_MIMES, MAX_PHOTO_BYTES, USERNAME_RE,
  decodePhoto, ADMIN_USER_SELECT, adminUserRow, getUserOr404,
};
