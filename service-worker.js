// Windy Tree service worker — offline app shell + CDN cache + update lifecycle.
// Bump VERSION to invalidate every cached asset on the next page load.
const VERSION = 'v1';
const CACHE = `windy-tree-${VERSION}`;

// Hard-precache shell. Versioned URLs (?v=...) match the index.html imports
// exactly, so replacing them invalidates only the changed file.
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './main.js?v=r19',
  './schema.js?v=r1',
  './noise.js',
  './roots.js',
  './ui-widgets.js',
  './tree-worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  // Bundled assets the app loads at boot.
  './sky.hdr',
  './tex/bark.jpg',
  './tex/bark_normal.jpg',
  './tex/leaf.png',
  './tex/leaf_b.png',
  './tex/leaf_normal.jpg',
];

self.addEventListener('install', (e) => {
  // Activate the new SW immediately so the update-toast reload uses it.
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // addAll is atomic — a single 404 fails the whole install. Use
      // individual puts so a missing optional asset doesn't sink offline.
      await Promise.all(APP_SHELL.map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok) await cache.put(url, res);
        } catch {}
      }));
    }),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
    )).then(() => self.clients.claim()),
  );
});

// Cache strategy:
//   • Same-origin GETs: stale-while-revalidate (return cached, refresh in bg).
//   • jsdelivr CDN (Three.js bundle): cache-first (rarely changes; pinned by
//     version in importmap, so the URL itself is the cache key).
//   • Non-GET / cross-origin to other hosts: pass through.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !isCdn) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: false });

    // CDN: cache-first. Importmap pins the version so the URL itself
    // versions the cache; revalidating each load wastes a round-trip.
    if (isCdn && cached) return cached;

    if (cached) {
      // SWR — return cached now, refresh in background.
      e.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok && fresh.type !== 'opaque') {
            await cache.put(req, fresh.clone());
          }
        } catch {}
      })());
      return cached;
    }

    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type !== 'opaque') {
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      // Network unreachable, nothing cached. For navigations, fall back to
      // the cached app shell so the user still gets a UI to look at.
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});

// Page asks the waiting SW to take over so the update-toast reload picks
// up the new build immediately.
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
