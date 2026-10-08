const CACHE_NAME = 'snnc-pwa-v13';

const FILES_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/notification-helmet-192.png',
  './icons/notification-helmet-badge-96.png'
];

/* =========================
   PWA 설치
========================= */

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(
        FILES_TO_CACHE.map(url => new Request(url, { cache: 'reload' }))
      ))
  );

  // 새 버전은 사용자가 업데이트 적용을 누를 때 활성화합니다.
});


self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

/* =========================
   PWA 활성화
========================= */

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('snnc-pwa-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});


/* =========================
   일반 파일 요청
========================= */

self.addEventListener('fetch', event => {
  // 다른 앱의 페이지와 자산은 해당 앱의 서비스 워커가 처리합니다.
  if (new URL(event.request.url).pathname.startsWith('/worktable')) return;
  event.respondWith(
    (event.request.mode === 'navigate'
      ? fetch(event.request, { cache: 'no-cache' })
          .then(async response => {
            if (response.ok) {
              try {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(event.request, response.clone());
              } catch (error) {
                console.warn('페이지 캐시 갱신 실패:', error);
              }
            }
            return response;
          })
      : fetch(event.request))
      .catch(() => caches.match(event.request))
  );
});


/* =========================
   🔔 푸시 알림 수신
========================= */

self.addEventListener('push', event => {

  let data = {
    title: '휴무계획표',
    body: '새로운 알림이 있습니다.',
    url: './index.html'
  };

  /*
   * 서버에서 JSON 형태로 보낸 경우
   */
  if (event.data) {
    try {
      const pushData = event.data.json();

      data = {
        ...data,
        ...pushData
      };

    } catch (error) {
      /*
       * JSON이 아닌 일반 문자열로 들어온 경우
       */
      data.body = event.data.text();
    }
  }

  const notificationOptions = {
    body: data.body,

    icon: './icons/notification-helmet-192.png',

    badge: './icons/notification-helmet-badge-96.png',

    data: {
      url: data.url === './' || data.url === '/' ? './index.html' : (data.url || './index.html')
    },

    // 수신마다 고유한 tag를 사용해 이전 알림과 분리합니다.
    tag: 'snnc-' + (
      typeof self.crypto?.randomUUID === 'function'
        ? self.crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    ),
    vibrate: [200, 100, 200]
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title,
      notificationOptions
    )
  );
});


/* =========================
   🔔 알림 클릭
========================= */

self.addEventListener('notificationclick', event => {

  event.notification.close();

  const urlToOpen =
    event.notification.data?.url || './';

  event.waitUntil(

    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(clientList => {

      /*
       * 이미 PWA가 열려 있다면
       * 해당 화면을 앞으로 가져옵니다.
       */
      for (const client of clientList) {

        if ('focus' in client && new URL(client.url).origin === self.location.origin && ['/', '/index.html'].includes(new URL(client.url).pathname)) {
          return client.focus();
        }

      }

      /*
       * PWA가 열려 있지 않다면
       * 앱을 새로 엽니다.
       */
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }

    })
  );
});
