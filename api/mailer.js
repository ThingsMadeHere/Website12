// ── mailer ───────────────────────────────────────────────────────────────────
// Sends application-review emails to the team admin.
//
// Provider selection (first match wins):
//   1. RESEND_API_KEY  → Resend HTTP API (no domain needed on the free plan;
//      emails are sent "from" onboarding@resend.dev and can only be delivered
//      to the address that owns the API key — perfect for admin notifications)
//   2. SMTP_HOST       → any SMTP server (e.g. Gmail with an app password),
//      using nodemailer. SMTP_USER / SMTP_PASS / SMTP_PORT / SMTP_SECURE.
//   3. neither         → console fallback: the email (including approve/deny
//      links) is printed to the server log so the flow still works in dev.
//
// EMAIL_FROM overrides the sender for either provider.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'physicsiscool314@gmail.com';

function providerName() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'console';
}

async function sendResend({ from, to, subject, html, text, attachments }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html, text, attachments }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function sendSmtp({ from, to, subject, html, text, attachments }) {
  // Lazy require — nodemailer is only needed on the SMTP path
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT) || 587;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: String(process.env.SMTP_SECURE) === 'true' || port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  await transporter.sendMail({
    from,
    to,
    subject,
    html,
    text,
    attachments: attachments.map(a => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
    })),
  });
}

// sendMail({ to?, subject, html, text, attachments: [{ filename, content(base64) }] })
// Never throws — returns { sent, provider, error? } so callers can degrade gracefully.
async function sendMail({ to = ADMIN_EMAIL, subject, html, text, attachments = [] }) {
  const provider = providerName();
  try {
    if (provider === 'resend') {
      const from = process.env.EMAIL_FROM || 'MCHS Robotics Portal <onboarding@resend.dev>';
      await sendResend({ from, to, subject, html, text, attachments });
    } else if (provider === 'smtp') {
      const from = process.env.EMAIL_FROM || process.env.SMTP_USER || 'MCHS Robotics Portal <no-reply@localhost>';
      await sendSmtp({ from, to, subject, html, text, attachments });
    } else {
      console.log('─'.repeat(64));
      console.log('[mailer] No email provider configured (set RESEND_API_KEY or SMTP_HOST).');
      console.log(`[mailer] Would send to: ${to}`);
      console.log(`[mailer] Subject: ${subject}`);
      console.log(text || '(html-only email)');
      console.log('─'.repeat(64));
    }
    return { sent: provider !== 'console', provider };
  } catch (err) {
    console.error(`[mailer] send failed via ${provider}:`, err.message);
    return { sent: false, provider, error: err.message };
  }
}

module.exports = { sendMail, ADMIN_EMAIL };
