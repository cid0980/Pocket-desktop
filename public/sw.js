/* Pocket Desktop service worker — offline shell + static caching only.
 * Network-first for the app shell so updates land immediately;
 * cache-first for vendored libraries and icons (they are versioned by path).
 * API responses are never cached. */

const CACHE = 'pocket-desktop-v14'; // bump with every release so phones stop running stale files
const SHELL = ['/', '/index.html', '/assets/style.css', '/assets/app.js', '/assets/remote.js',
  '/assets/pad.js', '/assets/controls.js', '/assets/workspaces.js', '/assets/screenshot-viewer.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon-180.png',
  '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  const isStatic = url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/');

  if (isStatic) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      } catch (err) {
        return new Response('offline', { status: 503, statusText: 'offline' });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (res.ok && (url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.startsWith('/assets/'))) {
        const cache = await caches.open(CACHE);
        cache.put(request, res.clone());
      }
      return res;
    } catch (err) {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const shell = await cache.match('/index.html');
      if (shell) return shell;
      throw err;
    }
  })());
});
