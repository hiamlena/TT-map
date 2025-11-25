/**
 * @fileoverview Service Worker для оффлайн-работы приложения Trans-Time.
 * Обеспечивает кэширование статических ресурсов, поддержку оффлайн-режима
 * и корректную работу с динамическими запросами Яндекс.Карт.
 */

/**
 * Имя текущего кэша. При изменении значения произойдёт пересоздание кэша
 * и обновление всех закэшированных ресурсов.
 * @type {string}
 */
const CACHE = 'tt-v2'; // Обнови версию, чтобы сбросить кэш

/**
 * Список критических ресурсов, необходимых для оффлайн-работы.
 * Эти ресурсы будут закэшированы при установке Service Worker.
 * @type {string[]}
 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './errors.js',
  './diag.html',
  './assets/css/style.css',
  // При необходимости добавь:
  // './assets/js/yandex.js',    // ← раскомментируй, если нужно оффлайн-ядро
  // './assets/js/boot.js'
];

/**
 * Событие 'install': активируется при установке Service Worker.
 * Открывает кэш с именем `CACHE` и добавляет в него все ресурсы из `PRECACHE`.
 * В случае ошибки — выводит её в консоль, не блокируя дальнейшую работу.
 * @param {InstallEvent} e - Событие установки.
 */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .catch(console.error)
  );
});

/**
 * Событие 'activate': активируется при активации Service Worker.
 * Удаляет все предыдущие версии кэша (оставляя только текущую `CACHE`),
 * чтобы избежать накопления устаревших данных.
 * Вызывает `self.clients.claim()` для немедленного контроля над всеми вкладками.
 * @param {ExtendableEvent} e - Событие активации.
 */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim(); // Немедленно берём контроль над страницей
});

/**
 * Событие 'fetch': перехватывает все сетевые запросы.
 * Реализует стратегию кэширования:
 * - Пропускает не-GET запросы.
 * - Для ресурсов Яндекс.Карт: всегда делает сетевой запрос, при ошибке — возвращает из кэша (если есть).
 * - Для остальных ресурсов: сначала проверяет кэш, при отсутствии — делает запрос, кэширует и возвращает.
 * - При полном отказе сети — возвращает резервную страницу диагностики или главную.
 * @param {FetchEvent} e - Событие сетевого запроса.
 */
self.addEventListener('fetch', e => {
  const { request } = e;

  // Пропускаем не-GET запросы (POST, PUT и т.д.)
  if (request.method !== 'GET') return;

  // Исключаем внешние API Яндекса из агрессивного кэширования
  if (
    request.url.includes('api-maps.yandex') ||
    request.url.includes('yastatic.net') ||
    request.url.includes('yandex.ru') ||
    request.destination === 'script'
  ) {
    e.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // Основная стратегия: кэш → сеть → fallback
  e.respondWith(
    caches.match(request).then(cached => {
      // Если ресурс найден в кэше — возвращаем его
      if (cached) return cached;

      // Иначе — делаем сетевой запрос
      return fetch(request).then(response => {
        // Если запрос успешен — клонируем ответ и сохраняем в кэш
        if (response.status === 200 && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => {
            cache.put(request, clone);
          });
        }
        return response;
      }).catch(() => {
        // При сетевой ошибке — возвращаем диагностику или главную страницу
        return caches.match('./diag.html') || caches.match('./');
      });
    })
  );
});
