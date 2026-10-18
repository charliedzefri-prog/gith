const VERSION = 'gith-world-v2';
const SHELL = ['/', '/styles.css?v=2', '/game.js?v=2', '/manifest.json', '/characters.json', '/locations.json', '/icons/app.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const url = new URL(req.url);
  if (url.pathname === '/health') return;
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  event.respondWith(fetch(req).then(res => {
    if (res.ok && (req.mode === 'navigate' || /\.(css|js|json|svg|png)$/.test(url.pathname))) {
      const clone = res.clone(); caches.open(VERSION).then(cache => cache.put(req, clone));
    }
    return res;
  }).catch(async () => (await caches.match(req)) || caches.match('/')));
});
