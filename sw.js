const CACHE_NAME = 'zivanta-shell-v39';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/api.js',
  '/js/app.js',
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
