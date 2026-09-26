'use strict';
// ── Google Sign-In ───────────────────────────────────────────────────────────
// Replaces custom accounts (team key / passwords) as the primary sign-in:
// students click "Continue with Google", the browser obtains an ID token from
// Google (via the official Google Identity Services script — loaded on demand
// by src/utils/googleSignIn.js), and we verify that token SERVER-SIDE with
// google-auth-library (signature + issuer + audience + expiry). No password
// database, no reset flows, nothing to forget on Chromebooks.
//
// Access control (the replacement for the old join-key / application flow):
//   GOOGLE_ALLOWED_DOMAINS  comma-separated email domains allowed to sign in,
//                           e.g. "mcsd47.org,sacredheartofmilford.org".
//                           Empty/unset = any verified Google account may
//                           sign in (fine for testing; set it in production!).
//   GOOGLE_ALLOWLIST        optional comma-separated exact emails that are
//                           always allowed even when their domain is blocked.
//   ADMIN_EMAILS            emails whose first-time sign-in gets admin rights
//                           (replaces the hardcoded ADMIN_USERNAMES list).
// Everyone else who tries to sign in lands in the `google_denied` table so an
// admin can see them and add their school domain (or approve the address).
//
// Configuration lives in api/.env — see .env.example.

const { db } = require('./db');
const { OAuth2Client } = require('google-auth-library');
const { createSession, sqlUtcPlus } = require('./auth');

// One client for token verification; keeps no state of its own.
let oauthClient = null;
function getClient() {
  const id = process.env.GOOGLE_CLIENT_ID || '';
  if (!id) return null;
  if (!oauthClient || oauthClient._clientId !== id) oauthClient = new OAuth2Client(id);
  return oauthClient;
}

// Parsed, cached-by-call env lists (these change only via restart/PM2 reload).
const csv = (v) => String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const allowedDomains = () => csv(process.env.GOOGLE_ALLOWED_DOMAINS);
const allowlist      = () => csv(process.env.GOOGLE_ALLOWLIST);
const adminEmails    = () => csv(process.env.ADMIN_EMAILS);

function isConfigured() {
  return !!process.env.GOOGLE_CLIENT_ID;
}

// Schema migration (called from initDb): users gain identity columns, and a
// small table records sign-ins that were rejected so admins can review them.
const googleMigrations = [
  ['email',       'TEXT'],
  ['email_verified', 'INTEGER NOT NULL DEFAULT 0'],
  ['picture_url', 'TEXT'],
];

function migrateGoogle(dbRef) {
  const userCols = dbRef.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  for (const [col, decl] of googleMigrations) {
    if (!userCols.includes(col)) {
      dbRef.exec(`ALTER TABLE users ADD COLUMN ${col} ${decl}`);
      console.log(`Migration: added users.${col} column (Google Sign-In)`);
    }
  }
  dbRef.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');
  dbRef.exec(`
    CREATE TABLE IF NOT EXISTS google_denied (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE,
      name          TEXT    NOT NULL DEFAULT '',
      attempts      INTEGER NOT NULL DEFAULT 1,
      last_attempt  TEXT    NOT NULL DEFAULT (datetime('now')),
      reviewed      INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// Deterministic, valid local username derived from an email address
// ("Alex.Trujillo@mchsrobotics.dev" → "alextrujillo", collisions get a suffix).
function suggestUsername(email) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  let base = (local || 'member').slice(0, 28).replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
  if (base.length < 3) base = (base + 'member').slice(0, 20);
  let name = base, i = 2;
  while (db.prepare('SELECT id FROM users WHERE username = ?').get(name)) {
    name = `${base}${i++}`;
    if (i > 999) return null; // pathological — effectively impossible
  }
  return name;
}

// Verify a Google ID token (JWT) server-side and return the profile claims.
async function verifyGoogleCredential(credential) {
  const client = getClient();
  if (!client) return { error: 'Google Sign-In is not configured on this server (set GOOGLE_CLIENT_ID in api/.env).' };
  if (!credential || typeof credential !== 'string') return { error: 'Missing Google credential.' };
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
  } catch {
    return { error: 'That Google sign-in token could not be verified. Please try again.' };
  }
  const p = ticket.getPayload() || {};
  if (!p.email) return { error: 'Your Google account did not share an email address.' };
  return {
    profile: {
      sub: p.sub,
      email: String(p.email).toLowerCase(),
      emailVerified: !!p.email_verified,
      name: String(p.name || p.given_name || '').slice(0, 80),
      picture: typeof p.picture === 'string' ? p.picture : null,
    },
  };
}

function accessAllowed(email) {
  const domain = email.split('@')[1] || '';
  if (allowlist().includes(email)) return true;
  const domains = allowedDomains();
  if (!domains.length) return true; // no restriction configured
  return domains.includes(domain.toLowerCase());
}

// Full sign-in flow: verify token → gate by domain → find-or-create the user
// row → return the standard session payload (same shape as /api/login).
async function loginWithGoogle(credential) {
  const v = await verifyGoogleCredential(credential);
  if (v.error) return { error: v.error };
  const prof = v.profile;

  if (!accessAllowed(prof.email)) {
    // Record it so an admin can see who tried and adjust GOOGLE_ALLOWED_DOMAINS.
    db.prepare(`
      INSERT INTO google_denied (email, name) VALUES (?, ?)
      ON CONFLICT(email) DO UPDATE SET
        attempts = attempts + 1,
        last_attempt = datetime('now'),
        name = excluded.name
    `).run(prof.email, prof.name);
    const domains = allowedDomains();
    return {
      denied: true,
      email: prof.email,
      error: domains.length
        ? `@${prof.email.split('@')[1]} isn't an approved school domain yet. An admin was notified — ask them to allow your school's email.`
        : 'This account cannot sign in right now. Please contact a team admin.',
    };
  }

  // Find by email first (identity follows the person across username changes),
  // then fall back to the legacy username (first part of the email) so accounts
  // created by the old join-key/application flow link up automatically.
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(prof.email);
  if (!user) {
    const guess = String(prof.email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (guess) user = db.prepare('SELECT * FROM users WHERE username = ? AND email IS NULL').get(guess);
  }

  if (user) {
    db.prepare(`
      UPDATE users
         SET email = ?, email_verified = ?, picture_url = ?,
             full_name = CASE WHEN full_name = '' OR full_name IS NULL THEN ? ELSE full_name END
       WHERE id = ?
    `).run(prof.email, prof.emailVerified ? 1 : 0, prof.picture, prof.name, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  } else {
    const username = suggestUsername(prof.email);
    if (!username) return { error: 'Could not allocate a username for this account. Ask an admin.' };
    const isAdmin = adminEmails().includes(prof.email) ? 1 : 0;
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, email_verified, picture_url, verified, admin)
      VALUES (?, '!', ?, ?, ?, ?, 1, ?)
    `).run(username, prof.name, prof.email, prof.emailVerified ? 1 : 0, prof.picture, isAdmin);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    if (isAdmin) {
      db.prepare(`INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, 'admin')`).run(user.id);
    }
    console.log(`Google sign-in created @${username} <${prof.email}>${isAdmin ? ' (admin)' : ''}`);
  }

  if (!user.verified) {
    return {
      pending: true,
      error: 'Your account is waiting for an admin to approve it. Try again after you are verified.',
    };
  }

  return { ok: true, user };
}

// Admin helper: recent sign-ins that were blocked by the domain gate.
function listDeniedEmails() {
  return db.prepare(`
    SELECT id, email, name, attempts, last_attempt AS lastAttempt
    FROM google_denied WHERE reviewed = 0
    ORDER BY last_attempt DESC LIMIT 100
  `).all();
}

function markDeniedReviewed(id) {
  db.prepare('UPDATE google_denied SET reviewed = 1 WHERE id = ?').run(Number(id) || 0);
}

module.exports = {
  isConfigured,
  migrateGoogle,
  verifyGoogleCredential,
  loginWithGoogle,
  listDeniedEmails,
  markDeniedReviewed,
  sqlUtcPlus, // re-exported for symmetry; auth.js owns it
};
