// Load api/.env (RESEND_API_KEY, SMTP_*, ADMIN_EMAIL, PUBLIC_URL, …) before
// anything reads process.env. The file is git-ignored — see README.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { z }   = require('zod');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { db, initDb, ADMIN_USERNAMES, ensureRecurringMeetings } = require('./db');
const { sendMail } = require('./mailer');
const {
  hashPassword, verifyPassword, maybeUpgradePasswordHash,
  createSession, destroySession, requireAuth, requireAdmin, blockIfTimedOut,
  getJoinKeyInfo, setJoinKey, clearJoinKey, joinWithKey, KEY_TTL_DAYS,
  SESSION_TTL_DAYS,
} = require('./auth');
const {
  isConfigured: isGoogleConfigured, loginWithGoogle,
  listDeniedEmails, markDeniedReviewed,
} = require('./googleAuth');
const {
  attachDb, registerSubscription, removeSubscription, getSubscription, getSubscribedUserIds,
  sendBoardMessageNotification, sendMeetingReminderNotification, sendPushNotification,
  sendPushNotificationToMany,
  vapidPublicKey, subscriptions
} = require('./push');
const robot = require('./robot');
const { createRemoteDevRouter } = require('./remoteDev');

const app  = express();
// Standard production flag (also used for the Secure cookie flag below).
const isProd = process.env.NODE_ENV === 'production';
// HttpOnly cookie that lets returning Google users re-sign-in with one click
// (POST /api/auth/google/quick). Contains only their verified email.
const GOOGLE_COOKIE = 'mchs_gsid';
// parseInt: a string PORT (e.g. from PM2's env or the shell) makes
// server.listen() treat it as a pipe/path and fail in confusing ways.
const PORT = parseInt(process.env.PORT, 10) || 3001;

// Push subscriptions are stored in SQLite — hand the handle to the push module.
attachDb(db);

// Behind ONE reverse proxy (nginx/Caddy in front of PM2). `true` (= hop count
// ∞) lets any client spoof X-Forwarded-* and breaks the rate limiter's IP
// keying; 1 is the correct setting for a single trusted proxy.
app.set('trust proxy', 1);
// Standard security headers on API responses. contentSecurityPolicy is left
// off: this origin also serves the Vite-built frontend, whose CSP belongs to
// the static host (nginx/Caddy), not the API.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser()); // required by the Google quick-sign-in cookie routes
app.use(express.json({ limit: '15mb' })); // applications carry base64 photos

// ── input validation (zod) ───────────────────────────────────────────────────
// Replaces hand-rolled typeof/regex checks scattered across the routes.
// Usage: const [data, errResponse] = validate(LoginSchema, req, res);
function validate(schema, req, res) {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ error: `${first.path.join('.') || 'body'}: ${first.message}` });
    return [null, undefined];
  }
  return [parsed.data, null];
}

const UsernameSchema = z.string().trim().toLowerCase()
  .min(1, 'required').max(32, 'may be at most 32 characters')
  .regex(/^[a-z0-9._-]+$/, 'may only contain letters, numbers, and . _ - characters');

const LoginSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(1, 'required').max(200),
});

const JoinLoginSchema = z.object({
  username: z.string().trim().toLowerCase().min(3).max(20)
    .regex(/^[a-z0-9_]+$/, 'Usernames: 3–20 letters, numbers, or underscores.'),
  key: z.string().min(1, 'Enter the team key.').max(100),
});

const PasswordResetSchema = z.object({
  username: UsernameSchema,
  currentPassword: z.string().min(1, 'required').max(200),
  newPassword: z.string().min(6, 'New password must be at least 6 characters').max(200),
});

const PhotoSchema = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  data: z.string().min(64, 'Photo data is invalid'),
});

const ApplicationSchema = z.object({
  username: UsernameSchema,
  fullName: z.string().trim().min(1, 'Full name is required').max(80),
  photo: PhotoSchema.optional(),
});

const NotificationSettingsSchema = z.object({
  settings: z.enum(['all', 'mentions_only', 'none']),
});

const ProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(80),
});

const ProfilePhotoSchema = z.object({ photo: PhotoSchema });

const ChannelSchema = z.object({
  name: z.string().min(2, 'Channel name must be at least 2 characters (letters/numbers only)').max(64),
  description: z.string().max(200).optional().default(''),
});

const MessageSchema = z.object({
  body: z.string().trim().min(1, 'Message is empty').max(2000, 'Message is too long (max 2000 characters)'),
});

const AvailabilitySchema = z.object({
  title: z.string().max(120).optional().nullable(),
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$/, 'date must look like 2026-04-10 or 2026-04-10T16:00'),
  startTime: z.string().regex(/^([0-9]{2}:[0-9]{2})?$/, 'HH:MM').optional().nullable(),
  endTime: z.string().regex(/^([0-9]{2}:[0-9]{2})?$/, 'HH:MM').optional().nullable(),
  location: z.string().max(120).optional().nullable(),
  repeatType: z.enum(['none', 'weekly', 'monthly']).optional().default('none'),
}).refine(d => d.date, { message: 'Date is required' });

const EventCreateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().max(5000).optional().default(''),
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$/, 'date must look like 2026-04-10 or 2026-04-10T16:00'),
  location: z.string().max(200).optional().default(''),
  type: z.enum(['meeting', 'event', 'workshop', 'competition']).optional().default('meeting'),
  push: z.boolean().optional().default(false),
});

const EventUpdateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200).optional(),
  description: z.string().max(5000).optional(),
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$/, 'date must look like 2026-04-10 or 2026-04-10T16:00').optional(),
  location: z.string().max(200).optional(),
  type: z.enum(['meeting', 'event', 'workshop', 'competition']).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

const VoteSchema = z.object({ vote: z.union([z.literal(1), z.literal(-1)]) });

const DecisionSchema = z.object({ action: z.enum(['approve', 'deny']) });

const AdminUserCreateSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(6, 'Password must be at least 6 characters').max(200),
  fullName: z.string().trim().max(80).optional().default(''),
  photo: PhotoSchema.nullable().optional(),
  tags: z.array(z.any()).optional().default([]),
  verified: z.boolean().optional(),
  mustChangePassword: z.boolean().optional().default(false),
});

const AdminUserPatchSchema = z.object({
  username: UsernameSchema.optional(),
  fullName: z.string().trim().max(80).optional(),
  verified: z.boolean().optional(),
  password: z.string().min(6, 'Password must be at least 6 characters').max(200).optional(),
  mustChangePassword: z.boolean().optional(),
  photo: PhotoSchema.nullable().optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' });

const TimeoutSchema = z.object({
  minutes: z.number().int().min(1, 'minutes must be between 1 and 527040 (1 year)')
    .max(60 * 24 * 366, 'minutes must be between 1 and 527040 (1 year)').optional(),
  until: z.string().datetime({ offset: true }).or(z.string().min(4)).optional(),
  clear: z.boolean().optional(),
});

const JoinKeySetSchema = z.object({
  key: z.string().min(6, 'The team key should be at least 6 characters (letters and numbers).').max(100),
  label: z.string().max(60).optional().default(''),
  days: z.number().int().min(1).max(365).optional(),
});

const PushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url('Invalid subscription object').max(2048),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).partial().optional(),
  }),
});

// ── rate limits (express-rate-limit) ─────────────────────────────────────────
// Auth endpoints were previously unlimited — trivial to brute-force the team
// key or member passwords. trust proxy=1 above makes the client IP correct
// behind nginx/Caddy so these limits actually key on real clients.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in a few minutes.' },
});
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'You are sending messages too quickly — take a breath.' },
});
app.use('/api', generalLimiter);

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
app.post('/api/applications', authLimiter, (req, res) => {
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
  const info = db
    .prepare(
      `INSERT INTO applications (username, full_name, password_hash, photo_mime, photo, token)
       VALUES (?, ?, '', ?, ?, ?)`
    )
    .run(cleaned, name, mime, buf, token);

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
app.get('/api/applications/:id/decision', (req, res) => {
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

// ── accounts ─────────────────────────────────────────────────────────────────

// Build the standard login-success payload for a user row (shared by
// /api/login and /api/login/code).
function sessionPayload(user) {
  const tags = db
    .prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag ASC')
    .all(user.id)
    .map(t => t.tag);
  return {
    userId: user.id,
    username: user.username,
    token: createSession(user.id),
    verified: !!user.verified,
    admin: !!user.admin,
    fullName: user.full_name || '',
    tags,
    hasPhoto: user.photo != null,
    timeoutUntil: isoOrNull(user.timeout_until),
  };
}

// ── sign-in ──────────────────────────────────────────────────────────────────
// Primary method: Google Sign-In (api/googleAuth.js). The browser gets an ID
// token from Google Identity Services and posts it here; we verify it
// server-side, gate by school domain (GOOGLE_ALLOWED_DOMAINS), create/link the
// account, and hand back a session. No passwords, no team key, nothing to
// forget on Chromebooks.
//
// Legacy paths kept for recovery/automation accounts and old scripts:
//   POST /api/login        { username, password }  — bcrypt fallback
//   POST /api/login/join   { username, key }       — old shared team key
//   POST /api/password/reset                       — forced password change

// GET /api/auth/config — what the sign-in screen needs to know (public).
app.get('/api/auth/config', (_, res) => {
  const configured = isGoogleConfigured();
  res.json({
    googleEnabled: configured,
    // Only expose the client ID when Google sign-in actually works, so the
    // frontend never renders a button that can only fail.
    googleClientId: configured ? process.env.GOOGLE_CLIENT_ID : null,
  });
});

// POST /api/auth/google  { credential }  (credential = Google ID token)
// On success responds with the standard session payload AND sets an HttpOnly
// cookie (mchs_gsid=<email>) so a returning user can complete sign-in with one
// click — no popup, no interaction, safe for kiosk-style Chromebooks.
app.post('/api/auth/google', authLimiter, async (req, res) => {
  if (!isGoogleConfigured())
    return res.status(503).json({ error: 'Google Sign-In is not configured on this server yet.' });

  const credential = String((req.body || {}).credential || '');
  const result = await loginWithGoogle(credential);

  if (result.error && !result.denied && !result.pending)
    return res.status(401).json({ error: result.error });
  if (result.denied)
    return res.status(403).json({ code: 'denied', email: result.email, error: result.error });
  if (result.pending)
    return res.status(403).json({ code: 'pending', error: result.error });

  console.log(`@${result.user.username} signed in with Google <${result.user.email}>`);
  res.cookie(GOOGLE_COOKIE, result.user.email, {
    httpOnly: true, sameSite: 'lax', secure: isProd,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000, path: '/',
  });
  res.json(sessionPayload(result.user));
});

// POST /api/auth/google/quick  {} — silent re-auth for users who signed in
// with Google before: the browser still has our HttpOnly cookie, so we mint a
// fresh session without touching Google at all. Rate-limited + requires the
// cookie to match an existing verified account.
app.post('/api/auth/google/quick', authLimiter, (req, res) => {
  const email = String(req.cookies?.[GOOGLE_COOKIE] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not signed in' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Account not found — please sign in again.' });
  if (!user.verified)
    return res.status(403).json({ code: 'pending', error: 'Your account is still pending admin approval.' });

  res.json(sessionPayload(user));
});

// GET /api/auth/google/status — does this browser carry the quick-sign-in
// cookie? Lets the landing page show a one-click "Continue as …" button.
app.get('/api/auth/google/status', (req, res) => {
  const email = String(req.cookies?.[GOOGLE_COOKIE] || '').toLowerCase().trim();
  if (!email) return res.json({ remembered: false });
  const user = db.prepare('SELECT username, full_name, verified FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ remembered: false });
  res.json({ remembered: true, username: user.username, fullName: user.full_name || '', verified: !!user.verified });
});

// (The quick-sign-in cookie is cleared in POST /api/logout below.)

// ── Google sign-in: admin review of blocked accounts ─────────────────────────
// When someone signs in with a non-approved domain, googleAuth.js records them
// in `google_denied` so an admin can see the attempt here (and then either add
// the school's domain to GOOGLE_ALLOWED_DOMAINS or approve that exact address
// via GOOGLE_ALLOWLIST + re-check).

// GET /api/admin/google-denied — recent blocked sign-in attempts (admin)
app.get('/api/admin/google-denied', requireAuth, requireAdmin, (_, res) => {
  res.json({ requests: listDeniedEmails() });
});

// POST /api/admin/google-denied/:id/review — mark an attempt as handled
app.post('/api/admin/google-denied/:id/review', requireAuth, requireAdmin, (req, res) => {
  markDeniedReviewed(req.params.id);
  res.json({ ok: true });
});

// ── team key (LEGACY admin-managed) ──────────────────────────────────────────

// GET /api/admin/join-key — status only; the key itself is stored hashed
app.get('/api/admin/join-key', requireAuth, requireAdmin, (_, res) => {
  const info = getJoinKeyInfo();
  if (!info) return res.json({ set: false });
  res.json({
    set: true,
    label: info.label,
    createdAt: info.createdAt,
    expiresAt: info.expiresAt,
    expired: new Date(info.expiresAt.replace(' ', 'T') + 'Z').getTime() < Date.now(),
  });
});

// POST /api/admin/join-key  { key, label?, days? } — set or rotate the key.
// Existing sessions stay valid; only NEW sign-ins need the new key.
app.post('/api/admin/join-key', requireAuth, requireAdmin, (req, res) => {
  const [body,] = validate(JoinKeySetSchema, req, res);
  if (!body) return;
  const ttl = body.days || KEY_TTL_DAYS;
  const r = setJoinKey(body.key, req.user.id, body.label, ttl);
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`Team key rotated by ${req.user.username} (label "${r.label}", valid ${ttl}d)`);
  res.json({ ok: true, label: r.label, createdAt: r.createdAt, expiresAt: r.expiresAt });
});

// DELETE /api/admin/join-key — close self-service sign-in (applications still work)
app.delete('/api/admin/join-key', requireAuth, requireAdmin, (req, res) => {
  clearJoinKey();
  console.log(`Team key removed by ${req.user.username}`);
  res.json({ ok: true });
});

// Legacy fallback: POST /api/login/join  { username, key } — the old shared
// "team key" sign-in. Superseded by Google Sign-In; kept only so recovery/
// automation scripts and old databases keep working. Not offered in the UI.
app.post('/api/login/join', authLimiter, (req, res) => {
  const [data,] = validate(JoinLoginSchema, req, res);
  if (!data) return;
  const result = joinWithKey(data.username, data.key);

  if (result.pending)
    return res.status(403).json({
      code: 'pending',
      error: 'Your application is still pending review — you can sign in once an admin approves it.',
    });

  if (result.apply) {
    const uname = String(data.username || '').toLowerCase().trim();
    // Raise (or reuse) a pending application so an admin sees them in the queue.
    let appId = db
      .prepare(`SELECT id FROM applications WHERE username = ? AND status = 'pending'`)
      .get(uname)?.id;
    if (!appId && /^[a-z0-9_]{3,20}$/.test(uname)) {
      appId = Number(
        db
          .prepare(
            `INSERT INTO applications (username, full_name, password_hash, token)
             VALUES (?, ?, '', ?)`
          )
          .run(
            uname,
            `${uname} (join request from sign-in screen)`,
            crypto.randomBytes(32).toString('hex')
          ).lastInsertRowid
      );
    }
    return res.status(403).json({
      code: 'apply',
      applicationId: appId ?? null,
      error: appId
        ? `That team key doesn't match. We've opened a join request for @${uname} — an admin will review it, then you'll get the current key.`
        : "That team key doesn't match, and that username isn't valid. Ask a teammate for the current key.",
    });
  }

  if (result.error) return res.status(401).json({ error: result.error });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId);
  console.log(`@${user.username} signed in with the legacy team key`);
  res.json(sessionPayload(user));
});

// POST /api/login  { username, password } — legacy bcrypt sign-in kept for
// recovery/automation accounts (and the E2E test suite). Regular members use
// Google Sign-In above.
app.post('/api/login', authLimiter, (req, res) => {
  const [data,] = validate(LoginSchema, req, res);
  if (!data) return;

  const uname = data.username;
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

  // bcrypt verify; legacy scrypt hashes are upgraded transparently on success.
  if (!maybeUpgradePasswordHash(user, data.password))
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
app.post('/api/password/reset', authLimiter, (req, res) => {
  const [data,] = validate(PasswordResetSchema, req, res);
  if (!data) return;

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(data.username);
  if (!user || !user.must_change_password)
    return res.status(403).json({ error: 'This account does not need a password reset — sign in normally' });

  if (!maybeUpgradePasswordHash(user, data.currentPassword))
    return res.status(401).json({ error: 'Current password is incorrect' });

  if (verifyPassword(data.newPassword, user.password_hash))
    return res.status(400).json({ error: 'New password must be different from the current one' });

  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`
  ).run(hashPassword(data.newPassword), user.id);
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

// POST /api/logout — destroys the session and clears the Google quick-sign-in
// cookie so "Sign out" really means signed out everywhere on this browser.
app.post('/api/logout', requireAuth, (req, res) => {
  destroySession(req.user.token);
  updateUserPresence(req.user.id, false); // Mark user as offline
  res.clearCookie(GOOGLE_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// PUT /api/me/notification-settings — update notification preferences
app.put('/api/me/notification-settings', requireAuth, (req, res) => {
  const [data,] = validate(NotificationSettingsSchema, req, res);
  if (!data) return;

  db.prepare('UPDATE users SET notification_settings = ? WHERE id = ?').run(data.settings, req.user.id);
  res.json({ ok: true, notificationSettings: data.settings });
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

// ── profile & availability ────────────────────────────────────────────────────

// PUT /api/profile — update profile information (full name)
app.put('/api/profile', requireAuth, blockIfTimedOut, (req, res) => {
  const [data,] = validate(ProfileSchema, req, res);
  if (!data) return;
  db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(data.fullName, req.user.id);
  res.json({ ok: true });
});

// POST /api/profile/photo — upload profile photo
app.post('/api/profile/photo', requireAuth, blockIfTimedOut, (req, res) => {
  const photo = (req.body || {}).photo;
  if (!photo) {
    return res.status(400).json({ error: 'No photo provided' });
  }
  
  const mime = photo.mime || photo.type;
  const ext = PHOTO_MIMES[mime];
  if (!ext) {
    return res.status(400).json({ error: 'Photo must be JPG, PNG, WebP, or GIF' });
  }
  
  let buf;
  try {
    // Handle both base64 string and FormData
    const dataStr = photo.data || photo;
    buf = Buffer.from(String(dataStr), 'base64');
  } catch {
    return res.status(400).json({ error: 'Photo data is invalid' });
  }
  
  if (buf.length < 64) {
    return res.status(400).json({ error: 'Photo data is invalid' });
  }
  if (buf.length > MAX_PHOTO_BYTES) {
    return res.status(400).json({ error: 'Photo is too large (max 6 MB)' });
  }
  
  db.prepare('UPDATE users SET photo = ?, photo_mime = ? WHERE id = ?').run(buf, mime, req.user.id);
  res.json({ ok: true });
});

// GET /api/availability — get user's availability blocks
app.get('/api/availability', requireAuth, (_, res) => {
  const rows = db
    .prepare('SELECT * FROM user_availability WHERE user_id = ? ORDER BY date ASC, start_time ASC')
    .all(req.user.id);
  res.json(rows);
});

// POST /api/availability — create availability block
app.post('/api/availability', requireAuth, blockIfTimedOut, (req, res) => {
  const { title, date, startTime, endTime, location, repeatType } = req.body || {};
  
  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }
  
  const insert = db.prepare(`
    INSERT INTO user_availability (user_id, title, date, start_time, end_time, location, repeat_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const info = insert.run(
    req.user.id,
    title || null,
    date,
    startTime || null,
    endTime || null,
    location || null,
    repeatType || 'none'
  );
  
  res.json({ id: info.lastInsertRowid, ok: true });
});

// DELETE /api/availability/:id — delete availability block
app.delete('/api/availability/:id', requireAuth, blockIfTimedOut, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT user_id FROM user_availability WHERE id = ?').get(id);
  
  if (!row) {
    return res.status(404).json({ error: 'Availability block not found' });
  }
  
  if (!req.user.admin && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  db.prepare('DELETE FROM user_availability WHERE id = ?').run(id);
  res.json({ ok: true });
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

// GET /api/users/mentionable — usernames for the @-mention autocomplete.
// Authenticated so guests can't enumerate the roster; verified members only.
app.get('/api/users/mentionable', requireAuth, (_, res) => {
  const rows = db
    .prepare(
      `SELECT u.username, u.full_name, u.admin,
              COALESCE(group_concat(t.tag, ','), '') AS tags
       FROM users u
       LEFT JOIN user_tags t ON t.user_id = u.id AND t.tag != 'admin'
       WHERE u.verified = 1
       GROUP BY u.id
       ORDER BY u.username`
    )
    .all();
  res.json(rows.map(r => ({
    username: r.username,
    name: r.full_name || r.username,
    admin: !!r.admin,
    tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
  })));
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

// ── calendar events ──────────────────────────────────────────────────────────
// Members PROPOSE events (status 'pending') which move onto the calendar once
// a majority votes 👍. Admins can PUSH events straight onto the calendar
// (status 'approved', no voting required), approve or reject any proposal,
// and delete any event.

const EVENT_TYPES = ['meeting', 'event', 'workshop', 'competition'];

function eventRow(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    date: row.date,
    location: row.location || '',
    type: row.type || 'meeting',
    status: row.status || 'pending',
    isMeeting: (row.type || 'meeting') === 'meeting',
    proposedBy: row.proposed_by != null && row.proposed_by !== '' ? Number(row.proposed_by) : null,
    proposerName: row.proposer_name || null,
  };
}

// Notify everyone subscribed to pushes that an event landed on the calendar.
// Aggressive delivery: a prominent "New event" announcement (tagged +
// renotify so it surfaces even if an older one is still on screen), plus the
// reminder-style push, plus scheduled follow-ups before the event starts.
function notifyEventApproved(event) {
  try {
    const subscribedUsers = getSubscribedUserIds();
    if (subscribedUsers.length === 0) return;
    const timeUntil = getTimeUntilString(new Date(event.date));
    const where = event.location || 'TBD';

    subscribedUsers.forEach(userId => {
      // Primary announcement
      sendPushNotification(userId, {
        title: `\u{1F4C5} New event: ${event.title}`,
        body: `${where} \u2014 ${fmtEventWhen(event.date)} (starting ${timeUntil}). Tap to view the calendar.`,
        data: { type: 'event_added', eventId: event.id, url: '/calendar' },
        tag: `event-${event.id}`,
        renotify: true,
        requireInteraction: true,
      }).catch(err => console.error('Push notification failed:', err.message));

      // Reminder-style push too, so it also lands in the reminders thread
      sendMeetingReminderNotification(userId, {
        meetingId: event.id,
        title: event.title,
        location: where,
        timeUntil: timeUntil,
      }).catch(err => console.error('Push notification failed:', err.message));
    });

    scheduleEventFollowups(event);
  } catch (err) {
    console.error('Failed to send push notifications for approved event:', err.message);
  }
}

// Human-readable when-string for pushes: "today at 4:00 PM", "tomorrow at 12:00 PM"
function fmtEventWhen(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isTomorrow = d.getFullYear() === tomorrow.getFullYear() &&
                     d.getMonth() === tomorrow.getMonth() &&
                     d.getDate() === tomorrow.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isSameDayLocal(d, now)) return `today at ${time}`;
  if (isTomorrow) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

function isSameDayLocal(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Follow-up nudges after an event lands on the calendar: a morning-of heads-up
// and an "almost time" push ~55 min before start (ahead of the scheduler's
// hourly window). In-process timers — best-effort, but they make pushes land
// far more often than the old announce-once-then-silence behavior.
const eventFollowupTimers = new Map(); // eventId -> [timer, …]
function scheduleEventFollowups(event) {
  try {
    const start = new Date(event.date);
    if (Number.isNaN(start.getTime())) return;

    (eventFollowupTimers.get(event.id) || []).forEach(clearTimeout);
    const timers = [];
    eventFollowupTimers.set(event.id, timers);

    const broadcast = (payload) => {
      getSubscribedUserIds().forEach(userId => {
        sendPushNotification(userId, payload)
          .catch(err => console.error('Push notification failed:', err.message));
      });
    };

    const queue = (when, build) => {
      const delay = when - Date.now();
      if (delay <= 0 || delay > 24 * 60 * 60 * 1000) return; // skip stale / far-out
      timers.push(setTimeout(() => broadcast(build()), delay));
    };

    // Morning-of reminder (8:00 AM local on the event day, if still ahead)
    const morning = new Date(start); morning.setHours(8, 0, 0, 0);
    queue(morning, () => ({
      title: `\u{1F3C1} Today: ${event.title}`,
      body: `Starts ${fmtEventWhen(event.date).split(' at ')[1] ? 'at ' + start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'today'} \u2014 ${event.location || 'TBD'}. See you there!`,
      data: { type: 'event_reminder', eventId: event.id, url: '/calendar' },
      tag: `event-${event.id}-morning`,
      requireInteraction: true,
    }));

    // Heads-up ~55 minutes before start
    queue(new Date(start.getTime() - 55 * 60 * 1000), () => ({
      title: `\u23F0 Almost time: ${event.title}`,
      body: `Starting ${getTimeUntilString(start)} at ${event.location || 'TBD'}. Head over!`,
      data: { type: 'event_reminder', eventId: event.id, url: '/calendar' },
      tag: `event-${event.id}-soon`,
      renotify: true,
      requireInteraction: true,
    }));
  } catch (err) {
    console.error('Failed to schedule event follow-ups:', err.message);
  }
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
    res.json(rows.map(eventRow));
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// POST /api/events — create a calendar event.
// Members propose (status 'pending' → goes to the voting panel); admins may
// pass { push: true } to skip voting and land it on the calendar immediately.
app.post('/api/events', requireAuth, blockIfTimedOut, (req, res) => {
  const { title, description, date, location, type, push } = req.body || {};

  if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });

  const evType = type || 'meeting';
  if (!EVENT_TYPES.includes(evType))
    return res.status(400).json({ error: 'type must be meeting, event, workshop, or competition' });

  // Only admins may bypass the vote workflow.
  const status = (push && req.user.admin) ? 'approved' : 'pending';

  try {
    const info = db
      .prepare(
        `INSERT INTO calendar_events (title, description, date, location, type, status, proposed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(String(title).trim(), description || '', date, location || '', evType, status, String(req.user.id));

    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(info.lastInsertRowid);
    if (status === 'approved') notifyEventApproved(event);
    res.json(eventRow(event));
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

// Update an event (admin or the original proposer). Used for edits and for
// toggling approved <-> pending without deleting/recreating (which would lose
// votes and recurring-seed linkage).
app.put('/api/events/:id', requireAuth, blockIfTimedOut, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isProposer = event.proposed_by != null && event.proposed_by !== '' &&
      Number(event.proposed_by) === Number(req.user.id);
    if (!isProposer && !req.user.admin)
      return res.status(403).json({ error: 'Only an admin or the proposer can edit this event' });

    const b = req.body || {};
    const next = {
      title:       b.title !== undefined ? String(b.title).trim() : event.title,
      description: b.description !== undefined ? (b.description || '') : (event.description || ''),
      date:        b.date !== undefined ? String(b.date) : event.date,
      location:    b.location !== undefined ? (b.location || '') : (event.location || ''),
      type:        b.type !== undefined ? b.type : (event.type || 'meeting'),
      status:      b.status !== undefined ? b.status : (event.status || 'pending'),
    };
    if (!next.title || !next.date) return res.status(400).json({ error: 'Title and date are required' });
    if (!EVENT_TYPES.includes(next.type)) return res.status(400).json({ error: `type must be one of ${EVENT_TYPES.join(', ')}` });
    if (!['pending', 'approved', 'rejected'].includes(next.status))
      return res.status(400).json({ error: 'status must be pending, approved, or rejected' });
    // Only admins may (re-)approve directly.
    if (next.status === 'approved' && event.status !== 'approved' && !req.user.admin)
      return res.status(403).json({ error: 'Members cannot approve their own events — send it through voting' });
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$/.test(next.date))
      return res.status(400).json({ error: 'date must look like 2026-04-10 or 2026-04-10T16:00' });

    const wasApproved = event.status === 'approved';
    db.prepare(
      `UPDATE calendar_events SET title=?, description=?, date=?, location=?, type=?, status=? WHERE id=?`
    ).run(next.title, next.description, next.date, next.location, next.type, next.status, event.id);

    const updated = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
    if (!wasApproved && next.status === 'approved') notifyEventApproved(updated);
    res.json(eventRow(updated));
  } catch (err) {
    console.error('Error updating event:', err);
    res.status(500).json({ error: 'Failed to update event' });
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

    let promoted = false;
    const ev = db.prepare(`SELECT status FROM calendar_events WHERE id = ?`).get(req.params.id);
    const yes = totals.yes_votes || 0, total = totals.total_votes || 0;
    if (ev && ev.status === 'pending' && total > 0 && yes >= Math.floor(total / 2) + 1) {
      db.prepare(`UPDATE calendar_events SET status = 'approved' WHERE id = ?`).run(req.params.id);
      notifyEventApproved(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id));
      promoted = true;
    }

    res.json({
      event_id: Number(req.params.id),
      yes_votes: yes,
      no_votes: totals.no_votes || 0,
      total_votes: total,
      promoted,
    });
  } catch (err) {
    console.error('Error voting on event:', err);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

// PUT /api/events/:id/approve — put a proposal on the calendar.
// Anyone may call it, but it only succeeds once a majority voted yes; admins
// can force-approve any pending proposal (their word is enough — no votes
// needed).
app.put('/api/events/:id/approve', requireAuth, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'approved') {
      return res.json({ success: true, approved: true, message: 'Event is already on the calendar' });
    }
    if (event.status !== 'pending') {
      return res.status(400).json({ success: false, approved: false, error: `Event was ${event.status}` });
    }

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

    // Admin decision counts as approval on its own; members need a vote majority.
    if (req.user.admin || (totalVotes > 0 && yesVotes >= majority)) {
      db.prepare(`UPDATE calendar_events SET status = 'approved' WHERE id = ?`).run(req.params.id);
      notifyEventApproved(event);
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

// PUT /api/events/:id/reject  (admin) — deny a pending proposal outright,
// without waiting for (or requiring) a vote majority.
app.put('/api/events/:id/reject', requireAuth, requireAdmin, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status !== 'pending')
      return res.status(400).json({ error: `Only pending proposals can be rejected (this one is ${event.status})` });

    db.prepare(`UPDATE calendar_events SET status = 'rejected' WHERE id = ?`).run(req.params.id);
    console.log(`Event ${req.params.id} ("${event.title}") rejected by ${req.user.username}`);
    res.json({ success: true, rejected: true });
  } catch (err) {
    console.error('Error rejecting event:', err);
    res.status(500).json({ error: 'Failed to reject event' });
  }
});

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
      const pad = (n) => String(n).padStart(2, '0');
      // Event dates are stored as LOCAL wall-clock strings ('YYYY-MM-DD' or
      // 'YYYY-MM-DDTHH:MM:SS'), so compare them against local time — using
      // sqlUtc() here (as before) meant reminders effectively never fired.
      const fmtLocal = (d) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

      // Get approved meetings starting within the next hour
      const rows = db.prepare(
        `SELECT * FROM calendar_events
         WHERE status = 'approved'
         AND date >= ?
         AND date <= ?`
      ).all(fmtLocal(now), fmtLocal(oneHourFromNow));
      
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

app.use('/api/remote-dev', createRemoteDevRouter({ requireAuth }));

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
