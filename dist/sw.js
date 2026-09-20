// Service Worker for push notifications
// Handles incoming push notifications and notification clicks

const CACHE_NAME = 'mchs-robotics-v1';
const ASSETS_TO_CACHE = ['/', '/index.html', '/manifest.json', '/notification-sound.mp3'];

// Preload and cache the notification sound
let notificationSoundBuffer = null;

async function cacheNotificationSound() {
  try {
    const response = await fetch('/notification-sound.mp3');
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      notificationSoundBuffer = arrayBuffer;
      console.log('✅ Notification sound cached');
    }
  } catch (error) {
    console.warn('⚠️  Could not cache notification sound:', error);
  }
}

// Install event - cache assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE)).then(() => {
      cacheNotificationSound();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((name) => name !== CACHE_NAME ? caches.delete(name) : null)
      )
    )
  );
});

// Fetch event - serve from cache, fall back to network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});

/**
 * Play notification sound using the Audio API
 */
async function playNotificationSound() {
  try {
    // Try to use cached sound first
    if (notificationSoundBuffer) {
      const audioContext = new (self.AudioContext || self.webkitAudioContext)();
      const audioBuffer = await audioContext.decodeAudioData(notificationSoundBuffer.slice(0));
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.start(0);
      console.log('🔊 Notification sound played');
      return;
    }
    
    // Fallback: fetch and play
    const response = await fetch('/notification-sound.mp3');
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      const audioContext = new (self.AudioContext || self.webkitAudioContext)();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.start(0);
      console.log('🔊 Notification sound played (fetched)');
    }
  } catch (error) {
    console.warn('⚠️  Could not play notification sound:', error);
  }
}

// Push event - handle incoming push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon.svg',
    badge: data.badge || '/icon.svg',
    vibrate: data.vibrate || [200, 100, 200],
    data: data.data || {},
    requireInteraction: data.requireInteraction !== false,
    timestamp: data.timestamp || Date.now(),
    silent: data.silent || false
  };

  // Show notification (sound will play automatically on most browsers)
  event.waitUntil(
    self.registration.showNotification(data.title || 'MCHS Robotics', options)
  );
});

// Notification click event - handle user clicking on notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Check if there's already a window open
      for (const client of clientList) {
        if (client.url === new URL(urlToOpen, self.location.origin).href && 'focus' in client) {
          return client.focus();
        }
      }
      // If no window is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});