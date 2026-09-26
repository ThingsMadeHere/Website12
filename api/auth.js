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

// ── join keys (small-team sign-in, self-service) ─────────────────────────────
// Passwords are a bad fit for ~20 students on locked-down school Chromebooks:
// they get reset by IT, forgotten over summer break, or shared verbally. And a
// code that works only once means every single login needs the club president's
// help. So instead: the admin sets ONE shared team key (like a Wi-Fi password)
// in the Admin panel — e.g. "ROBO-KEY-2026". Students pick their own username
// and sign in with the key whenever they like, no approval step, no admin
// assistance. The manual gate stays where it belongs: at the front door —
// outsiders without the key can only submit a join application, which an admin
// then approves. Admins can rotate the key any time (end of year, if it leaks);
// sessions already handed out stay valid until logout, so rotating never locks
// the whole team out by accident. Passwords remain as a private fallback for
// the seed/recovery/automation accounts.

const KEY_TTL_DAYS = Math.max(1, parseInt(process.env.JOIN_KEY_TTL_DAYS, 10) || 180);
const JOIN_KEY_SETTING = 'join_key';

function normalizeKey(raw) {
  // uppercase, strip decoration; keep letters+digits only ("robo key 2026" → "ROBOKEY2026")
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getKeyHash(raw) {
  return crypto.createHash('sha256').update(normalizeKey(raw)).digest('hex');
}

// Current team key (stored hashed; we can't read it back — rotation replaces it)
function getJoinKeyInfo() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(JOIN_KEY_SETTING);
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value); // { hash, label, createdAt, expiresAt }
  } catch {
    return null;
  }
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
// Returns { ok, userId } | { pending } | { error }. No admin needed per login;
// knowing the key IS the membership proof.
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
    // Outsiders can't brute-force accounts — but they can raise an application
    // for admin review (the manual-approval gate lives here, at the front door).
    const pending = db
      .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'pending'`)
      .get(uname);
    if (pending) return { pending: true };
    return { apply: true };
  }

  if (existing) return { ok: true, userId: existing.id };

  const res = db
    .prepare(`INSERT INTO users (username, password_hash, verified) VALUES (?, ?, 1)`)
    .run(uname, '!join-key'); // '!' prefix: scrypt format is hex:hex, so this can never verify as a password
  return { ok: true, userId: Number(res.lastInsertRowid) };
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

// SQLite-safe "now + ms" in UTC 'YYYY-MM-DD HH:MM:SS' form
function sqlUtcPlus(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
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
  // join-key sign-in (small team, self-service)
  getJoinKeyInfo, setJoinKey, clearJoinKey, joinWithKey, normalizeKey,
  listUsersForAdmin, revokeUserSessions, KEY_TTL_DAYS,
};
