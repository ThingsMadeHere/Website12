const crypto = require('crypto');
const { db } = require('./db');

// ── password hashing (scrypt, no external deps) ──────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

// ── sessions ─────────────────────────────────────────────────────────────────

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Express middleware: requires a valid session token.
// Accepts `Authorization: Bearer <token>` or `x-auth-token: <token>`.
function requireAuth(req, res, next) {
  let token = null;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!token) token = req.headers['x-auth-token'] || null;

  if (!token) return res.status(401).json({ error: 'Not signed in' });

  const row = db
    .prepare(
      `SELECT s.token, u.id AS user_id, u.username, u.verified
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);

  if (!row) return res.status(401).json({ error: 'Session expired — please sign in again' });

  db.prepare(`UPDATE sessions SET last_seen = datetime('now') WHERE token = ?`).run(token);
  req.user = { id: row.user_id, username: row.username, verified: !!row.verified, token };
  next();
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, requireAuth };
