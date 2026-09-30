'use strict';
// ── chat routes: channels & messages ─────────────────────────────────────────
// The message board API. Domain logic (row shaping, mentions, push fan-out)
// lives in modules/chat.js — this file is the thin HTTP layer. Mounted at /api.

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin, blockIfTimedOut } = require('../auth');
const {
  TS_SQL, MESSAGE_SELECT, messageRow, slugifyChannelName, broadcastBoardMessage,
} = require('../modules/chat');

const router = express.Router();

// GET /api/channels
router.get('/channels', requireAuth, (_, res) => {
  const rows = db
    .prepare('SELECT id, name, description FROM channels ORDER BY id ASC')
    .all();
  res.json(rows);
});

// POST /api/channels  { name, description? }
router.post('/channels', requireAuth, blockIfTimedOut, (req, res) => {
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
router.delete('/channels/:id', requireAuth, requireAdmin, (req, res) => {
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

// GET /api/channels/:id/messages
//   ?after=<messageId>   → only newer messages (for polling)
//   ?afterDel=<delId>    → only newer deletion tombstones (for polling)
//   ?limit=<n>           → last n messages (default 100, max 200)
// Response: { messages, deletions, lastDeletionId }
router.get('/channels/:id/messages', requireAuth, (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const after    = Number(req.query.after) || 0;
  const afterDel = Number(req.query.afterDel) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);

  let rows;
  if (after > 0) {
    rows = db
      .prepare(`${MESSAGE_SELECT}
         WHERE m.channel_id = ? AND m.id > ?
         ORDER BY m.id ASC LIMIT 500`)
      .all(channelId, after);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM (${MESSAGE_SELECT}
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
router.post('/channels/:id/messages', requireAuth, blockIfTimedOut, (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const body = String((req.body || {}).body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Message is empty' });

  const info = db
    .prepare('INSERT INTO messages (channel_id, user_id, body) VALUES (?, ?, ?)')
    .run(channelId, req.user.id, body);

  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(info.lastInsertRowid);

  // Push fan-out (presence-aware, mention-aware) — handled by the chat module,
  // fire-and-forget so a slow push provider never delays the echo.
  broadcastBoardMessage({
    channelId,
    messageId: info.lastInsertRowid,
    authorId: req.user.id,
    authorUsername: req.user.username,
    body,
  });

  res.json(messageRow(row));
});

// DELETE /api/messages/:id — author deletes their own message; admins delete any
router.delete('/messages/:id', requireAuth, (req, res) => {
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

module.exports = router;
module.exports.TS_SQL = TS_SQL; // re-export for sibling routers embedding raw SQL
