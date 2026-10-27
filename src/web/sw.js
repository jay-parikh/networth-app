/* NetWorth offline cache. VERSION and FILES are filled in by tools/build.py
   (VERSION = a hash of every shipped file, so any change installs fresh). */
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = `networth-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // one by one: a flaky connection retries only what failed next time
    for (const f of FILES) {
      try { await c.add(new Request(f, { cache: 'reload' })); } catch (err) { /* next visit */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('networth-') && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // the market-data relay must always go to the network
  if (url.pathname.includes('/.netlify/') || url.pathname.includes('/px/')) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const hit = await c.match(path, { ignoreSearch: true }) || await c.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && res.type === 'basic') c.put(e.request, res.clone());
      return res;
    } catch (err) {
      if (e.request.mode === 'navigate') {
        const shell = await c.match(new URL('index.html', self.registration.scope).pathname);
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
