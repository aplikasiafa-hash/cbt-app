// Salinan halaman ujian & pustaka di perangkat: halaman tetap bisa dibuka ulang saat internet putus
// (jawaban & soal sudah tersimpan di perangkat). Halaman selalu diambil dari server dulu bila ada internet.
const CACHE = 'cbt-ujian-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.pathname.startsWith('/api')) return;
  const halaman = req.mode === 'navigate' && u.origin === location.origin;
  const pustaka = /(^|\.)cdn\.jsdelivr\.net$|(^|\.)unpkg\.com$|(^|\.)cdn\.sheetjs\.com$/.test(u.hostname);
  if (halaman) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const k = r.clone(); caches.open(CACHE).then(c => c.put(req, k)); } return r; })
      .catch(() => caches.match(req).then(r => r || caches.match(new URL('./', location.href).href))));
  } else if (pustaka) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(x => { if (x.ok || x.type === 'opaque') { const k = x.clone(); caches.open(CACHE).then(c => c.put(req, k)); } return x; })));
  }
});
