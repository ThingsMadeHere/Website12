// Push notification utilities for the frontend
// Handles service worker registration and push subscription management

/**
 * Convert base64 string to Uint8Array for VAPID key
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  
  return outputArray;
}

/**
 * Register the service worker
 * @returns {Promise<ServiceWorkerRegistration|false>}
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service workers are not supported');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered:', registration.scope);
    return registration;
  } catch (error) {
    console.error('Service Worker registration failed:', error);
    return false;
  }
}

/**
 * Request notification permission
 * @returns {Promise<'granted'|'denied'|'unsupported'>}
 */
export async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    return 'unsupported';
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  if (Notification.permission !== 'denied') {
    return await Notification.requestPermission();
  }

  return 'denied';
}

/**
 * Subscribe to push notifications
 * @param {ServiceWorkerRegistration} registration 
 * @param {string} token 
 * @returns {Promise<boolean>}
 */
export async function subscribeToPush(registration, token) {
  try {
    const vapidResponse = await fetch('/api/push/vapid-key');
    if (!vapidResponse.ok) throw new Error('Failed to get VAPID key');
    
    const { publicKey } = await vapidResponse.json();
    const convertedVapidKey = urlBase64ToUint8Array(publicKey);
    
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedVapidKey
    });
    
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ subscription })
    });
    
    if (!response.ok) throw new Error('Failed to register subscription');
    
    console.log('Successfully subscribed to push notifications');
    return true;
  } catch (error) {
    console.error('Failed to subscribe to push:', error);
    return false;
  }
}

/**
 * Unsubscribe from push notifications
 * @param {string} token 
 * @returns {Promise<boolean>}
 */
export async function unsubscribeFromPush(token) {
  try {
    const response = await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!response.ok) throw new Error('Failed to unregister subscription');
    
    console.log('Successfully unsubscribed from push notifications');
    return true;
  } catch (error) {
    console.error('Failed to unsubscribe from push:', error);
    return false;
  }
}

/**
 * Check subscription status
 * @param {string} token 
 * @returns {Promise<boolean>}
 */
export async function checkSubscriptionStatus(token) {
  try {
    const response = await fetch('/api/push/subscription', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) throw new Error('Failed to check subscription status');
    
    const { subscribed } = await response.json();
    return subscribed;
  } catch (error) {
    console.error('Failed to check subscription status:', error);
    return false;
  }
}

/**
 * Initialize push notifications for a logged-in user
 * @param {string} token 
 * @returns {Promise<boolean>}
 */
export async function initializePushNotifications(token) {
  try {
    const registration = await registerServiceWorker();
    if (!registration) {
      console.warn('Service worker registration failed');
      return false;
    }
    
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      console.log('Notification permission not granted:', permission);
      return false;
    }
    
    const isSubscribed = await checkSubscriptionStatus(token);
    if (isSubscribed) {
      console.log('Already subscribed to push notifications');
      return true;
    }
    
    return await subscribeToPush(registration, token);
  } catch (error) {
    console.error('Failed to initialize push notifications:', error);
    return false;
  }
}