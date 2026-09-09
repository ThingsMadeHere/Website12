const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'mchs.db');
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
      verified      INTEGER     NOT NULL DEFAULT 0,
      created_at    TEXT        NOT NULL DEFAULT (datetime('now'))
    );

    -- Simple session tokens
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT        PRIMARY KEY,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT        NOT NULL DEFAULT (datetime('now')),
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
  `);

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
}

module.exports = { db, initDb };
