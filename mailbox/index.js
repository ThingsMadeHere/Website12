#!/usr/bin/env node
'use strict';
// ── mailbox sidecar ──────────────────────────────────────────────────────────
// Bridges the team's self-hosted Mailcow mailbox into the portal.
//
// It polls one IMAP folder (default INBOX) on the Mailcow Dovecot server with
// imapflow, parses new messages with nodemailer/mailparser, and reports each
// one to the API's /api/mail/inbound-hook endpoint (which stores a summary,
// pushes an admin notification, and forwards to ADMIN_EMAIL). Messages are
// then moved to a "Processed" folder so nothing is ever reported twice — even
// after a container restart.
//
// Outgoing mail does NOT go through this container: the portal sends it
// itself via SMTP submission on port 587 (see api/mailer.js). Port 25 is only
// used by the internet's MX servers delivering INTO Mailcow; if your host
// blocks inbound 25 you can remap it to 2525 in the mailcow docker-compose
// override and point your MX record at port 2525 (Cloudflare can proxy that).
//
// Env:
//   IMAP_HOST        Dovecot host (e.g. mail.mchsrobotics.dev, or the mailcow
//                    `postfix-dovecot` service name when on the same network)
//   IMAP_PORT        993 (implicit TLS, default) or 143 (STARTTLS)
//   IMAP_TLS         true|false (default: true on 993, false elsewhere)
//   IMAP_USER        full mailbox address, e.g. team@mchsrobotics.dev
//   IMAP_PASS        mailbox password (create in the Mailcow UI)
//   IMAP_FOLDER      folder to poll (default INBOX)
//   PROCESSED_FOLDER folder to move handled mail to (default Processed;
//                    set empty to mark Seen instead of moving)
//   API_URL          portal API base (default http://mchs-api:3001)
//   MAILHOOK_TOKEN   shared secret, must equal api/.env MAILHOOK_TOKEN
//   POLL_SECONDS     poll interval (default 60)

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const cfg = {
  host: process.env.IMAP_HOST || 'mail.mchsrobotics.dev',
  port: Number(process.env.IMAP_PORT) || 993,
  secure: process.env.IMAP_TLS !== undefined
    ? process.env.IMAP_TLS === 'true'
    : (Number(process.env.IMAP_PORT) || 993) === 993,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
};
const FOLDER    = process.env.IMAP_FOLDER || 'INBOX';
const PROCESSED = process.env.PROCESSED_FOLDER ?? 'Processed';
const API_URL   = (process.env.API_URL || 'http://mchs-api:3001').replace(/\/+$/, '');
const TOKEN     = process.env.MAILHOOK_TOKEN || '';
const POLL_MS   = Math.max(15, Number(process.env.POLL_SECONDS) || 60) * 1000;

const log = (...a) => console.log(new Date().toISOString(), '-', ...a);

if (!cfg.auth.user || !cfg.auth.pass) {
  console.error('[mailbox] IMAP_USER and IMAP_PASS are required — exiting.');
  process.exit(1);
}
if (!TOKEN) console.warn('[mailbox] MAILHOOK_TOKEN not set; the API will reject reports with 503/401.');

async function reportToApi(msg) {
  const res = await fetch(`${API_URL}/api/mail/inbound-hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mailhook-token': TOKEN },
    body: JSON.stringify(msg),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`hook ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

let client = null;
async function getClient() {
  if (client && !client.closed) return client;
  client = new ImapFlow({
    ...cfg,
    logger: false,
    tls: { servername: cfg.host },
    connTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  });
  await client.connect();
  return client;
}

async function dropClient(err) {
  log('IMAP connection problem:', err.message);
  try { if (client) await client.logout(); } catch { /* already dead */ }
  client = null;
}

async function cfetchAllUids(c) {
  // Last-resort enumeration when SEARCH is unsupported: fetch UID of every
  // message and skip the ones flagged \Seen during the per-uid loop.
  const list = [];
  for await (const msg of c.fetchAll({ uid: true, flags: true })) {
    if (!msg.flags || !msg.flags.includes('\\Seen')) list.push(msg.uid);
  }
  return list;
}

async function pollOnce() {
  const c = await getClient();
  let lock;
  try {
    lock = await c.getMailboxLock(FOLDER);
  } catch (err) {
    // Folder may not exist yet on a brand-new mailbox — create it once.
    if (/does not exist|NONEXISTENT|NO \[/i.test(err.message)) {
      await c.mailboxCreate(FOLDER);
      return;
    }
    throw err;
  }
  let uids;
  try {
    uids = await c.search({ seen: false });
  } catch (err) {
    log('SEARCH UNSEEN failed, falling back to full fetch:', err.message);
    uids = await cfetchAllUids(c);
  }
  if (!uids || uids.length === 0) return;

    for (const uid of uids.slice(-25)) { // cap per-cycle so a flooded inbox drains steadily
      let source, info;
      try {
        info = await c.fetchOne(uid, { uid: true }, { source: true, flags: true });
        if (!info || !info.source) continue;
        if (info.flags && info.flags.includes('\\Seen')) continue; // already handled
        source = info.source;
        const parsed = await simpleParser(source);
        const msg = {
          from: parsed.from?.value?.[0]?.address || String(parsed.from || 'unknown'),
          to: parsed.to?.value?.[0]?.address || cfg.auth.user,
          subject: parsed.subject || '(no subject)',
          snippet: String(parsed.text || '').slice(0, 900),
          messageId: parsed.messageId || '',
          receivedAt: (parsed.date || new Date()).toISOString(),
        };
        await reportToApi(msg);
        log(`reported uid=${uid} "${msg.subject}" from ${msg.from}`);
        // Move out of the polling folder so we never re-report it.
        if (PROCESSED) {
          try {
            await c.mailboxCreate(PROCESSED);
            await c.messageMove(uid, PROCESSED, { uid: true });
          } catch (mvErr) {
            log(`move to ${PROCESSED} failed for uid=${uid}:`, mvErr.message);
            try { await c.messageFlagAdd(['\\Seen'], uid, { uid: true }); } catch { /* ignore */ }
          }
        } else {
          await c.messageFlagAdd(['\\Seen'], uid, { uid: true });
        }
      } catch (err) {
        log(`uid=${uid} failed:`, err.message);
        try { await c.messageFlagAdd(['\\Seen'], uid, { uid: true }); } catch { /* ignore */ }
      }
    }
  } finally {
    lock.release();
  }
}

(async function main() {
  log(`mailbox sidecar starting: ${cfg.host}:${cfg.port} folder=${FOLDER} -> ${API_URL}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      await dropClient(err);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
