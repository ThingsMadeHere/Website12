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

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → Date | null
function parseSqliteUtc(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

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
      `SELECT s.token, u.id AS user_id, u.username, u.verified, u.admin,
              u.timeout_until, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);

  if (!row) return res.status(401).json({ error: 'Session expired — please sign in again' });

  const tags = db
    .prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag ASC')
    .all(row.user_id)
    .map(t => t.tag);

  db.prepare(`UPDATE sessions SET last_seen = datetime('now') WHERE token = ?`).run(token);
  req.user = {
    id: row.user_id,
    username: row.username,
    verified: !!row.verified,
    admin: !!row.admin,
    tags,
    timeoutUntil: parseSqliteUtc(row.timeout_until), // Date | null
    mustChangePassword: !!row.must_change_password,
    token,
  };
  next();
}

// Express middleware: blocks write actions while a member is timed out.
// Read-only browsing (and signing in) still works — timeouts stop posting.
function blockIfTimedOut(req, res, next) {
  const until = req.user?.timeoutUntil;
  if (until && until.getTime() > Date.now()) {
    return res.status(403).json({
      code: 'timeout',
      error: 'You are timed out and cannot post right now. Talk to an admin if you think this is a mistake.',
      until: until.toISOString(),
    });
  }
  next();
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, destroySession,
  requireAuth, blockIfTimedOut, parseSqliteUtc,
};
