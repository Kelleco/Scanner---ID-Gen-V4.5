'use strict';

// Bump this version to force a refresh of the cached app shell.
const CACHE = 'scanner-id-v2';

// Same-origin app shell. addAll() rejects if any of these fail to fetch,
// so a partial/broken install never silently "succeeds".
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/tailwind.min.css',
  './vendor/papaparse.min.js',
  './vendor/html5-qrcode.min.js',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigations: serve the cached app shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else: cache-first, fall back to network.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});
