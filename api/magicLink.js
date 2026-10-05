// ── magicLink ────────────────────────────────────────────────────────────────
// Passwordless authentication via email magic links.
//
// Flow:
//   1. User enters email → POST /api/auth/magic-link
//   2. Server sends magic link (one-time token) via email
//   3. User clicks link → GET /api/auth/verify?token=...
//   4. Server validates token and sets HTTPOnly session cookie
//
// Token storage: SQLite (magictokens table) with expiry (1 hour)
// Session storage: HTTPOnly cookie with 90-day expiry

const { nanoid } = require('nanoid');
const { sendMail, ADMIN_EMAIL } = require('./mailer');
const fs = require('fs');
const path = require('path');

// Token expiry: 1 hour (seconds)
const TOKEN_TTL = 60 * 60;

// Session cookie options
const SESSION_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days
const SESSION_NAME = 'mchs_session_magic';

// Load .env for DATABASE_PATH before db.js
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Database path matches db.js
const os = require('os');
const defaultDbPath = path.join(os.homedir(), 'JarvisData', 'database', 'mchs.db');
const dbPath = process.env.DATABASE_PATH || defaultDbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let db = null;
function getDb() {
  if (!db) {
    const Database = require('better-sqlite3');
    db = new Database(dbPath);
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS magictokens (
      id            INTEGER      PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token         TEXT         UNIQUE NOT NULL,
      created_at    TEXT         NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT         NOT NULL,
      used_at       TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_magictokens_token ON magictokens(token);
    CREATE INDEX IF NOT EXISTS idx_magictokens_user_id ON magictokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_magictokens_expires_at ON magictokens(expires_at);
    
    -- Cleanup expired tokens automatically (called periodically)
    CREATE TRIGGER IF NOT EXISTS cleanup_expired_tokens
    AFTER INSERT ON magictokens
    BEGIN
      DELETE FROM magictokens WHERE expires_at < datetime('now');
    END;
  `);
}

/**
 * Generate a magic link token for a user
 * Returns: { token, link }
 */
function createToken(userId) {
  const db = getDb();
  const token = nanoid(32); // URL-safe random token
  const expiresAt = new Date(Date.now() + TOKEN_TTL * 1000).toISOString();
  
  db.prepare(`
    INSERT INTO magictokens (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, token, expiresAt);
  
  // Return token only (link is constructed by caller)
  return token;
}

/**
 * Verify a magic link token and return user data if valid
 */
function verifyToken(token) {
  const db = getDb();
  const now = new Date().toISOString();
  
  // Find valid, unused token
  const row = db.prepare(`
    SELECT t.id, t.user_id, t.used_at, u.username, u.full_name, u.verified, u.admin, u.email
    FROM magictokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token = ? AND t.expires_at > ? AND t.used_at IS NULL
  `).get(token, now);
  
  if (!row) return null;
  
  // Mark token as used
  db.prepare('UPDATE magictokens SET used_at = datetime(''now'') WHERE id = ?').run(row.id);
  
  return {
    userId: row.user_id,
    username: row.username,
    fullName: row.full_name,
    verified: !!row.verified,
    admin: !!row.admin,
    email: row.email
  };
}

/**
 * Send magic link email to user
 */
async function sendMagicLink({ to, username, token }) {
  const publicUrl = process.env.PUBLIC_URL || 'https://mchsrobotics.dev';
  const verifyUrl = `${publicUrl}/api/auth/verify?token=${token}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>MCHS Robotics - Sign In</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #14532d; margin: 0;">MCHS Robotics</h1>
        <p style="color: #666; margin: 5px 0 0;">Team 5728</p>
      </div>
      
      <h2 style="color: #14532d;">Sign In to the Portal</h2>
      
      <p>Hello ${username || 'Team Member'},</p>
      
      <p>Click the button below to sign in to the MCHS Robotics Portal. This link will expire in 1 hour.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${verifyUrl}" 
           style="display: inline-block; background: #14532d; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
          Sign In
        </a>
      </div>
      
      <p style="font-size: 12px; color: #888;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${verifyUrl}">${verifyUrl}</a>
      </p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      
      <p style="font-size: 11px; color: #999; text-align: center;">
        If you didn't request this email, you can safely ignore it.<br>
        Your account will remain secure.
      </p>
    </body>
    </html>
  `;
  
  const text = `
    MCHS Robotics - Sign In
    
    Hello ${username || 'Team Member'},
    
    Click the link below to sign in to the MCHS Robotics Portal.
    This link will expire in 1 hour.
    
    ${verifyUrl}
    
    If you didn't request this email, you can safely ignore it.
  `;
  
  return sendMail({
    to,
    subject: 'Sign In to MCHS Robotics Portal',
    html,
    text
  });
}

module.exports = {
  createToken,
  verifyToken,
  sendMagicLink,
  SESSION_NAME,
  SESSION_MAX_AGE
};
