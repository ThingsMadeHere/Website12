const express = require('express');
const cors    = require('cors');
const { db, initDb } = require('./db');
const {
  hashPassword, verifyPassword,
  createSession, destroySession, requireAuth,
} = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ── helpers ──────────────────────────────────────────────────────────────────

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → epoch millis
const TS_SQL = `CAST((julianday(m.created_at) - 2440587.5) * 86400000 AS INTEGER)`;

function messageRow(r) {
  return {
    id:       r.id,
    userId:   r.user_id,
    username: r.username,
    verified: !!r.verified,
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

// ── accounts ─────────────────────────────────────────────────────────────────

// POST /api/register  { username, password }
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const cleaned = username.toLowerCase().trim();
  if (!/^[a-z0-9._-]{1,32}$/.test(cleaned))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, and . _ - characters' });

  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(cleaned);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const info = db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(cleaned, hashPassword(password));

  const token = createSession(info.lastInsertRowid);
  console.log('User registered:', cleaned);

  res.json({ userId: info.lastInsertRowid, username: cleaned, token, verified: false });
});

// POST /api/login  { username, password }
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });

  const token = createSession(user.id);
  res.json({ userId: user.id, username: user.username, token, verified: !!user.verified });
});

// POST /api/logout
app.post('/api/logout', requireAuth, (req, res) => {
  destroySession(req.user.token);
  res.json({ ok: true });
});

// POST /api/verify — marks the signed-in user as verified (✓ badge)
app.post('/api/verify', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true, verified: true });
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
app.post('/api/channels', requireAuth, (req, res) => {
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

// ── messages ─────────────────────────────────────────────────────────────────

// GET /api/channels/:id/messages
//   ?after=<messageId>  → only newer messages (for polling)
//   ?limit=<n>          → last n messages (default 100, max 200)
app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const after = Number(req.query.after) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);

  let rows;
  if (after > 0) {
    rows = db
      .prepare(
        `SELECT m.id, m.user_id, u.username, u.verified, m.body, ${TS_SQL} AS ts
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ? AND m.id > ?
         ORDER BY m.id ASC LIMIT 500`
      )
      .all(channelId, after);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM (
           SELECT m.id, m.user_id, u.username, u.verified, m.body, ${TS_SQL} AS ts
           FROM messages m JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ?
           ORDER BY m.id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(channelId, limit);
  }

  res.json(rows.map(messageRow));
});

// POST /api/channels/:id/messages  { body }
app.post('/api/channels/:id/messages', requireAuth, (req, res) => {
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
      `SELECT m.id, m.user_id, u.username, u.verified, m.body, ${TS_SQL} AS ts
       FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
    )
    .get(info.lastInsertRowid);

  res.json(messageRow(row));
});

// ── calendar events (unchanged contract) ─────────────────────────────────────

// GET /api/events — all calendar events
app.get('/api/events', (_, res) => {
  try {
    const rows = db.prepare('SELECT * FROM calendar_events ORDER BY date ASC').all();
    const events = rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description || '',
      date: row.date,
      location: row.location || '',
      type: row.type || 'meeting',
      status: row.status || 'pending',
      isMeeting: row.type === 'meeting',
    }));
    res.json(events);
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// POST /api/events — propose a new calendar event
app.post('/api/events', requireAuth, (req, res) => {
  const { title, description, date, location, type } = req.body || {};

  if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });

  try {
    const info = db
      .prepare(
        `INSERT INTO calendar_events (title, description, date, location, type, proposed_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(title, description || '', date, location || '', type || 'meeting', req.user.id);

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

// DELETE /api/events/:id
app.delete('/api/events/:id', requireAuth, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Event not found' });
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
app.post('/api/events/:id/vote', requireAuth, (req, res) => {
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

// ── start ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
