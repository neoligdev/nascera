const CACHE_NAME = 'nascera-v1';
const PRECACHE = ['/blackhole.mp4', '/blackhole.webm', '/favicon.png', '/logo.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const ext = url.pathname.split('.').pop();
  
  // Cache-first for static assets (video, images, fonts)
  if (['mp4','webm','png','jpg','jpeg','webp','gif','svg','ico','woff','woff2','ttf','css'].includes(ext)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        });
      })
    );
    return;
  }
  
  // Network-first for HTML/API
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
