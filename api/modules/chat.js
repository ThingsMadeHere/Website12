'use strict';
// ── chat: shared domain logic ────────────────────────────────────────────────
// Message row shaping, @-mention detection and the Discord-like notification
// fan-out live here so other modules (and the /api/channels routes) share one
// implementation. Push delivery itself is delegated downward to modules/push.

const { db } = require('../db');
const { getSubscribedUserIds, sendBoardMessageNotification } = require('./push');
const { isUserOnline, getUserNotificationSettings } = require('./presence');

// SQLite epoch-millis expression for message timestamps (shared SELECT fragment).
const TS_SQL = `CAST((julianday(m.created_at) - 2440587.5) * 86400000 AS INTEGER)`;

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

// The canonical message SELECT (join + badges + photo flag) — used by list,
// post-echo and any other module that needs a fully-shaped message row.
const MESSAGE_SELECT = `
  SELECT m.id, m.user_id, u.username, u.verified, u.admin, m.body, ${TS_SQL} AS ts,
         (SELECT GROUP_CONCAT(t.tag, ',') FROM user_tags t WHERE t.user_id = m.user_id) AS tags,
         (u.photo IS NOT NULL) AS has_photo
  FROM messages m JOIN users u ON u.id = m.user_id`;

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

// Decide whether `user` should be pinged about a board message and fire the
// push. Discord-like behavior: online users respect their notification
// settings; offline users are only interrupted by mentions.
function notifyBoardMessage(user, { channelId, messageId, channelName, author, content, isMentioned }) {
  const notificationSettings = getUserNotificationSettings(user.id);
  const isOnline = isUserOnline(user.id);
  let shouldNotify = false;
  let isMentionNotification = false;

  if (isOnline) {
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

  if (!shouldNotify) return Promise.resolve(false);

  return sendBoardMessageNotification(user.id, {
    channelId, messageId, channelName, author, content,
  }, isMentionNotification)
    .then(() => true)
    .catch(err => {
      console.error('Push notification failed:', err.message);
      return false;
    });
}

// Fan out a freshly-posted message to every push subscriber except the author.
// Fire-and-forget: never throws into the caller's request handler.
function broadcastBoardMessage({ channelId, messageId, authorId, authorUsername, body }) {
  try {
    const channel = db.prepare('SELECT name FROM channels WHERE id = ?').get(channelId);
    if (!channel) return;

    const allUsers = db.prepare('SELECT id, username FROM users').all();
    const subscribedUsers = getSubscribedUserIds().filter(userId => userId !== authorId);
    if (subscribedUsers.length === 0) return;

    const mentions = detectMentions(body, allUsers.map(u => u.username));

    subscribedUsers.forEach(userId => {
      const user = allUsers.find(u => u.id === userId);
      if (!user) return;
      const isMentioned = mentions.users.includes(user.username.toLowerCase()) || mentions.everyone;
      notifyBoardMessage(user, {
        channelId, messageId,
        channelName: channel.name,
        author: authorUsername,
        content: body,
        isMentioned,
      });
    });
  } catch (err) {
    console.error('Failed to send push notifications:', err.message);
  }
}

module.exports = {
  TS_SQL,
  MESSAGE_SELECT,
  messageRow,
  slugifyChannelName,
  detectMentions,
  notifyBoardMessage,
  broadcastBoardMessage,
};
