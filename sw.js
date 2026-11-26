const CACHE_NAME = 'zivanta-shell-v53';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/api.js',
  '/js/app-core.js',
  '/js/app-detail.js',
  '/js/app-capture.js',
  '/js/app-calls.js',
  '/js/app-home.js',
  '/js/app-reports.js',
  '/js/app-profile.js',
  '/js/map.js',
  '/js/keyboard.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — always go to network so data stays fresh.
  // If offline, let the app's own code show a "you're offline" state.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Cross-origin: only runtime-cache CDN scripts/styles (Leaflet etc.).
  // Never cache map tiles or other images — a day of panning would fill
  // the phone's storage. Let the browser handle those normally.
  const sameOrigin = url.origin === self.location.origin;
  const dest = event.request.destination;
  if (!sameOrigin && dest !== 'script' && dest !== 'style') return;

  // App shell: cache-first so the app opens instantly and works offline.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
      );
    })
  );
});

// ---- phone reminders (sent by the server) ----
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Zivanta', {
    body: d.body || '', tag: d.tag || 'zivanta', renotify: true, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
