'use strict';

// ── CACHE CONFIG ─────────────────────────────────────────────
const CACHE_NAME    = 'elitepace-v2.0';
const OFFLINE_URL   = '/index.html';

// Files जो cache होंगी
const CACHE_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/logo.svg'
];

// यह requests NEVER cache होंगी
const BYPASS_PATTERNS = [
  '/socket.io',   // Socket.io
  '/report/',     // PDF/Excel reports
  '/feedback',    // Feedback API
  '/problems',    // Problems API
  '/feedbacks',   // Feedbacks API
  '/log-error',   // Error logs
  '/health'       // Health check
];

// ── INSTALL ───────────────────────────────────────────────────
// Service Worker install होने पर files cache करो
self.addEventListener('install', (event) => {
  console.log('⚙️ SW: Installing ElitePace V2.0...');

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('📦 SW: Caching app files...');
        return cache.addAll(CACHE_FILES);
      })
      .then(() => {
        console.log('✅ SW: All files cached!');
        // तुरंत activate करो — wait मत करो
        return self.skipWaiting();
      })
      .catch((err) => {
        console.warn('⚠️ SW: Cache failed:', err);
      })
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────
// पुराने caches clean करो
self.addEventListener('activate', (event) => {
  console.log('✅ SW: Activating...');

  event.waitUntil(
    Promise.all([
      // पुराने caches delete करो
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('🗑️ SW: Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      }),
      // सभी clients को control करो
      self.clients.claim()
    ])
  );
});

// ── FETCH ─────────────────────────────────────────────────────
// हर request intercept करो
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // ── BYPASS: Socket.io और API requests
  const shouldBypass = BYPASS_PATTERNS.some(
    pattern => url.pathname.startsWith(pattern)
  );

  if (shouldBypass) {
    // Direct network se fetch करो
    event.respondWith(fetch(event.request));
    return;
  }

  // ── BYPASS: Non-GET requests (POST, PUT, etc.)
  if (event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // ── BYPASS: Different origin requests
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  // ── STRATEGY: Network First, Cache Fallback
  event.respondWith(
    networkFirstStrategy(event.request)
  );
});

// ── NETWORK FIRST STRATEGY ────────────────────────────────────
async function networkFirstStrategy(request) {
  try {
    // पहले network से try करो
    const networkResponse = await fetch(request);

    // Success — cache update करो
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;

  } catch (err) {
    // Network failed — cache से serve करो
    console.warn('🔴 SW: Network failed, using cache:', request.url);

    const cachedResponse = await caches.match(request);

    if (cachedResponse) {
      return cachedResponse;
    }

    // Cache में भी नहीं — offline page दो
    const offlineResponse = await caches.match(OFFLINE_URL);
    if (offlineResponse) {
      return offlineResponse;
    }

    // Last resort — simple offline message
    return new Response(
      `<!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8"/>
          <meta name="viewport" 
            content="width=device-width, initial-scale=1.0"/>
          <title>ElitePace — Offline</title>
          <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            body {
              font-family: 'Arial', sans-serif;
              background: #0a0a0f;
              color: #f0f0ff;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              text-align: center;
              padding: 2rem;
            }
            .wrap { max-width: 400px; }
            .icon { font-size: 4rem; margin-bottom: 1.5rem; }
            h1 {
              font-size: 2rem;
              font-weight: 900;
              margin-bottom: 0.75rem;
              background: linear-gradient(135deg, #7c5cff, #5c8fff);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
              background-clip: text;
            }
            p {
              color: #a0a0c0;
              margin-bottom: 2rem;
              line-height: 1.6;
            }
            .btn {
              display: inline-block;
              background: linear-gradient(135deg, #7c5cff, #5c8fff);
              color: #fff;
              padding: 0.85rem 2rem;
              border-radius: 12px;
              text-decoration: none;
              font-weight: 600;
              cursor: pointer;
              border: none;
              font-size: 1rem;
            }
            .tip {
              margin-top: 1.5rem;
              font-size: 0.82rem;
              color: #606080;
            }
          </style>
        </head>
        <body>
          <div class="wrap">
            <div class="icon">📡</div>
            <h1>You're Offline</h1>
            <p>
              ElitePace needs internet for 
              real-time sync between devices.
              <br/><br/>
              Use Mobile Hotspot to stay connected!
            </p>
            <button class="btn" 
              onclick="window.location.reload()">
              🔄 Try Again
            </button>
            <p class="tip">
              💡 Tip: Enable Mobile Hotspot and 
              connect all devices to it
            </p>
          </div>
        </body>
      </html>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }
    );
  }
}

// ── BACKGROUND SYNC ───────────────────────────────────────────
// Offline में queue हुए actions — online होने पर sync करो
self.addEventListener('sync', (event) => {
  if (event.tag === 'feedback-sync') {
    event.waitUntil(syncOfflineFeedback());
  }
  if (event.tag === 'problem-sync') {
    event.waitUntil(syncOfflineProblems());
  }
});

async function syncOfflineFeedback() {
  try {
    // IndexedDB से pending feedbacks लो
    // और server पर send करो
    console.log('🔄 SW: Syncing offline feedback...');
  } catch (err) {
    console.warn('⚠️ SW: Feedback sync failed:', err);
  }
}

async function syncOfflineProblems() {
  try {
    console.log('🔄 SW: Syncing offline problems...');
  } catch (err) {
    console.warn('⚠️ SW: Problem sync failed:', err);
  }
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────
// Future use के लिए ready
self.addEventListener('push', (event) => {
  try {
    const data = event.data
      ? event.data.json()
      : { title: 'ElitePace', body: 'New notification' };

    event.waitUntil(
      self.registration.showNotification(data.title || 'ElitePace', {
        body:  data.body  || 'Check ElitePace',
        icon:  '/logo.svg',
        badge: '/logo.svg',
        data:  data.url || '/'
      })
    );
  } catch (err) {
    console.warn('⚠️ SW: Push notification error:', err);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data || '/')
  );
});

// ── MESSAGE FROM APP ──────────────────────────────────────────
// App से messages receive करो
self.addEventListener('message', (event) => {
  if (!event.data) return;

  // Cache clear request
  if (event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      console.log('🗑️ SW: Cache cleared by app');
      event.ports[0]?.postMessage({ success: true });
    });
  }

  // Skip waiting request
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('⚡ ElitePace Service Worker V2.0 Loaded');
