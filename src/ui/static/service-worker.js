const CACHE = 'vyntaro-pwa-v1';
const CORE_ASSETS = ['/', '/onboarding', '/home', '/chat', '/static/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    fetch(req).then((res) => {
      const cloned = res.clone();
      caches.open(CACHE).then((cache) => cache.put(req, cloned));
      return res;
    }).catch(() => caches.match(req))
  );
});
