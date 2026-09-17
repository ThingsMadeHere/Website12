// Load api/.env (RESEND_API_KEY, SMTP_*, ADMIN_EMAIL, PUBLIC_URL, …) before
// anything reads process.env. The file is git-ignored — see README.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { db, initDb, ADMIN_USERNAMES, ensureRecurringMeetings } = require('./db');
const { sendMail } = require('./mailer');
const {
  hashPassword, verifyPassword,
  createSession, destroySession, requireAuth, blockIfTimedOut,
} = require('./auth');
const {
  registerSubscription, removeSubscription, getSubscription, getSubscribedUserIds,
  sendBoardMessageNotification, sendMeetingReminderNotification,
  vapidPublicKey, subscriptions
} = require('./push');
const robot = require('./robot');

const app  = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true); // honor X-Forwarded-Proto behind nginx/caddy
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' })); // applications carry base64 photos

// ── helpers ──────────────────────────────────────────────────────────────────

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → epoch millis
const TS_SQL = `CAST((julianday(m.created_at) - 2440587.5) * 86400000 AS INTEGER)`;

// Date → SQLite UTC "YYYY-MM-DD HH:MM:SS"
const sqlUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// SQLite UTC string (or null) → ISO-8601 for JSON responses
function isoOrNull(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Detect mentions in message body (@username or @everyone)
function detectMentions(body, allUsernames) {
  const mentions = {
    users: [],      // Array of usernames mentioned
    everyone: false // Whether @everyone was mentioned
  };
  
  const usernameSet = new Set(allUsernames.map(u => u.toLowerCase()));
  
  // Match @username patterns
  const userMentionRegex = /@([a-z0-9._-]{1,32})/gi;
  let match;
  while ((match = userMentionRegex.exec(body)) !== null) {
    const mentionedUsername = match[1].toLowerCase();
    if (usernameSet.has(mentionedUsername) && !mentions.users.includes(mentionedUsername)) {
      mentions.users.push(mentionedUsername);
    }
  }
  
  // Check for @everyone
  mentions.everyone = /@everyone/gi.test(body);
  
  return mentions;
}

// Update user presence (online/offline status)
function updateUserPresence(userId, isOnline) {
  const now = sqlUtc(new Date());
  db.prepare(`
    INSERT INTO user_presence (user_id, is_online, last_seen)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      is_online = excluded.is_online,
      last_seen = excluded.last_seen
  `).run(userId, isOnline ? 1 : 0, now);
}

// Check if user is currently online
function isUserOnline(userId) {
  const row = db.prepare('SELECT is_online FROM user_presence WHERE user_id = ?').get(userId);
  if (!row) return false;
  
  // Consider user offline if last_seen was more than 5 minutes ago
  const lastSeen = new Date(row.last_seen + 'Z');
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  return row.is_online === 1 && lastSeen > fiveMinutesAgo;
}

// Get user notification preferences
function getUserNotificationSettings(userId) {
  const user = db.prepare('SELECT notification_settings FROM users WHERE id = ?').get(userId);
  if (!user) return 'all'; // Default to all notifications
  return user.notification_settings || 'all';
}

// ── tags ─────────────────────────────────────────────────────────────────────
// Lowercase role labels (mentor, lead, alumni, …). 'admin' is special: it is
// always kept in sync with the users.admin column.
const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const MAX_TAGS = 8;

function normalizeTags(input) {
  if (!Array.isArray(input)) return { error: 'tags must be an array' };
  const seen = new Set();
  for (const raw of input) {
    const tag = String(raw || '').trim().toLowerCase();
    if (!tag) continue;
    if (!TAG_RE.test(tag))
      return { error: `Tag "${tag}" is invalid — use letters, numbers, - and _ (max 24 chars)` };
    seen.add(tag);
  }
  if (seen.size > MAX_TAGS)
    return { error: `Too many tags — a member can have at most ${MAX_TAGS}` };
  return { tags: [...seen].sort() };
}

function replaceTags(userId, tags) {
  const apply = db.transaction(() => {
    db.prepare('DELETE FROM user_tags WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_tags (user_id, tag) VALUES (?, ?)');
    for (const t of tags) ins.run(userId, t);
    // The 'admin' tag IS the admin flag — keep them in sync.
    db.prepare('UPDATE users SET admin = ? WHERE id = ?').run(tags.includes('admin') ? 1 : 0, userId);
  });
  apply();
}

function decodePhoto(photo) {
  // photo: { mime, data(base64) } — same contract as application photos.
  const ext = PHOTO_MIMES[(photo || {}).mime];
  if (!ext) return { error: 'Photo must be JPG, PNG, WebP, or GIF' };
  let buf;
  try { buf = Buffer.from(String(photo.data || ''), 'base64'); } catch { buf = null; }
  if (!buf || buf.length < 64) return { error: 'Photo data is invalid' };
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'Photo is too large (max 6 MB)' };
  return { mime: photo.mime, buf };
}

function messageRow(r) {
  return {
    id:       r.id,
    userId:   r.user_id,
    username: r.username,
    verified: !!r.verified,
    admin:    !!r.admin,
    tags:     r.tags ? String(r.tags).split(',') : [],
    hasPhoto: !!r.has_photo,
    body:     r.body,
    ts:       r.ts,
  };
}

function slugifyChannelName(raw) {
  const name = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32);
  return name;
}

// ── health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── robot telemetry & deployment ─────────────────────────────────────────────
/**
 * GET /api/robot/telemetry - Fetch telemetry from robot (10.57.28.2)
 * Requires authentication
 */
app.get('/api/robot/telemetry', requireAuth, async (req, res) => {
  try {
    const result = await robot.getTelemetry(req.user?.token);
    
    if (result.success) {
      res.json({ success: true, data: result.data });
    } else {
      res.status(result.statusCode || 503).json({
        success: false,
        error: 'Failed to fetch telemetry from robot',
        details: result.data
      });
    }
  } catch (error) {
    console.error('[Robot Telemetry] Error:', error.message);
    res.status(503).json({
      success: false,
      error: 'Robot communication failed',
      details: error.message
    });
  }
});

/**
 * POST /api/robot/deploy - Deploy compiled code to robot
 * Requires admin authentication
 * Accepts tar.gz archive in multipart form
 */
app.post('/api/robot/deploy', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Expect base64-encoded tar.gz in request body
    const { codeArchive } = req.body;
    
    if (!codeArchive) {
      return res.status(400).json({
        success: false,
        error: 'No code archive provided'
      });
    }
    
    const archiveBuffer = Buffer.from(codeArchive, 'base64');
    const result = await robot.deployCode(archiveBuffer, req.user?.token);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Code deployed successfully to robot',
        data: result.data
      });
    } else {
      res.status(result.statusCode || 500).json({
        success: false,
        error: 'Deployment failed',
        details: result.data
      });
    }
  } catch (error) {
    console.error('[Robot Deploy] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Deployment failed',
      details: error.message
    });
  }
});

/**
 * POST /api/robot/compile - Submit code compilation job to queue
 * Requires authentication
 * Body: { workspacePath, target?, javaVersion? }
 */
app.post('/api/robot/compile', requireAuth, async (req, res) => {
  try {
    const { workspacePath, target = 'simulation', javaVersion = '17' } = req.body || {};
    
    if (!workspacePath) {
      return res.status(400).json({
        success: false,
        error: 'workspacePath is required'
      });
    }
    
    const result = await robot.submitCompilationJob({
      workspacePath,
      target,
      javaVersion,
      requestedBy: req.user.username
    });
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('[Compile Job] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to queue compilation job',
      details: error.message
    });
  }
});

/**
 * GET /api/robot/compile/:jobId/status - Get compilation job status
 * Requires authentication
 */
app.get('/api/robot/compile/:jobId/status', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await robot.getJobStatus(jobId);
    res.json(result);
  } catch (error) {
    console.error('[Job Status] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get job status',
      details: error.message
    });
  }
});

/**
 * GET /api/robot/health - Check robot connectivity
 * Requires authentication
 */
app.get('/api/robot/health', requireAuth, async (req, res) => {
  try {
    const connected = await robot.checkRobotConnection();
    res.json({
      success: true,
      connected,
      robotIp: robot.ROBOT_IP
    });
  } catch (error) {
    console.error('[Robot Health] Error:', error.message);
    res.status(503).json({
      success: false,
      connected: false,
      error: error.message
    });
  }
});

// ── membership applications ──────────────────────────────────────────────────
// Signing up no longer creates an account directly. Visitors submit an
// application (name, username, password, photo); the admin gets an email with
// Approve/Deny links (and can also use the Applications page on the site).
// Only on approval is the user account actually created.

const PHOTO_MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const USERNAME_RE = /^[a-z0-9._-]{1,32}$/;

const baseUrl = (req) =>
  (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

const esc = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function requireAdmin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

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

// POST /api/applications  { username, password, fullName, photo: { mime, data(base64) } }
app.post('/api/applications', (req, res) => {
  const { username, password, fullName, photo } = req.body || {};

  const cleaned = String(username || '').toLowerCase().trim();
  if (!cleaned || !password)
    return res.status(400).json({ error: 'username and password required' });
  if (!USERNAME_RE.test(cleaned))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, and . _ - characters' });
  if (String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const name = String(fullName || '').trim().slice(0, 80);
  if (!name)
    return res.status(400).json({ error: 'Full name is required' });

  const mime = (photo || {}).mime;
  const ext  = PHOTO_MIMES[mime];
  if (!ext)
    return res.status(400).json({ error: 'A photo is required (JPG, PNG, WebP, or GIF)' });

  let buf;
  try { buf = Buffer.from(String((photo || {}).data || ''), 'base64'); } catch { buf = null; }
  if (!buf || buf.length < 64)
    return res.status(400).json({ error: 'Photo data is invalid' });
  if (buf.length > MAX_PHOTO_BYTES)
    return res.status(400).json({ error: 'Photo is too large (max 6 MB)' });

  if (db.prepare('SELECT id FROM users WHERE username = ?').get(cleaned))
    return res.status(409).json({ error: 'Username already taken' });
  const pending = db
    .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'pending'`)
    .get(cleaned);
  if (pending)
    return res.status(409).json({ error: 'An application for this username is already pending review' });

  const token = crypto.randomBytes(32).toString('hex');
  const info = db
    .prepare(
      `INSERT INTO applications (username, full_name, password_hash, photo_mime, photo, token)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(cleaned, name, hashPassword(String(password)), mime, buf, token);

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
    'Photo:     attached',
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
    attachments: [{ filename: `applicant-${id}-${cleaned}.${ext}`, content: buf.toString('base64') }],
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
app.get('/api/applications/:id/decision', (req, res) => {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(req.params.id));
  res.type('html');

  if (!row || row.token !== String(req.query.token || ''))
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
app.get('/api/applications', requireAuth, requireAdmin, (req, res) => {
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
app.get('/api/applications/:id/photo', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT photo, photo_mime FROM applications WHERE id = ?').get(Number(req.params.id));
  if (!row || !row.photo) return res.status(404).json({ error: 'No photo' });
  res.type(row.photo_mime || 'application/octet-stream').send(row.photo);
});

// POST /api/applications/:id/decision  { action: 'approve' | 'deny' }  (admin)
app.post('/api/applications/:id/decision', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Application not found' });
  if (row.status !== 'pending')
    return res.status(409).json({ error: `Application was already ${row.status}` });

  const action = String((req.body || {}).action || '');
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
  return res.status(400).json({ error: "action must be 'approve' or 'deny'" });
});

// ── accounts ─────────────────────────────────────────────────────────────────

// POST /api/login  { username, password }
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const uname = username.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);

  if (!user) {
    // Account doesn't exist — maybe they applied and are waiting on review
    const pending = db
      .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'pending'`)
      .get(uname);
    if (pending)
      return res.status(403).json({
        code: 'pending',
        error: 'Your application is still pending review — you can sign in once an admin approves it.',
      });

    const denied = db
      .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'denied' ORDER BY id DESC`)
      .get(uname);
    if (denied)
      return res.status(403).json({
        code: 'denied',
        error: 'Your application was not approved. Talk to a team lead if you think this is a mistake.',
      });

    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (!verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });

  // An admin flagged this account for a forced password change — no session
  // until they pick a new one (the client shows the reset form).
  if (user.must_change_password) {
    console.log(`Login for @${user.username} blocked pending forced password change`);
    return res.json({
      mustChangePassword: true,
      userId: user.id,
      username: user.username,
      message: 'An admin requires you to choose a new password before signing in.',
    });
  }

  const token = createSession(user.id);
  const tags = db
    .prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag ASC')
    .all(user.id)
    .map(t => t.tag);
  res.json({
    userId: user.id,
    username: user.username,
    token,
    verified: !!user.verified,
    admin: !!user.admin,
    fullName: user.full_name || '',
    tags,
    hasPhoto: user.photo != null,
    timeoutUntil: isoOrNull(user.timeout_until),
  });
});

// POST /api/password/reset  { username, currentPassword, newPassword }
// Completes a forced password change (users.must_change_password = 1) and
// returns a fresh session, exactly like /api/login.
app.post('/api/password/reset', (req, res) => {
  const { username, currentPassword, newPassword } = req.body || {};
  if (!username || !currentPassword || !newPassword)
    return res.status(400).json({ error: 'username, currentPassword and newPassword are required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).toLowerCase().trim());
  if (!user || !user.must_change_password)
    return res.status(403).json({ error: 'This account does not need a password reset — sign in normally' });

  if (!verifyPassword(String(currentPassword), user.password_hash))
    return res.status(401).json({ error: 'Current password is incorrect' });

  if (String(newPassword).length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  if (verifyPassword(String(newPassword), user.password_hash))
    return res.status(400).json({ error: 'New password must be different from the current one' });

  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`
  ).run(hashPassword(String(newPassword)), user.id);
  // The forced reset also invalidates any older lingering sessions.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

  const token = createSession(user.id);
  const tags = db
    .prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag ASC')
    .all(user.id)
    .map(t => t.tag);
  console.log(`@${user.username} completed a forced password change`);
  res.json({
    userId: user.id,
    username: user.username,
    token,
    verified: !!user.verified,
    admin: !!user.admin,
    fullName: user.full_name || '',
    tags,
    hasPhoto: user.photo != null,
    timeoutUntil: isoOrNull(user.timeout_until),
  });
});

// POST /api/logout
app.post('/api/logout', requireAuth, (req, res) => {
  destroySession(req.user.token);
  updateUserPresence(req.user.id, false); // Mark user as offline
  res.json({ ok: true });
});

// PUT /api/me/notification-settings — update notification preferences
app.put('/api/me/notification-settings', requireAuth, (req, res) => {
  const { settings } = req.body || {};
  const validSettings = ['all', 'mentions_only', 'none'];
  
  if (!settings || !validSettings.includes(settings)) {
    return res.status(400).json({ error: 'Invalid notification settings. Must be "all", "mentions_only", or "none"' });
  }
  
  db.prepare('UPDATE users SET notification_settings = ? WHERE id = ?').run(settings, req.user.id);
  res.json({ ok: true, notificationSettings: settings });
});

// POST /api/verify — grants the ✓ verified badge (admin only; the badge is
// managed from the Admin panel — legacy self-verify was a free-for-all)
app.post('/api/verify', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true, verified: true });
});

// GET /api/me — current session state, so clients can pick up admin changes
// (tags, badges, timeouts, demotions) without waiting for the next sign-in.
app.get('/api/me', requireAuth, (req, res) => {
  const u = db
    .prepare(
      `SELECT id, username, full_name, verified, admin, timeout_until, must_change_password, notification_settings,
              (photo IS NOT NULL) AS has_photo
       FROM users WHERE id = ?`
    )
    .get(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  
  // Update presence as online when user checks their session
  updateUserPresence(req.user.id, true);
  
  res.json({
    userId: u.id,
    username: u.username,
    fullName: u.full_name || '',
    verified: !!u.verified,
    admin: !!u.admin,
    tags: req.user.tags,
    hasPhoto: !!u.has_photo,
    timeoutUntil: isoOrNull(u.timeout_until),
    mustChangePassword: !!u.must_change_password,
    notificationSettings: u.notification_settings || 'all',
  });
});

// GET /api/users/:id/photo — profile picture (admins, or the member themself)
app.get('/api/users/:id/photo', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!req.user.admin && req.user.id !== id)
    return res.status(403).json({ error: 'Forbidden' });
  const row = db.prepare('SELECT photo, photo_mime FROM users WHERE id = ?').get(id);
  if (!row || !row.photo) return res.status(404).json({ error: 'No photo' });
  res.set('Cache-Control', 'private, max-age=300');
  res.type(row.photo_mime || 'application/octet-stream').send(row.photo);
});

// GET /api/users/verified — map of userId → verified (for chat badges)
app.get('/api/users/verified', (_, res) => {
  const rows = db.prepare('SELECT id, verified FROM users').all();
  const map = {};
  rows.forEach(r => { map[r.id] = !!r.verified; });
  res.json(map);
});

// GET /api/users/count — total registered members
app.get('/api/users/count', (_, res) => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  res.json({ count: row.n });
});

// ── channels ─────────────────────────────────────────────────────────────────

// GET /api/channels
app.get('/api/channels', requireAuth, (_, res) => {
  const rows = db
    .prepare('SELECT id, name, description FROM channels ORDER BY id ASC')
    .all();
  res.json(rows);
});

// POST /api/channels  { name }
app.post('/api/channels', requireAuth, blockIfTimedOut, (req, res) => {
  const name = slugifyChannelName((req.body || {}).name);
  if (name.length < 2)
    return res.status(400).json({ error: 'Channel name must be at least 2 characters (letters/numbers only)' });

  const exists = db.prepare('SELECT id FROM channels WHERE name = ?').get(name);
  if (exists) return res.status(409).json({ error: `#${name} already exists` });

  const info = db
    .prepare('INSERT INTO channels (name, description) VALUES (?, ?)')
    .run(name, (req.body || {}).description || '');
  res.json({ id: info.lastInsertRowid, name, description: (req.body || {}).description || '' });
});

// DELETE /api/channels/:id  (admin only)
app.delete('/api/channels/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const channel = db.prepare('SELECT id, name FROM channels WHERE id = ?').get(id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  // Delete all messages in the channel
  db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id);
  // Delete all deletion tombstones for the channel
  db.prepare('DELETE FROM message_deletions WHERE channel_id = ?').run(id);
  // Delete the channel itself
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);

  console.log(`Channel #${channel.name} (id ${id}) deleted by ${req.user.username}`);
  res.json({ ok: true, id });
});

// ── messages ─────────────────────────────────────────────────────────────────

// GET /api/channels/:id/messages
//   ?after=<messageId>   → only newer messages (for polling)
//   ?afterDel=<delId>    → only newer deletion tombstones (for polling)
//   ?limit=<n>           → last n messages (default 100, max 200)
// Response: { messages, deletions, lastDeletionId }
app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const after    = Number(req.query.after) || 0;
  const afterDel = Number(req.query.afterDel) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);

  let rows;
  if (after > 0) {
    rows = db
      .prepare(
        `SELECT m.id, m.user_id, u.username, u.verified, u.admin, m.body, ${TS_SQL} AS ts,
                (SELECT GROUP_CONCAT(t.tag, ',') FROM user_tags t WHERE t.user_id = m.user_id) AS tags,
                (u.photo IS NOT NULL) AS has_photo
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ? AND m.id > ?
         ORDER BY m.id ASC LIMIT 500`
      )
      .all(channelId, after);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM (
           SELECT m.id, m.user_id, u.username, u.verified, u.admin, m.body, ${TS_SQL} AS ts,
                  (SELECT GROUP_CONCAT(t.tag, ',') FROM user_tags t WHERE t.user_id = m.user_id) AS tags,
                  (u.photo IS NOT NULL) AS has_photo
           FROM messages m JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ?
           ORDER BY m.id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(channelId, limit);
  }

  // Deletion tombstones newer than the client's cursor (lets open clients
  // remove messages that someone deleted while they were polling).
  // Polling clients always send afterDel (even 0); history loads omit it.
  const wantDeletions = req.query.afterDel !== undefined;
  const deletions = wantDeletions
    ? db
        .prepare(
          `SELECT id, message_id FROM message_deletions
           WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT 500`
        )
        .all(channelId, afterDel)
        .map(d => ({ id: d.id, messageId: d.message_id }))
    : [];

  const lastDel = db
    .prepare('SELECT COALESCE(MAX(id), 0) AS m FROM message_deletions WHERE channel_id = ?')
    .get(channelId);

  res.json({
    messages: rows.map(messageRow),
    deletions,
    lastDeletionId: lastDel.m,
  });
});

// POST /api/channels/:id/messages  { body }
app.post('/api/channels/:id/messages', requireAuth, blockIfTimedOut, (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const body = String((req.body || {}).body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Message is empty' });

  const info = db
    .prepare('INSERT INTO messages (channel_id, user_id, body) VALUES (?, ?, ?)')
    .run(channelId, req.user.id, body);

  const row = db
    .prepare(
      `SELECT m.id, m.user_id, u.username, u.verified, u.admin, m.body, ${TS_SQL} AS ts,
              (SELECT GROUP_CONCAT(t.tag, ',') FROM user_tags t WHERE t.user_id = m.user_id) AS tags,
              (u.photo IS NOT NULL) AS has_photo
       FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
    )
    .get(info.lastInsertRowid);

  // Send push notifications to other users in the channel
  // Discord-like behavior: online users get all notifications, offline users only get mentions
  try {
    const channel = db.prepare('SELECT name FROM channels WHERE id = ?').get(channelId);
    if (channel) {
      // Get all users and their notification settings
      const allUsers = db.prepare('SELECT id, username, notification_settings FROM users').all();
      const subscribedUsers = getSubscribedUserIds()
        .filter(userId => userId !== req.user.id);
      
      // Detect mentions in the message
      const mentions = detectMentions(body, allUsers.map(u => u.username));
      
      if (subscribedUsers.length > 0) {
        // Send notifications based on Discord-like logic
        subscribedUsers.forEach(userId => {
          const user = allUsers.find(u => u.id === userId);
          if (!user) return;
          
          const notificationSettings = user.notification_settings || 'all';
          const isOnline = isUserOnline(userId);
          const isMentioned = mentions.users.includes(user.username.toLowerCase()) || mentions.everyone;
          
          // Discord-like notification logic:
          // - If user is online: respect their notification settings
          // - If user is offline: only notify if mentioned (@name or @everyone)
          let shouldNotify = false;
          let isMentionNotification = false;
          
          if (isOnline) {
            // User is online - respect their notification settings
            if (notificationSettings === 'all') {
              shouldNotify = true;
            } else if (notificationSettings === 'mentions_only' && isMentioned) {
              shouldNotify = true;
              isMentionNotification = true;
            }
          } else {
            // User is offline - only notify if mentioned
            if (isMentioned) {
              shouldNotify = true;
              isMentionNotification = true;
            }
          }
          
          if (shouldNotify) {
            sendBoardMessageNotification(userId, {
              channelId,
              messageId: info.lastInsertRowid,
              channelName: channel.name,
              author: req.user.username,
              content: body
            }, isMentionNotification).catch(err => console.error('Push notification failed:', err.message));
          }
        });
      }
    }
  } catch (err) {
    console.error('Failed to send push notifications:', err.message);
  }

  res.json(messageRow(row));
});

// DELETE /api/messages/:id — author deletes their own message; admins delete any
app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const msg = db
    .prepare('SELECT id, user_id, channel_id FROM messages WHERE id = ?')
    .get(Number(req.params.id));

  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const isAuthor = msg.user_id === req.user.id;
  if (!isAuthor && !req.user.admin)
    return res.status(403).json({ error: 'You can only delete your own messages' });

  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  db.prepare(
    'INSERT INTO message_deletions (message_id, channel_id, deleted_by) VALUES (?, ?, ?)'
  ).run(msg.id, msg.channel_id, req.user.id);

  console.log(
    `Message ${msg.id} deleted by ${req.user.username}${isAuthor ? '' : ' (admin)'}`
  );
  res.json({ ok: true, id: msg.id, channelId: msg.channel_id });
});

// ── calendar events (unchanged contract) ─────────────────────────────────────

// GET /api/events — all calendar events (approved + pending proposals)
app.get('/api/events', (_, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT e.*, u.username AS proposer_name
         FROM calendar_events e
         LEFT JOIN users u ON u.id = CAST(e.proposed_by AS INTEGER)
         ORDER BY e.date ASC`
      )
      .all();
    const events = rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description || '',
      date: row.date,
      location: row.location || '',
      type: row.type || 'meeting',
      status: row.status || 'pending',
      isMeeting: row.type === 'meeting',
      proposedBy: row.proposed_by != null && row.proposed_by !== '' ? Number(row.proposed_by) : null,
      proposerName: row.proposer_name || null,
    }));
    res.json(events);
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// POST /api/events — propose a new calendar event
app.post('/api/events', requireAuth, blockIfTimedOut, (req, res) => {
  const { title, description, date, location, type } = req.body || {};

  if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });

  try {
    const info = db
      .prepare(
        `INSERT INTO calendar_events (title, description, date, location, type, proposed_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(title, description || '', date, location || '', type || 'meeting', String(req.user.id));

    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(info.lastInsertRowid);
    res.json({
      id: event.id,
      title: event.title,
      description: event.description || '',
      date: event.date,
      location: event.location || '',
      type: event.type || 'meeting',
      status: event.status || 'pending',
      isMeeting: event.type === 'meeting',
    });
  } catch (err) {
    console.error('Error creating event:', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// DELETE /api/events/:id — proposer deletes their own event; admins delete any
app.delete('/api/events/:id', requireAuth, (req, res) => {
  try {
    const event = db.prepare('SELECT id, proposed_by FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Numeric compare: better-sqlite3 v12 stores JS numbers bound into this TEXT
    // column as '3.0', so string equality against '3' would wrongly fail.
    const isProposer = event.proposed_by != null && event.proposed_by !== '' &&
      Number(event.proposed_by) === Number(req.user.id);
    if (!isProposer && !req.user.admin)
      return res.status(403).json({ error: 'You can only delete events you proposed' });

    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting event:', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// GET /api/events/:id/votes — votes for an event
app.get('/api/events/:id/votes', (req, res) => {
  try {
    const rows = db.prepare('SELECT user_id, vote FROM event_votes WHERE event_id = ?').all(req.params.id);
    const votes = rows.reduce((acc, r) => { acc[r.user_id] = r.vote; return acc; }, {});
    res.json({ votes });
  } catch (err) {
    console.error('Error fetching votes:', err);
    res.status(500).json({ error: 'Failed to fetch votes' });
  }
});

// POST /api/events/:id/vote  { vote: 1 | -1 }
app.post('/api/events/:id/vote', requireAuth, blockIfTimedOut, (req, res) => {
  const vote = Number((req.body || {}).vote);
  if (vote !== 1 && vote !== -1)
    return res.status(400).json({ error: 'vote must be 1 or -1' });

  try {
    db.prepare(
      `INSERT INTO event_votes (event_id, user_id, vote) VALUES (?, ?, ?)
       ON CONFLICT(event_id, user_id) DO UPDATE SET vote = excluded.vote`
    ).run(req.params.id, req.user.id, vote);

    const totals = db
      .prepare(
        `SELECT
           SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END)  AS yes_votes,
           SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS no_votes,
           COUNT(*) AS total_votes
         FROM event_votes WHERE event_id = ?`
      )
      .get(req.params.id);

    res.json({
      event_id: Number(req.params.id),
      yes_votes: totals.yes_votes || 0,
      no_votes: totals.no_votes || 0,
      total_votes: totals.total_votes || 0,
    });
  } catch (err) {
    console.error('Error voting on event:', err);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

// PUT /api/events/:id/approve — approve if majority voted yes
app.put('/api/events/:id/approve', requireAuth, (req, res) => {
  try {
    const totals = db
      .prepare(
        `SELECT
           SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS yes_votes,
           COUNT(*) AS total_votes
         FROM event_votes WHERE event_id = ?`
      )
      .get(req.params.id);

    const totalVotes = totals.total_votes || 0;
    const yesVotes   = totals.yes_votes || 0;
    const majority   = totalVotes > 0 ? Math.floor(totalVotes / 2) + 1 : 0;

    if (yesVotes >= majority && totalVotes > 0) {
      db.prepare(`UPDATE calendar_events SET status = 'approved' WHERE id = ?`).run(req.params.id);
      
      // Send push notification for approved event
      try {
        const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
        if (event) {
          const subscribedUsers = getSubscribedUserIds();
          if (subscribedUsers.length > 0) {
            const eventDate = new Date(event.date);
            const timeUntil = getTimeUntilString(eventDate);
            
            subscribedUsers.forEach(userId => {
              sendMeetingReminderNotification(userId, {
                meetingId: event.id,
                title: event.title,
                location: event.location || 'TBD',
                timeUntil: timeUntil
              }).catch(err => console.error('Push notification failed:', err.message));
            });
          }
        }
      } catch (err) {
        console.error('Failed to send push notifications for approved event:', err.message);
      }
      
      res.json({ success: true, approved: true, message: 'Event approved and added to calendar' });
    } else {
      res.status(400).json({
        success: false,
        approved: false,
        message: `Needs ${majority} votes (currently has ${yesVotes})`,
      });
    }
  } catch (err) {
    console.error('Error approving event:', err);
    res.status(500).json({ error: 'Failed to approve event' });
  }
});

// Helper function to get time until string
function getTimeUntilString(date) {
  const now = new Date();
  const diff = date - now;
  
  if (diff <= 0) return 'starting soon';
  
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `in ${days} day${days > 1 ? 's' : ''}`;
  if (hours > 0) return `in ${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
  return 'starting soon';
}

// Helper function to get time until string
function getTimeUntilString(date) {
  const now = new Date();
  const diff = date - now;
  
  if (diff <= 0) return 'starting soon';
  
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `in ${days} day${days > 1 ? 's' : ''}`;
  if (hours > 0) return `in ${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
  return 'starting soon';
}

// ── admin: member management ─────────────────────────────────────────────────
// Powers the Admin panel: list members, create accounts, edit profile info &
// photos, manage role tags, hand out timeouts, and force password resets.

function adminUserRow(u) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name || '',
    verified: !!u.verified,
    admin: !!u.admin,
    tags: u.tags ? String(u.tags).split(',') : [],
    timeoutUntil: isoOrNull(u.timeout_until),
    mustChangePassword: !!u.must_change_password,
    hasPhoto: !!u.has_photo,
    createdAt: u.created_at,
    lastSeen: u.last_seen || null,
  };
}

const ADMIN_USER_SELECT = `
  SELECT u.id, u.username, u.full_name, u.verified, u.admin, u.timeout_until,
         u.must_change_password, u.created_at,
         (u.photo IS NOT NULL) AS has_photo,
         (SELECT GROUP_CONCAT(t.tag, ',') FROM user_tags t WHERE t.user_id = u.id) AS tags,
         (SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
  FROM users u
`;

function getUserOr404(id, res) {
  const u = db.prepare(`${ADMIN_USER_SELECT} WHERE u.id = ?`).get(id);
  if (!u) { res.status(404).json({ error: 'Member not found' }); return null; }
  return u;
}

// GET /api/admin/users?search=  (admin) — every member, newest info first
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  let rows = db.prepare(`${ADMIN_USER_SELECT} ORDER BY u.username COLLATE NOCASE ASC`).all();
  const q = String(req.query.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter(r =>
      r.username.toLowerCase().includes(q) ||
      (r.full_name || '').toLowerCase().includes(q) ||
      (r.tags || '').toLowerCase().includes(q));
  }
  res.json(rows.map(adminUserRow));
});

// POST /api/admin/users  (admin) — create an account directly (no application).
// { username, password, fullName?, photo?: {mime,data}, tags?: [], verified?, mustChangePassword? }
app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, fullName, photo, tags, verified, mustChangePassword } = req.body || {};

  const cleaned = String(username || '').toLowerCase().trim();
  if (!cleaned) return res.status(400).json({ error: 'username is required' });
  if (!USERNAME_RE.test(cleaned))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, and . _ - characters (max 32)' });
  if (!password || String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(cleaned))
    return res.status(409).json({ error: `Username '${cleaned}' is already taken` });

  let photoMime = null, photoBuf = null;
  if (photo && (photo.mime || photo.data)) {
    const p = decodePhoto(photo);
    if (p.error) return res.status(400).json({ error: p.error });
    photoMime = p.mime; photoBuf = p.buf;
  }

  const normalized = normalizeTags(tags || []);
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, full_name, photo_mime, photo, verified, admin, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cleaned,
      hashPassword(String(password)),
      String(fullName || '').trim().slice(0, 80),
      photoMime, photoBuf,
      verified === undefined ? 1 : (verified ? 1 : 0), // admin-created accounts are trusted by default
      normalized.tags.includes('admin') ? 1 : 0,
      mustChangePassword ? 1 : 0
    );
  replaceTags(info.lastInsertRowid, normalized.tags);

  // A pending application for the same username can no longer be approved —
  // flag it so the Applications page doesn't confuse anyone later.
  db.prepare(
    `UPDATE applications SET status = 'denied', decided_by = ?, decided_at = datetime('now')
     WHERE username = ? AND status = 'pending'`
  ).run(req.user.id, cleaned);

  console.log(`Account @${cleaned} created by ${req.user.username}${mustChangePassword ? ' (must change password at first login)' : ''}`);
  const u = getUserOr404(info.lastInsertRowid, res);
  if (u) res.json(adminUserRow(u));
});

// PATCH /api/admin/users/:id  (admin) — update account info.
// Any subset of: { username?, fullName?, verified?, password?,
//                  mustChangePassword?, photo?: {mime,data} | null }
// photo: null removes the picture; omitting it leaves it untouched.
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Member not found' });

  const body = req.body || {};
  const sets = [], params = [];
  const notes = [];

  if (body.username !== undefined) {
    const cleaned = String(body.username).toLowerCase().trim();
    if (!USERNAME_RE.test(cleaned))
      return res.status(400).json({ error: 'Username may only contain letters, numbers, and . _ - characters (max 32)' });
    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(cleaned, id);
    if (clash) return res.status(409).json({ error: `Username '${cleaned}' is already taken` });
    if (cleaned !== existing.username) {
      sets.push('username = ?'); params.push(cleaned);
      notes.push(`username ${existing.username} → ${cleaned}`);
    }
  }

  if (body.fullName !== undefined) {
    sets.push('full_name = ?');
    params.push(String(body.fullName).trim().slice(0, 80));
  }

  if (body.verified !== undefined) {
    sets.push('verified = ?'); params.push(body.verified ? 1 : 0);
    notes.push(body.verified ? 'verified ✓ on' : 'verified ✓ off');
  }

  if (body.password !== undefined) {
    if (String(body.password).length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    sets.push('password_hash = ?'); params.push(hashPassword(String(body.password)));
    notes.push('password set by admin');
  }

  if (body.mustChangePassword !== undefined) {
    sets.push('must_change_password = ?'); params.push(body.mustChangePassword ? 1 : 0);
    notes.push(body.mustChangePassword ? 'must change password at next login' : 'forced password reset cleared');
  }

  if (body.photo !== undefined) {
    if (body.photo === null) {
      sets.push('photo = NULL', 'photo_mime = NULL');
      notes.push('photo removed');
    } else {
      const p = decodePhoto(body.photo);
      if (p.error) return res.status(400).json({ error: p.error });
      sets.push('photo = ?', 'photo_mime = ?'); params.push(p.buf, p.mime);
      notes.push('photo updated');
    }
  }

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  console.log(`Admin ${req.user.username} updated @${existing.username}${notes.length ? ` (${notes.join(', ')})` : ''}`);

  const u = getUserOr404(id, res);
  if (u) res.json(adminUserRow(u));
});

// PUT /api/admin/users/:id/tags  { tags: [...] }  (admin) — replace the full
// tag set. The 'admin' tag drives the users.admin flag; you cannot remove
// your own (that would lock you out of the panel mid-session).
app.put('/api/admin/users/:id/tags', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, username, admin FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Member not found' });

  const normalized = normalizeTags((req.body || {}).tags);
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  if (id === req.user.id && !normalized.tags.includes('admin'))
    return res.status(400).json({ error: 'You cannot remove your own admin tag' });

  replaceTags(id, normalized.tags);

  if (normalized.tags.includes('admin') && !existing.admin)
    console.log(`@${existing.username} promoted to admin by ${req.user.username}`);
  if (!normalized.tags.includes('admin') && existing.admin && id !== req.user.id)
    console.log(`@${existing.username} demoted from admin by ${req.user.username}`);
  if (ADMIN_USERNAMES.includes(existing.username) && !normalized.tags.includes('admin'))
    console.log(`Note: @${existing.username} is in ADMIN_USERNAMES and will be re-promoted on the next server restart`);

  const u = getUserOr404(id, res);
  if (u) res.json(adminUserRow(u));
});

// POST /api/admin/users/:id/timeout  (admin)
//   { minutes: n }        → timed out for n minutes from now
//   { until: <ISO date> } → timed out until that moment
//   { clear: true }       → lift the timeout
// Timed-out members can still sign in and read; posting is blocked.
app.post('/api/admin/users/:id/timeout', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Member not found' });

  if (id === req.user.id)
    return res.status(400).json({ error: 'You cannot time yourself out' });

  const { minutes, until, clear } = req.body || {};
  let value = null;

  if (!clear) {
    let when = null;
    if (minutes !== undefined && minutes !== null) {
      const mins = Number(minutes);
      if (!Number.isFinite(mins) || mins < 1 || mins > 60 * 24 * 366)
        return res.status(400).json({ error: 'minutes must be between 1 and 527040 (1 year)' });
      when = new Date(Date.now() + mins * 60 * 1000);
    } else if (until) {
      when = new Date(String(until));
      if (isNaN(when.getTime()))
        return res.status(400).json({ error: 'until must be a valid date/time' });
    } else {
      return res.status(400).json({ error: 'Provide minutes, until, or clear: true' });
    }
    if (when.getTime() <= Date.now())
      return res.status(400).json({ error: 'Timeout end must be in the future (use clear to lift it)' });
    value = sqlUtc(when);
  }

  db.prepare('UPDATE users SET timeout_until = ? WHERE id = ?').run(value, id);

  if (value) {
    // Kick live sessions' write access immediately is handled by the guard on
    // every write endpoint — but also note it in the log.
    console.log(`@${existing.username} timed out until ${value} UTC by ${req.user.username}`);
  } else {
    console.log(`Timeout for @${existing.username} lifted by ${req.user.username}`);
  }

  const u = getUserOr404(id, res);
  if (u) res.json(adminUserRow(u));
});

// ── push notifications ────────────────────────────────────────────────────────

// GET /api/push/vapid-key — public VAPID key for subscription
app.get('/api/push/vapid-key', (_, res) => {
  if (!vapidPublicKey) {
    return res.status(500).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey: vapidPublicKey });
});

// POST /api/push/subscribe — register push subscription for current user
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }
  
  registerSubscription(req.user.id, subscription);
  res.json({ ok: true });
});

// POST /api/push/unsubscribe — remove push subscription for current user
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  removeSubscription(req.user.id);
  res.json({ ok: true });
});

// GET /api/push/subscription — get current user's subscription status
app.get('/api/push/subscription', requireAuth, (req, res) => {
  const subscription = getSubscription(req.user.id);
  res.json({ subscribed: !!subscription });
});

// ── meeting reminder scheduler ───────────────────────────────────────────────
// Check for upcoming meetings and send reminders periodically
// Track sent reminders to avoid duplicates
const sentReminders = new Set(); // eventId_timestamp

function scheduleMeetingReminders() {
  setInterval(async () => {
    try {
      const now = new Date();
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
      
      // Get approved meetings in the next hour
      const rows = db.prepare(
        `SELECT * FROM calendar_events 
         WHERE status = 'approved' 
         AND date >= ? 
         AND date <= ?`
      ).all(sqlUtc(now), sqlUtc(oneHourFromNow));
      
      for (const event of rows) {
        const eventDate = new Date(event.date);
        const timeUntil = getTimeUntilString(eventDate);
        const reminderKey = `${event.id}_${Math.floor(eventDate.getTime() / (60 * 60 * 1000))}`; // Unique key per hour
        
        // Only send if we haven't sent a reminder for this event in this hour
        if (!sentReminders.has(reminderKey)) {
          sentReminders.add(reminderKey);
          
          // Send reminder to all subscribed users
          const subscribedUsers = getSubscribedUserIds();
          if (subscribedUsers.length > 0) {
            subscribedUsers.forEach(userId => {
              sendMeetingReminderNotification(userId, {
                meetingId: event.id,
                title: event.title,
                location: event.location || 'TBD',
                timeUntil: timeUntil
              }).catch(err => console.error('Push notification failed:', err.message));
            });
          }
        }
      }
    } catch (err) {
      console.error('Meeting reminder check failed:', err);
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}

// ── remote development workspace ─────────────────────────────────────────────

/**
 * GET /api/remote-dev/connect - Initialize remote dev session
 * Requires authentication
 */
app.get('/api/remote-dev/connect', requireAuth, (req, res) => {
  // User is authenticated, grant access to their workspace
  // The actual file operations happen via the SSH server which uses the same auth
  res.json({
    success: true,
    workspacePath: `~/Jarvis/dev/workspaces/${req.user.username}`,
    message: 'Connected to remote development workspace'
  });
});

/**
 * GET /api/remote-dev/files - List files in workspace
 * Requires authentication
 */
app.get('/api/remote-dev/files', requireAuth, async (req, res) => {
  try {
    const { path = '~' } = req.query;
    const username = req.user.username;
    
    // Security: Ensure user can only access their own workspace
    const requestedPath = String(path);
    if (!requestedPath.includes(username)) {
      return res.status(403).json({ 
        error: 'Access denied: Can only access your own workspace' 
      });
    }
    
    // In production, this would call the SSH server or a file service
    // For now, return a mock structure - the real implementation uses the SSH server
    res.json({
      success: true,
      files: [
        {
          name: 'src',
          path: '~/Jarvis/dev/workspaces/src',
          type: 'folder',
          children: [
            { name: 'Main.java', path: '~/Jarvis/dev/workspaces/src/Main.java', type: 'file' },
            { name: 'RobotContainer.java', path: '~/Jarvis/dev/workspaces/src/RobotContainer.java', type: 'file' }
          ]
        },
        {
          name: 'vendordeps',
          path: '~/Jarvis/dev/workspaces/vendordeps',
          type: 'folder',
          children: []
        },
        { name: 'build.gradle', path: '~/Jarvis/dev/workspaces/build.gradle', type: 'file' },
        { name: 'settings.gradle', path: '~/Jarvis/dev/workspaces/settings.gradle', type: 'file' }
      ]
    });
  } catch (error) {
    console.error('[Remote Dev Files] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to list files',
      details: error.message
    });
  }
});

/**
 * GET /api/remote-dev/file - Get file content
 * Requires authentication
 */
app.get('/api/remote-dev/file', requireAuth, async (req, res) => {
  try {
    const { path } = req.query;
    const username = req.user.username;
    
    if (!path) {
      return res.status(400).json({ error: 'path parameter required' });
    }
    
    // Security: Ensure user can only access their own workspace
    const requestedPath = String(path);
    if (!requestedPath.includes(username)) {
      return res.status(403).json({ 
        error: 'Access denied: Can only access your own workspace' 
      });
    }
    
    // In production, fetch from SSH server or file service
    // Mock response for now
    res.json({
      success: true,
      content: `// Sample Java file for ${username}
package frc.robot;

public class Main {
    public static void main(String... args) {
        System.out.println("Hello from WPLib Remote Dev!");
    }
}`
    });
  } catch (error) {
    console.error('[Remote Dev File] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get file',
      details: error.message
    });
  }
});

/**
 * PUT /api/remote-dev/file - Save file content
 * Requires authentication
 */
app.put('/api/remote-dev/file', requireAuth, async (req, res) => {
  try {
    const { path, content } = req.body || {};
    const username = req.user.username;
    
    if (!path || content === undefined) {
      return res.status(400).json({ error: 'path and content required' });
    }
    
    // Security: Ensure user can only modify their own workspace
    const requestedPath = String(path);
    if (!requestedPath.includes(username)) {
      return res.status(403).json({ 
        error: 'Access denied: Can only modify your own workspace' 
      });
    }
    
    // Validate content size (max 1MB per file)
    if (String(content).length > 1024 * 1024) {
      return res.status(400).json({ error: 'File content too large (max 1MB)' });
    }
    
    // In production, save via SSH server or file service
    // Mock success for now
    res.json({
      success: true,
      message: 'File saved successfully',
      path
    });
  } catch (error) {
    console.error('[Remote Dev Save] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to save file',
      details: error.message
    });
  }
});

// ── start ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));

  // Keep the recurring weekly meetings seeded on long-running processes
  // (initDb seeds startup; this extends the horizon as days roll by).
  const reseed = setInterval(() => {
    try { ensureRecurringMeetings(); }
    catch (err) { console.error('Recurring meeting seeding failed:', err); }
  }, 6 * 60 * 60 * 1000);
  reseed.unref?.();
  
  // Start meeting reminder scheduler
  scheduleMeetingReminders();
  
  // Robot connectivity check on startup
  robot.checkRobotConnection().then(connected => {
    console.log(`[Robot] Connection to ${robot.ROBOT_IP}: ${connected ? 'OK' : 'OFFLINE'}`);
  }).catch(err => {
    console.error('[Robot] Connection check failed:', err.message);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
