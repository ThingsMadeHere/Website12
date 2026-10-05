// ── Discord relay routes ─────────────────────────────────────────────────────
const express = require('express');
const { requireAuth } = require('../auth');
const { getChannels, sendToDiscord, getMessagesFromDb } = require('../discord');

const router = express.Router();

// GET /api/discord/channels - List all accessible channels
router.get('/channels', (_, res) => {
  const channels = getChannels();
  res.json({ channels });
});

// GET /api/discord/history - Get messages for a channel
router.get('/history', (req, res) => {
  const channelId = req.query.channelId;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  
  const messages = getMessagesFromDb(channelId, limit);
  res.json({ messages, channelId });
});

// POST /api/discord/send - Send message to Discord
router.post('/send', requireAuth, (req, res) => {
  const { channelId, body, username, avatar } = req.body || {};
  
  if (!channelId) {
    return res.status(400).json({ error: 'Missing channelId' });
  }
  
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Missing message body' });
  }

  const sent = sendToDiscord({
    channelId,
    body: String(body).trim(),
    username: username || req.user.username,
    avatar: avatar || null,
    userId: req.user.id,
  });

  if (sent) {
    res.json({ ok: true });
  } else {
    res.status(503).json({ error: 'Could not send message' });
  }
});

module.exports = router;
