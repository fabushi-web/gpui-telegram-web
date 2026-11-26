/* Fabushi Web v1.6.11 — Standalone Offline-Capable Service Worker (Root & Subpath Safe) */
const CACHE_NAME = 'fabushi-web-v5';

function resolveScopedUrl(relPath) {
  const scope = (self.registration && self.registration.scope) || self.location.origin + '/';
  return new URL(relPath, scope).toString();
}

const PRECACHE_REL_PATHS = [
  './',
  './manifest.webmanifest',
  './js/telegram-web-app.js',
  './miniapps/fabushi-globe/index.html',
  './miniapps/fabushi-globe/fabushi_miniapp.wasm',
  './miniapps/fabushi-globe/earth_texture.jpg',
  './miniapps/fabushi-globe/home_world_lightfield.webp',
  './miniapps/fabushi-globe/zen_room_backdrop_2d.webp',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_REL_PATHS.map((rel) => {
            const url = resolveScopedUrl(rel);
            return fetch(url, { cache: 'no-cache' }).then((res) => {
              if (res.ok) {
                return cache.put(url, res);
              }
              return undefined;
            });
          }),
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

  // Never intercept REST/SSE/WS/OAuth/MCP/Health/Bot endpoints — let client adapters & offline outbox handle them directly
  if (/\/(api|v1|oauth|mcp|\.well-known)\/|^\/(mcp|health|healthz)$|^\/bot[^/]+\//.test(url.pathname)) return;

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
            return caches.match(resolveScopedUrl('./'));
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }),
      ),
  );
});
