'use strict';
// ── team mailbox routes (self-hosted Mailcow + the `mailbox` sidecar) ────────
// Outgoing mail goes through SMTP on port 587 (see api/mailer.js — port 25 is
// never required from the app; it's only used by MX servers delivering INTO
// Mailcow, and can be remapped to 2525 if your host blocks it). Incoming mail
// lands in the team@… mailbox; the `mailbox` container polls it over IMAP and
// notifies this API here. The hook stores a summary in SQLite so admins can
// see team mail activity in the portal, and forwards everything to ADMIN_EMAIL
// via the normal mailer. Mounted at /api by index.js ('/mail/...').

const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const { sendMail } = require('../mailer');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

// POST /api/mail/inbound-hook — called by the mailbox sidecar for each new
// message. Guarded by the shared MAILHOOK_TOKEN (timing-safe compare).
router.post('/mail/inbound-hook', (req, res) => {
  const secret = (process.env.MAILHOOK_TOKEN || '').trim();
  if (!secret) return res.status(503).json({ error: 'MAILHOOK_TOKEN not configured' });
  const token = req.get('x-mailhook-token') || '';
  if (token.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(token.padEnd(secret.length)), Buffer.from(secret))) {
    return res.status(401).json({ error: 'bad hook token' });
  }
  const { from, to, subject, receivedAt, messageId, snippet } = req.body || {};
  if (!from || !subject) return res.status(400).json({ error: 'from and subject are required' });
  try {
    const info = db.prepare(
      `INSERT INTO inbound_mail (from_addr, to_addr, subject, snippet, message_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(String(from).slice(0, 254), String(to || '').slice(0, 254), String(subject).slice(0, 500),
          String(snippet || '').slice(0, 900), String(messageId || '').slice(0, 254),
          String(receivedAt || new Date().toISOString()).slice(0, 64));
    console.log(`[mail] inbound #${info.lastInsertRowid}: "${subject}" from ${from}`);
    sendMail({
      subject: `[team-mail] ${subject}`,
      text: `New email for the team mailbox.\n\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${snippet || ''}`,
      html: `<p><b>From:</b> ${String(from)}</p><p><b>To:</b> ${String(to || '')}</p>` +
            `<p><b>Subject:</b> ${String(subject)}</p><pre style="white-space:pre-wrap">${String(snippet || '')}</pre>` +
            `<p style="color:#888">Delivered by the MCHS Robotics team mailbox.</p>`,
    }).catch(() => {});
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('[mail] inbound hook failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mail/inbox?limit=50 (admin) — recent team-mail summaries
router.get('/mail/inbox', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  res.json(db.prepare(
    `SELECT id, from_addr AS fromAddr, to_addr AS toAddr, subject, snippet,
            received_at AS receivedAt
     FROM inbound_mail ORDER BY id DESC LIMIT ?`
  ).all(limit));
});

module.exports = router;
