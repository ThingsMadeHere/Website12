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

// ── login codes (small-team sign-in) ─────────────────────────────────────────
// Passwords are a bad fit for ~20 students on locked-down school Chromebooks:
// they get reset by IT, forgotten over summer break, or shared verbally. So an
// admin generates short one-time codes instead — "ROBO-4F2K" style, 32-char
// alphabet with the confusing glyphs removed. Codes expire (default 7 days),
// work for ANY existing account (identity = the username you type; the code is
// just the "an admin said you're on the team" proof), and each can be redeemed
// exactly once. Passwords remain as the private fallback (seed-admin script,
// recovery, automation/tests).

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I O 0 1
const CODE_TTL_DAYS = Math.max(1, parseInt(process.env.LOGIN_CODE_TTL_DAYS, 10) || 7);

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatCode(c32) {
  return `${c32.slice(0, 4)}-${c32.slice(4, 8)}`;
}

function randomCode() {
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function generateLoginCode(createdBy, ttlDays = CODE_TTL_DAYS) {
  const code = randomCode();
  const expiresAt = sqlUtcPlus(new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000));
  db.prepare('INSERT INTO login_codes (code, created_by, expires_at) VALUES (?, ?, ?)')
    .run(code, createdBy, expiresAt);
  // opportunistic cleanup of stale/expired codes
  db.prepare(`DELETE FROM login_codes WHERE expires_at < datetime('now') OR used_at IS NOT NULL`).run();
  return { code, formatted: formatCode(code), expiresAt };
}

// Redeem a code for a username → returns { ok } or { error }.
// Unknown usernames are rejected WITHOUT consuming the code, so mistyping your
// name doesn't burn the invite.
function redeemLoginCode(rawCode, username) {
  const code = normalizeCode(rawCode);
  if (!/^[A-Z0-9]{8}$/.test(code)) return { error: 'Codes look like ROBO-4F2K — 8 letters and numbers.' };

  const uname = String(username || '').toLowerCase().trim();
  if (!uname) return { error: 'Enter your username first.' };
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (!user) return { error: `No member named @${uname}. Check the spelling, or apply to join.` };

  const row = db.prepare('SELECT * FROM login_codes WHERE code = ?').get(code);
  if (!row) return { error: 'That code is not valid. Ask a team admin for a new one.' };
  if (row.used_at) return { error: 'That code was already used. Codes are one-time only.' };
  if (new Date(String(row.expires_at).replace(' ', 'T') + 'Z').getTime() < Date.now())
    return { error: 'That code has expired. Ask a team admin for a new one.' };

  db.prepare(`UPDATE login_codes SET used_by = ?, used_at = datetime('now') WHERE code = ?`)
    .run(user.id, code);
  return { ok: true, userId: user.id };
}

function listLoginCodes() {
  return db.prepare(`
    SELECT lc.code, lc.created_at, lc.expires_at, lc.used_at,
           cu.username AS created_by_name, uu.username AS used_by_name
    FROM login_codes lc
    LEFT JOIN users cu ON cu.id = lc.created_by
    LEFT JOIN users uu ON uu.id = lc.used_by
    ORDER BY lc.created_at DESC LIMIT 100
  `).all();
}

function revokeLoginCode(rawCode) {
  const info = db.prepare('DELETE FROM login_codes WHERE code = ? AND used_at IS NULL')
    .run(normalizeCode(rawCode));
  return info.changes > 0;
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
  generateLoginCode, redeemLoginCode, listLoginCodes, revokeLoginCode,
  formatCode, CODE_TTL_DAYS,
};
