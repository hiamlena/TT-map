// sw.js — минимальный офлайн-кеш
const CACHE = 'tt-v1';
const PRECACHE = [
'./',
'./index.html',
'./manifest.json',
'./errors.js',
'./diag.html',
'./assets/css/style.css',
// Добавь сюда критичные JS, если нужны офлайн: './assets/js/yandex.js', './assets/js/router.js', './assets/js/core.js'
];


self.addEventListener('install', e => {
e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(()=>{}));
});


self.addEventListener('activate', e => {
e.waitUntil(
caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
);
});


self.addEventListener('fetch', e => {
const { request } = e;
if (request.method !== 'GET') return;
e.respondWith(
caches.match(request).then(hit => hit || fetch(request).catch(() => caches.match('./diag.html')))
);
});