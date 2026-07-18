/* Service Worker für Grabfinder – macht die App offline nutzbar
 * und cached besuchte Kartenkacheln. */
'use strict';

const SHELL_CACHE = 'grabfinder-shell-v2';
const TILE_CACHE = 'grabfinder-tiles-v1';
const TILE_LIMIT = 400;

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './gruppen.js',
  './manifest.webmanifest',
  './icon.svg',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > TILE_LIMIT) {
    await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map(k => cache.delete(k)));
  }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Kartenkacheln: Cache zuerst, im Hintergrund aktualisieren
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(e.request);
      const fetched = fetch(e.request).then(res => {
        if (res.ok) {
          cache.put(e.request, res.clone());
          trimTileCache();
        }
        return res;
      }).catch(() => null);
      return cached || (await fetched) || Response.error();
    })());
    return;
  }

  // App-Dateien: Cache zuerst, sonst Netz (und nachträglich cachen)
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    try {
      const res = await fetch(e.request);
      if (res.ok && url.origin === location.origin) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(e.request, res.clone());
      }
      return res;
    } catch {
      return Response.error();
    }
  })());
});
