/* Service Worker für Grabfinder – macht die App offline nutzbar
 * und cached besuchte Kartenkacheln.
 *
 * App-Dateien und Daten: „Netz zuerst“ – Updates sind sofort sichtbar,
 * ohne Netz kommt die zuletzt gespeicherte Version aus dem Cache.
 * Kartenkacheln: „Cache zuerst“ (ändern sich praktisch nie). */
'use strict';

const SHELL_CACHE = 'grabfinder-shell-v8';
const TILE_CACHE = 'grabfinder-tiles-v1';
const TILE_LIMIT = 400;

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './gruppen.js',
  './promis.js',
  './manifest.webmanifest',
  './icon.svg',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      // cache: 'reload' umgeht den HTTP-Cache – sonst landen u. U. alte Dateien im neuen Cache
      .then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
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

  // Nur eigene Dateien behandeln (Overpass, Wikipedia usw. direkt ans Netz)
  if (url.origin !== location.origin) return;

  // App-Dateien und Daten: Netz zuerst, bei Fehler Cache
  e.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      // Navigations-Requests dürfen nicht mit eigenen Optionen neu gebaut werden
      const req = e.request.mode === 'navigate'
        ? e.request
        : new Request(e.request.url, { cache: 'no-cache' });
      const res = await fetch(req);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});
