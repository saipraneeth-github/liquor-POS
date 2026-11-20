/* Liquor Counter POS - service worker.
 *
 * Why it exists: a counter tablet that is restarted or reloaded while the shop's internet is down used to show a blank page,
 * because only the code already in memory kept working. With this worker the app shell and the built files open from the
 * device, and a short list of READ-ONLY screens' data (the product list, who is signed in, the outlets, sale types) is served
 * from the last good copy. Bills made offline are queued by the POS itself (localStorage + clientRef) and are not touched here.
 *
 * What it must never do:
 *   - cache anything but a successful (2xx) GET, or intercept a POST / PUT / PATCH / DELETE;
 *   - keep one person's data for another: API copies are stored per signed-in user (a hash of the token, never the token)
 *     and the app asks for them to be wiped on every sign-out;
 *   - serve stale code: the page itself is network-first, and built files are content-hashed.
 */
const VERSION = 'v1';
// Stamped by the build (vite.config.ts): the file's bytes must change with every release or the browser keeps the old worker.
const BUILD = '__BUILD_ID__';
const SHELL = 'lc-shell-' + VERSION;     // the page (index.html), manifest, icons
const FILES = 'lc-files-' + BUILD;       // content-hashed JS / CSS / fonts / images: immutable, so cache-first; one cache per release
const DATA = 'lc-data-' + VERSION;       // the few read-only API lists, per signed-in user
const CURRENT = [SHELL, FILES, DATA];

// Only these GETs are kept for offline use. Everything else under /api goes straight to the network.
const DATA_PATHS = [
  /^\/api\/v1\/me$/,
  /^\/api\/v1\/branches$/,
  /^\/api\/v1\/products(\?|$)/,
  /^\/api\/v1\/sale-types\/[0-9a-f-]{36}(\/prices|\/stock)?$/,
  /^\/api\/v1\/inventory\/stock\/[0-9a-f-]{36}$/,
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // the page is the same file for every route (it is a single-page app)
    await cache.add(new Request('/', { headers: { Accept: 'text/html' } })).catch(() => undefined);
    await cache.addAll(['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']).catch(() => undefined);
    // Keep EVERY built script and stylesheet on the device. Every screen except sign-in, dashboard and POS is its own file, so
    // without this a cashier who goes offline and opens a screen they had not visited yet would get nothing. A failure here
    // (a flaky connection during install) must not stop the worker installing: files are then cached as they are first used.
    try {
      const listed = await fetch('/precache.json', { cache: 'no-store' });
      if (listed.ok) {
        const files = await listed.json();
        const store = await caches.open(FILES);
        const failed = [];
        await Promise.all(files.map((f) => store.add(f).catch(() => { failed.push(f); })));
        // a file that did not arrive (a dropped connection, a busy server) is tried once more, one at a time: a screen that is
        // missing from the device is a screen that will not open offline
        for (const f of failed) await store.add(f).catch(() => undefined);
      }
    } catch (err) { /* offline during install: fine */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('lc-') && !CURRENT.includes(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // sign-out: forget every person's cached data on this device
  if (event.data && event.data.type === 'clear-data') event.waitUntil(caches.delete(DATA));
});

async function userKey(request) {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  const bytes = new TextEncoder().encode(auth);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isDataRequest = (url) => DATA_PATHS.some((re) => re.test(url.pathname + url.search));
const isBuiltFile = (url) => url.pathname.startsWith('/assets/') || /\.(woff2?|png|svg|gif|ico)$/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;                       // never touch writes
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;           // never touch other sites (payment gateway, ...)

  // 1. The page: always try the network first so a new release is picked up; fall back to the saved page when offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok && fresh.headers.get('content-type') && fresh.headers.get('content-type').includes('text/html')) {
          (await caches.open(SHELL)).put('/', fresh.clone());
        }
        return fresh;
      } catch (err) {
        const saved = await (await caches.open(SHELL)).match('/');
        if (saved) return saved;
        throw err;
      }
    })());
    return;
  }

  // 2. Built files: cache-first (their names change whenever their content does).
  if (isBuiltFile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(FILES);
      const hit = await cache.match(request);
      if (hit) return hit;
      const fresh = await fetch(request);
      if (fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    })());
    return;
  }

  // 3. A few read-only lists: network first, last good copy for THIS signed-in user when the network is down.
  if (url.pathname.startsWith('/api/') && isDataRequest(url)) {
    event.respondWith((async () => {
      const key = await userKey(request);
      if (!key) return fetch(request);                         // not signed in: nothing to keep
      // The per-user part must be a QUERY parameter: the Cache API ignores a URL fragment (#...) when matching, which would
      // have given every person on the device the same entry.
      const keyed = new URL(request.url);
      keyed.searchParams.set('__lcu', key);
      const cacheKey = new Request(keyed.href);
      const cache = await caches.open(DATA);
      try {
        const fresh = await fetch(request);
        if (fresh.ok) cache.put(cacheKey, fresh.clone());
        return fresh;
      } catch (err) {
        const saved = await cache.match(cacheKey);
        if (saved) {
          const headers = new Headers(saved.headers);
          headers.set('X-Served-Offline', '1');
          return new Response(saved.body, { status: saved.status, headers });
        }
        throw err;
      }
    })());
  }
  // everything else: the browser's normal handling
});
