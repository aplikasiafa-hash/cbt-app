// Salinan halaman ujian & pustaka di perangkat: halaman tetap bisa dibuka ulang saat internet putus
// (jawaban & soal sudah tersimpan di perangkat).
// Saat ada internet, halaman TIDAK diambil lewat service worker: permintaan dari service worker di aplikasi
// Android tidak membawa tanda aplikasi CBT Ujian (kunci link), sehingga server menjawab "Halaman tidak ditemukan".
// Jadi halaman selalu dimuat langsung oleh aplikasi; salinannya disimpan oleh halaman itu sendiri.
const CACHE = 'cbt-ujian-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.pathname.startsWith('/api')) return;
  const halaman = req.mode === 'navigate' && u.origin === location.origin;
  const pustaka = /(^|\.)cdn\.jsdelivr\.net$|(^|\.)unpkg\.com$|(^|\.)cdn\.sheetjs\.com$|^fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (halaman) {
    if (self.navigator.onLine !== false) return;   // ada internet → dimuat langsung oleh aplikasi
    e.respondWith(caches.match(req, { ignoreSearch: true })
      .then(r => r || caches.match(new URL('./', location.href).href))
      .then(r => r || Response.error()));
  } else if (pustaka) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(x => { if (x.ok || x.type === 'opaque') { const k = x.clone(); caches.open(CACHE).then(c => c.put(req, k)); } return x; })));
  }
});
