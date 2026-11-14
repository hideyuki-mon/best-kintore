// オフライン用サービスワーカー: アプリ本体だけをキャッシュする（家計データはキャッシュしない）
const VERSION = 'kakeibo-v1.1.0';
const FILES = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/model.js', './js/crypto.js', './js/db.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kakeibo-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部へは関与しない
  // 画面(HTML)はネットワーク優先（更新をすぐ届ける）。3秒で応答がなければキャッシュ。
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = await caches.match('./index.html', { cacheName: VERSION });
      try {
        const res = await Promise.race([
          fetch(req, { cache: 'no-cache' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
        ]);
        return res.ok ? res : (cached || res);
      } catch { return cached || Response.error(); }
    })());
    return;
  }
  // それ以外はこの版のキャッシュから（同じ版のファイルだけが組み合わさる）
  e.respondWith(caches.match(req, { ignoreSearch: true, cacheName: VERSION }).then((hit) => hit || fetch(req)));
});
