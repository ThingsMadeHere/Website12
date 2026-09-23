const webpush = require('web-push');

// Configure VAPID keys from environment variables
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@mchsrobotics.dev';

if (!vapidPublicKey || !vapidPrivateKey) {
  console.warn('⚠️  VAPID keys not configured. Push notifications will not work.');
  console.warn('   Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to api/.env');
} else {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  console.log('✅ VAPID keys configured for push notifications');
}

// Push subscriptions live in SQLite (push_subscriptions table) so they
// survive server restarts — previously they were memory-only, which meant
// reminders silently stopped working after every deploy until each user
// reloaded the site. Each user may have several subscriptions (one per
// device/browser); all of them receive pushes.
let dbRef = null;
function attachDb(db) {
  dbRef = db;
  try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(''); } catch { /* ignore */ }
}

// Legacy in-memory map kept only so old callers don't crash; no longer read.
const subscriptions = new Map();

/**
 * Register a push subscription for a user (dedupes by endpoint across devices)
 */
function registerSubscription(userId, subscription) {
  const endpoint = String((subscription || {}).endpoint || '');
  if (!endpoint) return;
  if (dbRef) {
    // Re-adding an endpoint that belongs to another account (e.g. shared
    // browser profile) would misroute notifications — move it instead.
    dbRef.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    dbRef.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(userId, endpoint, subscription.keys?.p256dh || '', subscription.keys?.auth || '');
  } else {
    subscriptions.set(userId, subscription); // fallback: no DB attached yet
  }
  console.log(`📱 Registered push subscription for user ${userId}`);
}

/**
 * Remove one subscription (by endpoint), or all of a user's subscriptions
 * when called with just a userId (legacy signature).
 */
function removeSubscription(userId, endpoint) {
  if (dbRef && endpoint) {
    dbRef.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint));
  } else if (dbRef) {
    dbRef.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  } else {
    subscriptions.delete(userId);
  }
  console.log(`📱 Removed push subscription(s) for user ${userId}`);
}

/**
 * Get the first subscription for a user (legacy API)
 */
function getSubscription(userId) {
  if (dbRef) {
    const row = dbRef.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? LIMIT 1').get(userId);
    return row ? subRowToPayload(row) : null;
  }
  return subscriptions.get(userId) || null;
}

function subRowToPayload(row) {
  return {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
}

/**
 * Get all subscribed user IDs (deduped)
 */
function getSubscribedUserIds() {
  if (dbRef) {
    return dbRef.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all().map(r => r.user_id);
  }
  return Array.from(subscriptions.keys());
}

// All stored subscription payloads for one user (one per device/browser).
function subsForUser(userId) {
  if (dbRef) {
    return dbRef.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId).map(subRowToPayload);
  }
  const s = subscriptions.get(userId);
  return s ? [s] : [];
}

/**
 * Send a push notification to every device a user has registered.
 */
async function sendPushNotification(userId, payload) {
  const subs = subsForUser(userId);

  if (subs.length === 0) {
    console.log(`❌ No subscription found for user ${userId}`);
    return false;
  }

  const results = await Promise.all(subs.map(sub => deliver(sub, payload, userId)));
  return results.some(Boolean);
}

async function deliver(subscription, payload, userId) {
  try {
    const notificationPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: payload.data || {},
      timestamp: Date.now(),
      tag: payload.tag,
      renotify: payload.renotify || undefined,
      vibrate: payload.vibrate || [200, 100, 200, 100, 200],
      requireInteraction: payload.requireInteraction !== false,
      silent: payload.silent || false
    });

    await webpush.sendNotification(subscription, notificationPayload);
    console.log(`✅ Push notification sent to user ${userId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send push notification to user ${userId}:`, error.message);

    // Remove invalid/expired subscriptions (user revoked permission, endpoint
    // rotated, browser wiped) so the store doesn't accumulate garbage.
    if (error.statusCode === 410 || error.statusCode === 404) {
      console.log(`🗑️  Removing expired subscription for user ${userId}`);
      if (dbRef && subscription.endpoint) {
        dbRef.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
      } else {
        subscriptions.delete(userId);
      }
    }

    return false;
  }
}

/**
 * Send push notification to multiple users
 */
async function sendPushNotificationToMany(userIds, payload) {
  const results = { success: 0, failed: 0, details: [] };

  await Promise.all(userIds.map(async (userId) => {
    const success = await sendPushNotification(userId, payload);
    results.details.push({ userId, success });
    if (success) results.success++;
    else results.failed++;
  }));

  return results;
}

/**
 * Send board message notification
 */
async function sendBoardMessageNotification(userId, messageData, isMention = false) {
  const title = isMention 
    ? `@${messageData.author} mentioned you in ${messageData.channelName}`
    : `New message in ${messageData.channelName}`;
    
  return sendPushNotification(userId, {
    title,
    body: `${messageData.author}: ${messageData.content.substring(0, 100)}${messageData.content.length > 100 ? '...' : ''}`,
    data: {
      type: 'board_message',
      channelId: messageData.channelId,
      messageId: messageData.messageId,
      url: `/board/${messageData.channelId}`,
      isMention: isMention
    }
  });
}

/**
 * Send meeting reminder notification
 */
async function sendMeetingReminderNotification(userId, meetingData) {
  return sendPushNotification(userId, {
    title: `Meeting Reminder: ${meetingData.title}`,
    body: `Starting in ${meetingData.timeUntil} - ${meetingData.location}`,
    data: {
      type: 'meeting_reminder',
      meetingId: meetingData.meetingId,
      url: '/calendar'
    }
  });
}

module.exports = {
  attachDb,
  registerSubscription,
  removeSubscription,
  getSubscription,
  getSubscribedUserIds,
  sendPushNotification,
  sendPushNotificationToMany,
  sendBoardMessageNotification,
  sendMeetingReminderNotification,
  vapidPublicKey,
  subscriptions
};