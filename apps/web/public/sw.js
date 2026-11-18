/* GPUI Telegram Web — Standalone Offline-Capable Service Worker */
const CACHE_NAME = 'gpui-telegram-web-shell-v1';
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/js/telegram-web-app.js',
  '/miniapps/fabushi/app.wasm',
  '/miniapps/fabushi-globe/fabushi-merit.wasm',
  '/miniapps/fabushi-globe/index.html',
  '/miniapps/taskboard/index.html',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_URLS.map((url) =>
            fetch(url, { cache: 'no-cache' }).then((res) => {
              if (res.ok) {
                return cache.put(url, res);
              }
              return undefined;
            }),
          ),
        ),
      )
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept REST/SSE/WS endpoints — let client adapters & offline outbox handle them directly
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
          const clone = networkRes.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => undefined);
        }
        return networkRes;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match('/');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }),
      ),
  );
});
