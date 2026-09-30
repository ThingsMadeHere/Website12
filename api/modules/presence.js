'use strict';
// ── presence: shared domain logic ────────────────────────────────────────────
// Online/offline status and notification preferences live here so the chat,
// auth and admin modules all read/write one source of truth. Other modules
// talk to presence exclusively through these exports.

const { db } = require('../db');
const { sqlUtc } = require('./util');

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

// Get user notification preferences ('all' | 'mentions_only' | 'none')
function getUserNotificationSettings(userId) {
  const user = db.prepare('SELECT notification_settings FROM users WHERE id = ?').get(userId);
  if (!user) return 'all'; // Default to all notifications
  return user.notification_settings || 'all';
}

module.exports = { updateUserPresence, isUserOnline, getUserNotificationSettings };
