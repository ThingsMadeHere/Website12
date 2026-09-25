const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Usernames that always receive admin privileges (promoted on startup + registration).
const ADMIN_USERNAMES = ['carter', 'carterherrault'];

// Default database location: <repo root>/JarvisData/database/mchs.db
// (overridable with DATABASE_PATH, e.g. the Docker volume at /app/data).
const defaultDbPath = path.join(__dirname, '..', 'JarvisData', 'database', 'mchs.db');
const dbPath = process.env.DATABASE_PATH || defaultDbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Initialize schema on startup
async function initDb() {
  db.exec(`
    -- Local accounts (replaces Dendrite/Matrix users)
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER     PRIMARY KEY AUTOINCREMENT,
      username      TEXT        UNIQUE NOT NULL,
      password_hash TEXT        NOT NULL,
      full_name     TEXT        NOT NULL DEFAULT '',
      photo_mime    TEXT,
      photo         BLOB,
      verified      INTEGER     NOT NULL DEFAULT 0,
      admin         INTEGER     NOT NULL DEFAULT 0,
      timeout_until TEXT,                          -- UTC 'YYYY-MM-DD HH:MM:SS'; NULL = not timed out
      must_change_password INTEGER NOT NULL DEFAULT 0, -- 1 = forced reset at next login
      created_at    TEXT        NOT NULL DEFAULT (datetime('now'))
    );

    -- Free-form role tags (mentor, lead, alumni, …). The special 'admin' tag
    -- is kept in sync with the users.admin column by the API.
    CREATE TABLE IF NOT EXISTS user_tags (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag         TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tag)
    );

    -- Simple session tokens
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT        PRIMARY KEY,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT        NOT NULL DEFAULT (datetime('now')),
      last_seen   TEXT        NOT NULL DEFAULT (datetime('now'))
    );

    -- User presence tracking (online/offline status)
    CREATE TABLE IF NOT EXISTS user_presence (
      user_id     INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      is_online   INTEGER     NOT NULL DEFAULT 0,
      last_seen   TEXT        NOT NULL DEFAULT (datetime('now'))
    );

    -- Board channels
    CREATE TABLE IF NOT EXISTS channels (
      id          INTEGER     PRIMARY KEY AUTOINCREMENT,
      name        TEXT        UNIQUE NOT NULL,
      description TEXT        DEFAULT '',
      created_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );

    -- Board messages
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER     PRIMARY KEY AUTOINCREMENT,
      channel_id  INTEGER     NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body        TEXT        NOT NULL,
      created_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

    -- Calendar (unchanged from the old site — existing events carry over)
    CREATE TABLE IF NOT EXISTS calendar_events (
      id          INTEGER     PRIMARY KEY AUTOINCREMENT,
      title       TEXT        NOT NULL,
      description TEXT,
      date        TEXT        NOT NULL,
      location    TEXT,
      type        TEXT        DEFAULT 'meeting',
      status      TEXT        DEFAULT 'pending',
      proposed_by TEXT,
      created_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_votes (
      id          INTEGER     PRIMARY KEY AUTOINCREMENT,
      event_id    INTEGER     NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vote        INTEGER     NOT NULL,
      created_at  TEXT        NOT NULL DEFAULT (datetime('now')),
      UNIQUE(event_id, user_id)
    );

    -- Web-push subscriptions. Persisted (not in-memory) so reminders keep
    -- working across server restarts; one row per device/browser per user.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          INTEGER     PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint    TEXT        NOT NULL UNIQUE,
      p256dh      TEXT        NOT NULL DEFAULT '',
      auth        TEXT        NOT NULL DEFAULT '',
      created_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

    -- Tombstones for deleted messages so polling clients can remove them live
    CREATE TABLE IF NOT EXISTS message_deletions (
      id          INTEGER     PRIMARY KEY AUTOINCREMENT,
      message_id  INTEGER     NOT NULL,
      channel_id  INTEGER     NOT NULL,
      deleted_by  INTEGER,
      deleted_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );

    -- Membership applications: the user account is only created once an
    -- admin approves (via the email links or the Applications page).
    CREATE TABLE IF NOT EXISTS applications (
      id            INTEGER     PRIMARY KEY AUTOINCREMENT,
      username      TEXT        NOT NULL,
      full_name     TEXT        NOT NULL DEFAULT '',
      password_hash TEXT        NOT NULL,
      photo_mime    TEXT,
      photo         BLOB,
      token         TEXT        NOT NULL UNIQUE,
      status        TEXT        NOT NULL DEFAULT 'pending', -- pending | approved | denied
      user_id       INTEGER,
      decided_by    INTEGER,
      created_at    TEXT        NOT NULL DEFAULT (datetime('now')),
      decided_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

    -- Tracks which recurring-meeting occurrences have already been seeded,
    -- so restarts never duplicate them — and never resurrect an occurrence
    -- an admin deleted (e.g. a holiday week).
    CREATE TABLE IF NOT EXISTS recurring_seeds (
      series  TEXT NOT NULL,
      date    TEXT NOT NULL,  -- YYYY-MM-DD
      PRIMARY KEY (series, date)
    );

    -- User availability blocks for scheduling
    CREATE TABLE IF NOT EXISTS user_availability (
      id          INTEGER     PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT,
      date        TEXT        NOT NULL,  -- YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
      start_time  TEXT,       -- HH:MM
      end_time    TEXT,       -- HH:MM
      location    TEXT,
      repeat_type TEXT        NOT NULL DEFAULT 'none',  -- none, weekly, monthly
      created_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_availability_user ON user_availability(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_availability_date ON user_availability(date);
  `);

  // ── migrations for existing databases ────────────────────────────────────
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('admin')) {
    db.exec('ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0');
    console.log('Migration: added users.admin column');
  }

  // Admin-panel era columns: profile info, photos, timeouts, forced password
  // resets. (ALTER TABLE ... ADD COLUMN is a no-op to re-run past the first.)
  const userMigrations = [
    ['full_name',            `TEXT NOT NULL DEFAULT ''`],
    ['photo_mime',           'TEXT'],
    ['photo',                'BLOB'],
    ['timeout_until',        'TEXT'],
    ['must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
    ['notification_settings', 'TEXT DEFAULT "all"'], // "all" | "mentions_only" | "none"
  ];
  for (const [col, decl] of userMigrations) {
    if (!userCols.includes(col)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${col} ${decl}`);
      console.log(`Migration: added users.${col} column`);
    }
  }

  // Backfill profile name + photo from each member's approved application
  // (approvals before this feature existed threw the data away). Idempotent —
  // only touches rows that are still missing the info.
  const needBackfill = db
    .prepare(
      `SELECT id, username FROM users
       WHERE full_name IS NULL OR full_name = '' OR photo IS NULL`
    )
    .all();
  if (needBackfill.length) {
    const latestApp = db.prepare(
      `SELECT full_name, photo, photo_mime FROM applications
       WHERE username = ? AND status = 'approved'
       ORDER BY id DESC LIMIT 1`
    );
    const fill = db.prepare(
      `UPDATE users SET
         full_name  = CASE WHEN full_name IS NULL OR full_name = '' THEN ? ELSE full_name END,
         photo      = CASE WHEN photo IS NULL THEN ? ELSE photo END,
         photo_mime = CASE WHEN photo_mime IS NULL THEN ? ELSE photo_mime END
       WHERE id = ?`
    );
    let filled = 0;
    for (const u of needBackfill) {
      const a = latestApp.get(u.username);
      if (!a) continue;
      fill.run(a.full_name || '', a.photo || null, a.photo_mime || null, u.id);
      filled++;
    }
    if (filled > 0) console.log(`Migration: backfilled profile name/photo for ${filled} user(s) from approved applications`);
  }

  // Older databases predate columns the calendar now requires.
  // (The committed mchs.db was missing both status and proposed_by —
  // approving events 500'd until this migration existed.)
  const evCols = db.prepare('PRAGMA table_info(calendar_events)').all().map(c => c.name);
  const evMigrations = [
    ['proposed_by', 'TEXT'],
    ['status',      `TEXT DEFAULT 'pending'`],
    ['location',    'TEXT'],
    ['type',        `TEXT DEFAULT 'meeting'`],
    ['description', 'TEXT'],
  ];
  for (const [col, decl] of evMigrations) {
    if (!evCols.includes(col)) {
      db.exec(`ALTER TABLE calendar_events ADD COLUMN ${col} ${decl}`);
      console.log(`Migration: added calendar_events.${col} column`);
      if (col === 'status') {
        // Legacy events predate the proposal workflow — keep them visible
        db.exec(`UPDATE calendar_events SET status = 'approved' WHERE status IS NULL OR status = 'pending'`);
        console.log('Migration: marked pre-existing calendar events as approved');
      }
    }
  }

  // better-sqlite3 v12 binds JS numbers into TEXT columns as '3.0' —
  // normalize any such proposed_by values to plain integer strings.
  // (Idempotent; runs on every startup to catch rows written by older builds.)
  const normalized = db
    .prepare(
      `UPDATE calendar_events
       SET proposed_by = CAST(CAST(proposed_by AS INTEGER) AS TEXT)
       WHERE proposed_by IS NOT NULL AND proposed_by != '' AND proposed_by GLOB '*.*'`
    )
    .run();
  if (normalized.changes > 0) {
    console.log(`Migration: normalized ${normalized.changes} proposed_by value(s) (e.g. "3.0" → "3")`);
  }

  // Promote configured admin usernames (idempotent — runs on every startup)
  const promote = db.prepare('UPDATE users SET admin = 1 WHERE username = ? AND admin = 0');
  for (const name of ADMIN_USERNAMES) {
    const info = promote.run(name);
    if (info.changes > 0) console.log(`Admin promoted: ${name}`);
  }

  // Keep the 'admin' role tag in sync with the admin flag for EVERY admin.
  // Runs after promotion so auto-promoted usernames get the tag too — the
  // Admin panel's tag editor rebuilds the whole tag set on save, so an admin
  // without the tag would have admin silently stripped on their next tag edit.
  db.exec(`INSERT OR IGNORE INTO user_tags (user_id, tag) SELECT id, 'admin' FROM users WHERE admin = 1`);

  // Seed default channels on first run
  const seed = ['general', 'announcements', 'build', 'programming'];
  const insert = db.prepare('INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)');
  const descriptions = {
    general:       'Team-wide chatter',
    announcements: 'Important updates from team leads',
    build:         'Mechanical, electrical, and fabrication',
    programming:   'Robot code, vision, and software',
  };
  for (const name of seed) insert.run(name, descriptions[name] || '');

  console.log('DB schema ready');
  ensureRecurringMeetings();
}

// ── recurring weekly meetings ────────────────────────────────────────────────
// Keeps the calendar populated with the team's standing weekly meetings for
// the next SEED_HORIZON_DAYS days. Idempotent via the recurring_seeds table;
// deleted occurrences stay deleted.
const SEED_HORIZON_DAYS = 120;

const RECURRING_MEETINGS = [
  {
    key: 'tue-lunch-f1',
    weekday: 2, // Tuesday
    title: 'Tuesday Lunch Meeting',
    time: '12:00',
    location: 'Room F1',
    description: 'Weekly Tuesday meeting during lunch in Room F1. All members welcome!',
  },
  {
    key: 'wed-after-c5',
    weekday: 3, // Wednesday
    title: 'Wednesday After-School Meeting',
    time: '16:00',
    location: 'Room C5',
    description: 'Weekly Wednesday meeting from 4:00 PM to 6:00 PM in Room C5, with robotics shop access.',
  },
];

function ensureRecurringMeetings() {
  const hasSeed  = db.prepare('SELECT 1 AS x FROM recurring_seeds WHERE series = ? AND date = ?');
  const addSeed  = db.prepare('INSERT OR IGNORE INTO recurring_seeds (series, date) VALUES (?, ?)');
  const addEvent = db.prepare(
    `INSERT INTO calendar_events (title, description, date, location, type, status)
     VALUES (?, ?, ?, ?, 'meeting', 'approved')`
  );

  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  let created = 0;

  for (let i = 0; i <= SEED_HORIZON_DAYS; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    for (const s of RECURRING_MEETINGS) {
      if (d.getDay() !== s.weekday) continue;
      if (hasSeed.get(s.key, ymd)) continue;
      addEvent.run(s.title, s.description, `${ymd}T${s.time}:00`, s.location);
      addSeed.run(s.key, ymd);
      created++;
    }
  }

  if (created > 0) {
    console.log(`Calendar: seeded ${created} recurring meeting(s) through the next ${SEED_HORIZON_DAYS} days`);
  }
  return created;
}

module.exports = { db, initDb, ADMIN_USERNAMES, ensureRecurringMeetings };
