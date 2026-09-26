'use strict';
// ── auth ─────────────────────────────────────────────────────────────────────
// Passwords: bcryptjs (pure JS — no native build step, so PM2's bundled node
// or a different NODE_MODULE_VERSION can never break it the way
// better-sqlite3/bcrypt native addons do). Legacy scrypt hashes ("hex:hex")
// are still accepted on login and transparently upgraded to bcrypt.
//
// Sessions: signed JWTs (jsonwebtoken) that carry only a session id; the id
// maps to a row in `sessions` so logout/revocation stay instant (JWTs alone
// can't be revoked). The signing key persists in the `settings` table, so
// sessions survive restarts and no env var is required.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_DAYS = Math.max(1, parseInt(process.env.SESSION_TTL_DAYS, 10) || 30);

// ── password hashing ─────────────────────────────────────────────────────────

function hashPassword(password) {
  return bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
}

function isLegacyScrypt(stored) {
  return /^[0-9a-f]{16,64}:[0-9a-f]{64,256}$/i.test(String(stored));
}

function verifyLegacyScrypt(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

// Returns { ok, needsRehash } — needsRehash means `stored` was a legacy scrypt
// hash that verified; callers should upgrade it via hashPassword().
function verifyPasswordFull(password, stored) {
  const s = String(stored || '');
  if (isLegacyScrypt(s)) return { ok: verifyLegacyScrypt(password, s), needsRehash: true };
  if (s.startsWith('$2a$') || s.startsWith('$2b$')) {
    try { return { ok: bcrypt.compareSync(String(password), s), needsRehash: false }; }
    catch { return { ok: false, needsRehash: false }; }
  }
  return { ok: false, needsRehash: false }; // e.g. '!join-key' sentinel — never verifies
}

function verifyPassword(password, stored) {
  return verifyPasswordFull(password, stored).ok;
}

// Transparent legacy-hash upgrade used by every login path.
function maybeUpgradePasswordHash(user, password) {
  const r = verifyPasswordFull(password, user.password_hash);
  if (r.ok && r.needsRehash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    console.log(`Upgraded legacy scrypt hash for @${user.username} to bcrypt`);
  }
  return r.ok;
}

// ── JWT signing key (persisted in settings) ──────────────────────────────────

const SECRET_SETTING = 'jwt_secret';

function getJwtSecret() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SECRET_SETTING);
  if (row && row.value) return row.value;
  const secret = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(SECRET_SETTING, secret);
  return secret;
}

// ── join keys (small-team sign-in, self-service) ─────────────────────────────
// Passwords are a bad fit for ~20 students on locked-down school Chromebooks:
// they get reset by IT, forgotten over summer break, or shared verbally. So
// the admin sets ONE shared team key (like a Wi-Fi password) in the Admin
// panel — students pick a username and sign in with the key whenever they
// like. Outsiders without the key can only submit a join application, which
// an admin approves. The key is stored hashed (sha256); rotation never locks
// out existing sessions. Passwords remain as a fallback for recovery accounts.

const KEY_TTL_DAYS = Math.max(1, parseInt(process.env.JOIN_KEY_TTL_DAYS, 10) || 180);
const JOIN_KEY_SETTING = 'join_key';

function normalizeKey(raw) {
  // uppercase, strip decoration; keep letters+digits only ("robo key 2026" → "ROBOKEY2026")
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getKeyHash(raw) {
  return crypto.createHash('sha256').update(normalizeKey(raw)).digest('hex');
}

function getJoinKeyInfo() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(JOIN_KEY_SETTING);
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value); // { hash, label, createdAt, expiresAt }
  } catch {
    return null;
  }
}

// SQLite-safe UTC 'YYYY-MM-DD HH:MM:SS'
function sqlUtcPlus(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function setJoinKey(rawKey, createdBy, label = '', ttlDays = KEY_TTL_DAYS) {
  const clean = String(rawKey || '').trim();
  if (normalizeKey(clean).length < 6)
    return { error: 'The team key should be at least 6 characters (letters and numbers).' };
  const rec = {
    hash: getKeyHash(clean),
    label: String(label || clean).slice(0, 60),
    createdAt: sqlUtcPlus(new Date()),
    expiresAt: sqlUtcPlus(new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)),
  };
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JOIN_KEY_SETTING, JSON.stringify(rec));
  return { ok: true, ...rec };
}

function clearJoinKey() {
  db.prepare('DELETE FROM settings WHERE key = ?').run(JOIN_KEY_SETTING);
}

// Sign-in check: correct key + free username → create the account & session.
// Returns { ok, userId } | { pending } | { apply } | { error }.
function joinWithKey(rawUsername, rawKey) {
  const uname = String(rawUsername || '').toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(uname))
    return { error: 'Usernames: 3–20 letters, numbers, or underscores.' };

  const info = getJoinKeyInfo();
  if (!info)
    return { error: 'Sign-in is not open yet. An admin must set the team key first, or you can apply to join.' };
  if (new Date(info.expiresAt.replace(' ', 'T') + 'Z').getTime() < Date.now())
    return { error: 'The team key has expired. Ask an admin to update it, or apply to join.' };

  const key = normalizeKey(rawKey);
  if (!key) return { error: 'Enter the team key.' };
  const expected = Buffer.from(info.hash, 'utf8');
  const actual = Buffer.from(getKeyHash(key), 'utf8');
  const keyOk = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  const existing = db.prepare('SELECT id, verified FROM users WHERE username = ?').get(uname);
  if (!keyOk) {
    if (existing) return { error: 'Wrong team key for that account.' };
    const pending = db
      .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'pending'`)
      .get(uname);
    if (pending) return { pending: true };
    return { apply: true };
  }

  if (existing) return { ok: true, userId: existing.id };

  const res = db
    .prepare(`INSERT INTO users (username, password_hash, verified) VALUES (?, ?, 1)`)
    .run(uname, '!join-key'); // '!' prefix: bcrypt/scrypt formats can never match this, so no password login
  return { ok: true, userId: Number(res.lastInsertRowid) };
}

// ── sessions (DB row + JWT pointer) ──────────────────────────────────────────

function createSession(userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  const expiresIn = SESSION_TTL_DAYS * 24 * 60 * 60;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    sid, userId, sqlUtcPlus(new Date(Date.now() + expiresIn * 1000))
  );
  return jwt.sign({ sid }, getJwtSecret(), { expiresIn });
}

function resolveSessionToken(token) {
  // Verify the JWT wrapper first (cheap HMAC), then look up the DB row so
  // revocation (logout, admin kick, forced reset) stays instant.
  let payload;
  try {
    payload = jwt.verify(String(token), getJwtSecret());
  } catch {
    return null;
  }
  return db
    .prepare(
      `SELECT s.token, s.expires_at, u.id AS user_id, u.username, u.verified, u.admin,
              u.timeout_until, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(payload.sid) || null;
}

function destroySession(token) {
  let sid = token;
  try { sid = jwt.verify(String(token), getJwtSecret()).sid; } catch { /* raw sid also fine */ }
  db.prepare('DELETE FROM sessions WHERE token = ?').run(sid);
}

// Express middleware: requires a valid session token.
// Accepts `Authorization: Bearer <token>` or `x-auth-token: <token>`.
function requireAuth(req, res, next) {
  let token = null;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!token) token = req.headers['x-auth-token'] || null;

  if (!token) return res.status(401).json({ error: 'Not signed in' });

  const row = resolveSessionToken(token);
  if (!row) return res.status(401).json({ error: 'Session expired — please sign in again' });

  const tags = db
    .prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag ASC')
    .all(row.user_id)
    .map(t => t.tag);

  db.prepare(`UPDATE sessions SET last_seen = datetime('now') WHERE token = ?`).run(row.token);
  req.user = {
    id: row.user_id,
    username: row.username,
    verified: !!row.verified,
    admin: !!row.admin,
    tags,
    timeoutUntil: parseSqliteUtc(row.timeout_until), // Date | null
    mustChangePassword: !!row.must_change_password,
    token, // opaque to the caller — destroySession() unwraps it
  };
  next();
}

// Express middleware: blocks write actions while a member is timed out.
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

function requireAdmin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → Date | null
function parseSqliteUtc(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function listUsersForAdmin() {
  return db.prepare(`
    SELECT u.id, u.username, u.full_name, u.admin, u.verified,
           u.timeout_until, u.created_at,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS active_sessions
    FROM users u ORDER BY u.username
  `).all();
}

function revokeUserSessions(userId) {
  const info = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return info.changes;
}

module.exports = {
  hashPassword, verifyPassword, verifyPasswordFull, maybeUpgradePasswordHash,
  createSession, destroySession, resolveSessionToken,
  requireAuth, requireAdmin, blockIfTimedOut, parseSqliteUtc,
  // join-key sign-in (small team, self-service)
  getJoinKeyInfo, setJoinKey, clearJoinKey, joinWithKey, normalizeKey,
  listUsersForAdmin, revokeUserSessions, KEY_TTL_DAYS, SESSION_TTL_DAYS,
};
