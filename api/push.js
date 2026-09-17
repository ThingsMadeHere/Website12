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

// Store push subscriptions in memory (userId -> subscription)
const subscriptions = new Map();

/**
 * Register a push subscription for a user
 */
function registerSubscription(userId, subscription) {
  subscriptions.set(userId, subscription);
  console.log(`📱 Registered push subscription for user ${userId}`);
}

/**
 * Remove a push subscription for a user
 */
function removeSubscription(userId) {
  subscriptions.delete(userId);
  console.log(`📱 Removed push subscription for user ${userId}`);
}

/**
 * Get subscription for a user
 */
function getSubscription(userId) {
  return subscriptions.get(userId) || null;
}

/**
 * Get all subscribed user IDs
 */
function getSubscribedUserIds() {
  return Array.from(subscriptions.keys());
}

/**
 * Send a push notification to a specific user
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
    
    // Remove invalid subscriptions (e.g., user revoked permission)
    if (error.statusCode === 410 || error.statusCode === 404) {
      console.log(`🗑️  Removing invalid subscription for user ${userId}`);
      subscriptions.delete(userId);
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