'use strict';
// ── membership applications module ───────────────────────────────────────────
// Signing up no longer creates an account directly. Visitors submit an
// application (name, username, photo); the admin gets an email with
// Approve/Deny links (and can also use the Applications page on the site).
// Only on approval is the user account actually created.
//
// approveApplication() is exported so other backend modules (admin account
// creation) share the exact same "become a member" logic.

const express = require('express');
const crypto = require('crypto');
const { db, ADMIN_USERNAMES } = require('../db');
const { sendMail } = require('../mailer');
const { requireAuth, requireAdmin, hashPassword } = require('../auth');
const { authLimiter } = require('../modules/limits');
const { validate, ApplicationSchema, DecisionSchema } = require('../modules/schemas');
const { baseUrl, esc } = require('../modules/util');

const router = express.Router();

const PHOTO_MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

function approveApplication(application, decidedBy = null) {
  const clash = db.prepare('SELECT id FROM users WHERE username = ?').get(application.username);
  if (clash) return { error: `Username '${application.username}' is already taken — cannot approve` };

  const isAdmin = ADMIN_USERNAMES.includes(application.username);
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, full_name, photo_mime, photo, verified, admin)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      application.username,
      application.password_hash,
      application.full_name || '',
      application.photo_mime || null,
      application.photo || null,
      isAdmin ? 1 : 0
    );

  if (isAdmin) {
    db.prepare(`INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, 'admin')`)
      .run(info.lastInsertRowid);
  }

  db.prepare(
    `UPDATE applications SET status = 'approved', user_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`
  ).run(info.lastInsertRowid, decidedBy, application.id);

  return { ok: true, userId: info.lastInsertRowid, admin: isAdmin };
}

function denyApplication(application, decidedBy = null) {
  db.prepare(
    `UPDATE applications SET status = 'denied', decided_by = ?, decided_at = datetime('now') WHERE id = ?`
  ).run(decidedBy, application.id);
  return { ok: true };
}

// Minimal self-contained HTML page for approve/deny links clicked from email
function decisionPage(ok, title, message) {
  const accent = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · MCHS Robotics</title></head>
<body style="margin:0;background:#f5f6f2;font-family:Arial,Helvetica,sans-serif;color:#1d2419;
             min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="max-width:420px;width:100%;background:#ffffff;border:1px solid #dfe2d7;border-radius:12px;
              padding:32px;text-align:center;box-shadow:0 12px 40px rgba(29,36,25,0.08)">
    <div style="width:44px;height:44px;border-radius:999px;margin:0 auto 16px;display:flex;align-items:center;
                justify-content:center;background:${accent}1a;border:1px solid ${accent}55;color:${accent};
                font-size:22px;font-weight:bold">${ok ? '✓' : '!'}</div>
    <h1 style="font-size:18px;margin:0 0 8px;color:#1d2419">${esc(title)}</h1>
    <p style="font-size:14px;color:#566050;margin:0 0 24px;line-height:1.5">${esc(message)}</p>
    <a href="/" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;
                      padding:10px 20px;border-radius:8px;font-size:14px;font-weight:bold">Back to site</a>
  </div>
</body></html>`;
}

// POST /api/applications  { username, fullName, photo? }
// Manual-approval front door for people without the team key. No password —
// approved applicants sign in with the key (an admin shares it at the next
// meeting). Photo is now optional: small teams recognize their own members;
// admins can still ask for one on the review card.
router.post('/', authLimiter, (req, res) => {
  const [data,] = validate(ApplicationSchema, req, res);
  if (!data) return;

  const cleaned = data.username;
  const name = data.fullName;

  let mime = null, buf = null, ext = null;
  if (data.photo) {
    mime = data.photo.mime;
    ext = PHOTO_MIMES[mime]; // already whitelisted by the schema
    try { buf = Buffer.from(data.photo.data, 'base64'); } catch { buf = null; }
    if (!buf || buf.length < 64)
      return res.status(400).json({ error: 'Photo data is invalid' });
    if (buf.length > MAX_PHOTO_BYTES)
      return res.status(400).json({ error: 'Photo is too large (max 6 MB)' });
  }

  if (db.prepare('SELECT id FROM users WHERE username = ?').get(cleaned))
    return res.status(409).json({ error: 'Username already taken' });
  const pending = db
    .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'pending'`)
    .get(cleaned);
  if (pending)
    return res.status(409).json({ error: 'An application for this username is already pending review' });

  const token = crypto.randomBytes(32).toString('hex');
  // Empty string = no usable password (login rejects it); a supplied one is
  // bcrypt-hashed up front so the raw value never touches the database.
  const passwordHash = data.password ? hashPassword(data.password) : '';
  const info = db
    .prepare(
      `INSERT INTO applications (username, full_name, password_hash, photo_mime, photo, token)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(cleaned, name, passwordHash, mime, buf, token);

  const id         = info.lastInsertRowid;
  const base       = baseUrl(req);
  const approveUrl = `${base}/api/applications/${id}/decision?token=${token}&action=approve`;
  const denyUrl    = `${base}/api/applications/${id}/decision?token=${token}&action=deny`;
  const when       = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const text = [
    'New membership application — MCHS Robotics (Team 5728)',
    '',
    `Name:      ${name}`,
    `Username:  @${cleaned}`,
    `Submitted: ${when}`,
    `Photo:     ${buf ? 'attached' : 'not provided'}`,
    '',
    `Approve: ${approveUrl}`,
    `Deny:    ${denyUrl}`,
    '',
    'Approving creates the account (with the ✓ verified badge) so they can sign in right away.',
    'You can also review applications from the Applications page while signed in as an admin.',
  ].join('\n');

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;background:#0d0d0f;padding:24px;color:#f0f0f2">
  <div style="max-width:520px;margin:0 auto;background:#111114;border:1px solid #1e1e24;border-radius:12px;padding:24px">
    <h2 style="margin:0 0 4px;font-size:18px">New membership application</h2>
    <p style="color:#9a9aa5;font-size:13px;margin:0 0 20px">MCHS Robotics · Team 5728</p>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#9a9aa5;width:100px">Name</td><td style="padding:6px 0"><strong>${esc(name)}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#9a9aa5">Username</td><td style="padding:6px 0">@${esc(cleaned)}</td></tr>
      <tr><td style="padding:6px 0;color:#9a9aa5">Submitted</td><td style="padding:6px 0">${esc(when)}</td></tr>
      <tr><td style="padding:6px 0;color:#9a9aa5">Photo</td><td style="padding:6px 0">see attachment</td></tr>
    </table>
    <div style="margin-top:24px">
      <a href="${approveUrl}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;margin:0 8px 8px 0">✓ Approve</a>
      <a href="${denyUrl}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">✗ Deny</a>
    </div>
    <p style="color:#6b6b78;font-size:12px;margin-top:20px;line-height:1.5">
      Approving creates the account (with the ✓ verified badge) so they can sign in right away.
      You can also review applications from the <strong>Applications</strong> page on the site.
    </p>
  </div>
</div>`;

  // Never block the application on email delivery — the admin page is the fallback.
  sendMail({
    subject: `Approve or deny: ${name} (@${cleaned}) — MCHS Robotics application`,
    text,
    html,
    attachments: buf ? [{ filename: `applicant-${id}-${cleaned}.${ext}`, content: buf.toString('base64') }] : [],
  })
    .then(r => {
      if (!r.sent)
        console.log(`[applications] #${id} for @${cleaned}: email NOT sent via ${r.provider}${r.error ? ` (${r.error})` : ''} — use the Applications page or the links above`);
      else
        console.log(`[applications] #${id} for @${cleaned}: review email sent via ${r.provider}`);
    })
    .catch(err => console.error('[applications] email error:', err.message));

  console.log(`Application #${id}: ${name} (@${cleaned}) — pending review`);
  res.json({ ok: true, applicationId: id, status: 'pending' });
});

// GET /api/applications/:id/decision?token=…&action=approve|deny
// Token-protected links used from the email (no session needed).
router.get('/:id/decision', (req, res) => {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(req.params.id));
  res.type('html');

  const providedTok = Buffer.from(String(req.query.token || ''));
  const expectedTok = Buffer.from(String(row?.token ?? ''));
  const tokenOk = providedTok.length === expectedTok.length && crypto.timingSafeEqual(providedTok, expectedTok);
  if (!row || !tokenOk)
    return res.status(400).send(decisionPage(false, 'Invalid link', 'This approval link is invalid or has already been replaced. Review the application from the Applications page instead.'));

  if (row.status !== 'pending')
    return res.status(409).send(decisionPage(false, 'Already processed', `This application was already ${row.status}.`));

  const action = String(req.query.action || '');
  if (action === 'approve') {
    const result = approveApplication(row);
    if (result.error) return res.status(409).send(decisionPage(false, 'Could not approve', result.error));
    console.log(`Application #${row.id} approved via email link — @${row.username} created${result.admin ? ' (admin)' : ''}`);
    return res.send(decisionPage(true, `Approved — @${row.username}`, 'The account was created with the ✓ verified badge. They can sign in right away.'));
  }
  if (action === 'deny') {
    denyApplication(row);
    console.log(`Application #${row.id} denied via email link — @${row.username}`);
    return res.send(decisionPage(true, 'Application denied', `@${row.username} was not approved. They can submit a new application if this was a mistake.`));
  }
  return res.status(400).send(decisionPage(false, 'Unknown action', 'Use the Approve or Deny link from the email.'));
});

// GET /api/applications?status=pending|approved|denied|all  (admin)
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const wanted = String(req.query.status || 'pending');
  const cols = `id, username, full_name, status, created_at, decided_at, photo_mime, (photo IS NOT NULL) AS has_photo`;
  const rows = ['pending', 'approved', 'denied'].includes(wanted)
    ? db.prepare(`SELECT ${cols} FROM applications WHERE status = ? ORDER BY id DESC LIMIT 200`).all(wanted)
    : db.prepare(`SELECT ${cols} FROM applications ORDER BY id DESC LIMIT 200`).all();

  res.json(rows.map(r => ({
    id: r.id,
    username: r.username,
    fullName: r.full_name,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    photoMime: r.photo_mime,
    hasPhoto: !!r.has_photo,
  })));
});

// GET /api/applications/:id/photo  (admin) — raw image bytes
router.get('/:id/photo', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT photo, photo_mime FROM applications WHERE id = ?').get(Number(req.params.id));
  if (!row || !row.photo) return res.status(404).json({ error: 'No photo' });
  res.type(row.photo_mime || 'application/octet-stream').send(row.photo);
});

// POST /api/applications/:id/decision  { action: 'approve' | 'deny' }  (admin)
router.post('/:id/decision', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Application not found' });
  if (row.status !== 'pending')
    return res.status(409).json({ error: `Application was already ${row.status}` });

  const [decisionData,] = validate(DecisionSchema, req, res);
  if (!decisionData) return;
  const action = decisionData.action;
  if (action === 'approve') {
    const result = approveApplication(row, req.user.id);
    if (result.error) return res.status(409).json({ error: result.error });
    console.log(`Application #${row.id} approved by ${req.user.username} — @${row.username} created${result.admin ? ' (admin)' : ''}`);
    return res.json({ ok: true, status: 'approved', userId: result.userId });
  }
  if (action === 'deny') {
    denyApplication(row, req.user.id);
    console.log(`Application #${row.id} denied by ${req.user.username}`);
    return res.json({ ok: true, status: 'denied' });
  }
});

module.exports = router;
module.exports.approveApplication = approveApplication;
module.exports.denyApplication = denyApplication;
