const webpush = require('web-push');

// Configure VAPID keys from environment variables
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@mchsrobotics.dev';

if (!vapidPublicKey || !vapidPrivateKey) {
  console.warn('⚠️  VAPID keys not configured. Push notifications will not work.');
  console.warn('   Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to api/.env');
} else {
  webpush.setVapidDetails(
    vapidSubject,
    vapidPublicKey,
    vapidPrivateKey
  );
  console.log('✅ VAPID keys configured for push notifications');
}

// Store push subscriptions in memory (in production, you'd want to persist these)
// For now, we'll use a simple Map: userId -> subscription object
const subscriptions = new Map();

/**
 * Register a push subscription for a user
 * @param {string} userId - User ID
 * @param {object} subscription - PushSubscription object from browser
 */
function registerSubscription(userId, subscription) {
  subscriptions.set(userId, subscription);
  console.log(`📱 Registered push subscription for user ${userId}`);
}

/**
 * Get all subscribed user IDs
 * @returns {string[]} Array of user IDs with active subscriptions
 */
function getSubscribedUserIds() {
  return Array.from(subscriptions.keys());
}

/**
 * Remove a push subscription for a user
 * @param {string} userId - User ID
 */
function removeSubscription(userId) {
  subscriptions.delete(userId);
  console.log(`📱 Removed push subscription for user ${userId}`);
}

/**
 * Get subscription for a user
 * @param {string} userId - User ID
 * @returns {object|null} Subscription object or null
 */
function getSubscription(userId) {
  return subscriptions.get(userId) || null;
}

/**
 * Send a push notification to a specific user
 * @param {string} userId - User ID to send notification to
 * @param {object} payload - Notification payload
 * @param {string} payload.title - Notification title
 * @param {string} payload.body - Notification body
 * @param {object} payload.data - Additional data to send
 * @returns {Promise<boolean>} Success status
 */
async function sendPushNotification(userId, payload) {
  const subscription = subscriptions.get(userId);
  
  if (!subscription) {
    console.log(`❌ No subscription found for user ${userId}`);
    return false;
  }

  try {
    const notificationPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: payload.data || {},
      timestamp: Date.now()
    });

    await webpush.sendNotification(subscription, notificationPayload);
    console.log(`✅ Push notification sent to user ${userId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send push notification to user ${userId}:`, error.message);
    
    // If subscription is invalid (e.g., user revoked permission), remove it
    if (error.statusCode === 410 || error.statusCode === 404) {
      console.log(`🗑️  Removing invalid subscription for user ${userId}`);
      subscriptions.delete(userId);
    }
    
    return false;
  }
}

/**
 * Send push notification to multiple users
 * @param {string[]} userIds - Array of user IDs
 * @param {object} payload - Notification payload
 * @returns {Promise<object>} Results with success/failure counts
 */
async function sendPushNotificationToMany(userIds, payload) {
  const results = {
    success: 0,
    failed: 0,
    details: []
  };

  const promises = userIds.map(async (userId) => {
    const success = await sendPushNotification(userId, payload);
    results.details.push({ userId, success });
    if (success) results.success++;
    else results.failed++;
  });

  await Promise.all(promises);
  return results;
}

/**
 * Send board message notification
 * @param {string} userId - User ID to notify
 * @param {object} messageData - Message information
 * @param {boolean} isMention - Whether this is a mention notification
 */
async function sendBoardMessageNotification(userId, messageData, isMention = false) {
  const title = isMention 
    ? `@${messageData.author} mentioned you in ${messageData.channelName}`
    : `New message in ${messageData.channelName}`;
    
  return sendPushNotification(userId, {
    title: title,
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
 * @param {string} userId - User ID to notify
 * @param {object} meetingData - Meeting information
 */
async function sendMeetingReminderNotification(userId, meetingData) {
  return sendPushNotification(userId, {
    title: `Meeting Reminder: ${meetingData.title}`,
    body: `Starting in ${meetingData.timeUntil} - ${meetingData.location}`,
    data: {
      type: 'meeting_reminder',
      meetingId: meetingData.meetingId,
      url: `/calendar`
    }
  });
}

module.exports = {
  registerSubscription,
  removeSubscription,
  getSubscription,
  getSubscribedUserIds,
  sendPushNotification,
  sendPushNotificationToMany,
  sendBoardMessageNotification,
  sendMeetingReminderNotification,
  vapidPublicKey, // Export for frontend use
  subscriptions // Export subscriptions Map for external access
};