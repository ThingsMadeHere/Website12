// Push notification utilities for the frontend
// Handles service worker registration and push subscription management

// Convert base64 string to Uint8Array for the subscription
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

// Register the service worker
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service workers are not supported in this browser');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered with scope:', registration.scope);
    return registration;
  } catch (error) {
    console.error('Service Worker registration failed:', error);
    return false;
  }
}

// Request notification permission
export async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    console.warn('This browser does not support notifications');
    return 'unsupported';
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    return permission;
  }

  return 'denied';
}

// Subscribe to push notifications
export async function subscribeToPushNotifications(registration, token) {
  try {
    // Get the VAPID key from the server first
    const vapidResponse = await fetch('/api/push/vapid-key');
    if (!vapidResponse.ok) {
      throw new Error('Failed to get VAPID key');
    }
    
    const { publicKey } = await vapidResponse.json();
    const convertedVapidKey = urlBase64ToUint8Array(publicKey);
    
    // Subscribe to push
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedVapidKey
    });
    
    // Send subscription to server
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ subscription })
    });
    
    if (!response.ok) {
      throw new Error('Failed to register subscription with server');
    }
    
    console.log('Successfully subscribed to push notifications');
    return true;
  } catch (error) {
    console.error('Failed to subscribe to push notifications:', error);
    return false;
  }
}

// Unsubscribe from push notifications
export async function unsubscribeFromPushNotifications(token) {
  try {
    const response = await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to unregister subscription from server');
    }
    
    console.log('Successfully unsubscribed from push notifications');
    return true;
  } catch (error) {
    console.error('Failed to unsubscribe from push notifications:', error);
    return false;
  }
}

// Check subscription status
export async function checkSubscriptionStatus(token) {
  try {
    const response = await fetch('/api/push/subscription', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to check subscription status');
    }
    
    const { subscribed } = await response.json();
    return subscribed;
  } catch (error) {
    console.error('Failed to check subscription status:', error);
    return false;
  }
}

// Initialize push notifications for a logged-in user
export async function initializePushNotifications(token) {
  try {
    // Register service worker
    const registration = await registerServiceWorker();
    if (!registration) {
      console.warn('Service worker registration failed, push notifications unavailable');
      return false;
    }
    
    // Request notification permission
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      console.log('Notification permission not granted:', permission);
      return false;
    }
    
    // Check if already subscribed
    const isSubscribed = await checkSubscriptionStatus(token);
    if (isSubscribed) {
      console.log('Already subscribed to push notifications');
      return true;
    }
    
    // Subscribe to push notifications
    const success = await subscribeToPushNotifications(registration, token);
    return success;
  } catch (error) {
    console.error('Failed to initialize push notifications:', error);
    return false;
  }
}